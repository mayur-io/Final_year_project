"use client";

import { Activity, Camera, ScanLine, Boxes, CheckCircle2, Circle, Lock } from "lucide-react";

export type EditorRailSlug = "source" | "prepare" | "reconstruct" | "view";

/** Alias consumed by ProjectWorkspace so its import resolves. */
export type RailStageId = EditorRailSlug;

/** Map a conductor caption (e.g. "Extracting frames · 12 visible") onto the editor rail stage. */
export function stageFromCaption(caption: string): RailStageId {
  const search = caption.toLowerCase();
  if (search.includes("reconstruct") || search.includes("model") || search.includes("cloud")) return "reconstruct";
  if (search.includes("frame") || search.includes("360") || search.includes("projection") || search.includes("view") || search.includes("preparation") || search.includes("extract")) return "prepare";
  if (search.includes("viewer") || search.includes("gallery") || search.includes("result") || search.includes("capture")) return "view";
  return "view";
}

/** Reverse map: a rail slug → the conductor caption that forces that stage (drives UploadStage navigation). */
export function captionFromSlug(slug: RailStageId): string {
  switch (slug) {
    case "source": return "Source capture";
    case "prepare": return "Video preparation";
    case "reconstruct": return "Reconstruction";
    case "view": return "Viewer";
  }
}

export const RAIL_STAGES: Array<{ slug: EditorRailSlug; label: string; caption: string; icon: typeof Camera }> = [
  { slug: "source", label: "Source", caption: "Capture your media", icon: Camera },
  { slug: "prepare", label: "Prepare", caption: "Extract frames & views", icon: ScanLine },
  { slug: "reconstruct", label: "Reconstruct", caption: "Build the 3D model", icon: Boxes },
  { slug: "view", label: "View", caption: "Inspect the result", icon: Activity },
];

interface EditorRailProps {
  current: EditorRailSlug;
  reached: EditorRailSlug[];
  onNavigate: (slug: EditorRailSlug) => void;
}

export default function EditorRail({ current, reached, onNavigate }: EditorRailProps) {
  return (
    <nav aria-label="Project stages" className="flex items-center gap-3">
      {RAIL_STAGES.map((stage, index) => {
        const Icon = stage.icon;
        const isCurrent = stage.slug === current;
        const isReached = reached.includes(stage.slug);
        const traversable = isReached || isCurrent;

        return (
          <div key={stage.slug} className="flex items-center gap-3">
            {index > 0 && <div className={`h-px w-8 ${isReached ? "bg-sky-400/50" : "bg-zinc-800"}`} />}
            <button
              type="button"
              onClick={() => traversable && onNavigate(stage.slug)}
              disabled={!traversable}
              title={traversable ? `${stage.label} — ${stage.caption}` : `${stage.label} — not reached yet`}
              className={`group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                isCurrent
                  ? "border-sky-400/40 bg-sky-400/10 text-sky-200"
                  : isReached
                    ? "border-zinc-700/80 bg-white/[0.03] text-zinc-300 hover:border-zinc-500 hover:bg-white/[0.06]"
                    : "cursor-not-allowed border-zinc-800/60 text-zinc-600"
              }`}
            >
              <Icon className={`h-3.5 w-3.5 ${isCurrent ? "text-sky-300" : isReached ? "text-zinc-400" : "text-zinc-700"}`} />
              <span>{stage.label}</span>
              {isCurrent ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />
              ) : isReached ? (
                <Circle className="h-3.5 w-3.5 text-zinc-500" />
              ) : (
                <Lock className="h-3 w-3 text-zinc-700" />
              )}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
