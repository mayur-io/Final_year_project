"use client";

import {
  AlertTriangle,
  Box,
  Cpu,
  Download,
  Play,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useStagePanels } from "@/components/workspace/WorkspacePanels";
import PointCloudViewer from "@/components/stage/PointCloudViewer";
import SplatViewer from "@/components/stage/SplatViewer";

interface ReconstructionStageProps {
  projectId: string;
  frameCount: number;
}
type ReconstructionMode = "object" | "environment";
type ColmapJob = {
  phase: "queued" | "features" | "matching" | "mapping" | "dense" | "complete" | "failed" | "cancelled" | "cancelling";
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  error?: string;
};
type SplatJobState = {
  phase: "queued" | "training" | "bootstrapping" | "complete" | "failed" | "cancelled" | "cancelling";
  trained: boolean;
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  error?: string;
};
type ReconstructionStatus = {
  engines: {
    colmapAvailable: boolean;
    colmapManaged: boolean;
    glomapAvailable: boolean;
    glomapManaged: boolean;
    glomapCompatible: boolean;
    gaussianRuntimeAvailable: boolean;
    gaussianRuntimeMode: "train" | "bootstrap" | null;
  };
  environment?: {
    ffmpeg: boolean;
    ffprobe: boolean;
    colmap: boolean;
    python: boolean;
    numpy: boolean;
    gpu: string | null;
  };
  artifacts: {
    hasPointCloud: boolean;
    hasDense: boolean;
    hasSplat: boolean;
    splatTrained: boolean;
  };
  preparation: {
    verdict: "PASS" | "WARN" | "REJECT";
    reasons: string[];
    warnings: string[];
  } | null;
  report: {
    verdict: "PASS" | "WARN" | "FAIL";
    engine: string;
    engineVersion?: string;
    intent: string;
    registeredImages: number;
    unregisteredImages: number;
    registrationRatio: number | null;
    meanReprojectionErrorPx: number | null;
    sparsePointCount: number;
    densePointCount: number | null;
    warnings: string[];
    qualityNotes: string[];
    failure?: { stage: string; message: string; recoverable: boolean };
  } | null;
  job: ColmapJob | null;
  splatJob: SplatJobState | null;
};

const phaseTitle: Record<ColmapJob["phase"], string> = {
  queued: "Queued",
  features: "Feature extraction",
  matching: "Feature matching",
  mapping: "Camera reconstruction",
  dense: "Dense reconstruction",
  complete: "Sparse cloud ready",
  failed: "Needs attention",
  cancelled: "Stopped safely",
  cancelling: "Stopping…",
};

/** Single progress readout, shown in the controls column under the actions. */
const phaseProgress: Record<ColmapJob["phase"], number> = {
  queued: 2,
  features: 22,
  matching: 44,
  mapping: 66,
  dense: 86,
  complete: 100,
  failed: 0,
  cancelled: 0,
  cancelling: 50,
};

function elapsed(startedAt?: string, now = Date.now()) {
  if (!startedAt) return "0:00";
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(startedAt).getTime()) / 1000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function ReconstructionStage({
  projectId,
  frameCount,
}: ReconstructionStageProps) {
  const [mode, setMode] = useState<ReconstructionMode>("environment");
  // Two build targets only: a fast sparse cloud, or sparse + dense in one run.
  // Dense can also be added later without wiping anything (build-dense).
  const [buildTarget, setBuildTarget] = useState<"sparse" | "dense">("sparse");
  // Solver choice. GLOMAP is preselected: the startup probe enables this
  // button only when the installed build can actually read our databases.
  const [mapper, setMapper] = useState<"glomap" | "colmap">("glomap");
  const [status, setStatus] = useState<ReconstructionStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [splatStarting, setSplatStarting] = useState(false);
  const [splatInstalling, setSplatInstalling] = useState(false);
  const [stoppingColmap, setStoppingColmap] = useState(false);
  const [stoppingSplat, setStoppingSplat] = useState(false);
  const [buildingDense, setBuildingDense] = useState(false);
  // Center viewer toggle: point cloud vs trained Gaussian model.
  const [viewTab, setViewTab] = useState<"cloud" | "splat">("cloud");
  const [viewAutoPicked, setViewAutoPicked] = useState(false);
  // Open on the trained model when one exists; the user can toggle back.
  useEffect(() => {
    if (viewAutoPicked || !status) return;
    setViewTab(status.artifacts.hasSplat ? "splat" : "cloud");
    setViewAutoPicked(true);
  }, [status, viewAutoPicked]);
  const [cloudSource, setCloudSource] = useState<"sparse" | "dense">("sparse");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const refreshStatus = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/reconstruction`);
    if (response.ok) setStatus((await response.json()) as ReconstructionStatus);
  }, [projectId]);
  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      void refreshStatus();
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  async function request(action: "reconstruct" | "build-dense" | "install-engine" | "install-splat" | "build-splat" | "cancel-reconstruction" | "cancel-splat") {
    const response = await fetch(`/api/projects/${projectId}/reconstruction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // "dense" target runs the full pipeline at balanced resolution.
      body: JSON.stringify(
        action === "reconstruct"
          ? { action, mode, quality: buildTarget === "dense" ? "balanced" : "draft", mapper }
          : { action },
      ),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok)
      throw new Error(result.error ?? "Reconstruction request failed.");
  }
  async function start() {
    setStarting(true);
    setError(null);
    try {
      await request("reconstruct");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Reconstruction could not start.",
      );
    } finally {
      setStarting(false);
      await refreshStatus();
    }
  }
  async function setupEngine() {
    setInstalling(true);
    setError(null);
    try {
      await request("install-engine");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Managed COLMAP setup failed.",
      );
    } finally {
      setInstalling(false);
      await refreshStatus();
    }
  }

  const colmapReady = status?.engines.colmapAvailable ?? false;
  const splatReady = status?.engines.gaussianRuntimeAvailable ?? false;
  const splatMode = status?.engines.gaussianRuntimeMode ?? null;
  const splatTrained = status?.artifacts.splatTrained ?? false;
  const environment = status?.environment;
  const missingTools = environment
    ? [
        !environment.ffmpeg && "ffmpeg",
        !environment.ffprobe && "ffprobe",
        !environment.colmap && "COLMAP",
        !environment.python && "Python",
        !environment.numpy && "numpy",
      ].filter((item): item is string => typeof item === "string")
    : [];
  const environmentOk = Boolean(environment) && missingTools.length === 0;
  const job = status?.job;
  const splatJob = status?.splatJob;
  const preparation = status?.preparation ?? null;
  const report = status?.report ?? null;
  const preparationBlocked = preparation?.verdict === "REJECT";
  const jobActive = job ? !["complete", "failed", "cancelled"].includes(job.phase) : false;
  const splatActive = splatJob ? !["complete", "failed", "cancelled"].includes(splatJob.phase) : false;
  const jobCancellable = job ? ["queued", "features", "matching", "mapping", "dense"].includes(job.phase) : false;
  const splatCancellable = splatJob ? ["queued", "training", "bootstrapping"].includes(splatJob.phase) : false;
  const progress = job ? phaseProgress[job.phase] : 0;

  async function buildSplat() {
    setSplatStarting(true);
    setError(null);
    try {
      await request("build-splat");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Splat build could not start.");
    } finally {
      setSplatStarting(false);
      await refreshStatus();
    }
  }
  async function setupSplat() {
    setSplatInstalling(true);
    setError(null);
    try {
      await request("install-splat");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Splat setup failed.");
    } finally {
      setSplatInstalling(false);
      await refreshStatus();
    }
  }
  async function stopColmap() {
    setStoppingColmap(true);
    setError(null);
    try {
      await request("cancel-reconstruction");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not stop reconstruction.");
    } finally {
      setStoppingColmap(false);
      await refreshStatus();
    }
  }
  async function stopSplat() {
    setStoppingSplat(true);
    setError(null);
    try {
      await request("cancel-splat");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not stop Gaussian training.");
    } finally {
      setStoppingSplat(false);
      await refreshStatus();
    }
  }
  async function buildDense() {
    setBuildingDense(true);
    setError(null);
    try {
      await request("build-dense");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dense follow-up could not start.");
    } finally {
      setBuildingDense(false);
      await refreshStatus();
    }
  }
  const panels = useMemo(
    () => ({
      left: (
        <div className="space-y-6">
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Reconstruction mode
            </p>
            <div className="mt-3 grid grid-cols-2 gap-1">
              {(["object", "environment"] as ReconstructionMode[]).map(
                (item) => (
                  <button
                    key={item}
                    type="button"
                    disabled={jobActive}
                    onClick={() => setMode(item)}
                    className={`border px-2 py-2 text-xs capitalize disabled:opacity-50 ${mode === item ? "border-zinc-300 bg-zinc-200 text-black" : "border-zinc-700 text-zinc-400"}`}
                  >
                    {item}
                  </button>
                ),
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              Incremental mapping with a pose-quality gate: under 45% registered images fails fast instead of building on broken poses.
            </p>
          </section>
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Point cloud
            </p>
            <div className="mt-3 grid gap-1">
              {(["sparse", "dense"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  disabled={jobActive}
                  onClick={() => setBuildTarget(item)}
                  className={`border px-2 py-2 text-left text-xs capitalize disabled:opacity-50 ${buildTarget === item ? "border-zinc-300 bg-zinc-200 text-black" : "border-zinc-700 text-zinc-400"}`}
                >
                  <span className="block capitalize">{item === "sparse" ? "Sparse cloud" : "Dense cloud"}</span>
                  <span className="mt-0.5 block text-[11px] opacity-70">
                    {item === "sparse" ? "Fastest · enough for training" : "Sparse + dense · slowest"}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              Dense can also be added afterwards without wiping the sparse result.
            </p>
          </section>
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Camera solver
            </p>
            <div className="mt-3 grid gap-1">
              {(["glomap", "colmap"] as const).map((item) => {
                const usable = item === "colmap" || Boolean(status?.engines.glomapCompatible);
                return (
                  <button
                    key={item}
                    type="button"
                    disabled={jobActive || !usable}
                    onClick={() => setMapper(item)}
                    title={
                      usable
                        ? undefined
                        : "GLOMAP needs a COLMAP build whose databases it can read — install a matching pair to enable it"
                    }
                    className={`border px-2 py-2 text-left text-xs capitalize disabled:opacity-50 ${mapper === item ? "border-zinc-300 bg-zinc-200 text-black" : "border-zinc-700 text-zinc-400"}`}
                  >
                    <span className="block capitalize">
                      {item === "glomap" ? "GLOMAP global" : "COLMAP incremental"}
                      {item === "glomap" && usable ? " · recommended" : ""}
                    </span>
                    <span className="mt-0.5 block text-[11px] opacity-70">
                      {item === "glomap"
                        ? usable
                          ? "Joint global solve · seconds, not minutes"
                          : "Unavailable — no compatible build"
                        : "Proven fallback · slower on long sequences"}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          {!colmapReady ? (
            <button
              type="button"
              onClick={() => void setupEngine()}
              disabled={installing}
              className="flex w-full items-center justify-center gap-2 bg-zinc-100 px-3 py-2.5 text-sm font-medium text-black disabled:opacity-50"
            >
              {installing ? (
                <Cpu className="h-4 w-4 animate-pulse" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {installing ? "Setting up COLMAP…" : "Set up managed COLMAP"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || jobActive || preparationBlocked}
              className="flex w-full items-center justify-center gap-2 bg-zinc-100 px-3 py-2.5 text-sm font-medium text-black disabled:opacity-50"
            >
              {starting || jobActive ? (
                <Cpu className="h-4 w-4 animate-pulse" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {preparationBlocked
                ? "Blocked by preparation"
                : jobActive
                  ? "Reconstruction running"
                  : job?.phase === "failed"
                    ? `Retry ${buildTarget} cloud`
                    : job?.phase === "cancelled"
                      ? "Restart after safe stop"
                      : buildTarget === "dense"
                        ? "Build sparse + dense clouds"
                        : "Build sparse cloud"}
            </button>
          )}
          {jobCancellable ? (
            <button
              type="button"
              onClick={() => void stopColmap()}
              disabled={stoppingColmap}
              className="flex w-full items-center justify-center gap-2 border border-amber-700 px-3 py-2 text-xs text-amber-200 disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" />
              {stoppingColmap ? "Stopping…" : "Stop safely (keeps finished stages)"}
            </button>
          ) : null}
          {colmapReady && status?.artifacts.hasPointCloud && !status?.artifacts.hasDense && !jobActive ? (
            <button
              type="button"
              onClick={() => void buildDense()}
              disabled={buildingDense || preparationBlocked}
              title="Adds the dense cloud from the existing sparse result — nothing is wiped"
              className="flex w-full items-center justify-center gap-2 border border-zinc-600 px-3 py-2 text-xs text-zinc-200 disabled:opacity-50"
            >
              <Box className="h-3.5 w-3.5" />
              {buildingDense ? "Building dense…" : "Add dense cloud (keeps sparse)"}
            </button>
          ) : null}
          {status?.artifacts.hasSplat ? (
            <p className="text-xs leading-5 text-zinc-500">
              Re-running reconstruction clears the clouds and the trained model file — retrain afterwards.
            </p>
          ) : null}
          {(job || splatJob) && (
            <section className="border-t border-zinc-800 pt-4">
              <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
                Progress
              </p>
              {job ? (
                <div className="mt-3">
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-zinc-200">{phaseTitle[job.phase]}</span>
                    <span className="font-mono text-zinc-400">{progress}%</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden bg-zinc-800">
                    <div
                      className={`h-full transition-all duration-500 ${job.phase === "failed" ? "bg-rose-400" : job.phase === "complete" ? "bg-emerald-400" : "bg-sky-300"}`}
                      style={{ width: `${Math.max(2, progress)}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {splatJob ? (
                <p className="mt-2 text-xs text-zinc-400">
                  Gaussian model: <span className="font-mono">{splatJob.phase}</span>
                </p>
              ) : null}
            </section>
          )}
          {preparationBlocked ? (
            <p className="border border-rose-900 bg-rose-950/30 p-2 text-xs text-rose-200">
              Preparation was rejected, so reconstruction will not start.{" "}
              {preparation?.reasons.join(" ")}
            </p>
          ) : null}
          {error ? (
            <p className="border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-200">
              {error}
            </p>
          ) : null}
        </div>
      ),
      right: (
        <div className="space-y-6">
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Preflight
            </p>
            <dl className="mt-3 space-y-2 text-xs text-zinc-400">
              <div className="flex justify-between">
                <dt>Prepared frames</dt>
                <dd>{frameCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Elapsed</dt>
                <dd>{job ? elapsed(job.startedAt, now) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Local tools</dt>
                <dd className={environmentOk ? "text-emerald-300" : "text-amber-300"}>
                  {environment ? (environmentOk ? "Ready" : "Missing pieces") : "Checking…"}
                </dd>
              </div>
              {environment && !environmentOk ? (
                <div className="text-[11px] leading-4 text-amber-200/90">
                  Missing: {missingTools.join(", ")}. Fix this before starting — otherwise the job fails minutes in.
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt>GPU</dt>
                <dd>{environment?.gpu ?? "none detected"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>COLMAP</dt>
                <dd
                  className={
                    colmapReady ? "text-emerald-300" : "text-amber-300"
                  }
                >
                  {colmapReady
                    ? status?.engines.colmapManaged
                      ? "Managed"
                      : "Ready"
                    : "Not set up"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt>GLOMAP</dt>
                <dd
                  className={
                    status?.engines.glomapAvailable && status?.engines.glomapCompatible ? "text-emerald-300" : "text-zinc-500"
                  }
                >
                  {!status?.engines.glomapAvailable
                    ? "Not installed"
                    : status.engines.glomapCompatible
                      ? status.engines.glomapManaged
                        ? "Managed"
                        : "Ready"
                      : "Incompatible"}
                </dd>
              </div>
            </dl>
          </section>
          {job || splatJob ? (
            <section className="border-y border-zinc-800 py-4">
              <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
                Live engine stream
              </p>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border border-zinc-800 bg-black/30 p-2 font-mono text-[10px] leading-4 text-zinc-400">
                {[
                  ...(job ? [`── reconstruction (${phaseTitle[job.phase]}) ──`, ...job.logs.slice(-14)] : []),
                  ...(splatJob ? [`── gaussian model (${splatJob.phase}) ──`, ...splatJob.logs.slice(-10)] : []),
                ].join("\n")}
              </pre>
            </section>
          ) : null}
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Artifacts
            </p>
            <p className="mt-2 text-sm text-zinc-400">
              {status?.artifacts.hasPointCloud
                ? "Sparse point cloud available."
                : "No point cloud yet."}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              {status?.artifacts.hasDense
                ? "Dense point cloud available."
                : "No dense cloud yet (pick the dense target, or add it afterwards)."}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              {status?.artifacts.hasSplat
                ? status?.artifacts.splatTrained
                  ? "Trained 3D Gaussian model available (real gsplat optimizer)."
                  : "Gaussian initialization preview available (not a trained 3DGS model)."
                : "No Gaussian model yet."}
            </p>
          </section>
          {report ? (
            <section className="border-t border-zinc-800 pt-4">
              <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
                Latest reconstruction result
              </p>
              <p className={`mt-2 text-sm font-medium ${report.verdict === "FAIL" ? "text-rose-300" : report.verdict === "WARN" ? "text-amber-300" : "text-emerald-300"}`}>
                {report.verdict} · {report.engine}
                {report.engineVersion ? ` ${report.engineVersion}` : ""}
              </p>
              <dl className="mt-3 space-y-2 text-xs text-zinc-400">
                <div className="flex justify-between">
                  <dt>Registered images</dt>
                  <dd className="font-mono">
                    {report.registeredImages}/
                    {report.registeredImages + report.unregisteredImages}
                    {report.registrationRatio != null
                      ? ` (${(report.registrationRatio * 100).toFixed(0)}%)`
                      : ""}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Mean reprojection error</dt>
                  <dd className="font-mono">
                    {report.meanReprojectionErrorPx != null
                      ? `${report.meanReprojectionErrorPx.toFixed(2)} px`
                      : "unavailable"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Sparse points</dt>
                  <dd className="font-mono">{report.sparsePointCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Dense vertices</dt>
                  <dd className="font-mono">{report.densePointCount ?? "not produced"}</dd>
                </div>
              </dl>
              {report.failure ? (
                <p className="mt-3 text-xs leading-5 text-rose-200">{report.failure.message}</p>
              ) : null}
              {report.warnings.map((warning) => (
                <p key={warning} className="mt-2 text-xs leading-5 text-amber-200">
                  {warning}
                </p>
              ))}
            </section>
          ) : null}
          <section className="border-t border-zinc-800 pt-4">
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              {splatMode === "train"
                ? "Trained Gaussian model"
                : "Gaussian initialization preview"}
            </p>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              {splatMode === "train"
                ? "A real Gaussian Splatting optimizer (gsplat on CUDA) is installed. Training initializes one Gaussian per sparse point and minimizes an L1 + SSIM photometric loss against the captured frames with Adam."
                : "No trained 3D Gaussian Splatting optimizer is installed here. This builds an initialization-only preview: reconstruction points with fixed Gaussian parameters and no training loop."}
            </p>
            {!splatReady ? (
              <button type="button" onClick={() => void setupSplat()} disabled={splatInstalling} className="mt-3 w-full border border-zinc-700 p-2 text-xs text-zinc-300 disabled:opacity-50">
                {splatInstalling ? "Setting up preview runtime…" : "Set up preview runtime (Python + numpy)"}
              </button>
            ) : (
              <button type="button" onClick={() => void buildSplat()} disabled={splatStarting || splatActive || !status?.artifacts.hasPointCloud} title={!status?.artifacts.hasPointCloud ? "Run reconstruction first" : undefined} className="mt-3 w-full bg-zinc-100 p-2 text-xs font-medium text-black disabled:opacity-50">
                {splatActive
                  ? splatMode === "train"
                    ? "Training model…"
                    : "Building preview…"
                  : splatJob?.phase === "failed" || splatJob?.phase === "cancelled"
                    ? "Retry Gaussian model"
                    : splatMode === "train"
                      ? "Train Gaussian model"
                      : "Build Gaussian initialization preview"}
              </button>
            )}
            {splatCancellable ? (
              <button type="button" onClick={() => void stopSplat()} disabled={stoppingSplat} className="mt-2 w-full border border-amber-700 p-2 text-xs text-amber-200 disabled:opacity-50">
                {stoppingSplat ? "Stopping…" : "Stop training safely"}
              </button>
            ) : null}
            {splatJob?.error ? <p className="mt-2 text-xs text-rose-300">{splatJob.error}</p> : null}
          </section>
        </div>
      ),
    }),
    [
      buildTarget,
      buildingDense,
      colmapReady,
      environment,
      environmentOk,
      error,
      frameCount,
      installing,
      job,
      jobActive,
      jobCancellable,
      mapper,
      missingTools,
      mode,
      now,
      preparation,
      preparationBlocked,
      report,
      splatActive,
      splatCancellable,
      splatInstalling,
      splatJob,
      splatMode,
      splatReady,
      splatStarting,
      splatTrained,
      starting,
      stoppingColmap,
      stoppingSplat,
      status?.artifacts.hasDense,
      status?.artifacts.hasPointCloud,
      status?.artifacts.hasSplat,
      status?.artifacts.splatTrained,
      status?.engines.colmapManaged,
      status?.engines.glomapAvailable,
    ],
  );
  useStagePanels(panels);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0b0b0e] text-zinc-100">
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
          <div className="flex gap-1">
            {(["cloud", "splat"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setViewTab(tab)}
                className={`border px-3 py-1 text-[11px] uppercase tracking-[.16em] ${viewTab === tab ? "border-zinc-200 bg-zinc-200 text-black" : "border-zinc-700 text-zinc-500"}`}
              >
                {tab === "cloud" ? "Point cloud" : splatTrained ? "Trained Gaussians" : "Gaussian preview"}
              </button>
            ))}
          </div>
          {viewTab === "cloud" && status?.artifacts.hasDense ? (
            <div className="flex gap-1">
              {(["sparse", "dense"] as const).map((source) => (
                <button key={source} type="button" onClick={() => setCloudSource(source)} className={`border px-2 py-1 text-[10px] uppercase tracking-[.16em] ${cloudSource === source ? "border-zinc-200 text-zinc-100" : "border-zinc-700 text-zinc-500"}`}>
                  {source}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-[10px] uppercase tracking-[.16em] text-zinc-500">
              {viewTab === "splat"
                ? splatJob && splatActive ? splatJob.phase : splatTrained ? "trained" : "interactive"
                : "3D preview"}
            </span>
          )}
        </div>
        {job?.error ? (
          <p className="flex gap-2 border-b border-rose-900 bg-rose-950/20 px-3 py-2 text-xs leading-5 text-rose-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {job.error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          {viewTab === "cloud" ? (
            status?.artifacts.hasPointCloud || job?.phase === "complete" ? (
              <PointCloudViewer projectId={projectId} source={cloudSource} className="h-full" />
            ) : (
              <div className="grid h-full place-items-center text-sm text-zinc-400">
                No point cloud yet — build the sparse cloud to unlock this view.
              </div>
            )
          ) : status?.artifacts.hasSplat ? (
            <SplatViewer projectId={projectId} trained={splatTrained} className="h-full" />
          ) : (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-zinc-400">
              {splatActive
                ? splatMode === "train" ? "Training model… watch the live stream on the right." : "Building splat…"
                : splatJob?.error ?? "No Gaussian model yet — train one from the panel on the right."}
            </div>
          )}
        </div>
      </main>
    </section>
  );
}
