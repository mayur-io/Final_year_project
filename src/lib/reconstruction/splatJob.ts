import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";

import { projectStorageDirectory } from "@/lib/storage";
import { pythonBinary } from "@/lib/system/environment";

type SplatPhase = "queued" | "training" | "bootstrapping" | "complete" | "failed" | "cancelling" | "cancelled";

export type SplatJob = {
  phase: SplatPhase;
  trained: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  logs: string[];
};

/** Real trainer settings. Kept modest so a 4 GB laptop GPU can finish a run. */
export const TRAIN_ITERATIONS = 4000;
export const TRAIN_DOWNSCALE = 4;
export const TRAIN_MAX_POINTS = 200000;

const jobs = new Map<string, SplatJob>();
const cancelRequests = new Set<string>();
const activeChildren = new Map<string, ChildProcess>();

class SplatCancelledError extends Error {
  constructor() {
    super("Gaussian training was stopped safely.");
    this.name = "SplatCancelledError";
  }
}

function bootstrapScriptPath() {
  // Next bundles src/ at the project root in dev and standalone builds.
  return path.join(process.cwd(), "src", "lib", "reconstruction", "splatBootstrap.py");
}

function trainScriptPath() {
  return path.join(process.cwd(), "src", "lib", "reconstruction", "splatTrain.py");
}

async function python() {
  return pythonBinary();
}

/** Candidates for the CUDA gsplat interpreter, in preference order. */
function trainPythonCandidates() {
  const explicit = process.env.SPLATO_SPLAT_PYTHON;
  const candidates = [
    explicit,
    // The venv used to install torch+cu124 and the prebuilt gsplat wheel.
    "D:\\SplatoStorage\\runtime\\gsplat310\\Scripts\\python.exe",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

function runLogged(command: string, args: string[], job: SplatJob, projectId?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    if (projectId) activeChildren.set(projectId, child);
    const write = (chunk: Buffer) =>
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => {
          job.logs = [...job.logs, line].slice(-80);
        });
    child.stdout.on("data", write);
    child.stderr.on("data", write);
    child.on("error", (error) => {
      if (projectId) activeChildren.delete(projectId);
      if (projectId && cancelRequests.has(projectId)) reject(new SplatCancelledError());
      else reject(error);
    });
    child.on("close", (code) => {
      if (projectId) activeChildren.delete(projectId);
      if (projectId && cancelRequests.has(projectId)) {
        reject(new SplatCancelledError());
        return;
      }
      code === 0 ? resolve() : reject(new Error(`Splat step exited with code ${code ?? "unknown"}.`));
    });
  });
}

export function requestSplatCancel(projectId: string) {
  const job = jobs.get(projectId);
  if (!job || ["complete", "failed", "cancelled"].includes(job.phase)) return job ?? null;
  cancelRequests.add(projectId);
  job.phase = "cancelling";
  job.logs.push("Stop requested — finishing the current training step, then stopping safely.");
  const child = activeChildren.get(projectId);
  if (child) {
    try {
      child.kill();
    } catch {
      // Already exited; the close handler surfaces cancellation.
    }
  }
  return job;
}

function clearSplatCancel(projectId: string) {
  cancelRequests.delete(projectId);
  activeChildren.delete(projectId);
}

export type SplatRuntime = {
  ready: boolean;
  python: string;
  /** "train" = CUDA torch + gsplat installed; "bootstrap" = numpy-only preview. */
  mode: "train" | "bootstrap" | null;
};

/**
 * Resolve which splat pipeline can run on this machine.
 * A real gsplat optimizer is preferred; the fixed-parameter initialization
 * preview is the honest fallback when no CUDA trainer is installed.
 */
export async function resolveSplatRuntime(): Promise<SplatRuntime> {
  const probes: Array<[string, "train" | "bootstrap"]> = [];
  for (const candidate of trainPythonCandidates()) {
    const exists = await fs.access(candidate).then(() => true).catch(() => false);
    if (!exists) continue;
    probes.push([candidate, "train"]);
  }
  for (const [binary, mode] of probes) {
    try {
      await runLogged(
        binary,
        ["-c", "import torch, gsplat; assert torch.cuda.is_available()"],
        { logs: [] } as unknown as SplatJob,
      );
      return { ready: true, python: binary, mode };
    } catch {
      // Candidate exists but lacks a CUDA-capable torch/gsplat; skip it.
    }
  }
  const binary = await python();
  try {
    await runLogged(binary, ["-c", "import numpy"], { logs: [] } as unknown as SplatJob);
    return { ready: true as const, python: binary, mode: "bootstrap" as const };
  } catch {
    return { ready: false, python: binary, mode: null };
  }
}

export async function installSplatRuntime() {
  const job: SplatJob = {
    phase: "queued",
    trained: false,
    startedAt: new Date().toISOString(),
    logs: [],
  };
  await runLogged(await python(), ["-m", "pip", "install", "numpy"], job);
  return resolveSplatRuntime();
}

export function getSplatJob(projectId: string) {
  return jobs.get(projectId) ?? null;
}

export function splatArtifactPaths(projectId: string) {
  const root = projectStorageDirectory(projectId);
  const reconstruction = path.join(root, "reconstruction");
  return {
    dense: path.join(reconstruction, "dense", "fused.ply"),
    sparse: path.join(reconstruction, "sparse", "0", "points3D.bin"),
    sparseModel: path.join(reconstruction, "sparse", "0"),
    frames: path.join(root, "processed", "frames"),
    splat: path.join(reconstruction, "splat.ply"),
    splatInfo: path.join(reconstruction, "splat-info.json"),
  };
}

/** A real gsplat optimizer is available only when torch+gsplat resolve with CUDA. */
export async function startSplatJob(projectId: string) {
  const existing = jobs.get(projectId);
  if (existing && !["complete", "failed", "cancelled"].includes(existing.phase)) return existing;
  clearSplatCancel(projectId);
  const runtime = await resolveSplatRuntime();
  if (!runtime.ready)
    throw new Error(
      `Python with numpy was not found (${runtime.python}). Set PYTHON_PATH or run the splat setup step first.`,
    );
  const { dense, sparse, sparseModel, frames, splat, splatInfo } = splatArtifactPaths(projectId);
  const hasDense = await fs.access(dense).then(() => true).catch(() => false);
  const hasSparse = await fs.access(sparse).then(() => true).catch(() => false);
  if (!hasDense && !hasSparse)
    throw new Error(
      "No point cloud yet. Run reconstruction first — the preview is built from the sparse cloud and upgraded from the dense cloud when available.",
    );

  const job: SplatJob = {
    phase: "queued",
    trained: runtime.mode === "train",
    startedAt: new Date().toISOString(),
    logs:
      runtime.mode === "train"
        ? ["Real Gaussian Splatting training queued (gsplat + CUDA torch found)."]
        : ["Gaussian initialization preview queued (no trained 3DGS optimizer is installed)."],
  };
  jobs.set(projectId, job);

  void (async () => {
    try {
      if (runtime.mode === "train") {
        job.phase = "training";
        job.logs.push(
          `Training ${TRAIN_ITERATIONS} iterations with gsplat on ${runtime.python}. ` +
            `Initializing ${TRAIN_MAX_POINTS.toLocaleString()}+ Gaussian candidates from the COLMAP sparse cloud; ` +
            `optimizing L1 + SSIM against the captured frames.`,
        );
        await runLogged(
          runtime.python,
          [
            trainScriptPath(),
            "--sparse-dir",
            sparseModel,
            "--image-dir",
            frames,
            "--output",
            splat,
            "--iterations",
            String(TRAIN_ITERATIONS),
            "--downscale",
            String(TRAIN_DOWNSCALE),
            "--max-points",
            String(TRAIN_MAX_POINTS),
          ],
          job,
          projectId,
        );
        const info = await fs
          .readFile(splatInfo, "utf8")
          .then((contents) => JSON.parse(contents) as { iterations?: number; finalLoss?: number; gaussians?: number })
          .catch(() => null);
        job.logs.push(
          info
            ? `Trained model written: ${(info.gaussians ?? 0).toLocaleString()} Gaussians, loss ${info.finalLoss ?? "?"} after ${info.iterations ?? TRAIN_ITERATIONS} iterations.`
            : "Trained model written (gsplat).",
        );
      } else {
        job.phase = "bootstrapping";
        if (hasDense) {
          job.logs.push("Assigning fixed Gaussian parameters to dense points. No loss, images, poses, or optimizer are used — this is not a trained model.");
          await runLogged(runtime.python, [bootstrapScriptPath(), "--input", dense, "--output", splat], job, projectId);
        } else {
          job.logs.push("No dense cloud — building the initialization preview from the sparse cloud (fast; re-run at balanced/high for a denser preview).");
          await runLogged(runtime.python, [bootstrapScriptPath(), "--points3d-bin", sparse, "--output", splat], job, projectId);
        }
      }
      job.phase = "complete";
      job.finishedAt = new Date().toISOString();
      job.logs.push(
        job.trained
          ? "Gaussian Splatting training complete."
          : "Initialization preview written. No optimizer ran; this is not a trained 3D Gaussian Splatting reconstruction.",
      );
      clearSplatCancel(projectId);
    } catch (error) {
      if (error instanceof SplatCancelledError) {
        job.phase = "cancelled";
        job.finishedAt = new Date().toISOString();
        job.logs.push("Stopped safely. No partial model was promoted — the previous trained model (if any) is untouched.");
        clearSplatCancel(projectId);
        return;
      }
      job.phase = "failed";
      job.finishedAt = new Date().toISOString();
      job.error =
        error instanceof Error ? error.message : "Gaussian model step failed.";
      job.logs.push(job.error);
      clearSplatCancel(projectId);
    }
  })();
  return job;
}