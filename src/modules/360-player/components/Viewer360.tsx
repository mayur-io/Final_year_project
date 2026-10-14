"use client";

import { Maximize2, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useStagePanels } from "@/components/workspace/WorkspacePanels";
import { planEquirectViews } from "@/lib/media/planViews";
import type { Media } from "@/types/media";

import CoverageDome, { type CoverageView } from "./CoverageDome";
import ViewerRenderer from "./ViewerRenderer";

// The projection grid is planned automatically from these two values. The user
// does not choose a preset, an FOV, or individual views; the only control is the
// global seam shift below, which rotates the whole grid so the equirectangular
// seam can be moved off a subject of interest.
const PROJECTION_FOV = 90;
const PROJECTION_OVERLAP = 0.15;

function normalizeYaw(yaw: number) {
  return ((Math.round(yaw) % 360) + 360) % 360;
}

function sourceUrl(projectId: string, filepath: string) {
  return `/api/projects/${projectId}/media/${filepath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
}

export default function Viewer360({ projectId, media, onConversionComplete, replanning = false, onCancelReplan }: { projectId: string; media: Media[]; onConversionComplete: () => void; onReturnToUploader: () => void; replanning?: boolean; onCancelReplan?: () => void }) {
  const asset = media[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [seamShift, setSeamShift] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The base plan never changes; the seam shift rotates every view by the same
  // offset. Views are locked so the dome stays a read-only preview.
  const basePlan = useMemo<CoverageView[]>(
    () =>
      planEquirectViews({ fieldOfView: PROJECTION_FOV, overlap: PROJECTION_OVERLAP }).map((view) => ({
        ...view,
        locked: true,
      })),
    [],
  );
  const views = useMemo<CoverageView[]>(
    () =>
      basePlan.map((view) => {
        const yaw = normalizeYaw(view.yaw + seamShift);
        return { ...view, yaw, label: `${view.id} (${Math.round(view.pitch)}° / ${yaw}°)` };
      }),
    [basePlan, seamShift],
  );

  const selected = views.find((view) => view.id === selectedId) ?? views[0];
  const source = asset ? sourceUrl(projectId, asset.filepath) : null;

  const convertAll = useCallback(async () => {
    setConverting(true);
    setError(null);
    try {
      const directions = views.map(({ id, label, yaw, pitch, roll, fieldOfView }) => ({ id, label, yaw, pitch, roll, fieldOfView }));
      const res = await fetch(`/api/projects/${projectId}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: "360-conversion", fieldOfView: PROJECTION_FOV, directions }),
      });
      const result = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(result.error ?? "Conversion failed.");
      onConversionComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed.");
    } finally {
      setConverting(false);
    }
  }, [onConversionComplete, projectId, views]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const sync = () => {
      setTime(el.currentTime);
      setDuration(el.duration || 0);
      setPlaying(!el.paused);
    };
    el.addEventListener("timeupdate", sync);
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("play", sync);
    el.addEventListener("pause", sync);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("play", sync);
      el.removeEventListener("pause", sync);
    };
  }, []);

  const panels = useMemo(
    () => ({
      left: (
        <div className="space-y-6">
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Projection plan</p>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              Splato plans {views.length} views from a {PROJECTION_FOV}° field of view
              and {Math.round(PROJECTION_OVERLAP * 100)}% target overlap. The count is
              derived from those values, not chosen by hand.
            </p>
          </section>
          <section>
            <label className="text-xs text-zinc-300">
              Seam shift <span className="float-right font-mono">{seamShift}°</span>
              <input
                className="mt-2 w-full accent-zinc-200"
                type="range"
                min="-180"
                max="180"
                step="5"
                value={seamShift}
                onChange={(e) => setSeamShift(Number(e.target.value))}
              />
            </label>
            <p className="mt-1 text-[11px] leading-4 text-zinc-500">
              Rotates every view together to move the equirectangular seam. This is
              the only adjustment; FOV, overlap, and the view grid are fixed.
            </p>
          </section>
          <section className="border-y border-zinc-800 py-4">
            <p className="mb-2 text-xs text-zinc-300">Planned views ({views.length})</p>
            <div className="max-h-56 space-y-1 overflow-auto">
              {views.map((view) => (
                <button key={view.id} type="button" onClick={() => setSelectedId(view.id)} className={`flex w-full items-center gap-2 border px-2 py-1.5 text-left text-xs ${view.id === selectedId ? "border-zinc-200 bg-zinc-200 text-black" : "border-zinc-800 text-zinc-400"}`}>
                  <span className="flex-1 truncate">{view.label}</span>
                  <span className="font-mono opacity-60">{view.yaw}°</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ),
      right: (
        <div className="space-y-6">
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Projection summary</p>
            <dl className="mt-3 space-y-2 text-xs text-zinc-400">
              <div className="flex justify-between"><dt>Views</dt><dd>{views.length}</dd></div>
              <div className="flex justify-between"><dt>Field of view</dt><dd>{PROJECTION_FOV}°</dd></div>
              <div className="flex justify-between"><dt>Target overlap</dt><dd>{Math.round(PROJECTION_OVERLAP * 100)}%</dd></div>
              <div className="flex justify-between"><dt>Seam shift</dt><dd>{seamShift}°</dd></div>
            </dl>
            <p className="mt-2 text-[11px] leading-4 text-zinc-500">
              More views than a flat preset, because a 360° capture needs full
              spherical coverage. Overlap is what lets COLMAP connect the frames.
            </p>
          </section>
          {replanning ? (
            <div className="flex items-center gap-2 border border-amber-800/70 bg-amber-950/20 p-2">
              <p className="flex-1 text-xs text-amber-200/90">Committing replaces the projected views.</p>
              <button type="button" onClick={onCancelReplan} className="border border-amber-800 px-2 py-1 text-xs text-amber-200">Close</button>
            </div>
          ) : null}
          <button onClick={() => void convertAll()} disabled={converting || !views.length} className="w-full bg-zinc-100 p-2.5 text-sm font-medium text-black disabled:opacity-50">{converting ? "Creating views." : `Commit ${views.length} views`}</button>
          {error ? <p className="border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">{error}</p> : null}
        </div>
      ),
    }),
    [converting, convertAll, error, onCancelReplan, replanning, seamShift, selectedId, views],
  );
  useStagePanels(panels);
  if (!asset || !source) return null;

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#0b0b0e] text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div>
          <p className="text-xs uppercase tracking-[.16em] text-zinc-500">360 projection planner</p>
          <h1 className="mt-1 text-lg font-medium">Automatic spherical coverage</h1>
        </div>
      </header>
      <main className="relative min-h-0 flex-1">
        {video ? <CoverageDome views={views} selectedViewId={selectedId} video={video} focusMode={false} protectedRegion={null} onSelect={setSelectedId} onMove={() => {}} onAddGap={() => {}} /> : <div className="grid h-full place-items-center text-zinc-500">Loading panorama.</div>}
        <video ref={videoRef} src={source} crossOrigin="anonymous" playsInline preload="auto" className="pointer-events-none absolute h-px w-px opacity-0" onLoadedData={(e) => setVideo(e.currentTarget)} />
        {selected && video ? (
          <aside className="absolute bottom-4 left-4 overflow-hidden border border-zinc-700 bg-black" style={{ width: 288, height: 180 }}>
            <div className="flex justify-between border-b border-zinc-700 bg-[#151518] px-2 py-1.5 text-xs text-zinc-300">
              <span>Preview · {selected.label}</span>
              <X className="h-3.5 w-3.5 opacity-0" />
            </div>
            <div className="h-[calc(100%-30px)]"><ViewerRenderer video={video} mode="inside" aspectRatio={16 / 9} yaw={-selected.yaw} pitch={selected.pitch} fieldOfView={selected.fieldOfView} allowControls={false} /></div>
          </aside>
        ) : null}
      </main>
      <footer className="flex items-center gap-3 border-t border-zinc-800 px-4 py-3">
        <button onClick={() => { if (videoRef.current?.paused) void videoRef.current.play(); else videoRef.current?.pause(); }} className="border border-zinc-700 p-2">{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button onClick={() => { if (videoRef.current) { videoRef.current.muted = !videoRef.current.muted; setMuted(videoRef.current.muted); } }} className="border border-zinc-700 p-2">{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
        <input type="range" min="0" max={duration || 0} value={time} onChange={(e: ChangeEvent<HTMLInputElement>) => { if (videoRef.current) videoRef.current.currentTime = Number(e.target.value); }} className="min-w-0 flex-1 accent-zinc-100" />
        <span className="font-mono text-xs text-zinc-500">{Math.floor(time)} / {Math.floor(duration)}s</span>
        <button onClick={() => document.querySelector("section")?.requestFullscreen()} className="border border-zinc-700 p-2"><Maximize2 className="h-4 w-4" /></button>
      </footer>
    </section>
  );
}
