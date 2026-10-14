"use client";

import { use, useEffect, useState } from "react";

import PointCloudViewer from "@/components/stage/PointCloudViewer";
import SplatViewer from "@/components/stage/SplatViewer";

type ReconStatus = {
  artifacts: { hasPointCloud: boolean; hasDense: boolean; hasSplat: boolean; splatTrained: boolean };
  report: { registeredImages: number; sparsePointCount: number; meanReprojectionErrorPx: number | null } | null;
};

// Standalone viewer: deep-linkable trained-model inspection without going
// through the gallery. `/preview/<id>` always shows whatever artifacts exist.
export default function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [status, setStatus] = useState<ReconStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/projects/${id}/reconstruction`)
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (!cancelled && result) setStatus(result as ReconStatus);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const trained = status?.artifacts.splatTrained ?? false;
  const projectUrl = `/projects/${id}?stage=reconstruction`;

  return (
    <main style={{ background: "#0b0b0e", padding: 24, display: "grid", gap: 24, minHeight: "100vh", color: "#e4e4e7" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1>Preview · {id}</h1>
          <p style={{ color: "#a1a1aa", fontSize: 13, marginTop: 4 }}>
            {status
              ? trained
                ? `Trained Gaussian model available${status.report ? ` · ${status.report.sparsePointCount.toLocaleString()} sparse points` : ""}`
                : status.artifacts.hasSplat
                  ? "Gaussian preview available (not trained)"
                  : status.artifacts.hasPointCloud
                    ? "Sparse cloud available — no Gaussian model yet"
                    : "No reconstruction artifacts yet"
              : "Loading reconstruction status…"}
          </p>
        </div>
        <a href={projectUrl} style={{ border: "1px solid #3f3f46", padding: "8px 12px", fontSize: 13, color: "#e4e4e7", textDecoration: "none" }}>
          Open reconstruction workspace →
        </a>
      </header>
      <PointCloudViewer projectId={id} source="sparse" />
      {status?.artifacts.hasSplat ? (
        <SplatViewer projectId={id} trained={trained} />
      ) : (
        <div style={{ border: "1px solid #27272a", padding: 24, color: "#71717a", fontSize: 14 }}>
          No Gaussian model yet — open the reconstruction workspace to train one.
        </div>
      )}
    </main>
  );
}
