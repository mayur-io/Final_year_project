import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

import { resolveColmapRuntime } from "@/lib/reconstruction/colmapRuntime";
import { projectStorageDirectory } from "@/lib/storage";

type ReconstructionMode = "object" | "environment";
type Quality = "draft" | "balanced" | "high";
type JobPhase =
  | "queued"
  | "features"
  | "matching"
  | "mapping"
  | "complete"
  | "failed";

export type ColmapJob = {
  phase: JobPhase;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  logs: string[];
};

const jobs = new Map<string, ColmapJob>();
const imageSizeByQuality: Record<Quality, number> = {
  draft: 1024,
  balanced: 1400,
  high: 2000,
};
const minimumFrameCount = 100;

function gigabytes(bytes: number) {
  return (bytes / 1024 ** 3).toFixed(1);
}

function addLog(job: ColmapJob, message: string) {
  job.logs = [...job.logs, message].slice(-80);
}

async function hasSparsePointCloud(sparseDirectory: string) {
  const modelDirectory = path.join(sparseDirectory, "0");
  return await Promise.all([
    fs
      .access(path.join(modelDirectory, "points3D.bin"))
      .then(() => true)
      .catch(() => false),
    fs
      .access(path.join(modelDirectory, "points3D.txt"))
      .then(() => true)
      .catch(() => false),
  ]).then((results) => results.some(Boolean));
}

function frameParts(filename: string) {
  const match = /^(.*)_(\d+)\.(?:jpe?g|png|webp)$/i.exec(filename);
  return match ? { stream: match[1], index: Number(match[2]) } : null;
}

async function createMatchingPlan(
  outputDirectory: string,
  frameNames: string[],
) {
  const pairs = new Set<string>();
  const addPair = (first: string, second: string) => {
    if (first === second) return;
    pairs.add([first, second].sort().join(" "));
  };
  const parsed = frameNames
    .map((name) => ({ name, parts: frameParts(name) }))
    .filter((item): item is { name: string; parts: NonNullable<ReturnType<typeof frameParts>> } => Boolean(item.parts));

  if (parsed.length === frameNames.length) {
    const byStream = new Map<string, { name: string; parts: NonNullable<ReturnType<typeof frameParts>> }[]>();
    const byIndex = new Map<number, string[]>();
    for (const item of parsed) {
      byStream.set(item.parts.stream, [...(byStream.get(item.parts.stream) ?? []), item]);
      byIndex.set(item.parts.index, [...(byIndex.get(item.parts.index) ?? []), item.name]);
    }
    for (const streamFrames of byStream.values()) {
      streamFrames.sort((first, second) => first.parts.index - second.parts.index);
      for (let index = 0; index < streamFrames.length; index += 1) {
        for (let offset = 1; offset <= 3; offset += 1) {
          const next = streamFrames[index + offset];
          if (next) addPair(streamFrames[index].name, next.name);
        }
      }
    }
    for (const synchronizedFrames of byIndex.values()) {
      for (let first = 0; first < synchronizedFrames.length; first += 1) {
        for (let second = first + 1; second < synchronizedFrames.length; second += 1) {
          addPair(synchronizedFrames[first], synchronizedFrames[second]);
        }
      }
    }
  } else {
    const ordered = [...frameNames].sort();
    for (let index = 0; index < ordered.length; index += 1) {
      for (let offset = 1; offset <= 3; offset += 1) {
        if (ordered[index + offset]) addPair(ordered[index], ordered[index + offset]);
      }
    }
  }

  const matchListPath = path.join(outputDirectory, "matching-plan.txt");
  await fs.writeFile(matchListPath, [...pairs].join("\n"));
  return { matchListPath, pairCount: pairs.size };
}

function runColmap(binaryPath: string, args: string[], job: ColmapJob) {
  return new Promise<void>((resolve, reject) => {
    const isBatchFile = path.extname(binaryPath).toLowerCase() === ".bat";
    const process = isBatchFile
      ? spawn(
          "cmd.exe",
          [
            "/d",
            "/c",
            `"${binaryPath}" ${args.map((value) => `"${value.replace(/"/g, '""')}"`).join(" ")}`,
          ],
          { windowsHide: true },
        )
      : spawn(binaryPath, args, { windowsHide: true });
    const write = (chunk: Buffer) =>
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => addLog(job, line));
    process.stdout.on("data", write);
    process.stderr.on("data", write);
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`COLMAP exited with code ${code ?? "unknown"}.`)),
    );
  });
}

export function getColmapJob(projectId: string) {
  return jobs.get(projectId) ?? null;
}

export async function startColmapJob(
  projectId: string,
  mode: ReconstructionMode,
  quality: Quality,
) {
  const existing = jobs.get(projectId);
  if (existing && !["complete", "failed"].includes(existing.phase))
    return existing;

  const runtime = await resolveColmapRuntime();
  if (!runtime) throw new Error("The managed COLMAP engine is not ready yet.");
  const projectDirectory = projectStorageDirectory(projectId);
  const imageDirectory = path.join(projectDirectory, "processed", "frames");
  const outputDirectory = path.join(projectDirectory, "reconstruction");
  const frameNames = await fs.readdir(imageDirectory).catch(() => []);
  const frameCount = frameNames.filter((name) =>
    /\.(jpe?g|png|webp)$/i.test(name),
  ).length;
  if (frameCount < minimumFrameCount)
    throw new Error(
      `At least ${minimumFrameCount} prepared images are required for reconstruction. Return to capture preparation and increase coverage before starting COLMAP.`,
    );
  const filesystem = await fs.statfs(projectDirectory);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredBytes = Math.max(10 * 1024 ** 3, frameCount * 35 * 1024 ** 2);
  if (availableBytes < requiredBytes)
    throw new Error(
      `Not enough project storage. This reconstruction needs about ${gigabytes(requiredBytes)} GB free; ${gigabytes(availableBytes)} GB is available in the selected storage location.`,
    );

  const job: ColmapJob = {
    phase: "queued",
    startedAt: new Date().toISOString(),
    logs: ["Reconstruction queued."],
  };
  jobs.set(projectId, job);
  void (async () => {
    const databasePath = path.join(outputDirectory, "database.db");
    const sparseDirectory = path.join(outputDirectory, "sparse");
    try {
      await fs.rm(outputDirectory, { recursive: true, force: true });
      await fs.mkdir(sparseDirectory, { recursive: true });
      job.phase = "features";
      addLog(job, "Extracting image features.");
      await runColmap(
        runtime.path,
        [
          "feature_extractor",
          "--database_path",
          databasePath,
          "--image_path",
          imageDirectory,
          "--ImageReader.single_camera",
          "1",
          "--FeatureExtraction.max_image_size",
          String(imageSizeByQuality[quality]),
        ],
        job,
      );
      const matchingPlan = await createMatchingPlan(outputDirectory, frameNames);
      job.phase = "matching";
      addLog(job, `Matching ${matchingPlan.pairCount.toLocaleString()} planned image pairs.`);
      await runColmap(
        runtime.path,
        [
          "matches_importer",
          "--database_path",
          databasePath,
          "--match_list_path",
          matchingPlan.matchListPath,
          "--match_type",
          "pairs",
        ],
        job,
      );
      job.phase = "mapping";
      if (mode === "environment") {
        addLog(
          job,
          "Trying GLOMAP global layout using available camera priors.",
        );
        try {
          await runColmap(
            runtime.path,
            [
              "global_mapper",
              "--database_path",
              databasePath,
              "--image_path",
              imageDirectory,
              "--output_path",
              sparseDirectory,
            ],
            job,
          );
        } catch {
          addLog(
            job,
            "GLOMAP could not solve the uncalibrated capture. Falling back to COLMAP incremental mapping.",
          );
          await fs.rm(sparseDirectory, { recursive: true, force: true });
          await fs.mkdir(sparseDirectory, { recursive: true });
          await runColmap(
            runtime.path,
            [
              "mapper",
              "--database_path",
              databasePath,
              "--image_path",
              imageDirectory,
              "--output_path",
              sparseDirectory,
            ],
            job,
          );
        }
      } else {
        addLog(job, "Solving object camera layout with incremental mapping.");
        await runColmap(
          runtime.path,
          [
            "mapper",
            "--database_path",
            databasePath,
            "--image_path",
            imageDirectory,
            "--output_path",
            sparseDirectory,
          ],
          job,
        );
      }

      const modelAvailable = await hasSparsePointCloud(sparseDirectory);
      if (!modelAvailable) {
        throw new Error(
          "COLMAP exited without producing a usable sparse point cloud. This usually means the image set has insufficient overlap or bad initial pair selection.",
        );
      }

      job.phase = "complete";
      job.finishedAt = new Date().toISOString();
      addLog(job, "Sparse reconstruction completed.");
    } catch (error) {
      job.phase = "failed";
      job.finishedAt = new Date().toISOString();
      job.error =
        error instanceof Error
          ? error.message
          : "COLMAP reconstruction failed.";
      addLog(job, job.error);
    }
  })();
  return job;
}
