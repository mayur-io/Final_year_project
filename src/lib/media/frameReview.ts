import fs from "fs/promises";
import path from "path";

import { projectStorageDirectory } from "@/lib/storage";

export type RejectedFrame = {
  filename: string;
  reason: string;
  source: "automatic" | "manual";
  reviewedAt: string;
};

type ReviewManifest = {
  manualRejected: Record<string, RejectedFrame>;
};

function processedDirectory(projectId: string) {
  return path.join(projectStorageDirectory(projectId), "processed");
}

function manifestPath(projectId: string) {
  return path.join(processedDirectory(projectId), "frame-review.json");
}

async function readManifest(projectId: string): Promise<ReviewManifest> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(projectId), "utf8")) as ReviewManifest;
  } catch {
    return { manualRejected: {} };
  }
}

async function writeManifest(projectId: string, manifest: ReviewManifest) {
  await fs.mkdir(processedDirectory(projectId), { recursive: true });
  await fs.writeFile(manifestPath(projectId), JSON.stringify(manifest, null, 2));
}

function assertSafeFilename(filename: string) {
  if (!filename || path.basename(filename) !== filename) {
    throw new Error("An invalid frame name was provided.");
  }
}

async function candidatePath(projectId: string, filename: string) {
  assertSafeFilename(filename);
  const candidate = path.join(processedDirectory(projectId), "candidates", filename);
  await fs.access(candidate);
  return candidate;
}

export async function rejectFrames(projectId: string, filenames: string[]) {
  const manifest = await readManifest(projectId);
  const frameDirectory = path.join(processedDirectory(projectId), "frames");
  for (const filename of filenames) {
    await candidatePath(projectId, filename);
    await fs.rm(path.join(frameDirectory, filename), { force: true });
    manifest.manualRejected[filename] = {
      filename,
      reason: "Rejected during manual review",
      source: "manual",
      reviewedAt: new Date().toISOString(),
    };
  }
  await writeManifest(projectId, manifest);
}

export async function restoreFrames(projectId: string, filenames: string[]) {
  const manifest = await readManifest(projectId);
  const frameDirectory = path.join(processedDirectory(projectId), "frames");
  await fs.mkdir(frameDirectory, { recursive: true });
  for (const filename of filenames) {
    const candidate = await candidatePath(projectId, filename);
    await fs.copyFile(candidate, path.join(frameDirectory, filename));
    delete manifest.manualRejected[filename];
  }
  await writeManifest(projectId, manifest);
}

export async function applyManualFrameRejections(projectId: string) {
  const manifest = await readManifest(projectId);
  const frameDirectory = path.join(processedDirectory(projectId), "frames");
  const rejected = Object.keys(manifest.manualRejected);
  await Promise.all(
    rejected.map((filename) => fs.rm(path.join(frameDirectory, filename), { force: true })),
  );
  return rejected.length;
}

export async function getFrameReview(projectId: string) {
  const processed = processedDirectory(projectId);
  const [manifest, report] = await Promise.all([
    readManifest(projectId),
    fs
      .readFile(path.join(processed, "filter-report.json"), "utf8")
      .then((content) => JSON.parse(content) as { rejected?: { frame: string; reason: string }[] })
      .catch(() => ({ rejected: [] })),
  ]);
  const automatic = (report.rejected ?? [])
    .filter((entry) => !manifest.manualRejected[entry.frame])
    .map<RejectedFrame>((entry) => ({
      filename: entry.frame,
      reason: entry.reason,
      source: "automatic",
      reviewedAt: "",
    }));
  return [...Object.values(manifest.manualRejected), ...automatic].sort((first, second) =>
    first.filename.localeCompare(second.filename),
  );
}
