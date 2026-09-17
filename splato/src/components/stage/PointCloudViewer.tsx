"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

interface PointCloudViewerProps {
  projectId: string;
}

function PointCloudMesh({
  points,
}: {
  points: Array<[number, number, number, number, number, number]>;
}) {
  const geometry = useMemo(() => {
    if (points.length === 0) {
      return null;
    }

    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);

    points.forEach(([x, y, z, r, g, b], index) => {
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      colors[index * 3] = r / 255;
      colors[index * 3 + 1] = g / 255;
      colors[index * 3 + 2] = b / 255;
    });

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    buffer.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return buffer;
  }, [points]);

  if (!geometry) {
    return null;
  }

  return (
    <points geometry={geometry}>
      <pointsMaterial
        size={0.025}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.9}
      />
    </points>
  );
}

export default function PointCloudViewer({ projectId }: PointCloudViewerProps) {
  const [points, setPoints] = useState<
    Array<[number, number, number, number, number, number]>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch(
          `/api/projects/${projectId}/reconstruction/point-cloud`,
        );
        if (!response.ok) {
          throw new Error("Point cloud could not be loaded.");
        }

        const result = (await response.json()) as {
          points?: Array<[number, number, number, number, number, number]>;
          error?: string;
        };
        if (result.error) {
          throw new Error(result.error);
        }

        setPoints(result.points ?? []);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Point cloud could not be loaded.",
        );
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [projectId]);

  if (loading) {
    return (
      <div className="grid h-[420px] place-items-center border border-zinc-800 bg-[#0f1014] text-sm text-zinc-400">
        Loading sparse point cloud…
      </div>
    );
  }

  if (error || points.length === 0) {
    return (
      <div className="grid h-[420px] place-items-center border border-zinc-800 bg-[#0f1014] text-sm text-zinc-400">
        {error ?? "No point cloud data available yet."}
      </div>
    );
  }

  return (
    <div className="relative h-[420px] overflow-hidden border border-zinc-800 bg-[#0f1014]">
      <Canvas camera={{ position: [0, 0, 8], fov: 50 }} dpr={[1, 2]}>
        <color attach="background" args={["#0b0b0e"]} />
        <ambientLight intensity={1.25} />
        <directionalLight position={[5, 5, 5]} intensity={2.5} />
        <PointCloudMesh points={points} />
        <OrbitControls
          enablePan={false}
          enableDamping
          minDistance={3}
          maxDistance={20}
        />
      </Canvas>
      <div className="pointer-events-none absolute left-3 top-3 rounded border border-zinc-700 bg-[#0f1014]/80 px-2 py-1 text-[10px] uppercase tracking-[.16em] text-zinc-400">
        Orbit view
      </div>
    </div>
  );
}
