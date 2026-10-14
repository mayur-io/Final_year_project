import fs from "fs/promises";

import { NextResponse } from "next/server";

import { resolveColmapRuntime } from "@/lib/reconstruction/colmapRuntime";
import { resolveSplatRuntime } from "@/lib/reconstruction/splatJob";
import { checkEnvironment } from "@/lib/system/environment";
import { storageRoot } from "@/lib/storage";

/**
 * Truthful, cached view of what the reconstruction runtime can actually run
 * right now: the COLMAP engine, the Gaussian (gsplat) runtime mode, and free
 * storage. The sidebar badge polls this instead of a phantom WebSocket engine
 * that never existed.
 */
type RuntimeProbe = {
  colmap: { available: boolean; managed: boolean; path?: string };
  gaussian: { ready: boolean; mode: "train" | "bootstrap" | null; python: string };
  environment: Awaited<ReturnType<typeof checkEnvironment>>;
  storage: { root: string; freeBytes: number | null };
  checkedAt: string;
};

let cached: { at: number; value: RuntimeProbe } | null = null;
const CACHE_TTL_MS = 30_000;

async function freeBytes(root: string): Promise<number | null> {
  const statfs = (fs as unknown as {
    statfs?: (target: string) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;
  }).statfs;
  if (!statfs) return null;
  try {
    const stats = await statfs(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function probeRuntime(): Promise<RuntimeProbe> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  const [colmap, gaussian, environment, storage] = await Promise.all([
    resolveColmapRuntime(),
    resolveSplatRuntime(),
    checkEnvironment(),
    freeBytes(storageRoot).then((available) => ({ root: storageRoot, freeBytes: available })),
  ]);
  const value: RuntimeProbe = {
    colmap: colmap
      ? { available: true, managed: colmap.managed, path: colmap.path }
      : { available: false, managed: false },
    gaussian: {
      ready: gaussian.ready,
      mode: gaussian.mode,
      python: gaussian.python,
    },
    environment,
    storage,
    checkedAt: new Date().toISOString(),
  };
  cached = { at: now, value };
  return value;
}

export async function GET() {
  try {
    return NextResponse.json(await probeRuntime(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Runtime probe failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}