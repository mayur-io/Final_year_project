"use client";

import { Activity, FolderKanban, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import OriginalStage from "../stage/UploadStage";
import { useWorkspacePanels, WorkspacePanelsProvider } from "./WorkspacePanels";

export type ProjectStage =
  | "original"
  | "preprocessing"
  | "reconstruction"
  | "viewer"
  | "export";

interface ProjectWorkspaceProps {
  projectId: string;
  projectName: string;
}

type ProcessJob = { state: "queued" | "running" | "cancelling" | "cancelled" | "complete" | "failed"; phase: string; progress: number; current?: string; completed: number; total: number; logs: string[]; error?: string };

function WorkspaceFrame({ projectId, projectName }: ProjectWorkspaceProps) {
  const [workspaceState, setWorkspaceState] = useState("Source capture");
  const [job, setJob] = useState<ProcessJob | null>(null);
  const { panels } = useWorkspacePanels();

  const refreshJob = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/process`);
    if (response.ok) setJob((await response.json() as { job: ProcessJob | null }).job);
  }, [projectId]);

  useEffect(() => { void refreshJob(); const timer = window.setInterval(() => void refreshJob(), 900); return () => window.clearInterval(timer); }, [refreshJob]);
  const active = job && ["queued", "running", "cancelling"].includes(job.state);
  const recoverable = job && ["cancelled", "failed"].includes(job.state);
  async function jobAction(action: "cancel" | "resume") { await fetch(`/api/projects/${projectId}/process`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); await refreshJob(); }

  return (
    <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[#0a0a0c] text-zinc-100">
      <header className="border-b border-zinc-800 bg-[#111114] px-5 py-3">
        <div className="flex items-center justify-between"><p className="truncate text-sm font-medium text-zinc-100">{projectName}</p><p className="text-xs text-zinc-400">{workspaceState}</p></div>
        {job && job.state !== "complete" ? <div className={`mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border px-3 py-2 ${job.state === "failed" ? "border-rose-900 bg-rose-950/20" : job.state === "cancelled" ? "border-amber-900 bg-amber-950/20" : "border-sky-900 bg-sky-950/20"}`}><div className="min-w-0"><div className="flex justify-between gap-3 text-xs"><span className="truncate text-zinc-200">{job.phase}{job.current ? ` · ${job.current}` : ""}</span><span className="font-mono text-zinc-400">{job.progress}%{job.total ? ` · ${job.completed}/${job.total}` : ""}</span></div><div className="mt-1.5 h-1 overflow-hidden bg-zinc-800"><div className="h-full bg-sky-300 transition-[width] duration-500" style={{ width: `${Math.max(2, job.progress)}%` }} /></div><p className="mt-1 truncate text-[11px] text-zinc-500">{job.error ?? job.logs.at(-1) ?? "Preparing pipeline…"}</p></div>{active ? <button type="button" onClick={() => void jobAction("cancel")} className="flex items-center gap-1 border border-zinc-600 px-2 py-1.5 text-xs text-zinc-200"><Square className="h-3 w-3" /> Stop safely</button> : recoverable ? <button type="button" onClick={() => void jobAction("resume")} className="flex items-center gap-1 bg-zinc-100 px-2 py-1.5 text-xs font-medium text-black"><RotateCcw className="h-3 w-3" /> Resume</button> : null}</div> : null}
      </header>
      <div className="grid min-h-0 grid-cols-[17rem_minmax(0,1fr)_19rem]">
        <aside className="min-h-0 overflow-y-auto border-r border-zinc-800 bg-[#0e0e11]">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-zinc-500"><FolderKanban className="h-3.5 w-3.5" /> Controls</div>
          <div className="p-4">{panels.left}</div>
        </aside>
        <section className="min-w-0 overflow-hidden bg-[#0b0b0e]"><OriginalStage projectId={projectId} onStateChange={setWorkspaceState} /></section>
        <aside className="min-h-0 overflow-y-auto border-l border-zinc-800 bg-[#0e0e11]">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-zinc-500"><Activity className="h-3.5 w-3.5" /> Inspector</div>
          <div className="p-4">{panels.right}</div>
        </aside>
      </div>
    </main>
  );
}

export default function ProjectWorkspace(props: ProjectWorkspaceProps) {
  return <WorkspacePanelsProvider><WorkspaceFrame {...props} /></WorkspacePanelsProvider>;
}
