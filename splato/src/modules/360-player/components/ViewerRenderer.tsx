"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BackSide, Color, FrontSide, Group, PerspectiveCamera, SRGBColorSpace, Vector3, VideoTexture } from "three";

import { ViewerMode } from "../types";

interface ViewerRendererProps { video: HTMLVideoElement; mode: ViewerMode; aspectRatio: number; yaw?: number; pitch?: number; fieldOfView?: number; allowControls?: boolean; }

function CameraController({ mode, yaw = 0, pitch = 0, fieldOfView = 62 }: Pick<ViewerRendererProps, "mode" | "yaw" | "pitch" | "fieldOfView">) {
  const { camera } = useThree();
  useEffect(() => {
    const perspectiveCamera = camera as PerspectiveCamera;
    perspectiveCamera.fov = Math.min(Math.max(fieldOfView, 35), 130);
    if (mode === "inside") camera.position.set(0, 0, 0.01);
    else if (mode === "sphere") camera.position.set(0, 2.4, 18);
    else camera.position.set(0, 0, 6);
    if (mode === "inside") {
      const yawRadians = yaw * Math.PI / 180; const pitchRadians = pitch * Math.PI / 180;
      camera.lookAt(new Vector3(Math.sin(yawRadians) * Math.cos(pitchRadians), Math.sin(pitchRadians), -Math.cos(yawRadians) * Math.cos(pitchRadians)));
    } else camera.lookAt(0, 0, 0);
    perspectiveCamera.updateProjectionMatrix();
  }, [camera, fieldOfView, mode, pitch, yaw]);
  return null;
}

function SphereStage() { const stageRef = useRef<Group>(null); useFrame(({ clock }) => { if (stageRef.current) stageRef.current.rotation.y = clock.getElapsedTime() * 0.04; }); return <group ref={stageRef} position={[0, -6.2, 0]}><mesh rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[14, 96]} /><meshStandardMaterial color={new Color("#09060e")} roughness={0.35} metalness={0.7} /></mesh><mesh position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[8.6, 8.7, 96]} /><meshBasicMaterial color="#d4d4d8" transparent opacity={0.45} /></mesh><pointLight color="#fafafa" intensity={20} distance={22} /></group>; }

function VideoSurface({ video, mode, aspectRatio }: ViewerRendererProps) { const texture = useMemo(() => { const value = new VideoTexture(video); value.colorSpace = SRGBColorSpace; value.generateMipmaps = false; value.flipY = true; return value; }, [video]); useEffect(() => () => texture.dispose(), [texture]); if (mode === "flat") return <mesh><planeGeometry args={[Math.max(aspectRatio, 1.6) * 3.2, 3.2]} /><meshBasicMaterial map={texture} toneMapped={false} /></mesh>; return <mesh><sphereGeometry args={[8, 128, 128]} /><meshBasicMaterial map={texture} side={mode === "sphere" ? FrontSide : BackSide} toneMapped={false} /></mesh>; }

export default function ViewerRenderer({ video, mode, aspectRatio, yaw, pitch, fieldOfView, allowControls = true }: ViewerRendererProps) { return <Canvas className="h-full w-full" camera={{ fov: fieldOfView ?? 62, near: 0.01, far: 100 }} dpr={[1, 2]} gl={{ antialias: true }}><color attach="background" args={["#030306"]} /><fog attach="fog" args={["#030306", 15, 36]} /><ambientLight intensity={mode === "sphere" ? 0.45 : 0} /><CameraController mode={mode} yaw={yaw} pitch={pitch} fieldOfView={fieldOfView} /><VideoSurface video={video} mode={mode} aspectRatio={aspectRatio} />{mode === "sphere" ? <SphereStage /> : null}<OrbitControls enabled={allowControls} enablePan={mode !== "inside"} enableZoom={mode !== "inside"} enableDamping dampingFactor={0.08} rotateSpeed={-0.3} minDistance={mode === "sphere" ? 11 : 3} maxDistance={mode === "sphere" ? 28 : 12} minPolarAngle={mode === "inside" ? 0.35 : 0.55} maxPolarAngle={mode === "inside" ? 2.8 : 2.45} /></Canvas>; }

