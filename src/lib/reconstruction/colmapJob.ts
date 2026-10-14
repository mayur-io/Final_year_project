import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";

import { resolveColmapRuntime, resolveGlomapRuntime, isGlomapCompatible } from "@/lib/reconstruction/colmapRuntime";
import { readFramesManifest } from "@/lib/media/prepareReport";
import { projectStorageDirectory } from "@/lib/storage";

type ReconstructionMode = "object" | "environment";
type Quality = "draft" | "balanced" | "high";
/** Which SfM mapper solves cameras/points. GLOMAP is global (faster on
 * ordered captures, GPU bundle adjustment); COLMAP is incremental. */
export type MapperChoice = "auto" | "colmap" | "glomap";
type JobPhase =
  | "queued"
  | "features"
  | "matching"
  | "mapping"
  | "dense"
  | "complete"
  | "failed"
  | "cancelling"
  | "cancelled";
type Verdict = "PASS" | "WARN" | "FAIL";

export type ColmapJob = {
  phase: JobPhase;
  verdict?: Verdict;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  warnings: string[];
  logs: string[];
  reportPath?: string;
};

/**
 * Reconstruction report, written next to the artifacts. The UI reads this
 * instead of inferring success from an exit code — a mapped directory with no
 * points, or a sparse solve with almost no registered images, is not success.
 */
export type ReconstructionReport = {
  version: 1;
  projectId: string;
  engine: string;
  engineVersion?: string;
  engineSelectionEvidence: string[];
  intent: ReconstructionMode;
  verdict: Verdict;
  gateSource: "measured_fixture" | "fallback";
  inputFrames: number;
  registeredImages: number;
  unregisteredImages: number;
  registrationRatio: number | null;
  meanReprojectionErrorPx: number | null;
  sparsePointCount: number;
  densePointCount: number | null;
  artifacts: {
    sparse?: string;
    dense?: string;
    gaussian?: string;
    gaussianKind?: "trained" | "initialization_preview";
  };
  stageTimesMs: Record<string, number>;
  warnings: string[];
  qualityNotes: string[];
  failure?: { stage: string; message: string; recoverable: boolean };
  completedAt: string;
};

const jobs = new Map<string, ColmapJob>();
const cancelRequests = new Set<string>();
const activeChildren = new Map<string, Set<ChildProcess>>();

class JobCancelledError extends Error {
  constructor() {
    super("Reconstruction was stopped safely at the last finished stage.");
    this.name = "JobCancelledError";
  }
}

// The max-image-size flag moved namespaces across COLMAP versions
// (`SiftExtraction` in ≤3.12, `FeatureExtraction` umbrella in ≥3.13). Probe
// the binary once per path so the same pipeline runs on either lineage.
const extractorFlagByBinary = new Map<string, string>();
async function extractorSizeFlag(colmapPath: string): Promise<string> {
  const cached = extractorFlagByBinary.get(colmapPath);
  if (cached) return cached;
  const help = await new Promise<string>((resolve) => {
    const child = spawn(colmapPath, ["feature_extractor", "--help"], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
  });
  const flag = help.includes("FeatureExtraction.max_image_size")
    ? "--FeatureExtraction.max_image_size"
    : "--SiftExtraction.max_image_size";
  extractorFlagByBinary.set(colmapPath, flag);
  return flag;
}
const imageSizeByQuality: Record<Quality, number> = {
  draft: 1024,
  balanced: 1400,
  high: 2000,
};
const minimumFrameCount = 100;
// Evidence-aid gates. They are not a scientific guarantee; they separate an
// obviously broken solve from a usable one.
const MIN_REGISTRATION_RATIO = 0.45;
const WARN_REGISTRATION_RATIO = 0.7;
// A model can register most images and still contain almost no coherent
// geometry (duplicate/near-static viewpoints collapse into a handful of points).
// Below this the artifact is not a usable reconstruction, so it is a FAIL.
const MIN_SPARSE_POINTS = 100;
const WARN_SPARSE_POINTS = 500;

function gigabytes(bytes: number) {
  return (bytes / 1024 ** 3).toFixed(1);
}

function addLog(job: ColmapJob, message: string) {
  job.logs = [...job.logs, message].slice(-120);
}

function addWarning(job: ColmapJob, warnings: string[], message: string) {
  warnings.push(message);
  addLog(job, `WARN: ${message}`);
}

async function hasSparsePointCloud(sparseDirectory: string) {
  const modelDirectory = path.join(sparseDirectory, "0");
  return await Promise.all([
    fs.access(path.join(modelDirectory, "points3D.bin")).then(() => true).catch(() => false),
    fs.access(path.join(modelDirectory, "points3D.txt")).then(() => true).catch(() => false),
  ]).then((results) => results.some(Boolean));
}

/**
 * Normalize GLOMAP's `mapper` output to the shared `sparse/0` layout that the
 * rest of the pipeline (pose check, undistorter, PLY export) expects.
 * GLOMAP writes a single model directly into its output directory, while
 * COLMAP's mapper writes numbered `0/`, `1/`, … subdirectories.
 */
async function normalizeGlomapOutput(glomapOutput: string, sparseDirectory: string) {
  const target = path.join(sparseDirectory, "0");
  const directModel = await fs
    .access(path.join(glomapOutput, "cameras.bin"))
    .then(() => true)
    .catch(() => false);
  const numberedModel = await fs
    .access(path.join(glomapOutput, "0", "cameras.bin"))
    .then(() => true)
    .catch(() => false);
  await fs.rm(sparseDirectory, { recursive: true, force: true });
  await fs.mkdir(sparseDirectory, { recursive: true });
  if (numberedModel) {
    await fs.rename(path.join(glomapOutput, "0"), target);
  } else if (directModel) {
    await fs.rename(glomapOutput, target);
    return;
  } else {
    throw new Error(
      "GLOMAP finished without writing a usable model (no cameras.bin in its output). The capture may lack connectable overlap.",
    );
  }
  await fs.rm(glomapOutput, { recursive: true, force: true });
}

/** Read the u64 record count at the head of `points3D.bin`, or count text rows. */
async function countSparsePoints(sparseDirectory: string): Promise<number> {
  const modelDirectory = path.join(sparseDirectory, "0");
  try {
    const handle = await fs.open(path.join(modelDirectory, "points3D.bin"), "r");
    try {
      const buffer = Buffer.alloc(8);
      const { bytesRead } = await handle.read(buffer, 0, 8, 0);
      if (bytesRead === 8) return Number(buffer.readBigUInt64LE(0));
    } finally {
      await handle.close();
    }
  } catch {
    // fall through to the text export
  }
  try {
    const text = await fs.readFile(path.join(modelDirectory, "points3D.txt"), "utf8");
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.startsWith("#")).length;
  } catch {
    return 0;
  }
}

/** Read `element vertex <n>` from a PLY header without loading the file. */
async function countPlyVertices(plyPath: string): Promise<number> {
  try {
    const handle = await fs.open(plyPath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
      const head = buffer.subarray(0, bytesRead).toString("latin1");
      const match = /element\s+vertex\s+(\d+)/i.exec(head);
      return match ? Number(match[1]) : 0;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

async function writeReportAtomically(file: string, report: ReconstructionReport) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(report, null, 2), "utf8");
  await fs.rename(temporary, file);
}

function runColmap(projectId: string, binaryPath: string, args: string[], job: ColmapJob) {
  return new Promise<void>((resolve, reject) => {
    const isBatchFile = path.extname(binaryPath).toLowerCase() === ".bat";
    const child = isBatchFile
      ? spawn(
          "cmd.exe",
          ["/d", "/c", `"${binaryPath}" ${args.map((value) => `"${value.replace(/"/g, '""')}"`).join(" ")}`],
          { windowsHide: true },
        )
      : spawn(binaryPath, args, { windowsHide: true });
    let set = activeChildren.get(projectId);
    if (!set) {
      set = new Set();
      activeChildren.set(projectId, set);
    }
    set.add(child);
    const cleanup = () => {
      set?.delete(child);
      if (set?.size === 0) activeChildren.delete(projectId);
    };
    const write = (chunk: Buffer) =>
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => addLog(job, line));
    child.stdout.on("data", write);
    child.stderr.on("data", write);
    child.on("error", (error) => {
      cleanup();
      if (cancelRequests.has(projectId)) reject(new JobCancelledError());
      else reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (cancelRequests.has(projectId)) {
        reject(new JobCancelledError());
        return;
      }
      code === 0 ? resolve() : reject(new Error(`COLMAP exited with code ${code ?? "unknown"}.`));
    });
  });
}

/** Run one COLMAP stage and record its wall-clock time. */
async function runStage(
  projectId: string,
  job: ColmapJob,
  stageTimes: Record<string, number>,
  name: string,
  binaryPath: string,
  args: string[],
) {
  if (cancelRequests.has(projectId)) throw new JobCancelledError();
  const started = Date.now();
  await runColmap(projectId, binaryPath, args, job);
  stageTimes[name] = Date.now() - started;
}

export function getColmapJob(projectId: string) {
  return jobs.get(projectId) ?? null;
}

/** Request a safe stop: the running COLMAP child is killed and the job is
 * marked cancelled at the next checkpoint. Finished stages keep their files.
 */
export function requestColmapCancel(projectId: string) {
  const job = jobs.get(projectId);
  if (!job || ["complete", "failed", "cancelled"].includes(job.phase)) return job ?? null;
  cancelRequests.add(projectId);
  job.phase = "cancelling";
  addLog(job, "Stop requested — finishing the current COLMAP call, then stopping safely.");
  const children = activeChildren.get(projectId);
  if (children) {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // Already exited; the close handler surfaces cancellation.
      }
    }
  }
  return job;
}

function clearColmapCancel(projectId: string) {
  cancelRequests.delete(projectId);
  activeChildren.delete(projectId);
}

export interface PoseReport {
  registeredImages: number | null;
  totalImages: number | null;
  meanReprojectionError: number | null;
  parsed: boolean;
}

/**
 * Parse `colmap model_analyzer` output defensively. If the format differs we
 * return nulls and mark `parsed: false` — never a fake zero that looks like a
 * measured result.
 */
async function analyzePoses(binaryPath: string, modelDirectory: string): Promise<PoseReport> {
  return new Promise<PoseReport>((resolve) => {
    const isBatchFile = path.extname(binaryPath).toLowerCase() === ".bat";
    const child = isBatchFile
      ? spawn("cmd.exe", ["/d", "/c", `"${binaryPath}" "model_analyzer" "--path" "${modelDirectory}"`], { windowsHide: true })
      : spawn(binaryPath, ["model_analyzer", "--path", modelDirectory], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const finish = () => {
      const registered = /Registered images:\s*(\d+)/i.exec(output);
      const images = /Images:\s*(\d+)/i.exec(output);
      const error = /Mean reprojection error:\s*([\d.]+)px/i.exec(output);
      const parsed = Boolean(registered && images);
      resolve({
        registeredImages: registered ? Number(registered[1]) : null,
        totalImages: images ? Number(images[1]) : null,
        meanReprojectionError: error ? Number(error[1]) : null,
        parsed,
      });
    };
    child.on("error", finish);
    child.on("close", finish);
  });
}

export async function startColmapJob(
  projectId: string,
  mode: ReconstructionMode,
  quality: Quality,
  mapper: MapperChoice = "auto",
) {
  const existing = jobs.get(projectId);
  if (existing && !["complete", "failed", "cancelled"].includes(existing.phase)) return existing;
  clearColmapCancel(projectId);

  const runtime = await resolveColmapRuntime();
  if (!runtime) throw new Error("The managed COLMAP engine is not ready yet.");
  const glomap = await resolveGlomapRuntime();
  // A GLOMAP binary alone is not enough: it must also read this COLMAP
  // build's database schema. The managed GLOMAP was probed and cannot open
  // managed-COLMAP databases, so it stays off unless a compatible build is
  // installed. Explicit "colmap" always uses incremental mapping.
  const glomapCompatible = glomap ? await isGlomapCompatible(runtime.path, glomap.path) : false;
  const useGlomap = mapper === "colmap" ? false : Boolean(glomap && glomapCompatible);
  if (mapper === "glomap" && !glomap) {
    throw new Error(
      "GLOMAP was requested but no glomap executable was found (checked GLOMAP_BINARY_PATH and <storage>/runtime/glomap).",
    );
  }
  if (mapper === "glomap" && !glomapCompatible) {
    throw new Error(
      "GLOMAP is installed but cannot read databases from this COLMAP build (SQLite schema mismatch, verified by an empty-database probe). Use COLMAP incremental mapping, or install a GLOMAP build matching this COLMAP version.",
    );
  }

  const projectDirectory = projectStorageDirectory(projectId);
  const imageDirectory = path.join(projectDirectory, "processed", "frames");
  const outputDirectory = path.join(projectDirectory, "reconstruction");
  const reportPath = path.join(outputDirectory, "report.json");

  // The manifest is the contract between preparation and reconstruction. Do not
  // infer structure from a filename string when the manifest says otherwise.
  const manifest = await readFramesManifest(projectId);
  if (!manifest || !manifest.frames || manifest.frames.length === 0) {
    throw new Error(
      "No frames manifest was found for this project. Re-run capture preparation so the accepted frames and their provenance are recorded before reconstructing.",
    );
  }

  // Validate that every manifest frame still exists and is readable.
  const missing: string[] = [];
  for (const frame of manifest.frames) {
    const file = path.join(imageDirectory, frame.filename);
    const ok = await fs.access(file).then(() => true).catch(() => false);
    if (!ok) missing.push(frame.filename);
  }
  const frameCount = manifest.frames.length - missing.length;
  if (frameCount < minimumFrameCount) {
    throw new Error(
      `Only ${frameCount} prepared images are available (minimum ${minimumFrameCount}). Return to capture preparation and increase coverage before starting COLMAP.`,
    );
  }

  const filesystem = await fs.statfs(projectDirectory);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredBytes = Math.max(10 * 1024 ** 3, frameCount * 35 * 1024 ** 2);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Not enough project storage. This reconstruction needs about ${gigabytes(requiredBytes)} GB free; ${gigabytes(availableBytes)} GB is available in the selected storage location.`,
    );
  }

  const job: ColmapJob = {
    phase: "queued",
    startedAt: new Date().toISOString(),
    warnings: [],
    logs: ["Reconstruction queued."],
  };
  jobs.set(projectId, job);

  void (async () => {
    const stageTimes: Record<string, number> = {};
    const warnings: string[] = [];
    const qualityNotes: string[] = [];
    const databasePath = path.join(outputDirectory, "database.db");
    const sparseDirectory = path.join(outputDirectory, "sparse");
    const denseDirectory = path.join(outputDirectory, "dense");
    let engineVersion: string | undefined;
    let sparsePointCount = 0;
    let densePointCount: number | null = null;
    let poseReport: PoseReport = { registeredImages: null, totalImages: null, meanReprojectionError: null, parsed: false };
    let verdict: Verdict = "FAIL";
    let failure: ReconstructionReport["failure"];

    const finalize = async () => {
      const totalImages = poseReport.totalImages ?? frameCount;
      const registered = poseReport.registeredImages ?? 0;
      const report: ReconstructionReport = {
        version: 1,
        projectId,
        engine: useGlomap ? "COLMAP features + GLOMAP global mapper" : "COLMAP (incremental)",
        engineVersion,
        engineSelectionEvidence: useGlomap
          ? [
              "Global SfM (GLOMAP) solved cameras and points from the COLMAP feature/match database.",
              `GLOMAP executable: ${glomap?.path} (${glomap?.managed ? "managed runtime" : "configured path"}).`,
              `COLMAP executable (features/matching/dense): ${runtime.path} (${runtime.managed ? "managed runtime" : "configured path"}).`,
            ]
          : [
              "COLMAP incremental mapping solved cameras and points.",
              `Executable: ${runtime.path} (${runtime.managed ? "managed runtime" : "configured path"}).`,
            ],
        intent: mode,
        verdict,
        gateSource: "fallback",
        inputFrames: frameCount,
        registeredImages: registered,
        unregisteredImages: Math.max(totalImages - registered, 0),
        registrationRatio: totalImages > 0 ? Number((registered / totalImages).toFixed(4)) : null,
        meanReprojectionErrorPx: poseReport.meanReprojectionError,
        sparsePointCount,
        densePointCount,
        artifacts: {
          sparse: sparsePointCount > 0 ? ["reconstruction", "sparse", "0"].join("/") : undefined,
          dense: densePointCount ? ["reconstruction", "dense", "fused.ply"].join("/") : undefined,
        },
        stageTimesMs: stageTimes,
        warnings,
        qualityNotes,
        failure,
        completedAt: new Date().toISOString(),
      };
      await writeReportAtomically(reportPath, report);
      job.verdict = verdict;
      job.warnings = warnings;
      job.reportPath = reportPath;
      if (verdict === "FAIL") {
        job.phase = "failed";
        job.error = failure?.message ?? "Reconstruction did not produce a usable artifact.";
        job.finishedAt = new Date().toISOString();
        addLog(job, job.error);
      } else {
        job.phase = "complete";
        job.finishedAt = new Date().toISOString();
        addLog(job, `Reconstruction ${verdict}. Sparse points ${sparsePointCount}${densePointCount !== null ? `, dense vertices ${densePointCount}` : ", dense not produced"}.`);
      }
    };

    try {
      await fs.rm(outputDirectory, { recursive: true, force: true });
      await fs.mkdir(sparseDirectory, { recursive: true });

      if (glomap && !glomapCompatible && mapper !== "colmap") {
        addLog(job, "GLOMAP binary is present but incompatible with this COLMAP database version — using incremental mapping.");
        qualityNotes.push(
          "GLOMAP was skipped: the installed build cannot read this COLMAP version's databases (verified by an empty-database probe at startup).",
        );
      }

      job.phase = "features";
      addLog(job, `Extracting features from ${frameCount} images.`);
      await runStage(projectId, job, stageTimes, "features", runtime.path, [
        "feature_extractor",
        "--database_path",
        databasePath,
        "--image_path",
        imageDirectory,
        "--ImageReader.single_camera",
        "1",
        await extractorSizeFlag(runtime.path),
        String(imageSizeByQuality[quality]),
      ]);

      job.phase = "matching";
      addLog(job, `Matching ${frameCount} frames sequentially (overlap 10, from the manifest order).`);
      qualityNotes.push(
        "Matching uses the preparation manifest order with a sequential overlap window; 360 projections are interleaved by view and timestamp.",
      );
      await runStage(projectId, job, stageTimes, "matching", runtime.path, [
        "sequential_matcher",
        "--database_path",
        databasePath,
        "--SequentialMatching.overlap",
        "10",
        "--SequentialMatching.loop_detection",
        "0",
        // Pinned: 3.12.0 resolves this default to 0 and aborts matching.
        "--SiftMatching.max_num_matches",
        "32768",
      ]);

      job.phase = "mapping";
      const mapperArgs = ["--database_path", databasePath, "--image_path", imageDirectory, "--output_path", sparseDirectory];
      if (useGlomap && glomap) {
        // GLOMAP's CLI is `glomap mapper` (there is no `global_mapper`
        // subcommand). It solves all cameras jointly — much faster than
        // incremental mapping on ordered captures — then writes the model.
        // Output lands directly in the output dir, so it is normalized to
        // `sparse/0` below for the shared downstream layout.
        addLog(job, `Solving camera layout globally with GLOMAP (${glomap.managed ? "managed runtime" : "configured path"}).`);
        qualityNotes.push(
          "Mapping used the GLOMAP global solver on the COLMAP feature/match database; features, matching, and dense stereo remain COLMAP.",
        );
        // GLOMAP writes the model into a fresh directory; keep it separate so
        // a failed/cancelled run cannot corrupt a previous sparse result.
        const glomapOutput = path.join(outputDirectory, "sparse-glomap");
        await fs.rm(glomapOutput, { recursive: true, force: true });
        await fs.mkdir(glomapOutput, { recursive: true });
        await runStage(projectId, job, stageTimes, "mapping", glomap.path, [
          "mapper",
          "--database_path",
          databasePath,
          "--image_path",
          imageDirectory,
          "--output_path",
          glomapOutput,
        ]);
        await normalizeGlomapOutput(glomapOutput, sparseDirectory);
      } else {
        if (mode === "environment") {
          addLog(
            job,
            glomap
              ? "Solving environment layout with incremental mapping (GLOMAP available — select it explicitly to use global mapping)."
              : "Solving environment layout with incremental mapping (no GLOMAP binary found under <storage>/runtime/glomap).",
          );
        } else {
          addLog(job, "Solving object camera layout with incremental mapping.");
        }
        await runStage(projectId, job, stageTimes, "mapping", runtime.path, ["mapper", ...mapperArgs]);
      }

      if (!(await hasSparsePointCloud(sparseDirectory))) {
        failure = {
          stage: "mapping",
          message:
            `${useGlomap ? "GLOMAP" : "COLMAP"} finished without a usable sparse point cloud. This usually means too little overlap between images or a bad initial pair.`,
          recoverable: true,
        };
        verdict = "FAIL";
        await finalize();
        return;
      }

      sparsePointCount = await countSparsePoints(sparseDirectory);
      poseReport = await analyzePoses(runtime.path, path.join(sparseDirectory, "0"));
      if (!poseReport.parsed) {
        addWarning(
          job,
          warnings,
          "The COLMAP pose metric could not be parsed on this build; registration ratios are unavailable for this run.",
        );
      }
      addLog(
        job,
        `Pose check: ${poseReport.registeredImages ?? "?"}/${poseReport.totalImages ?? frameCount} images registered` +
          (poseReport.meanReprojectionError !== null
            ? `, mean reprojection error ${poseReport.meanReprojectionError.toFixed(2)}px.`
            : "."),
      );

      const ratio =
        poseReport.parsed && poseReport.totalImages && poseReport.totalImages > 0
          ? (poseReport.registeredImages ?? 0) / poseReport.totalImages
          : null;

      if (sparsePointCount <= 0) {
        failure = { stage: "sparse", message: "The sparse model contains no points.", recoverable: true };
      } else if (sparsePointCount < MIN_SPARSE_POINTS) {
        failure = {
          stage: "sparse",
          message: `The sparse model contains only ${sparsePointCount} points — too little coherent geometry to reconstruct from. The capture likely lacks parallax or overlap; add coverage and re-run.`,
          recoverable: true,
        };
      } else if (ratio !== null && ratio < MIN_REGISTRATION_RATIO) {
        failure = {
          stage: "sparse",
          message: `Only ${poseReport.registeredImages}/${poseReport.totalImages} images registered (${(ratio * 100).toFixed(0)}%). The capture lacks connectable overlap; add coverage and re-run instead of building on broken poses.`,
          recoverable: true,
        };
      }

      if (failure) {
        verdict = "FAIL";
        await finalize();
        return;
      }

      if (ratio !== null && ratio < WARN_REGISTRATION_RATIO) {
        addWarning(
          job,
          warnings,
          `Registration is partial (${poseReport.registeredImages}/${poseReport.totalImages}). The sparse cloud is usable but may be incomplete.`,
        );
      }

      if (sparsePointCount < WARN_SPARSE_POINTS) {
        addWarning(
          job,
          warnings,
          `The sparse model has only ${sparsePointCount} points. It is above the failure floor, but the geometry is thin and the reconstruction will be sparse.`,
        );
      }

      // Dense is optional after a good sparse solve: a dense failure is a WARN
      // with the sparse artifact preserved, not deletion of the whole result.
      // Draft quality stops at the sparse model - dense stereo is by far the
      // slowest stage and the sparse cloud already proves whether the capture
      // reconstructs. Balanced and High also build the dense cloud.
      let denseWarning: string | null = null;
      if (quality === "draft") {
        addLog(
          job,
          "Draft quality: sparse model complete. Skipping dense stereo (choose Balanced or High for a dense point cloud).",
        );
        qualityNotes.push(
          "Draft quality stops at the sparse model; choose Balanced or High for a dense point cloud.",
        );
      } else {
        job.phase = "dense";
        try {
        addLog(job, "Undistorting images for dense reconstruction.");
        await runStage(projectId, job, stageTimes, "undistort", runtime.path, [
          "image_undistorter",
          "--image_path",
          imageDirectory,
          "--input_path",
          path.join(sparseDirectory, "0"),
          "--output_path",
          denseDirectory,
          "--output_type",
          "COLMAP",
        ]);
        addLog(job, "Running patch-match stereo (GPU when available, CPU otherwise).");
        await runStage(projectId, job, stageTimes, "patch_match", runtime.path, [
          "patch_match_stereo",
          "--workspace_path",
          denseDirectory,
          "--workspace_format",
          "COLMAP",
        ]);
        addLog(job, "Fusing depth maps into a dense point cloud.");
        const fusedPath = path.join(denseDirectory, "fused.ply");
        await runStage(projectId, job, stageTimes, "fusion", runtime.path, [
          "stereo_fusion",
          "--workspace_path",
          denseDirectory,
          "--workspace_format",
          "COLMAP",
          "--input_type",
          "geometric",
          "--output_path",
          fusedPath,
        ]);
        const vertices = await countPlyVertices(fusedPath);
        if (vertices > 0) {
          densePointCount = vertices;
          addLog(job, `Dense point cloud completed (${vertices} vertices).`);
        } else {
          denseWarning = "The dense point cloud file was written but contains no readable vertices.";
        }
      } catch (error) {
        // A dense-stage failure (including a safe stop during dense) must not
        // delete the good sparse result — record it as a warning.
        if (error instanceof JobCancelledError) throw error;
        denseWarning = `Dense reconstruction failed: ${error instanceof Error ? error.message : "stereo reconstruction failed."} The sparse point cloud was preserved and remains viewable.`;
      }
      }

      if (denseWarning) {
        addWarning(job, warnings, denseWarning);
      }

      verdict = warnings.length > 0 ? "WARN" : "PASS";
      if (verdict === "PASS") {
        qualityNotes.push("Sparse output is readable with an adequate registration ratio for this fixture.");
      }
      await finalize();
    } catch (error) {
      if (error instanceof JobCancelledError) {
        job.phase = "cancelled";
        job.finishedAt = new Date().toISOString();
        addLog(job, "Stopped safely. Finished stages were kept — restart to resume from scratch.");
        clearColmapCancel(projectId);
        return;
      }
      failure = {
        stage: job.phase === "queued" ? "preflight" : job.phase,
        message: error instanceof Error ? error.message : "COLMAP reconstruction failed.",
        recoverable: true,
      };
      verdict = "FAIL";
      try {
        await finalize();
      } catch (reportError) {
        job.phase = "failed";
        job.error = failure.message;
        job.finishedAt = new Date().toISOString();
        addLog(job, `Report write failed: ${reportError instanceof Error ? reportError.message : "unknown"}`);
      }
    }
  })();

  return job;
}

/**
 * Build the dense cloud from an already-solved sparse result, without wiping
 * anything. This is the "dense after sparse" path: the sparse model, the
 * match database, and the trained splat (if any) are all preserved. Only the
 * `dense/` directory is rewritten.
 */
export async function startDenseFollowup(projectId: string) {
  const existing = jobs.get(projectId);
  if (existing && !["complete", "failed", "cancelled"].includes(existing.phase)) return existing;
  clearColmapCancel(projectId);

  const runtime = await resolveColmapRuntime();
  if (!runtime) throw new Error("The managed COLMAP engine is not ready yet.");

  const projectDirectory = projectStorageDirectory(projectId);
  const imageDirectory = path.join(projectDirectory, "processed", "frames");
  const outputDirectory = path.join(projectDirectory, "reconstruction");
  const databasePath = path.join(outputDirectory, "database.db");
  const sparseDirectory = path.join(outputDirectory, "sparse");
  const denseDirectory = path.join(outputDirectory, "dense");
  const reportPath = path.join(outputDirectory, "report.json");

  if (!(await hasSparsePointCloud(sparseDirectory))) {
    throw new Error("No sparse cloud yet. Build the sparse cloud first — dense stereo refines it.");
  }
  if (!(await fs.access(databasePath).then(() => true).catch(() => false))) {
    throw new Error("The reconstruction database is missing. Re-run the sparse step to rebuild it.");
  }

  const job: ColmapJob = {
    phase: "queued",
    startedAt: new Date().toISOString(),
    warnings: [],
    logs: ["Dense follow-up queued. Sparse model and database will be reused; nothing is wiped."],
  };
  jobs.set(projectId, job);

  void (async () => {
    const stageTimes: Record<string, number> = {};
    try {
      job.phase = "dense";
      await fs.mkdir(denseDirectory, { recursive: true });
      addLog(job, "Undistorting images for dense reconstruction.");
      await runStage(projectId, job, stageTimes, "undistort", runtime.path, [
        "image_undistorter",
        "--image_path",
        imageDirectory,
        "--input_path",
        path.join(sparseDirectory, "0"),
        "--output_path",
        denseDirectory,
        "--output_type",
        "COLMAP",
      ]);
      addLog(job, "Running patch-match stereo (GPU when available, CPU otherwise).");
      await runStage(projectId, job, stageTimes, "patch_match", runtime.path, [
        "patch_match_stereo",
        "--workspace_path",
        denseDirectory,
        "--workspace_format",
        "COLMAP",
      ]);
      addLog(job, "Fusing depth maps into a dense point cloud.");
      const fusedPath = path.join(denseDirectory, "fused.ply");
      await runStage(projectId, job, stageTimes, "fusion", runtime.path, [
        "stereo_fusion",
        "--workspace_path",
        denseDirectory,
        "--workspace_format",
        "COLMAP",
        "--input_type",
        "geometric",
        "--output_path",
        fusedPath,
      ]);
      const vertices = await countPlyVertices(fusedPath);
      if (vertices <= 0) {
        throw new Error("The dense point cloud file was written but contains no readable vertices.");
      }
      // Patch the existing report so the dashboard picks up the dense
      // artifact; the sparse verdict and evidence stay untouched.
      const previous = await fs
        .readFile(reportPath, "utf8")
        .then((contents) => JSON.parse(contents) as ReconstructionReport)
        .catch(() => null);
      const sparsePointCount =
        previous?.sparsePointCount ?? (await countSparsePoints(sparseDirectory));
      const report: ReconstructionReport = previous
        ? {
            ...previous,
            densePointCount: vertices,
            artifacts: { ...previous.artifacts, dense: ["reconstruction", "dense", "fused.ply"].join("/") },
            stageTimesMs: { ...previous.stageTimesMs, ...stageTimes },
            qualityNotes: [
              ...previous.qualityNotes,
              "Dense cloud built in a follow-up run from the preserved sparse result.",
            ],
            completedAt: new Date().toISOString(),
          }
        : {
            version: 1,
            projectId,
            engine: "COLMAP (incremental)",
            engineSelectionEvidence: [
              `Dense follow-up on a preserved sparse result. Executable: ${runtime.path}.`,
            ],
            intent: "environment",
            verdict: "PASS",
            gateSource: "fallback",
            inputFrames: 0,
            registeredImages: 0,
            unregisteredImages: 0,
            registrationRatio: null,
            meanReprojectionErrorPx: null,
            sparsePointCount,
            densePointCount: vertices,
            artifacts: {
              sparse: ["reconstruction", "sparse", "0"].join("/"),
              dense: ["reconstruction", "dense", "fused.ply"].join("/"),
            },
            stageTimesMs: stageTimes,
            warnings: [],
            qualityNotes: ["Dense cloud built in a follow-up run from the preserved sparse result."],
            completedAt: new Date().toISOString(),
          };
      await writeReportAtomically(reportPath, report);
      job.verdict = report.verdict;
      job.warnings = report.warnings;
      job.reportPath = reportPath;
      job.phase = "complete";
      job.finishedAt = new Date().toISOString();
      addLog(job, `Dense point cloud completed (${vertices} vertices). Sparse result untouched.`);
      clearColmapCancel(projectId);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        job.phase = "cancelled";
        job.finishedAt = new Date().toISOString();
        addLog(job, "Dense follow-up stopped safely. The sparse cloud is untouched.");
        clearColmapCancel(projectId);
        return;
      }
      job.phase = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : "Dense follow-up failed.";
      addLog(job, `${job.error} The sparse cloud was preserved and remains viewable.`);
    }
  })();

  return job;
}
