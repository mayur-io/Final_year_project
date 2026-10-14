"use client";

import { Image as DreiImage, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { AlertTriangle, CheckCircle2, ImageIcon, LoaderCircle, MousePointer2, Sparkles, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Vector3 } from "three";

import { useStagePanels } from "@/components/workspace/WorkspacePanels";

export interface GalleryFrame { id: string; filename: string; url: string; }
type PreparationVerdict = "PASS" | "WARN" | "REJECT";
type PreparationReport = {
  verdict: PreparationVerdict;
  sourceType: "normal-video" | "360-video" | "image-sequence";
  reasons: string[];
  warnings: string[];
  evidence: { motion: string; motionScore?: number; sky: string; overlap: string; overlapScore?: number; coverage: string; coverageScore?: number; dynamicObjects?: string };
  selection: {
    candidates: number; accepted: number; rejected: number; blurry: number;
    duplicates: number; textureless: number; outliers: number; manuallyRejected: number;
  };
};
interface FrameGalleryProps {
  projectId: string;
  frames: GalleryFrame[];
  processing?: boolean;
  onPrepare?: () => Promise<void>;
  onReconstruct?: () => void;
  onReplanViews?: () => void;
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

function FrameCard({ frame, position, selected, onSelect }: {
  frame: GalleryFrame; position: Vector3; selected: boolean;
  onSelect: (frame: GalleryFrame) => void;
}) {
  const groupRef = useRef<Group>(null);
  useFrame(() => groupRef.current?.lookAt(0, 0, 0));
  return <group ref={groupRef} position={position}>
    <DreiImage
      url={frame.url}
      scale={selected ? [2.05, 1.37] : [1.8, 1.2]}
      color={selected ? "#fbbf24" : "#ffffff"}
      transparent
      onClick={() => onSelect(frame)}
    />
  </group>;
}

function GalleryImages({ frames, selectedName, onSelect }: {
  frames: GalleryFrame[]; selectedName: string | null;
  onSelect: (frame: GalleryFrame) => void;
}) {
  const positions = useMemo(() => frames.map((frame, index) => positionFor(frame, index, frames.length)), [frames]);
  return <group>{frames.map((frame, index) => <FrameCard key={frame.id} frame={frame} position={positions[index]} selected={frame.filename === selectedName} onSelect={onSelect} />)}</group>;
}

const verdictTone: Record<PreparationVerdict, string> = {
  PASS: "border-emerald-800 bg-emerald-950/30 text-emerald-200",
  WARN: "border-amber-800 bg-amber-950/30 text-amber-200",
  REJECT: "border-rose-800 bg-rose-950/30 text-rose-200",
};

const verdictIcon: Record<PreparationVerdict, typeof CheckCircle2> = {
  PASS: CheckCircle2,
  WARN: AlertTriangle,
  REJECT: XCircle,
};

function VerdictBadge({ verdict }: { verdict: PreparationVerdict }) {
  const Icon = verdictIcon[verdict];
  return <span className={"inline-flex items-center gap-1.5 border px-2 py-1 text-xs font-medium " + verdictTone[verdict]}><Icon className="h-3.5 w-3.5" />{verdict}</span>;
}

function sourceLabel(sourceType: PreparationReport["sourceType"]) {
  return sourceType === "360-video" ? "360° projections" : sourceType === "normal-video" ? "Video frames" : "Image sequence";
}

export default function FrameGallery({
  projectId, frames, processing = false, onPrepare, onReconstruct, onReplanViews,
}: FrameGalleryProps) {
  const [selectedFrame, setSelectedFrame] = useState<GalleryFrame | null>(frames[0] ?? null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PreparationReport | null>(null);

  const refreshReport = useCallback(async () => {
    const response = await fetch("/api/projects/" + projectId + "/preparation");
    if (!response.ok) return;
    const result = (await response.json()) as { report: PreparationReport | null };
    setReport(result.report);
  }, [projectId]);

  useEffect(() => { void refreshReport(); }, [refreshReport]);
  useEffect(() => {
    if (selectedFrame && !frames.some((frame) => frame.id === selectedFrame.id)) setSelectedFrame(frames[0] ?? null);
    if (!selectedFrame && frames[0]) setSelectedFrame(frames[0]);
  }, [frames, selectedFrame]);

  async function prepare() {
    if (!onPrepare) return;
    setPreparing(true); setError(null);
    try { await onPrepare(); await refreshReport(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Image preparation failed."); }
    finally { setPreparing(false); }
  }

  const verdict = report?.verdict ?? null;
  const blocked = verdict === "REJECT";

  const panels = useMemo(() => ({
    left: <div className="space-y-6">
      <section>
        <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Preparation</p>
        {report ? <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between"><VerdictBadge verdict={report.verdict} /><span className="text-xs text-zinc-500">{sourceLabel(report.sourceType)}</span></div>
          <p className="text-xs leading-5 text-zinc-400">{report.selection.accepted} accepted of {report.selection.candidates} candidates.</p>
          {report.reasons.map((reason) => <p key={reason} className="border border-rose-900 bg-rose-950/30 p-2 text-xs text-rose-200">{reason}</p>)}
          {report.warnings.map((warning) => <p key={warning} className="border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-200">{warning}</p>)}
        </div> : <p className="mt-2 text-xs leading-5 text-zinc-500">No preparation report yet. Prepare the capture to record a verdict.</p>}
      </section>
      {report ? <section className="border-y border-zinc-800 py-4"><dl className="space-y-2 text-xs">
        <div className="flex justify-between text-zinc-400"><dt>Candidates</dt><dd className="font-mono">{report.selection.candidates}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>Accepted</dt><dd className="font-mono">{report.selection.accepted}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>Blurry</dt><dd className="font-mono">{report.selection.blurry}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>Duplicates</dt><dd className="font-mono">{report.selection.duplicates}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>Textureless</dt><dd className="font-mono">{report.selection.textureless}</dd></div>
        <div className="flex justify-between text-zinc-400"><dt>Scene outliers</dt><dd className="font-mono">{report.selection.outliers}</dd></div>
      </dl></section> : null}
      {report ? <section><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Evidence</p><dl className="mt-2 space-y-2 text-xs text-zinc-400">
        <div className="flex justify-between"><dt>Motion</dt><dd className="font-mono">{report.evidence.motion}{report.evidence.motionScore != null ? ` (${report.evidence.motionScore.toFixed(1)})` : ""}</dd></div>
        <div className="flex justify-between"><dt>Overlap</dt><dd className="font-mono">{report.evidence.overlap}{report.evidence.overlapScore != null ? ` (${report.evidence.overlapScore.toFixed(2)})` : ""}</dd></div>
        <div className="flex justify-between"><dt>Coverage</dt><dd className="font-mono">{report.evidence.coverage}{report.evidence.coverageScore != null ? ` (${report.evidence.coverageScore.toFixed(2)})` : ""}</dd></div>
        <div className="flex justify-between"><dt>Sky</dt><dd className="font-mono">{report.evidence.sky}</dd></div>
        <div className="flex justify-between"><dt>Dynamic objects</dt><dd className="font-mono">{report.evidence.dynamicObjects ?? "manual_review"}</dd></div>
      </dl><p className="mt-3 text-xs leading-5 text-zinc-500">Measured frame-to-frame change and scene continuity, plus brightness observations — not semantic masks. The gallery is read-only; the accepted set is exactly what reconstruction receives.</p></section> : null}
      {onReplanViews && !processing ? <button type="button" onClick={onReplanViews} className="w-full border border-zinc-700 px-3 py-2.5 text-sm text-zinc-200">Re-plan 360° views</button> : null}
      {onPrepare ? <button type="button" onClick={() => void prepare()} disabled={preparing} className="flex w-full items-center justify-center gap-2 bg-zinc-100 px-3 py-2.5 text-sm font-medium text-black disabled:opacity-50">{preparing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{preparing ? "Preparing images" : "Prepare image sequence"}</button> : null}
      {error ? <p className="border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">{error}</p> : null}
    </div>,
    right: <div className="space-y-6">
      <section><div className="flex items-center gap-2 text-sm font-medium text-zinc-200">{processing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}{processing ? "Extraction running" : "Image inspection"}</div><p className="mt-2 text-xs leading-5 text-zinc-500">{processing ? "Accepted frames appear here as preparation completes." : "Select a frame in the spatial gallery to inspect it."}</p></section>
      <section className="overflow-hidden border border-zinc-800 bg-black">{selectedFrame ? <><img src={selectedFrame.url} alt={selectedFrame.filename} className="aspect-video w-full object-cover" /><p className="truncate px-3 py-2 text-xs text-zinc-400">{selectedFrame.filename}</p></> : <div className="grid aspect-video place-items-center text-zinc-600"><ImageIcon className="h-6 w-6" /></div>}</section>
      <section className="border-y border-zinc-800 py-4"><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">Reconstruction</p>{onReconstruct ? <>
        <button type="button" onClick={onReconstruct} disabled={processing || blocked} className="mt-3 flex w-full items-center justify-center gap-2 bg-zinc-100 px-3 py-2.5 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-50">Open reconstruction workspace</button>
        {blocked ? <p className="mt-2 text-xs leading-5 text-rose-300">Reconstruction is blocked because preparation was rejected. Resolve the reasons on the left first.</p> : <p className="mt-2 text-xs leading-5 text-zinc-500">A PASS only means the input is coherent enough to attempt reconstruction; it does not promise final quality.</p>}
      </> : null}</section>
    </div>,
  }), [blocked, error, frames, onPrepare, onReconstruct, onReplanViews, preparing, processing, report, selectedFrame]);
  useStagePanels(panels);

  return <section className="relative h-full min-h-0 overflow-hidden bg-[#0b0b0e] text-zinc-100">
    <Canvas camera={{ position: [0, 0, 15], fov: 52 }} dpr={[1, 2]}><color attach="background" args={["#0b0b0e"]} /><ambientLight intensity={1.8} /><pointLight position={[0, 4, 7]} intensity={35} color="#f4f4f5" /><GalleryImages frames={frames} selectedName={selectedFrame?.filename ?? null} onSelect={setSelectedFrame} /><OrbitControls enablePan={false} enableDamping minDistance={7} maxDistance={20} /></Canvas>
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between border-b border-zinc-800 bg-[#0b0b0e]/80 p-5 backdrop-blur"><div><p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">{processing ? "Live frame extraction" : "Image gallery"}</p><h1 className="mt-1 text-lg font-medium">{processing ? "Frames are joining the gallery." : "Capture coverage"}</h1></div><div className="flex items-center gap-3">{verdict ? <VerdictBadge verdict={verdict} /> : null}<span className="font-mono text-xs text-zinc-400">{frames.length} frames</span></div></div>
    <div className="pointer-events-none absolute bottom-5 left-5 inline-flex items-center gap-2 border border-zinc-700 bg-[#111114]/90 px-3 py-2 text-xs text-zinc-400"><MousePointer2 className="h-3.5 w-3.5" />Drag to orbit · select a frame to inspect</div>
  </section>;
}
