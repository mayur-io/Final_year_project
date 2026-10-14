"use client";

import { useEffect, useState } from "react";

type RuntimeStatusData = {
  colmap: { available: boolean; managed: boolean; path?: string };
  gaussian: {
    ready: boolean;
    mode: "train" | "bootstrap" | null;
    python: string;
  };
  storage: { root: string; freeBytes: number | null };
  checkedAt: string;
};

function Dot({ color }: { color: string }) {
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/**
 * Live status of the real reconstruction engines (COLMAP + gsplat), read from
 * /api/runtime. Replaces the old "Splato Engine" badge that dialed a
 * WebSocket (ws://localhost:4380) no server ever listened on.
 */
export default function RuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatusData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const response = await fetch("/api/runtime", { cache: "no-store" });
        if (!response.ok) throw new Error("runtime probe failed");
        const data = (await response.json()) as RuntimeStatusData;
        if (!cancelled) {
          setStatus(data);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (failed || !status) {
    return (
      <span
        title="The reconstruction runtime could not be probed yet."
        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-xs text-gray-400"
      >
        <Dot color="bg-gray-500" /> Runtime · checking…
      </span>
    );
  }

  const { colmap, gaussian, storage } = status;
  const colmapLabel = colmap.available
    ? `COLMAP ${colmap.managed ? "(managed)" : ""}`
    : "COLMAP missing";
  const gaussianLabel =
    gaussian.mode === "train"
      ? "Gaussian train"
      : gaussian.mode === "bootstrap"
        ? "Gaussian preview"
        : "No Gaussian runtime";
  const freeLabel =
    storage.freeBytes != null
      ? `${(storage.freeBytes / 1024 ** 3).toFixed(1)} GB free`
      : null;

  const ready = colmap.available && gaussian.mode === "train";
  const partial = colmap.available && gaussian.mode === "bootstrap";
  const dot = ready ? "bg-emerald-400" : partial ? "bg-amber-400" : "bg-rose-400";

  const detail = [
    colmap.path ? `COLMAP: ${colmap.path}` : null,
    `Gaussian python: ${gaussian.python}`,
    storage.root ? `Storage: ${storage.root}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={detail}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        ready
          ? "border-emerald-500/30 text-emerald-300"
          : partial
            ? "border-amber-500/30 text-amber-300"
            : "border-rose-500/30 text-rose-300"
      }`}
    >
      <Dot color={dot} />
      {colmapLabel}
      <span className="text-gray-600">·</span>
      {gaussianLabel}
      {freeLabel ? (
        <>
          <span className="text-gray-600">·</span>
          {freeLabel}
        </>
      ) : null}
    </span>
  );
}