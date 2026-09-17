"use client";

import { Image as DreiImage, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { CheckCircle2, ImageIcon, LoaderCircle, MousePointer2, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Vector3 } from "three";

import { useStagePanels } from "@/components/workspace/WorkspacePanels";

export interface GalleryFrame { id: string; filename: string; url: string; }
type RejectedFrame = { filename: string; reason: string; source: "automatic" | "manual"; };
interface FrameGalleryProps {
  projectId: string;
  frames: GalleryFrame[];
  processing?: boolean;
  onPrepare?: () => Promise<void>;
  onReconstruct?: () => void;
  onFramesChanged?: () => void;
  summary?: { sampled: number; rejected: number; };
}

const anchors: Record<string, Vector3> = {
  front: new Vector3(0, 0, 8), right: new Vector3(8, 0, 0),
  back: new Vector3(0, 0, -8), left: new Vector3(-8, 0, 0),
  up: new Vector3(0, 8, 0), down: new Vector3(0, -8, 0),
};

function positionFor(frame: GalleryFrame, index: number, total: number) {
  const direction = Object.keys(anchors).find((name) => frame.filename.startsWith(name + "_"));
  const spread = ((index % 11) - 5) * 0.42;
  if (direction) {
    const anchor = anchors[direction].clone();
    if (direction === "up" || direction === "down") return anchor.add(new Vector3(spread, 0, Math.sin(index * 1.7) * 1.6));
    return anchor.add(new Vector3(
      direction === "right" || direction === "left" ? 0 : spread,
      Math.sin(index * 1.7) * 1.4,
      direction === "right" || direction === "left" ? spread : 0,
    ));
  }
  const progress = total <= 1 ? 0 : index / (total - 1);
  const angle = -Math.PI * 0.8 + progress * Math.PI * 2.6;
  const radius = 7.2 + Math.sin(progress * Math.PI * 4) * 1.1;
  return new Vector3(Math.cos(angle) * radius, (progress - 0.5) * 7, Math.sin(angle) * radius);
}

function FrameCard({ frame, position, selected, reviewing, onSelect, onToggle }: {
  frame: GalleryFrame; position: Vector3; selected: boolean; reviewing: boolean;
  onSelect: (frame: GalleryFrame) => void; onToggle: (filename: string) => void;
}) {
  const groupRef = useRef<Group>(null);
  useFrame(() => groupRef.current?.lookAt(0, 0, 0));
  return <group ref={groupRef} position={position}>
    <DreiImage
      url={frame.url}
      scale={selected ? [2.05, 1.37] : [1.8, 1.2]}
      color={selected ? "#fbbf24" : "#ffffff"}
      transparent
      onClick={() => reviewing ? onToggle(frame.filename) : onSelect(frame)}
    />
  </group>;
}

function GalleryImages({ frames, reviewing, selectedFrames, onSelect, onToggle }: {
  frames: GalleryFrame[]; reviewing: boolean; selectedFrames: Set<string>;
  onSelect: (frame: GalleryFrame) => void; onToggle: (filename: string) => void;
}) {
  const positions = useMemo(() => frames.map((frame, index) => positionFor(frame, index, frames.length)), [frames]);
  return <group>{frames.map((frame, index) => <FrameCard key={frame.id} frame={frame} position={positions[index]} selected={selectedFrames.has(frame.filename)} reviewing={reviewing} onSelect={onSelect} onToggle={onToggle} />)}</group>;
}

export default function FrameGallery({
  projectId, frames, processing = false, onPrepare, onReconstruct, onFramesChanged,
}: FrameGalleryProps) {
  const [selectedFrame, setSelectedFrame] = useState<GalleryFrame | null>(frames[0] ?? null);
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const [reviewMode, setReviewMode] = useState(false);
  const [rejected, setRejected] = useState<RejectedFrame[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshReview = useCallback(async () => {
    const response = await fetch("/api/projects/" + projectId + "/frames");
    if (!response.ok) return;
    const result = await response.json() as { rejected: RejectedFrame[] };
    setRejected(result.rejected);
  }, [projectId]);

  useEffect(() => { void refreshReview(); }, [refreshReview]);
  useEffect(() => {
    if (selectedFrame && !frames.some((frame) => frame.id === selectedFrame.id)) setSelectedFrame(frames[0] ?? null);
    if (!selectedFrame && frames[0]) setSelectedFrame(frames[0]);
    setSelectedFrames((previous) => new Set([...previous].filter((filename) => frames.some((frame) => frame.filename === filename))));
  }, [frames, selectedFrame]);

  const toggle = (filename: string) => setSelectedFrames((previous) => {
    const next = new Set(previous);
    if (next.has(filename)) next.delete(filename); else next.add(filename);
    return next;
  });

  async function prepare() {
    if (!onPrepare) return;
    setPreparing(true); setError(null);
    try { await onPrepare(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Image preparation failed."); }
    finally { setPreparing(false); }
  }

  async function review(action: "reject" | "restore", filenames: string[]) {
    if (!filenames.length) return;
    setReviewing(true); setError(null);
    try {
      const response = await fetch("/api/projects/" + projectId + "/frames", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, filenames }),
      });
      const result = await response.json() as { error?: string; review?: RejectedFrame[] };
      if (!response.ok) throw new Error(result.error ?? "Frame review could not be updated.");
      setRejected(result.review ?? []); setSelectedFrames(new Set()); onFramesChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Frame review could not be updated.");
    } finally { setReviewing(false); }
  }

  const selectedCount = selectedFrames.size;
  const panels = useMemo(() => ({
    left: <div className="space-y-6">
      <section><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Gallery controls</p><p className="mt-2 text-xs leading-5 text-zinc-500">Orbit to inspect coverage. Review mode supports individual or batch frame decisions.</p></section>
      <section className="border-y border-zinc-800 py-4"><dl className="space-y-3 text-xs">
        <div className="flex justify-between text-zinc-400"><dt>Accepted frames</dt><dd>{frames.length}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>Rejected bin</dt><dd>{rejected.length}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>State</dt><dd>{processing ? "Writing" : "Ready"}</dd></div>
      </dl></section>
      {!processing ? <section className="space-y-2">
        <button type="button" onClick={() => setReviewMode((value) => !value)} className={"w-full border px-3 py-2 text-sm " + (reviewMode ? "border-amber-300 bg-amber-300 text-black" : "border-zinc-700 text-zinc-200")}>{reviewMode ? "Finish review" : "Review and select"}</button>
        {reviewMode ? <><div className="grid grid-cols-2 gap-1">
          <button type="button" onClick={() => setSelectedFrames(new Set(frames.map((frame) => frame.filename)))} className="border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300">Select all</button>
          <button type="button" onClick={() => setSelectedFrames(new Set())} className="border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300">Clear</button>
        </div><button type="button" disabled={!selectedCount || reviewing} onClick={() => void review("reject", [...selectedFrames])} className="flex w-full items-center justify-center gap-2 border border-rose-800 px-3 py-2 text-sm text-rose-200 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />Reject {selectedCount || ""} frame{selectedCount === 1 ? "" : "s"}</button></> : null}
      </section> : null}
      {onReconstruct && !processing ? <button type="button" onClick={onReconstruct} className="w-full border border-zinc-700 px-3 py-2.5 text-sm text-zinc-200">Open reconstruction workspace</button> : null}
      {onPrepare ? <button type="button" onClick={() => void prepare()} disabled={preparing} className="flex w-full items-center justify-center gap-2 bg-zinc-100 px-3 py-2.5 text-sm font-medium text-black disabled:opacity-50">{preparing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{preparing ? "Preparing images" : "Prepare image sequence"}</button> : null}
      {error ? <p className="border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">{error}</p> : null}
    </div>,
    right: <div className="space-y-6">
      <section><div className="flex items-center gap-2 text-sm font-medium text-zinc-200">{processing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}{processing ? "Extraction running" : reviewMode ? selectedCount + " selected" : "Image inspection"}</div><p className="mt-2 text-xs leading-5 text-zinc-500">{processing ? "Raw candidates are appearing while OpenCV prepares the reconstruction set." : reviewMode ? "Selected frames move to the rejected bin. Originals remain recoverable." : "Select an image in the spatial gallery to inspect it."}</p></section>
      <section className="overflow-hidden border border-zinc-800 bg-black">{selectedFrame ? <><img src={selectedFrame.url} alt={selectedFrame.filename} className="aspect-video w-full object-cover" /><p className="truncate px-3 py-2 text-xs text-zinc-400">{selectedFrame.filename}</p></> : <div className="grid aspect-video place-items-center text-zinc-600"><ImageIcon className="h-6 w-6" /></div>}</section>
      <section className="border-y border-zinc-800 py-4"><div className="flex items-center justify-between"><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Rejected bin</p>{rejected.length ? <button type="button" disabled={reviewing} onClick={() => void review("restore", rejected.map((frame) => frame.filename))} className="text-xs text-sky-300 disabled:opacity-40">Restore all</button> : null}</div>{rejected.length ? <div className="mt-3 max-h-44 space-y-1 overflow-auto">{rejected.map((frame) => <div key={frame.filename} className="flex items-center gap-2 border border-zinc-800 px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 truncate text-zinc-400">{frame.filename}</span><button type="button" disabled={reviewing} onClick={() => void review("restore", [frame.filename])} className="text-sky-300 disabled:opacity-40" aria-label={"Restore " + frame.filename}><RotateCcw className="h-3.5 w-3.5" /></button></div>)}</div> : <p className="mt-2 text-xs leading-5 text-zinc-500">No rejected frames. Automated and manual rejects remain restorable here.</p>}</section>
      <section><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Quality filter</p><p className="mt-2 text-sm leading-6 text-zinc-400">Candidate images stay untouched. Only the accepted set is passed to reconstruction.</p></section>
    </div>,
  }), [error, frames, onPrepare, onReconstruct, preparing, processing, rejected, reviewMode, reviewing, selectedCount, selectedFrame, selectedFrames]);
  useStagePanels(panels);

  return <section className="relative h-full min-h-0 overflow-hidden bg-[#0b0b0e] text-zinc-100">
    <Canvas camera={{ position: [0, 0, 15], fov: 52 }} dpr={[1, 2]}><color attach="background" args={["#0b0b0e"]} /><ambientLight intensity={1.8} /><pointLight position={[0, 4, 7]} intensity={35} color="#f4f4f5" /><GalleryImages frames={frames} reviewing={reviewMode} selectedFrames={selectedFrames} onSelect={setSelectedFrame} onToggle={toggle} /><OrbitControls enablePan={false} enableDamping minDistance={7} maxDistance={20} /></Canvas>
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between border-b border-zinc-800 bg-[#0b0b0e]/80 p-5 backdrop-blur"><div><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">{processing ? "Live frame extraction" : reviewMode ? "Frame review" : "Image gallery"}</p><h1 className="mt-1 text-lg font-medium">{processing ? "Frames are joining the gallery." : reviewMode ? "Select frames to reject." : "Capture coverage"}</h1></div><span className="font-mono text-xs text-zinc-400">{frames.length} frames</span></div>
    <div className="pointer-events-none absolute bottom-5 left-5 inline-flex items-center gap-2 border border-zinc-700 bg-[#111114]/90 px-3 py-2 text-xs text-zinc-400"><MousePointer2 className="h-3.5 w-3.5" />{reviewMode ? "Select frames · use Controls to batch reject" : "Drag to orbit · select a frame to inspect"}</div>
  </section>;
}
