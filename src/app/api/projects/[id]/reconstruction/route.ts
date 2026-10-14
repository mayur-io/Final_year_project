import fs from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import {
  installManagedColmap,
  isGlomapCompatible,
  resolveColmapRuntime,
  resolveGlomapRuntime,
} from "@/lib/reconstruction/colmapRuntime";
import { getColmapJob, requestColmapCancel, startColmapJob, startDenseFollowup, type MapperChoice, type ReconstructionReport } from "@/lib/reconstruction/colmapJob";
import {
  getSplatJob,
  installSplatRuntime,
  requestSplatCancel,
  resolveSplatRuntime,
  startSplatJob,
} from "@/lib/reconstruction/splatJob";
import { readPreparationReport } from "@/lib/media/prepareReport";
import { checkEnvironment } from "@/lib/system/environment";
import { projectStorageDirectory } from "@/lib/storage";

async function exists(file: string) {
  return fs.access(file).then(() => true).catch(() => false);
}

async function reconstructionStatus(projectId: string) {
  const artifactDirectory = path.join(
    projectStorageDirectory(projectId),
    "reconstruction",
  );
  const [colmap, glomap, splatRuntime, environment, preparation, report] = await Promise.all([
    resolveColmapRuntime(),
    resolveGlomapRuntime(),
    resolveSplatRuntime(),
    checkEnvironment(),
    readPreparationReport(projectId),
    fs
      .readFile(path.join(artifactDirectory, "report.json"), "utf8")
      .then((contents) => JSON.parse(contents) as ReconstructionReport)
      .catch(() => null),
  ]);
  const sparseDirectory = path.join(artifactDirectory, "sparse", "0");
  const glomapCompatible = colmap && glomap ? await isGlomapCompatible(colmap.path, glomap.path) : false;
  const hasPointCloud = await Promise.all([
    exists(path.join(sparseDirectory, "points3D.bin")),
    exists(path.join(sparseDirectory, "points3D.txt")),
  ]).then((flags) => flags.some(Boolean));
  const hasDense = await exists(path.join(artifactDirectory, "dense", "fused.ply"));
  const hasSplat = await exists(path.join(artifactDirectory, "splat.ply"));
  // splat-info.json is written only by the real gsplat trainer, so its presence
  // is the honest "this is a trained model, not a fixed-parameter preview" flag.
  const splatTrained = await exists(path.join(artifactDirectory, "splat-info.json"));
  return {
    engines: {
      colmapAvailable: Boolean(colmap),
      colmapManaged: colmap?.managed ?? false,
      glomapAvailable: Boolean(glomap),
      glomapManaged: glomap?.managed ?? false,
      glomapCompatible,
      gaussianRuntimeAvailable: splatRuntime.ready,
      gaussianRuntimeMode: splatRuntime.mode,
    },
    environment,
    artifacts: { hasPointCloud, hasDense, hasSplat, splatTrained },
    preparation,
    report,
    job: getColmapJob(projectId),
    splatJob: getSplatJob(projectId),
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
    action?: "install-engine" | "reconstruct" | "build-dense" | "install-splat" | "build-splat" | "cancel-reconstruction" | "cancel-splat";
    mode?: "object" | "environment";
    quality?: "draft" | "balanced" | "high";
    mapper?: MapperChoice;
  };
  try {
    if (body.action === "cancel-reconstruction") {
      const job = requestColmapCancel(id);
      return NextResponse.json({ cancelled: true, job, status: await reconstructionStatus(id) });
    }
    if (body.action === "cancel-splat") {
      const job = requestSplatCancel(id);
      return NextResponse.json({ cancelled: true, job, status: await reconstructionStatus(id) });
    }
    if (body.action === "build-dense") {
      const job = await startDenseFollowup(id);
      return NextResponse.json({ accepted: true, job, status: await reconstructionStatus(id) }, { status: 202 });
    }
    if (body.action === "install-engine") {
      const runtime = await installManagedColmap();
      return NextResponse.json({
        installed: true,
        runtime: { managed: runtime.managed },
        status: await reconstructionStatus(id),
      });
    }
    if (body.action === "install-splat") {
      const runtime = await installSplatRuntime();
      return NextResponse.json({ installed: runtime.ready, status: await reconstructionStatus(id) });
    }
    if (body.action === "build-splat") {
      const job = await startSplatJob(id);
      return NextResponse.json({ accepted: true, job, status: await reconstructionStatus(id) }, { status: 202 });
    }
    // A REJECT preparation must not start reconstruction in the API either.
    const preparation = await readPreparationReport(id);
    if (preparation && preparation.verdict === "REJECT") {
      return NextResponse.json(
        {
          error: `Preparation was rejected, so reconstruction will not start. ${preparation.reasons.join(" ")}`,
          preparation,
        },
        { status: 409 },
      );
    }
    const job = await startColmapJob(
      id,
      body.mode ?? "environment",
      body.quality ?? "draft",
      body.mapper ?? "auto",
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
