import fs from "fs/promises";
import path from "path";

import { frameExtraction } from "@/lib/media/pipelines/frameExtraction";
import { applyManualFrameRejections } from "@/lib/media/frameReview";
import { analyzeSequenceCoverage, filterFrames, frameDifference, scoreFrame } from "@/lib/media/tools/openCv";
import { convert360View, extractSingleFrame, isEquirectangular, probeVideoDuration, probeVideoInfo } from "@/lib/media/tools/ffmpeg";
import { planEquirectViews } from "@/lib/media/planViews";
import {
  type FramesManifest,
  type PreparationReport,
  type PreparedFrame,
  type SourceType,
  writeFramesManifest,
  writePreparationReport,
} from "@/lib/media/prepareReport";
import { prisma } from "@/lib/prisma";
import { projectStorageDirectory, storageRoot } from "@/lib/storage";

type Direction = { id: string; label: string; yaw: number; pitch: number; roll?: number; fieldOfView?: number };

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
const DEFAULT_PROJECTION_FOV = 90;
const DEFAULT_PROJECTION_OVERLAP = 0.15;

/**
 * Optional time bound coming from the UI. The form submits empty bounds as
 * null or "", and `Number(null)` is 0 — which is finite — so a naive
 * `Number.isFinite(Number(value))` check silently turned "no end time" into
 * "end at 0s" and truncated every stream to a single frame.
 */
function optionalSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const activeJobs = new Map<string, ProcessJob>();
const cancelRequests = new Set<string>();
// The default 360° projection set is derived from the field of view and the
// overlap needed for matching — not a fixed "6" or "8" view preset.
const recommendedDirections: Direction[] = planEquirectViews({
  fieldOfView: DEFAULT_PROJECTION_FOV,
  overlap: DEFAULT_PROJECTION_OVERLAP,
});

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

type PreparationContext = {
  sourceType: SourceType;
  sourceFilenames: string[];
  sourceMeta?: PreparationReport["source"];
  frameRate?: number;
  projection?: PreparationReport["projection"];
  settings?: Record<string, unknown>;
  motion?: { state: PreparationReport["evidence"]["motion"]; score?: number };
  startedAt: number;
};

type ProjectionPlan = NonNullable<PreparationReport["projection"]>;

function sourceTypeFromMedia(media: { assetType: string; workspace: string }): SourceType {
  if (media.assetType === "IMAGE") return "image-sequence";
  return media.workspace === "VIEWER_360" ? "360-video" : "normal-video";
}

function relativeFramePath(filename: string) {
  return ["processed", "frames", filename].join("/");
}

function buildManifest(
  projectId: string,
  context: PreparationContext,
  acceptedNames: string[],
): FramesManifest {
  const acceptedAt = new Date().toISOString();
  const fps = context.frameRate && context.frameRate > 0 ? context.frameRate : 1;
  const frames: PreparedFrame[] = acceptedNames.map((filename, order) => {
    const stem = path.basename(filename, path.extname(filename));
    const match = /^(.*)_(\d+)$/.exec(stem);
    const prefix = match ? match[1] : stem;
    const index = match ? Number(match[2]) : order + 1;
    if (context.sourceType === "image-sequence") {
      return {
        filename,
        relativePath: relativeFramePath(filename),
        sourceKind: "image-sequence",
        sourceFilename: context.sourceFilenames[index - 1] ?? filename,
        sourceOrder: index,
        acceptedAt,
      };
    }
    const view = context.projection?.views?.find((candidate) => candidate.id === prefix);
    return {
      filename,
      relativePath: relativeFramePath(filename),
      sourceKind: context.sourceType === "360-video" ? "360-projection" : "normal-video",
      sourceFilename: context.sourceFilenames[0] ?? filename,
      sourceOrder: index,
      timestampSeconds: Number((index / fps).toFixed(3)),
      projection: view
        ? { viewId: view.id, yaw: view.yaw, pitch: view.pitch, roll: view.roll, fov: view.fov }
        : undefined,
      acceptedAt,
    };
  });
  return { version: 1, projectId, sourceType: context.sourceType, frames };
}

function projectionPlanPath(projectId: string) {
  return path.join(processedDirectory(projectId), "projection.json");
}

async function writeProjectionPlan(projectId: string, plan: ProjectionPlan) {
  await fs.mkdir(processedDirectory(projectId), { recursive: true });
  await fs.writeFile(projectionPlanPath(projectId), JSON.stringify(plan, null, 2));
}

async function readProjectionPlan(projectId: string): Promise<ProjectionPlan | null> {
  try {
    return JSON.parse(await fs.readFile(projectionPlanPath(projectId), "utf8")) as ProjectionPlan;
  } catch {
    return null;
  }
}

/**
 * Persist a REJECT before the job even reaches frame selection (bad geometry,
 * static capture, unreadable source). The UI reads this report, and the
 * reconstruction route refuses to start, so the user gets the reason instead
 * of a silent failure.
 */
async function writeRejectedPreparation(
  projectId: string,
  context: PreparationContext,
  reason: string,
  motion?: { state: PreparationReport["evidence"]["motion"]; score?: number },
) {
  const report: PreparationReport = {
    version: 1,
    projectId,
    sourceType: context.sourceType,
    reconstructionIntent: null,
    verdict: "REJECT",
    reasons: [reason],
    warnings: [],
    source: context.sourceMeta ?? { filenames: context.sourceFilenames },
    selection: {
      candidates: 0,
      accepted: 0,
      rejected: 0,
      unreadable: 0,
      blurry: 0,
      duplicates: 0,
      textureless: 0,
      outliers: 0,
      manuallyRejected: 0,
      maxAccepted: MAX_PREPARED_FRAMES,
    },
    evidence: {
      motion: motion?.state ?? "unknown",
      motionScore: motion?.score,
      overlap: "unknown",
      coverage: "unknown",
      sky: "not_checked",
      dynamicObjects: "not_implemented",
    },
    projection: context.projection,
    settings: context.settings ?? {},
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - context.startedAt,
  };
  await writePreparationReport(projectId, report);
  await writeFramesManifest(projectId, {
    version: 1,
    projectId,
    sourceType: context.sourceType,
    frames: [],
  });
}

async function filterAndValidate(
  projectId: string,
  job: ProcessJob,
  candidateDirectory: string,
  frameDirectory: string,
  context: PreparationContext,
) {
  await update(
    projectId,
    job,
    { phase: "Filtering blur and duplicates", progress: 78 },
    "Rejecting blur, duplicates and textureless frames while preserving every raw candidate.",
  );
  const result = await filterFrames({
    sourceDirectory: candidateDirectory,
    outputDirectory: frameDirectory,
    reportPath: path.join(processedDirectory(projectId), "filter-report.json"),
    maxAcceptedFrames: MAX_PREPARED_FRAMES,
  });
  const manualRejections = await applyManualFrameRejections(projectId);
  const existing = new Set(await fs.readdir(frameDirectory).catch(() => []));
  const acceptedNames = result.frames.filter((filename) => existing.has(filename));
  const accepted = acceptedNames.length;

  // Real coverage/overlap validation on the accepted set: a sequence with no
  // viewpoint change cannot reconstruct, and neighbours that look unrelated
  // will not match. Both are measured, not assumed.
  const coverage = accepted >= 2 ? await analyzeSequenceCoverage(frameDirectory, acceptedNames) : null;

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (context.sourceType === "360-video" && (context.projection?.views?.length ?? 0) === 0) {
    reasons.push("No perspective views were planned for this 360° capture.");
  }
  if (accepted < MINIMUM_PREPARED_FRAMES) {
    reasons.push(
      `Only ${accepted} usable frames were selected; at least ${MINIMUM_PREPARED_FRAMES} are required before reconstruction. Capture for longer, move slower, or add more overlapping views.`,
    );
  }
  if (coverage && coverage.coverage === "insufficient") {
    reasons.push(
      `The selected frames barely change viewpoint (mean frame difference ${coverage.meanDifference.toFixed(2)}). 3D reconstruction needs parallax — move the camera around the object or scene, then re-run.`,
    );
  }
  if (coverage && coverage.overlap === "insufficient") {
    warnings.push(
      `Neighbouring frames look visually unrelated (mean similarity ${coverage.meanSimilarity.toFixed(2)}). Matching may be weak; capture a smoother, denser pass with more overlap.`,
    );
  }
  if (result.skyFrames > 0) {
    warnings.push(
      `${result.skyFrames} frame(s) contain large sky or bright uniform regions. They were kept because they also contain scene detail — no semantic sky mask was applied.`,
    );
  }
  if (result.lowDetailFrames > 0) {
    warnings.push(`${result.lowDetailFrames} low-detail frame(s) were removed to protect matching.`);
  }
  if (context.motion?.state === "low") {
    warnings.push(
      `Camera motion is low (score ${context.motion.score?.toFixed(2) ?? "n/a"}). Reconstruction may be weak; use a slower, wider orbit with more parallax next time.`,
    );
  }
  if (result.outlierFrames > 0) {
    warnings.push(`${result.outlierFrames} frame(s) did not match the dominant scene and were dropped.`);
  }

  const verdict: PreparationReport["verdict"] = reasons.length
    ? "REJECT"
    : warnings.length
      ? "WARN"
      : "PASS";

  const report: PreparationReport = {
    version: 1,
    projectId,
    sourceType: context.sourceType,
    reconstructionIntent: null,
    verdict,
    reasons,
    warnings,
    source: context.sourceMeta ?? { filenames: context.sourceFilenames },
    selection: {
      candidates: result.sampledFrames,
      accepted,
      rejected: result.rejectedFrames,
      unreadable: result.rejected.filter((entry) => entry.reason === "unreadable").length,
      blurry: result.blurredFrames,
      duplicates: result.duplicateFrames,
      textureless: result.rejected.filter((entry) => entry.reason === "textureless").length,
      outliers: result.outlierFrames,
      manuallyRejected: manualRejections,
      maxAccepted: MAX_PREPARED_FRAMES,
    },
    evidence: {
      motion: context.motion?.state ?? "unknown",
      motionScore: context.motion?.score,
      overlap: coverage?.overlap ?? (context.sourceType === "360-video" ? "plausible" : "unknown"),
      overlapScore: coverage?.meanSimilarity,
      coverage: coverage?.coverage ?? "unknown",
      coverageScore: coverage?.meanDifference,
      sky: result.skyFrames > 0 ? "warned" : "not_checked",
      dynamicObjects: "manual_review",
    },
    projection: context.projection,
    settings: context.settings ?? {},
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - context.startedAt,
  };
  await writeFramesManifest(projectId, buildManifest(projectId, context, acceptedNames));
  await writePreparationReport(projectId, report);
  await update(
    projectId,
    job,
    { progress: 98 },
    `Preparation verdict ${verdict}: accepted ${accepted}, rejected ${result.rejectedFrames + manualRejections}, ${warnings.length} warning(s).`,
  );
  if (verdict === "REJECT") throw new Error(reasons.join(" "));
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

/**
 * Dismiss a terminal (failed/cancelled) job banner. Only clears the record —
 * active jobs cannot be dismissed, only cancelled. Checkpoints on disk stay,
 * so a dismissed job can still be restarted cleanly from the relevant stage.
 */
export async function dismissProcessJob(projectId: string) {
  const job = await getProcessJob(projectId);
  if (job && ["queued", "running", "cancelling"].includes(job.state)) return job;
  activeJobs.delete(projectId);
  cancelRequests.delete(projectId);
  await fs.rm(jobPath(projectId), { force: true });
  return null;
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
    const message = error instanceof Error ? error.message : "Processing failed.";
    await update(
      projectId,
      job,
      {
        state: "failed",
        phase: "Needs more coverage",
        error: message,
        finishedAt: new Date().toISOString(),
      },
      "Processing stopped: " + message,
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
  const info = await probeVideoInfo(resolveMediaPath(media.filepath));
  const ratio = info.height > 0 ? info.width / info.height : 0;
  if (!isEquirectangular(info.width, info.height)) {
    throw new Error(
      `This clip is ${info.width}×${info.height} (${ratio.toFixed(2)}:1), not a 2:1 equirectangular 360° capture. Upload a stitched equirectangular panorama or use the normal-video route.`,
    );
  }
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
      roll: Number(direction.roll) || 0,
      fieldOfView: Math.min(
        Math.max(
          Number(direction.fieldOfView) || Number(job.payload.fieldOfView) || DEFAULT_PROJECTION_FOV,
          50,
        ),
        120,
      ),
      outputWidth,
      outputHeight,
    });
    await update(projectId, job, {
      completed: index + 1,
      progress: Math.round(4 + ((index + 1) / directions.length) * 90),
    });
    // Per-view quality gate: sample the middle frame before extraction burns
    // minutes on a view that can never reconstruct (sky / blank / unreadable).
    const gateSample = path.join(outputDirectory, "gate-" + direction.id + ".jpg");
    try {
      const viewInfo = await probeVideoInfo(output);
      await extractSingleFrame(output, gateSample, viewInfo.duration / 2);
      const score = await scoreFrame(gateSample);
      if (!score) {
        await update(
          projectId,
          job,
          {},
          `View "${direction.label}" produced an unreadable sample frame. Continuing; extraction will skip frames it cannot read.`,
        );
      } else if (score.textureless) {
        await update(
          projectId,
          job,
          {},
          `View "${direction.label}" is largely blank or textureless. It was kept, but extraction will drop its frames; a global seam shift can move it off the empty area.`,
        );
      } else {
        if (score.skyDominated) {
          await update(
            projectId,
            job,
            {},
            `View "${direction.label}" contains a large sky/bright area. It was kept; extraction will filter frames. No semantic sky mask is applied.`,
          );
        }
        if (score.sharpness < 6) {
          await update(projectId, job, {}, `View "${direction.label}" looks soft (sharpness ${score.sharpness.toFixed(1)}). Continuing, but expect heavy filtering.`);
        }
      }
    } finally {
      await fs.rm(gateSample, { force: true });
    }
  }

  // Persist the exact projection settings so extraction can record per-frame
  // provenance (which view, which yaw/pitch/FOV) instead of guessing.
  await writeProjectionPlan(projectId, {
    enabled: true,
    fov: Number(job.payload.fieldOfView) || DEFAULT_PROJECTION_FOV,
    overlap: Number(job.payload.overlap) || DEFAULT_PROJECTION_OVERLAP,
    outputWidth,
    outputHeight,
    views: directions.map((direction) => ({
      id: direction.id,
      yaw: Number(direction.yaw) || 0,
      pitch: Number(direction.pitch) || 0,
      roll: Number(direction.roll) || 0,
      fov: Math.min(
        Math.max(
          Number(direction.fieldOfView) || Number(job.payload.fieldOfView) || DEFAULT_PROJECTION_FOV,
          50,
        ),
        120,
      ),
    })),
  });
}

async function extract(projectId: string, job: ProcessJob) {
  const media = await sourceVideo(projectId);
  if (!media) throw new Error("No video source is available for frame extraction.");
  const settings = (job.payload.settings as Record<string, unknown>) ?? {};
  const sourceType = sourceTypeFromMedia(media);
  const inputs = media.workspace === "VIEWER_360"
    ? await convertedVideos(projectId)
    : [resolveMediaPath(media.filepath)];
  if (!inputs.length) throw new Error("Create at least one projected 360° view before extracting frames.");
  const context: PreparationContext = {
    sourceType,
    sourceFilenames: [media.filename],
    projection: (await readProjectionPlan(projectId)) ?? undefined,
    settings,
    startedAt: Date.now(),
  };

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

  // Static-capture detector: a camera that never translates has zero
  // baseline — no SfM can solve it. Fail in seconds with guidance instead
  // of extracting hundreds of duplicates and failing mapping minutes later.
  // testRoom measured 0.62 across 6s (duplicate threshold 0.75).
  if (durations[0] > 3) {
    const probeA = path.join(candidatesDirectory, "motion-a.jpg");
    const probeB = path.join(candidatesDirectory, "motion-b.jpg");
    try {
      const first = inputs[0];
      await extractSingleFrame(first, probeA, durations[0] * 0.3);
      await extractSingleFrame(first, probeB, durations[0] * 0.7);
      const motion = await frameDifference(probeA, probeB);
      if (motion !== null && motion < 1.5) {
        const reason = `This capture looks static (frames ${(durations[0] * 0.4).toFixed(0)}s apart barely differ). 3D reconstruction needs a moving camera — walk around the object or scene while capturing, then re-upload.`;
        await writeRejectedPreparation(projectId, context, reason, { state: "static", score: motion });
        throw new Error(reason);
      }
      if (motion !== null) {
        context.motion = motion < 4 ? { state: "low", score: motion } : { state: "usable", score: motion };
      }
    } finally {
      await fs.rm(probeA, { force: true });
      await fs.rm(probeB, { force: true });
    }
  }
  const budgetedFps = Math.max(0.1, MAX_CANDIDATE_FRAMES / totalDuration);
  // Short clips at a fixed fps can never yield enough candidates (30s at
  // 3fps is 90 frames against a 100 minimum). Floor the rate so filtering
  // has headroom, capped at 30fps.
  const floorFps = totalDuration > 0 ? Math.min(130 / totalDuration, 30) : requestedFps;
  const effectiveFps = Math.min(Math.max(requestedFps, floorFps), Math.max(budgetedFps, floorFps));
  context.frameRate = effectiveFps;
  context.sourceMeta = {
    filenames: [media.filename],
    durationSeconds: Number(totalDuration.toFixed(3)),
    fps: Number(effectiveFps.toFixed(3)),
  };

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
      startTime: optionalSeconds(settings.startTime),
      endTime: optionalSeconds(settings.endTime),
      outputPrefix: prefix,
    });
    await writeCheckpoint(checkpointsDirectory, prefix);
    await update(projectId, job, {
      completed: index + 1,
      progress: Math.round(5 + ((index + 1) / inputs.length) * 68),
    });
  }
  if (await cancelled(projectId, job)) return;
  await filterAndValidate(projectId, job, candidatesDirectory, frameDirectory, context);
}

async function prepareImages(projectId: string, job: ProcessJob) {
  const images = await prisma.media.findMany({
    where: { projectId, assetType: "IMAGE" },
    orderBy: { createdAt: "asc" },
  });
  if (images.length < MINIMUM_PREPARED_FRAMES) {
    throw new Error("An image sequence needs at least " + MINIMUM_PREPARED_FRAMES + " images.");
  }
  const context: PreparationContext = {
    sourceType: "image-sequence",
    sourceFilenames: images.map((image) => image.filename),
    sourceMeta: { filenames: images.map((image) => image.filename) },
    startedAt: Date.now(),
  };

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
  await filterAndValidate(projectId, job, candidatesDirectory, frameDirectory, context);
}
