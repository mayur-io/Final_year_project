import fs from "fs/promises";
import path from "path";

import { frameExtraction } from "@/lib/media/pipelines/frameExtraction";
import { applyManualFrameRejections } from "@/lib/media/frameReview";
import { filterFrames } from "@/lib/media/tools/openCv";
import { convert360View, probeVideoDuration } from "@/lib/media/tools/ffmpeg";
import { prisma } from "@/lib/prisma";
import { projectStorageDirectory, storageRoot } from "@/lib/storage";

type Direction = { id: string; label: string; yaw: number; pitch: number };

export type Pipeline =
  | "360-conversion"
  | "frame-extraction"
  | "image-preparation";

export type ProcessJob = {
  pipeline: Pipeline;
  state: "queued" | "running" | "cancelling" | "cancelled" | "complete" | "failed";
  phase: string;
  progress: number;
  current?: string;
  completed: number;
  total: number;
  logs: string[];
  error?: string;
  payload: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
};

const MINIMUM_PREPARED_FRAMES = 100;
const MAX_CANDIDATE_FRAMES = 1800;
const MAX_PREPARED_FRAMES = 1200;
const activeJobs = new Map<string, ProcessJob>();
const cancelRequests = new Set<string>();
const recommendedDirections: Direction[] = [
  { id: "front", label: "Front", yaw: 0, pitch: 0 },
  { id: "right", label: "Right", yaw: 90, pitch: 0 },
  { id: "back", label: "Back", yaw: 180, pitch: 0 },
  { id: "left", label: "Left", yaw: -90, pitch: 0 },
  { id: "up", label: "Up", yaw: 0, pitch: 60 },
  { id: "down", label: "Down", yaw: 0, pitch: -60 },
];

function projectDirectory(projectId: string) {
  return projectStorageDirectory(projectId);
}

function jobPath(projectId: string) {
  return path.join(projectDirectory(projectId), "processing-job.json");
}

function processedDirectory(projectId: string) {
  return path.join(projectDirectory(projectId), "processed");
}

function resolveMediaPath(filepath: string) {
  if (path.isAbsolute(filepath)) return filepath;
  const normalized = filepath.replace(/[\\/]+/g, path.sep);
  const storagePrefix = "storage" + path.sep;
  return normalized.startsWith(storagePrefix)
    ? path.join(storageRoot, normalized.slice(storagePrefix.length))
    : path.join(storageRoot, normalized);
}

function payloadWithoutCheckpoint(payload: Record<string, unknown>) {
  const copy = { ...payload };
  delete copy.resumeFromCheckpoint;
  return copy;
}

function payloadsMatch(first: Record<string, unknown>, second: Record<string, unknown>) {
  return JSON.stringify(payloadWithoutCheckpoint(first)) === JSON.stringify(payloadWithoutCheckpoint(second));
}

async function save(projectId: string, job: ProcessJob) {
  activeJobs.set(projectId, job);
  await fs.mkdir(projectDirectory(projectId), { recursive: true });
  await fs.writeFile(jobPath(projectId), JSON.stringify(job, null, 2));
}

function log(job: ProcessJob, message: string) {
  job.logs = [...job.logs, new Date().toLocaleTimeString() + "  " + message].slice(-80);
}

async function update(projectId: string, job: ProcessJob, patch: Partial<ProcessJob>, message?: string) {
  Object.assign(job, patch);
  if (message) log(job, message);
  await save(projectId, job);
}

async function cancelled(projectId: string, job: ProcessJob) {
  if (!cancelRequests.has(projectId)) return false;
  cancelRequests.delete(projectId);
  await update(
    projectId,
    job,
    { state: "cancelled", phase: "Stopped safely", finishedAt: new Date().toISOString() },
    "Stopped after the current safe checkpoint. You can resume from the monitor.",
  );
  return true;
}

async function resetDerivedDirectory(directory: string) {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
}

async function hasCheckpoint(directory: string, name: string) {
  return fs.access(path.join(directory, name + ".complete")).then(() => true).catch(() => false);
}

async function writeCheckpoint(directory: string, name: string) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name + ".complete"), new Date().toISOString());
}

async function removeCandidateStream(directory: string, prefix: string) {
  const files = await fs.readdir(directory).catch(() => []);
  await Promise.all(
    files
      .filter((file) => file.startsWith(prefix + "_"))
      .map((file) => fs.rm(path.join(directory, file), { force: true })),
  );
}

async function filterAndValidate(
  projectId: string,
  job: ProcessJob,
  candidateDirectory: string,
  frameDirectory: string,
) {
  await update(
    projectId,
    job,
    { phase: "Filtering blur and duplicates", progress: 78 },
    "OpenCV is selecting usable frames while preserving every raw candidate.",
  );
  const result = await filterFrames({
    sourceDirectory: candidateDirectory,
    outputDirectory: frameDirectory,
    reportPath: path.join(processedDirectory(projectId), "filter-report.json"),
    maxAcceptedFrames: MAX_PREPARED_FRAMES,
  });
  const manualRejections = await applyManualFrameRejections(projectId);
  const acceptedFrames = (await fs.readdir(frameDirectory)).filter((filename) =>
    /\.(jpe?g|png|webp)$/i.test(filename),
  ).length;
  await update(
    projectId,
    job,
    { progress: 98 },
    "Accepted " + acceptedFrames + "; rejected " + (result.rejectedFrames + manualRejections) + "; flagged " + result.lowDetailFrames + " low-detail frames.",
  );
  if (acceptedFrames < MINIMUM_PREPARED_FRAMES) {
    throw new Error(
      "Only " + acceptedFrames + " usable frames were prepared. At least " + MINIMUM_PREPARED_FRAMES + " are required before reconstruction. Increase the sample rate, capture for longer, or add more 360° views.",
    );
  }
}

export async function getProcessJob(projectId: string) {
  const active = activeJobs.get(projectId);
  if (active) return active;
  try {
    const stored = JSON.parse(await fs.readFile(jobPath(projectId), "utf8")) as ProcessJob;
    if (["queued", "running", "cancelling"].includes(stored.state)) {
      stored.state = "failed";
      stored.phase = "Interrupted";
      stored.error = "The local processing service restarted before this job finished. Resume to restart this step safely.";
      stored.finishedAt = new Date().toISOString();
      await save(projectId, stored);
    }
    return stored;
  } catch {
    return null;
  }
}

export async function requestCancel(projectId: string) {
  const job = await getProcessJob(projectId);
  if (!job || !["queued", "running", "cancelling"].includes(job.state)) return job;
  cancelRequests.add(projectId);
  await update(
    projectId,
    job,
    { state: "cancelling", phase: "Stopping at a safe checkpoint" },
    "Stop requested. The current file will finish before the job stops.",
  );
  return job;
}

export async function startProcessJob(
  projectId: string,
  pipeline: Pipeline,
  payload: Record<string, unknown>,
  forceResume = false,
) {
  const existing = await getProcessJob(projectId);
  if (existing && ["queued", "running", "cancelling"].includes(existing.state)) return existing;
  const resumeFromCheckpoint = forceResume || Boolean(
    existing &&
      existing.pipeline === pipeline &&
      ["cancelled", "failed"].includes(existing.state) &&
      payloadsMatch(existing.payload, payload),
  );
  const job: ProcessJob = {
    pipeline,
    payload: { ...payloadWithoutCheckpoint(payload), resumeFromCheckpoint },
    state: "queued",
    phase: "Queued",
    progress: 0,
    completed: 0,
    total: 0,
    logs: [resumeFromCheckpoint ? "Resuming from the last safe checkpoint." : "Job created."],
    startedAt: new Date().toISOString(),
  };
  await save(projectId, job);
  void execute(projectId, job);
  return job;
}

export async function resumeProcessJob(projectId: string) {
  const job = await getProcessJob(projectId);
  if (!job) throw new Error("There is no processing job to resume.");
  return startProcessJob(projectId, job.pipeline, job.payload, true);
}

async function execute(projectId: string, job: ProcessJob) {
  try {
    await update(
      projectId,
      job,
      { state: "running", phase: "Preparing inputs", progress: 2 },
      "Processing started. You can safely navigate away; this project job continues.",
    );
    if (job.pipeline === "360-conversion") await convert360(projectId, job);
    if (job.pipeline === "frame-extraction") await extract(projectId, job);
    if (job.pipeline === "image-preparation") await prepareImages(projectId, job);
    if (job.state !== "cancelled") {
      await update(
        projectId,
        job,
        { state: "complete", phase: "Complete", progress: 100, finishedAt: new Date().toISOString() },
        "Processing completed. The next visual stage is ready.",
      );
    }
  } catch (error) {
    await update(
      projectId,
      job,
      {
        state: "failed",
        phase: "Needs more coverage",
        error: error instanceof Error ? error.message : "Processing failed.",
        finishedAt: new Date().toISOString(),
      },
      "Processing stopped before reconstruction because the prepared frame set is not reliable enough.",
    );
  }
}

async function sourceVideo(projectId: string) {
  return prisma.media.findFirst({
    where: { projectId, assetType: "VIDEO" },
    orderBy: { createdAt: "asc" },
  });
}

async function convertedVideos(projectId: string) {
  try {
    return (await fs.readdir(path.join(processedDirectory(projectId), "converted")))
      .filter((name) => path.extname(name).toLowerCase() === ".mp4")
      .map((name) => path.join(processedDirectory(projectId), "converted", name));
  } catch {
    return [];
  }
}

async function convert360(projectId: string, job: ProcessJob) {
  const media = await sourceVideo(projectId);
  if (!media || media.workspace !== "VIEWER_360") throw new Error("A 360° video source is required.");
  const raw = Array.isArray(job.payload.directions)
    ? (job.payload.directions as Direction[])
    : recommendedDirections;
  const directions = raw.length ? raw : recommendedDirections;
  if (directions.length > 24) throw new Error("Choose between one and 24 camera directions.");

  const outputDirectory = path.join(processedDirectory(projectId), "converted");
  const resume = job.payload.resumeFromCheckpoint === true;
  if (resume) await fs.mkdir(outputDirectory, { recursive: true });
  else await resetDerivedDirectory(outputDirectory);
  const outputWidth = Math.min(Math.max(Number(job.payload.projectionWidth) || 1600, 960), 3840);
  const outputHeight = Math.round(outputWidth / (16 / 9));
  await update(
    projectId,
    job,
    { phase: "Projecting 360° views", total: directions.length, progress: 4 },
    directions.length + " output views planned at " + outputWidth + "×" + outputHeight + ".",
  );

  for (const [index, direction] of directions.entries()) {
    if (await cancelled(projectId, job)) return;
    const output = path.join(outputDirectory, direction.id + ".mp4");
    const complete = resume
      ? await fs.stat(output).then((file) => file.size > 1024).catch(() => false)
      : false;
    if (complete) {
      await update(
        projectId,
        job,
        {
          current: direction.label,
          completed: index + 1,
          progress: Math.round(4 + ((index + 1) / directions.length) * 90),
        },
        "Reusing completed " + direction.label + " view (" + (index + 1) + "/" + directions.length + ").",
      );
      continue;
    }
    await update(
      projectId,
      job,
      {
        current: direction.label,
        completed: index,
        progress: Math.round(4 + (index / directions.length) * 90),
      },
      "Creating " + direction.label + " view (" + (index + 1) + "/" + directions.length + ").",
    );
    await convert360View({
      input: resolveMediaPath(media.filepath),
      output,
      yaw: Number(direction.yaw) || 0,
      pitch: Number(direction.pitch) || 0,
      fieldOfView: Number(job.payload.fieldOfView) || 100,
      outputWidth,
      outputHeight,
    });
    await update(projectId, job, {
      completed: index + 1,
      progress: Math.round(4 + ((index + 1) / directions.length) * 90),
    });
  }
}

async function extract(projectId: string, job: ProcessJob) {
  const media = await sourceVideo(projectId);
  if (!media) throw new Error("No video source is available for frame extraction.");
  const settings = (job.payload.settings as Record<string, unknown>) ?? {};
  const inputs = media.workspace === "VIEWER_360"
    ? await convertedVideos(projectId)
    : [resolveMediaPath(media.filepath)];
  if (!inputs.length) throw new Error("Create at least one projected 360° view before extracting frames.");

  const candidatesDirectory = path.join(processedDirectory(projectId), "candidates");
  const checkpointsDirectory = path.join(candidatesDirectory, ".checkpoints");
  const frameDirectory = path.join(processedDirectory(projectId), "frames");
  const resume = job.payload.resumeFromCheckpoint === true;
  if (resume) {
    await Promise.all([
      fs.mkdir(candidatesDirectory, { recursive: true }),
      fs.mkdir(frameDirectory, { recursive: true }),
    ]);
  } else {
    await Promise.all([
      resetDerivedDirectory(candidatesDirectory),
      resetDerivedDirectory(frameDirectory),
    ]);
  }

  const requestedFps = Math.min(Math.max(Number(settings.fps) || 3, 0.1), 30);
  const durations = await Promise.all(inputs.map((input) => probeVideoDuration(input)));
  const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const budgetedFps = Math.max(0.1, MAX_CANDIDATE_FRAMES / totalDuration);
  const effectiveFps = Math.min(requestedFps, budgetedFps);

  await update(
    projectId,
    job,
    { phase: "Extracting frames", total: inputs.length, progress: 5 },
    inputs.length + " video stream" + (inputs.length === 1 ? "" : "s") + " queued at " + effectiveFps.toFixed(2) + " fps (" + MAX_CANDIDATE_FRAMES + " candidate-frame budget).",
  );
  for (const [index, input] of inputs.entries()) {
    if (await cancelled(projectId, job)) return;
    const prefix = inputs.length > 1
      ? path.basename(input, path.extname(input))
      : "camera-path-01";
    if (resume && (await hasCheckpoint(checkpointsDirectory, prefix))) {
      await update(
        projectId,
        job,
        {
          current: path.basename(input),
          completed: index + 1,
          progress: Math.round(5 + ((index + 1) / inputs.length) * 68),
        },
        "Reusing extracted frames from " + path.basename(input) + " (" + (index + 1) + "/" + inputs.length + ").",
      );
      continue;
    }

    await removeCandidateStream(candidatesDirectory, prefix);
    await update(
      projectId,
      job,
      {
        current: path.basename(input),
        completed: index,
        progress: Math.round(5 + (index / inputs.length) * 68),
      },
      "Extracting frames from " + path.basename(input) + " (" + (index + 1) + "/" + inputs.length + ").",
    );
    await frameExtraction({
      projectId,
      mediaPath: input,
      mediaName: path.basename(input),
      outputDirectory: candidatesDirectory,
      fps: effectiveFps,
      quality: Math.min(Math.max(Number(settings.quality) || 2, 2), 31),
      startTime: Number.isFinite(Number(settings.startTime)) ? Number(settings.startTime) : undefined,
      endTime: Number.isFinite(Number(settings.endTime)) ? Number(settings.endTime) : undefined,
      outputPrefix: prefix,
    });
    await writeCheckpoint(checkpointsDirectory, prefix);
    await update(projectId, job, {
      completed: index + 1,
      progress: Math.round(5 + ((index + 1) / inputs.length) * 68),
    });
  }
  if (await cancelled(projectId, job)) return;
  await filterAndValidate(projectId, job, candidatesDirectory, frameDirectory);
}

async function prepareImages(projectId: string, job: ProcessJob) {
  const images = await prisma.media.findMany({
    where: { projectId, assetType: "IMAGE" },
    orderBy: { createdAt: "asc" },
  });
  if (images.length < MINIMUM_PREPARED_FRAMES) {
    throw new Error("An image sequence needs at least " + MINIMUM_PREPARED_FRAMES + " images.");
  }

  const candidatesDirectory = path.join(processedDirectory(projectId), "candidates");
  const frameDirectory = path.join(processedDirectory(projectId), "frames");
  const resume = job.payload.resumeFromCheckpoint === true;
  if (resume) {
    await Promise.all([
      fs.mkdir(candidatesDirectory, { recursive: true }),
      fs.mkdir(frameDirectory, { recursive: true }),
    ]);
  } else {
    await Promise.all([
      resetDerivedDirectory(candidatesDirectory),
      resetDerivedDirectory(frameDirectory),
    ]);
  }

  await update(
    projectId,
    job,
    { phase: "Staging image sequence", total: images.length, progress: 3 },
    images.length + " source images queued.",
  );
  for (const [index, image] of images.entries()) {
    if (await cancelled(projectId, job)) return;
    const extension = path.extname(image.filename).toLowerCase();
    const destination = path.join(
      candidatesDirectory,
      "sequence_" + (index + 1).toString().padStart(6, "0") + extension,
    );
    const copied = await fs.access(destination).then(() => true).catch(() => false);
    if (!copied) await fs.copyFile(resolveMediaPath(image.filepath), destination);
    await update(projectId, job, {
      current: image.filename,
      completed: index + 1,
      progress: Math.round(3 + ((index + 1) / images.length) * 72),
    });
  }
  if (await cancelled(projectId, job)) return;
  await filterAndValidate(projectId, job, candidatesDirectory, frameDirectory);
}
