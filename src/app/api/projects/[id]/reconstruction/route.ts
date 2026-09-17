import fs from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import {
  installManagedColmap,
  resolveColmapRuntime,
} from "@/lib/reconstruction/colmapRuntime";
import { getColmapJob, startColmapJob } from "@/lib/reconstruction/colmapJob";
import { projectStorageDirectory } from "@/lib/storage";

async function reconstructionStatus(projectId: string) {
  const colmap = await resolveColmapRuntime();
  const artifactDirectory = path.join(
    projectStorageDirectory(projectId),
    "reconstruction",
  );
  const sparseDirectory = path.join(artifactDirectory, "sparse", "0");
  const hasPointCloud = await Promise.all([
    fs
      .access(path.join(sparseDirectory, "points3D.bin"))
      .then(() => true)
      .catch(() => false),
    fs
      .access(path.join(sparseDirectory, "points3D.txt"))
      .then(() => true)
      .catch(() => false),
  ]).then((flags) => flags.some(Boolean));
  const hasSplat = await fs
    .access(path.join(artifactDirectory, "splat.ply"))
    .then(() => true)
    .catch(() => false);
  return {
    engines: {
      colmapAvailable: Boolean(colmap),
      colmapManaged: colmap?.managed ?? false,
      gaussianRuntimeAvailable: false,
    },
    artifacts: { hasPointCloud, hasSplat },
    job: getColmapJob(projectId),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json(await reconstructionStatus(id));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "install-engine" | "reconstruct";
    mode?: "object" | "environment";
    quality?: "draft" | "balanced" | "high";
  };
  try {
    if (body.action === "install-engine") {
      const runtime = await installManagedColmap();
      return NextResponse.json({
        installed: true,
        runtime: { managed: runtime.managed },
        status: await reconstructionStatus(id),
      });
    }
    const job = await startColmapJob(
      id,
      body.mode ?? "environment",
      body.quality ?? "balanced",
    );
    return NextResponse.json(
      { accepted: true, job, status: await reconstructionStatus(id) },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Engine setup failed.",
      },
      { status: 500 },
    );
  }
}
