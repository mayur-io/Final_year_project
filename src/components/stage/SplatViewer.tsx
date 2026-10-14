"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

interface SplatViewerProps {
  projectId: string;
  trained?: boolean;
  className?: string;
}

function splatUrl(projectId: string) {
  return `/api/projects/${projectId}/media/${["projects", projectId, "reconstruction", "splat.ply"].map(encodeURIComponent).join("/")}`;
}

export default function SplatViewer({ projectId, trained = false, className = "h-[420px]" }: SplatViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let viewer: import("@mkkellogg/gaussian-splats-3d").Viewer | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    void (async () => {
      try {
        const { Viewer } = await import("@mkkellogg/gaussian-splats-3d");
        const container = containerRef.current;
        if (disposed || !container) return;
        renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setSize(container.clientWidth || 800, container.clientHeight || 420);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);
        viewer = new Viewer({
          renderer,
          cameraUp: [0, 1, 0],
          initialCameraPosition: [0, 3, 14],
          initialCameraLookAt: [0, 0, 0],
          showLoadingUI: true,
          // No COOP/COEP headers here, so SharedArrayBuffer is unavailable.
          sharedMemoryForWorkers: false,
        });
        await viewer.addSplatScene(splatUrl(projectId), { progressiveLoad: true });
        if (!disposed) viewer.start();
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Splat could not be loaded.");
      }
    })();
    return () => {
      disposed = true;
      try {
        viewer?.stop();
        viewer?.dispose();
        renderer?.dispose();
      } catch {
        // Ignore teardown errors.
      }
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, [projectId]);

  if (error) {
    return (
      <div className={`grid ${className} place-items-center border border-zinc-800 bg-[#0f1014] text-sm text-zinc-400`}>
        {error}
      </div>
    );
  }

  return (
    <div className={`relative ${className} overflow-hidden border border-zinc-800 bg-[#0f1014]`}>
      <div ref={containerRef} className="h-full w-full [&>canvas]:h-full [&>canvas]:w-full" />
      <div className="pointer-events-none absolute left-3 top-3 rounded border border-zinc-700 bg-[#0f1014]/80 px-2 py-1 text-[10px] uppercase tracking-[.16em] text-zinc-400">
        {trained
          ? "Trained Gaussian model · drag to orbit · scroll to zoom"
          : "Gaussian initialization preview · not trained · drag to orbit · scroll to zoom"}
      </div>
    </div>
  );
}
