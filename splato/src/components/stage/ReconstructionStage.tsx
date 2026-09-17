"use client";

import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Clock3,
  Cpu,
  Download,
  Gauge,
  Play,
  ScanLine,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useStagePanels } from "@/components/workspace/WorkspacePanels";
import PointCloudViewer from "@/components/stage/PointCloudViewer";

interface ReconstructionStageProps {
  projectId: string;
  frameCount: number;
}
type ReconstructionMode = "object" | "environment";
type Quality = "draft" | "balanced" | "high";
type ColmapJob = {
  phase: "queued" | "features" | "matching" | "mapping" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  error?: string;
};
type ReconstructionStatus = {
  engines: {
    colmapAvailable: boolean;
    colmapManaged: boolean;
    gaussianRuntimeAvailable: boolean;
  };
  artifacts: { hasPointCloud: boolean; hasSplat: boolean };
  job: ColmapJob | null;
};

const progressForPhase: Record<ColmapJob["phase"], number> = {
  queued: 2,
  features: 28,
  matching: 58,
  mapping: 84,
  complete: 100,
  failed: 0,
};
const phaseTitle: Record<ColmapJob["phase"], string> = {
  queued: "Queued",
  features: "Feature extraction",
  matching: "Feature matching",
  mapping: "Camera reconstruction",
  complete: "Sparse cloud ready",
  failed: "Needs attention",
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
  const [quality, setQuality] = useState<Quality>("balanced");
  const [status, setStatus] = useState<ReconstructionStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [installing, setInstalling] = useState(false);
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

  async function request(action: "reconstruct" | "install-engine") {
    const response = await fetch(`/api/projects/${projectId}/reconstruction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        action === "reconstruct" ? { action, mode, quality } : { action },
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
  const job = status?.job;
  const jobActive = job ? !["complete", "failed"].includes(job.phase) : false;
  const progress = job ? progressForPhase[job.phase] : 0;
  const estimatedMinutes = Math.max(
    2,
    Math.ceil(
      frameCount /
        (quality === "draft" ? 90 : quality === "balanced" ? 45 : 25),
    ),
  );
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
                    className={`border px-2 py-2 text-xs capitalize disabled:opacity-40 ${mode === item ? "border-zinc-300 bg-zinc-200 text-black" : "border-zinc-700 text-zinc-400"}`}
                  >
                    {item}
                  </button>
                ),
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              Environment first tries global mapping, then safely falls back to
              incremental mapping when calibration is unreliable.
            </p>
          </section>
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Quality budget
            </p>
            <div className="mt-3 grid gap-1">
              {(["draft", "balanced", "high"] as Quality[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  disabled={jobActive}
                  onClick={() => setQuality(item)}
                  className={`border px-2 py-2 text-left text-xs capitalize disabled:opacity-40 ${quality === item ? "border-zinc-300 bg-zinc-200 text-black" : "border-zinc-700 text-zinc-400"}`}
                >
                  {item}
                </button>
              ))}
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
              disabled={starting || jobActive}
              className="flex w-full items-center justify-center gap-2 bg-zinc-100 px-3 py-2.5 text-sm font-medium text-black disabled:opacity-50"
            >
              {starting || jobActive ? (
                <Cpu className="h-4 w-4 animate-pulse" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {jobActive
                ? "Reconstruction running"
                : job?.phase === "failed"
                  ? "Retry sparse point cloud"
                  : "Build sparse point cloud"}
            </button>
          )}
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
                <dt>Est. solve</dt>
                <dd>~{estimatedMinutes} min</dd>
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
                <dt>Elapsed</dt>
                <dd>{elapsed(job?.startedAt, now)}</dd>
              </div>
            </dl>
          </section>
          {job ? (
            <section className="border-y border-zinc-800 py-4">
              <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
                Live COLMAP
              </p>
              <p
                className={`mt-2 text-sm ${job.phase === "failed" ? "text-rose-300" : job.phase === "complete" ? "text-emerald-300" : "text-sky-300"}`}
              >
                {phaseTitle[job.phase]}
              </p>
              <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-zinc-800 bg-black/30 p-2 font-mono text-[10px] leading-4 text-zinc-400">
                {job.logs.slice(-14).join("\n")}
              </p>
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
              {status?.artifacts.hasSplat
                ? "Gaussian Splat available."
                : "No Gaussian Splat yet."}
            </p>
          </section>
        </div>
      ),
    }),
    [
      colmapReady,
      error,
      estimatedMinutes,
      frameCount,
      installing,
      job,
      jobActive,
      mode,
      now,
      quality,
      starting,
      status?.artifacts.hasPointCloud,
      status?.artifacts.hasSplat,
      status?.engines.colmapManaged,
    ],
  );
  useStagePanels(panels);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0b0b0e] text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
            Reconstruction workspace
          </p>
          <h1 className="mt-1 text-lg font-medium">
            Point cloud → Gaussian Splat
          </h1>
        </div>
        <span className="text-xs text-zinc-500">
          {frameCount} prepared frames
        </span>
      </header>
      <main className="grid min-h-0 flex-1 place-items-center overflow-auto p-8">
        <div className="grid w-full max-w-3xl gap-5">
          <section className="border border-zinc-800 bg-[#101014] p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`grid h-10 w-10 place-items-center rounded-full border border-zinc-700 ${jobActive ? "bg-sky-950/40" : "bg-zinc-900"}`}
                >
                  <ScanLine
                    className={`h-5 w-5 ${jobActive ? "animate-pulse text-sky-200" : "text-zinc-300"}`}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {job ? phaseTitle[job.phase] : "Ready to reconstruct"}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {job
                      ? `${elapsed(job.startedAt, now)} elapsed`
                      : "Configure quality and launch when ready."}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono text-2xl text-zinc-100">{progress}%</p>
                <p className="text-[10px] uppercase tracking-[.16em] text-zinc-500">
                  real task state
                </p>
              </div>
            </div>
            <div className="mt-5 h-2 overflow-hidden bg-zinc-800">
              <div
                className={`h-full transition-all duration-700 ${job?.phase === "failed" ? "bg-rose-400" : job?.phase === "complete" ? "bg-emerald-400" : "bg-sky-300"}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            {job?.error ? (
              <p className="mt-3 flex gap-2 text-xs leading-5 text-rose-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {job.error}
              </p>
            ) : null}
          </section>
          <div className="grid gap-3 md:grid-cols-3">
            <article
              className={`border p-4 ${job && progress >= 28 ? "border-sky-700 bg-sky-950/20" : "border-zinc-800"}`}
            >
              <Gauge className="mb-3 h-4 w-4 text-zinc-300" />
              <p className="text-sm">Image features</p>
              <p className="mt-1 text-xs text-zinc-500">
                SIFT features are extracted from each accepted frame.
              </p>
            </article>
            <article
              className={`border p-4 ${job && progress >= 58 ? "border-sky-700 bg-sky-950/20" : "border-zinc-800"}`}
            >
              <Box className="mb-3 h-4 w-4 text-zinc-300" />
              <p className="text-sm">Camera graph</p>
              <p className="mt-1 text-xs text-zinc-500">
                Shared features become camera relationships and tracks.
              </p>
            </article>
            <article
              className={`border p-4 ${job && progress >= 84 ? "border-sky-700 bg-sky-950/20" : "border-zinc-800"}`}
            >
              <Sparkles className="mb-3 h-4 w-4 text-zinc-300" />
              <p className="text-sm">Sparse cloud</p>
              <p className="mt-1 text-xs text-zinc-500">
                Solved cameras generate the first real 3D points.
              </p>
            </article>
          </div>
          {(status?.artifacts.hasPointCloud || job?.phase === "complete") && (
            <section className="overflow-hidden border border-zinc-800 bg-[#101014]">
              <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[.16em] text-zinc-400">
                  <Sparkles className="h-3.5 w-3.5" />
                  Sparse point cloud
                </div>
                <span className="text-[10px] uppercase tracking-[.16em] text-zinc-500">
                  3D preview
                </span>
              </div>
              <div className="min-h-[420px]">
                <PointCloudViewer projectId={projectId} />
              </div>
            </section>
          )}
          {job ? (
            <section className="overflow-hidden border border-zinc-800 bg-black/30">
              <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
                <Terminal className="h-3.5 w-3.5" />
                Live engine stream
              </div>
              <pre className="max-h-56 overflow-auto p-3 text-[11px] leading-5 text-zinc-400">
                {job.logs.join("\n")}
              </pre>
            </section>
          ) : (
            <p className="flex items-center justify-center gap-2 text-xs text-zinc-500">
              <Clock3 className="h-3.5 w-3.5" />
              The live engine stream appears as soon as reconstruction begins.
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 text-left text-xs">
            <div className="border border-zinc-800 p-3">
              <Box className="mb-3 h-4 w-4 text-zinc-300" />
              Sparse cloud
            </div>
            <div className="border border-zinc-800 p-3">
              <Sparkles className="mb-3 h-4 w-4 text-zinc-300" />
              Gaussian Splat
            </div>
            <div className="border border-zinc-800 p-3">
              <CheckCircle2 className="mb-3 h-4 w-4 text-zinc-300" />
              Inspection
            </div>
          </div>
        </div>
      </main>
    </section>
  );
}
