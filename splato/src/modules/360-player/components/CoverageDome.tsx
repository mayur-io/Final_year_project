"use client";

import { Html, Line, OrbitControls, PerspectiveCamera, RenderTexture } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackSide, DoubleSide, Group, Quaternion, SRGBColorSpace, Vector3, VideoTexture } from "three";

export interface CoverageView { id: string; label: string; yaw: number; pitch: number; fieldOfView: number; locked?: boolean; }
export interface ProtectedRegion { yaw: number; pitch: number; radius: number; }

function directionFor(yaw: number, pitch: number) { const yawRadians = yaw * Math.PI / 180; const pitchRadians = pitch * Math.PI / 180; return new Vector3(Math.sin(yawRadians) * Math.cos(pitchRadians), Math.sin(pitchRadians), Math.cos(yawRadians) * Math.cos(pitchRadians)); }
function yawPitchFor(point: Vector3) { const value = point.clone().normalize(); return { yaw: Math.atan2(value.x, value.z) * 180 / Math.PI, pitch: Math.asin(value.y) * 180 / Math.PI }; }
function angularDistance(first: Vector3, second: Vector3) { return Math.acos(Math.min(1, Math.max(-1, first.dot(second)))) * 180 / Math.PI; }
function snap(value: number, points: number[]) { const closest = points.reduce((winner, candidate) => Math.abs(candidate - value) < Math.abs(winner - value) ? candidate : winner, points[0]); return Math.abs(closest - value) < 7 ? closest : Math.round(value); }

function OutputCard({ view, selected, focused, texture, onSelect, onMove, onDragChange }: { view: CoverageView; selected: boolean; focused: boolean; texture: VideoTexture; onSelect: (id: string) => void; onMove: (id: string, yaw: number, pitch: number) => void; onDragChange: (dragging: boolean) => void }) {
  const groupRef = useRef<Group>(null); const dragging = useRef(false);
  const direction = useMemo(() => directionFor(view.yaw, view.pitch), [view.pitch, view.yaw]); const position = useMemo(() => direction.clone().multiplyScalar(2.85), [direction]);
  const width = 1.15 * (focused ? 1.35 : 1); const height = width * 0.57;
  const outwardRotation = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), direction), [direction]);
  useFrame(() => { groupRef.current?.quaternion.copy(outwardRotation); });
  function move(event: { point: Vector3; stopPropagation: () => void }) { if (!dragging.current || view.locked) return; event.stopPropagation(); const next = yawPitchFor(event.point); onMove(view.id, snap(next.yaw, [-180, -135, -90, -45, 0, 45, 90, 135, 180]), snap(next.pitch, [-90, -60, -30, 0, 30, 60, 90])); }
  return <group ref={groupRef} position={position} onClick={(event) => { event.stopPropagation(); onSelect(view.id); }} onDoubleClick={(event) => { event.stopPropagation(); onSelect(view.id); }} onPointerDown={(event) => { if (view.locked) return; event.stopPropagation(); dragging.current = true; onDragChange(true); }} onPointerUp={(event) => { event.stopPropagation(); dragging.current = false; onDragChange(false); }} onPointerOut={() => { if (dragging.current) { dragging.current = false; onDragChange(false); } }} onPointerMove={move}>
    <mesh><planeGeometry args={[width + 0.1, height + 0.1]} /><meshBasicMaterial color={selected ? "#ffffff" : "#27272a"} transparent opacity={focused || selected ? 1 : 0.38} side={DoubleSide} /></mesh>
    <mesh position={[0, 0, 0.012]}><planeGeometry args={[width, height]} /><meshBasicMaterial toneMapped={false} transparent opacity={focused || selected ? 1 : 0.25} side={DoubleSide}><RenderTexture attach="map" width={320} height={180} samples={0}><PerspectiveCamera makeDefault manual fov={view.fieldOfView} position={[0, 0, 0.01]} rotation={[-view.pitch * Math.PI / 180, -view.yaw * Math.PI / 180, 0]} /><mesh><sphereGeometry args={[8, 64, 64]} /><meshBasicMaterial map={texture} side={BackSide} toneMapped={false} /></mesh></RenderTexture></meshBasicMaterial></mesh>
    <Html position={[0, -height / 2 - 0.14, 0.02]} transform sprite className="pointer-events-none select-none whitespace-nowrap rounded bg-zinc-950/90 px-1.5 py-0.5 text-[10px] text-zinc-200">{view.label}</Html>
  </group>;
}

function CoverageZone({ yaw, pitch, coverage, onAdd }: { yaw: number; pitch: number; coverage: number; onAdd: (yaw: number, pitch: number) => void }) { const position = useMemo(() => directionFor(yaw, pitch).multiplyScalar(1.78), [pitch, yaw]); const color = coverage === 0 ? "#ef4444" : coverage === 1 ? "#f59e0b" : "#22c55e"; return <mesh position={position} onClick={(event) => { event.stopPropagation(); if (coverage === 0) onAdd(yaw, pitch); }}><sphereGeometry args={[coverage === 0 ? 0.06 : 0.035, 10, 10]} /><meshBasicMaterial color={color} transparent opacity={coverage === 0 ? 0.85 : 0.45} /></mesh>; }

function DomeScene({ views, selectedViewId, video, focusMode, protectedRegion, onSelect, onMove, onAddGap, onDragChange }: { views: CoverageView[]; selectedViewId: string; video: HTMLVideoElement; focusMode: boolean; protectedRegion: ProtectedRegion | null; onSelect: (id: string) => void; onMove: (id: string, yaw: number, pitch: number) => void; onAddGap: (yaw: number, pitch: number) => void; onDragChange: (dragging: boolean) => void }) {
  const texture = useMemo(() => { const value = new VideoTexture(video); value.colorSpace = SRGBColorSpace; value.generateMipmaps = false; value.flipY = true; return value; }, [video]); useEffect(() => () => texture.dispose(), [texture]);
  const zones = useMemo(() => Array.from({ length: 48 }, (_, index) => { const yaw = (index % 12) * 30 - 180; const pitch = Math.floor(index / 12) * 50 - 75; const point = directionFor(yaw, pitch); const coverage = views.filter((view) => angularDistance(point, directionFor(view.yaw, view.pitch)) < view.fieldOfView * 0.52).length; return { yaw, pitch, coverage: Math.min(2, coverage) }; }), [views]);
  const relationships = useMemo(() => views.flatMap((view, index) => views.slice(index + 1).filter((other) => angularDistance(directionFor(view.yaw, view.pitch), directionFor(other.yaw, other.pitch)) < Math.min(view.fieldOfView, other.fieldOfView) * 0.78).map((other) => [directionFor(view.yaw, view.pitch).multiplyScalar(2.4), directionFor(other.yaw, other.pitch).multiplyScalar(2.4)])), [views]);
  const protectedPosition = protectedRegion ? directionFor(protectedRegion.yaw, protectedRegion.pitch).multiplyScalar(1.8) : null;
  return <><ambientLight intensity={0.8} /><pointLight position={[3, 4, 5]} intensity={18} color="#ffffff" /><mesh><sphereGeometry args={[1.75, 48, 32]} /><meshBasicMaterial color="#27272a" wireframe transparent opacity={0.36} /></mesh><mesh rotation={[Math.PI / 2, 0, 0]}><ringGeometry args={[1.75, 1.78, 64]} /><meshBasicMaterial color="#52525b" /></mesh>{zones.map((zone) => <CoverageZone key={`${zone.yaw}-${zone.pitch}`} {...zone} onAdd={onAddGap} />)}{protectedPosition ? <mesh position={protectedPosition}><sphereGeometry args={[0.12, 14, 14]} /><meshBasicMaterial color="#c084fc" /></mesh> : null}{relationships.map((points, index) => <Line key={index} points={points} color="#71717a" transparent opacity={0.35} lineWidth={1} />)}{views.map((view) => <OutputCard key={view.id} view={view} selected={view.id === selectedViewId} focused={!focusMode || view.id === selectedViewId} texture={texture} onSelect={onSelect} onMove={onMove} onDragChange={onDragChange} />)}</>;
}

export default function CoverageDome({ views, selectedViewId, video, focusMode, protectedRegion, onSelect, onMove, onAddGap }: { views: CoverageView[]; selectedViewId: string; video: HTMLVideoElement; focusMode: boolean; protectedRegion: ProtectedRegion | null; onSelect: (id: string) => void; onMove: (id: string, yaw: number, pitch: number) => void; onAddGap: (yaw: number, pitch: number) => void }) { const [dragging, setDragging] = useState(false); return <Canvas camera={{ position: [0, 0.5, 7.3], fov: 42 }} dpr={[1, 2]} gl={{ antialias: true }}><color attach="background" args={["#09090b"]} /><DomeScene views={views} selectedViewId={selectedViewId} video={video} focusMode={focusMode} protectedRegion={protectedRegion} onSelect={onSelect} onMove={onMove} onAddGap={onAddGap} onDragChange={setDragging} /><OrbitControls enabled={!dragging} enablePan={false} enableDamping minDistance={4.5} maxDistance={11} /></Canvas>; }




