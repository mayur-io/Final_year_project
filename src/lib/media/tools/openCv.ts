import fs from "fs/promises";
import path from "path";

import sharp from "sharp";

export interface FrameFilterResult {
  sampledFrames: number;
  acceptedFrames: number;
  rejectedFrames: number;
  blurredFrames: number;
  duplicateFrames: number;
  lowDetailFrames: number;
  skyFrames: number;
  outlierFrames: number;
  frames: string[];
  streams: Record<
    string,
    {
      sampled: number;
      accepted: number;
      lowDetail: number;
      medianSharpness: number;
      blurThreshold: number;
    }
  >;
  rejected: Array<{ frame: string; reason: string }>;
}

export interface FilterFramesOptions {
  sourceDirectory: string;
  outputDirectory: string;
  reportPath: string;
  maxAcceptedFrames?: number;
}

export interface ImageSetValidationResult {
  accepted: string[];
  rejected: string[];
}

const IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const DEFAULT_BLUR_THRESHOLD = 20;
const DEFAULT_DUPLICATE_THRESHOLD = 0.75;
const HARD_BLUR_THRESHOLD = 6;

/**
 * Frame filtering and set validation run natively on sharp + typed arrays.
 *
 * These used to shell out to a Python/OpenCV helper under `.venv`, which meant
 * the whole "filter" stage silently failed on any machine without that virtual
 * environment — the job reported an unreliable frame set instead of a missing
 * interpreter. The thresholds below are unchanged from the OpenCV original
 * (variance of the 3x3 Laplacian, and mean absolute difference of a 96x54
 * grayscale reduction), and are calibrated for full-resolution frames.
 */

interface FrameMetrics {
  name: string;
  sharpness: number;
  comparison: Buffer;
}

/** Variance of the 3x3 Laplacian — the OpenCV sharpness measure. */
function laplacianVariance(grayscale: Buffer, width: number, height: number): number {
  let sum = 0;
  let sumSquares = 0;
  let samples = 0;

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = row + x;
      const value =
        grayscale[index - width] +
        grayscale[index + width] +
        grayscale[index - 1] +
        grayscale[index + 1] -
        4 * grayscale[index];
      sum += value;
      sumSquares += value * value;
      samples += 1;
    }
  }

  if (samples === 0) return 0;
  const mean = sum / samples;
  return sumSquares / samples - mean * mean;
}

function streamNameOf(filename: string): string {
  const stem = path.basename(filename, path.extname(filename));
  const match = /^(.*)_\d+$/.exec(stem);
  return match ? match[1] : stem;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Bounded-concurrency map so multi-core machines stay responsive. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

async function measureFrame(filePath: string, name: string): Promise<FrameMetrics | null> {
  try {
    const full = await sharp(filePath).greyscale().raw().toBuffer({ resolveWithObject: true });
    const sharpness = laplacianVariance(full.data, full.info.width, full.info.height);
    const comparison = await sharp(filePath)
      .greyscale()
      .resize(96, 54, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer();
    return { name, sharpness, comparison };
  } catch {
    return null;
  }
}

function meanAbsoluteDifference(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(a[index] - b[index]);
  }
  return total / length;
}

/**
 * Mean absolute difference between two image files (96×54 thumbs).
 * Used for static-capture detection: a camera that never translates
 * has zero baseline and no SfM pipeline can solve it.
 */
export async function frameDifference(firstPath: string, secondPath: string): Promise<number | null> {
  try {
    const [a, b] = await Promise.all([
      sharp(firstPath).greyscale().resize(96, 54, { fit: "fill" }).raw().toBuffer(),
      sharp(secondPath).greyscale().resize(96, 54, { fit: "fill" }).raw().toBuffer(),
    ]);
    return meanAbsoluteDifference(a, b);
  } catch {
    return null;
  }
}
/**
 * Sky / cloud frames never triangulate — sky is at infinity, clouds move.
 * The 96×54 comparison buffer is enough: a sky-dominated frame has a bright,
 * near-uniform top third (low variance, high mean). Textureless frames
 * (blank walls, overexposure) have near-zero variance overall. Both poison
 * SfM matching and become splat floaters, so reject them here.
 */
function bufferStats(region: Buffer): { mean: number; variance: number } {
  if (region.length === 0) return { mean: 0, variance: 0 };
  let sum = 0;
  for (let i = 0; i < region.length; i += 1) sum += region[i];
  const mean = sum / region.length;
  let sq = 0;
  for (let i = 0; i < region.length; i += 1) sq += (region[i] - mean) * (region[i] - mean);
  return { mean, variance: sq / region.length };
}

function isSkyDominated(comparison: Buffer): boolean {
  // 96 wide × 54 tall, row-major. Top third = rows 0..17.
  const top = comparison.subarray(0, 96 * 18);
  const { mean, variance } = bufferStats(top);
  return mean > 150 && variance < 220;
}

function isTextureless(comparison: Buffer): boolean {
  return bufferStats(comparison).variance < 60;
}

async function clearImages(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  const existing = await fs.readdir(directory);
  await Promise.all(
    existing
      .filter((file) => IMAGE_SUFFIXES.has(path.extname(file).toLowerCase()))
      .map((file) => fs.rm(path.join(directory, file), { force: true })),
  );
}

export async function filterFrames(options: FilterFramesOptions): Promise<FrameFilterResult> {
  const maxAcceptedFrames = options.maxAcceptedFrames ?? 1200;
  const entries = (await fs.readdir(options.sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && IMAGE_SUFFIXES.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  await clearImages(options.outputDirectory);

  // Preserve first-appearance stream order so accepted frames stay grouped.
  const streams = new Map<string, string[]>();
  for (const name of entries) {
    const stream = streamNameOf(name);
    const bucket = streams.get(stream);
    if (bucket) bucket.push(name);
    else streams.set(stream, [name]);
  }

  const rejected: Array<{ frame: string; reason: string }> = [];
  const eligible: Array<{ stream: string; name: string }> = [];
  let blurry = 0;
  let duplicates = 0;
  let lowDetail = 0;
  let skyFrames = 0;
  let outlierFrames = 0;
  const byStream: FrameFilterResult["streams"] = {};

  for (const [stream, names] of streams) {
    const metrics = await mapWithConcurrency(
      names,
      4,
      (name) => measureFrame(path.join(options.sourceDirectory, name), name),
    );

    for (let index = 0; index < names.length; index += 1) {
      if (!metrics[index]) {
        rejected.push({ frame: names[index], reason: "unreadable" });
      }
    }

    const readable = metrics.filter((metric): metric is FrameMetrics => metric !== null);
    const medianSharpness = median(readable.map((metric) => metric.sharpness));
    const blurThreshold = Math.max(
      HARD_BLUR_THRESHOLD,
      Math.min(DEFAULT_BLUR_THRESHOLD, medianSharpness * 0.35),
    );

    let previous: Buffer | null = null;
    let streamAccepted = 0;
    let streamLowDetail = 0;

    for (const metric of readable) {
      if (metric.sharpness < HARD_BLUR_THRESHOLD) {
        rejected.push({ frame: metric.name, reason: "too_blurry" });
        blurry += 1;
        continue;
      }

      if (previous && meanAbsoluteDifference(previous, metric.comparison) < DEFAULT_DUPLICATE_THRESHOLD) {
        rejected.push({ frame: metric.name, reason: "near_duplicate" });
        duplicates += 1;
        continue;
      }

      // Low-detail frames are unreliable for SfM/splat matching — reject, don't keep.
      if (metric.sharpness < blurThreshold) {
        rejected.push({ frame: metric.name, reason: "low_detail" });
        lowDetail += 1;
        streamLowDetail += 1;
        continue;
      }

      // A frame with a large sky area is retained when it still carries usable
      // scene detail — a building or room against blue sky is a valid
      // reconstruction frame. Only a genuinely textureless frame (blank wall,
      // blown-out sky with no detail) is rejected. This brightness rule is an
      // observation, never a semantic sky mask.
      if (isTextureless(metric.comparison)) {
        rejected.push({ frame: metric.name, reason: "textureless" });
        continue;
      }
      if (isSkyDominated(metric.comparison)) {
        skyFrames += 1;
      }

      eligible.push({ stream, name: metric.name });
      previous = metric.comparison;
      streamAccepted += 1;
    }

    byStream[stream] = {
      sampled: names.length,
      accepted: streamAccepted,
      lowDetail: streamLowDetail,
      medianSharpness: round(medianSharpness, 2),
      blurThreshold: round(blurThreshold, 2),
    };
  }

  let selected = eligible;
  if (eligible.length > maxAcceptedFrames) {
    // Round-robin across streams so no single view dominates the budget.
    const byStreamEligible = new Map<string, string[]>();
    for (const item of eligible) {
      const bucket = byStreamEligible.get(item.stream);
      if (bucket) bucket.push(item.name);
      else byStreamEligible.set(item.stream, [item.name]);
    }
    const allocation = new Map<string, number>();
    for (const name of byStreamEligible.keys()) allocation.set(name, 0);

    let remaining = maxAcceptedFrames;
    while (remaining > 0) {
      let assigned = false;
      for (const [stream, names] of byStreamEligible) {
        const taken = allocation.get(stream) ?? 0;
        if (taken >= names.length) continue;
        allocation.set(stream, taken + 1);
        remaining -= 1;
        assigned = true;
        if (remaining === 0) break;
      }
      if (!assigned) break;
    }

    selected = [];
    for (const [stream, names] of byStreamEligible) {
      const take = allocation.get(stream) ?? 0;
      for (const index of evenIndices(names.length, take)) {
        selected.push({ stream, name: names[index] });
      }
    }
  }

  const selectedNames = new Set(selected.map((item) => item.name));
  const accepted: string[] = [];
  for (const item of eligible) {
    if (selectedNames.has(item.name)) {
      await fs.copyFile(
        path.join(options.sourceDirectory, item.name),
        path.join(options.outputDirectory, item.name),
      );
      accepted.push(item.name);
    } else {
      rejected.push({ frame: item.name, reason: "performance_budget" });
    }
  }

  // Outlier prune: drop frames that don't belong to the dominant scene.
  // Previously validateImageSet() existed but was never called anywhere.
  if (accepted.length >= 10) {
    const validation = await validateSet(options.outputDirectory, 0.48);
    if (validation.accepted.length >= 10 && validation.rejected.length > 0) {
      const rejectedSet = new Set(validation.rejected);
      for (const name of validation.rejected) {
        await fs.rm(path.join(options.outputDirectory, name), { force: true });
        rejected.push({ frame: name, reason: "scene_outlier" });
        outlierFrames += 1;
      }
      for (let i = accepted.length - 1; i >= 0; i -= 1) {
        if (rejectedSet.has(accepted[i])) accepted.splice(i, 1);
      }
    }
  }

  const report: FrameFilterResult = {
    sampledFrames: entries.length,
    acceptedFrames: accepted.length,
    rejectedFrames: rejected.length,
    blurredFrames: blurry,
    duplicateFrames: duplicates,
    lowDetailFrames: lowDetail,
    skyFrames,
    outlierFrames,
    frames: accepted,
    streams: byStream,
    rejected,
  };

  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(options.reportPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Evenly spaced indices from 0..length-1, matching numpy's linspace(int). */
function evenIndices(length: number, take: number): number[] {
  if (take <= 0 || length <= 0) return [];
  if (take === 1) return [0];
  const indices: number[] = [];
  for (let step = 0; step < take; step += 1) {
    indices.push(Math.round((step * (length - 1)) / (take - 1)));
  }
  return indices;
}

const VALIDATION_SUFFIXES = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
]);

/** 8x8x8 colour histogram, L2-normalised, as used for correlation matching. */
async function colorSignature(filePath: string): Promise<Float64Array | null> {
  try {
    const { data, info } = await sharp(filePath)
      .resize(160, 90, { fit: "fill", kernel: "cubic" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const histogram = new Float64Array(512);
    const channels = info.channels;
    for (let index = 0; index + 2 < data.length; index += channels) {
      const red = data[index] >> 5;
      const green = data[index + 1] >> 5;
      const blue = data[index + 2] >> 5;
      histogram[(red * 8 + green) * 8 + blue] += 1;
    }

    let norm = 0;
    for (const value of histogram) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return null;
    for (let index = 0; index < histogram.length; index += 1) histogram[index] /= norm;
    return histogram;
  } catch {
    return null;
  }
}

/** Pearson correlation, equivalent to cv2.compareHist(HISTCMP_CORREL). */
function correlation(a: Float64Array, b: Float64Array): number {
  const length = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < length; index += 1) {
    meanA += a[index];
    meanB += b[index];
  }
  meanA /= length;
  meanB /= length;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator === 0 ? 0 : covariance / denominator;
}

/**
 * Groups visually matching captures and keeps the largest group. A single
 * capture session should be one scene, so near-identical images collapse
 * together and anything left over is reported as an outlier.
 */
async function validateSet(directory: string, threshold: number): Promise<ImageSetValidationResult> {
  const names = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && VALIDATION_SUFFIXES.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();

  const signatures = await mapWithConcurrency(
    names,
    4,
    async (name) => ({ name, signature: await colorSignature(path.join(directory, name)) }),
  );

  const valid = signatures.filter(
    (entry): entry is { name: string; signature: Float64Array } => entry.signature !== null,
  );

  const adjacency = new Map<string, Set<string>>();
  for (const entry of valid) adjacency.set(entry.name, new Set());
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      if (correlation(valid[i].signature, valid[j].signature) >= threshold) {
        adjacency.get(valid[i].name)?.add(valid[j].name);
        adjacency.get(valid[j].name)?.add(valid[i].name);
      }
    }
  }

  const unseen = new Set(valid.map((entry) => entry.name));
  const groups: string[][] = [];
  while (unseen.size > 0) {
    const stack = [unseen.values().next().value as string];
    const group: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      group.push(current);
      for (const neighbour of adjacency.get(current) ?? []) {
        if (unseen.delete(neighbour)) stack.push(neighbour);
      }
    }
    groups.push(group.sort());
  }

  const accepted = groups.reduce<string[]>(
    (largest, group) => (group.length > largest.length ? group : largest),
    [],
  );
  const acceptedSet = new Set(accepted);
  return {
    accepted,
    rejected: names.filter((name) => !acceptedSet.has(name)),
  };
}

export function validateImageSet(directory: string): Promise<ImageSetValidationResult> {
  return validateSet(directory, 0.48);
}

/**
 * Equirect wrap test: in a true 360 frame the left and right edges are
 * adjacent on the sphere, so downscaled edge columns look alike.
 * Perspective clips almost never match at opposite edges.
 * PowerPark-style 16:9 equirect (squeezed, not 2:1) passes this.
 */
export async function hasEquirectWrap(filePath: string): Promise<boolean> {
  try {
    const { data, info } = await sharp(filePath)
      .greyscale()
      .resize(128, 64, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = info.width;
    let total = 0;
    let samples = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        total += Math.abs(data[y * width + x] - data[y * width + (width - 1 - x)]);
        samples += 1;
      }
    }
    return total / samples < 20;
  } catch {
    return false;
  }
}

/**
 * Single-frame quality score for the post-conversion gate: one sampled frame
 * per projected view is scored before extraction burns minutes on it.
 * Returns null when the frame is unreadable.
 */
export async function scoreFrame(filePath: string): Promise<{
  sharpness: number;
  skyDominated: boolean;
  textureless: boolean;
} | null> {
  const metric = await measureFrame(filePath, path.basename(filePath));
  if (!metric) return null;
  return {
    sharpness: metric.sharpness,
    skyDominated: isSkyDominated(metric.comparison),
    textureless: isTextureless(metric.comparison),
  };
}

export interface SequenceCoverageResult {
  /** How many accepted frames were sampled for the measurement. */
  sampled: number;
  /** Mean absolute difference (0–255) between consecutive sampled frames. */
  meanDifference: number;
  /** Mean colour-histogram correlation between consecutive sampled frames. */
  meanSimilarity: number;
  /** Viewpoint change across the sequence: `insufficient` means little or no parallax. */
  coverage: "insufficient" | "plausible";
  /** Frame-to-frame scene continuity: `insufficient` means neighbours look unrelated. */
  overlap: "insufficient" | "plausible";
}

const MIN_VIEWPOINT_DIFFERENCE = 1.0;
const MIN_NEIGHBOUR_SIMILARITY = 0.25;

/**
 * Validates that an accepted sequence actually contains viewpoint change
 * (parallax) and frame-to-frame continuity (overlap) — the two properties the
 * Scope requires before reconstruction. It measures consecutive *sampled*
 * accepted frames in capture order:
 *
 *   difference  → how much the view moved (parallax / viewpoint diversity)
 *   similarity  → whether neighbours still share the same scene (overlap)
 *
 * Both are cheap 96×54 greyscale / 8×8×8 colour-histogram proxies, not a
 * semantic camera solve, so they are surfaced as evidence and used directly
 * only for the unambiguous "no viewpoint change" case. A near-zero mean
 * difference means a static or duplicate capture that no SfM pipeline can solve.
 */
export async function analyzeSequenceCoverage(
  directory: string,
  filenames: string[],
  maxSamples = 60,
): Promise<SequenceCoverageResult | null> {
  const names = filenames.length <= maxSamples
    ? [...filenames]
    : evenIndices(filenames.length, maxSamples).map((index) => filenames[index]);
  if (names.length < 2) return null;

  const samples = await mapWithConcurrency(names, 4, async (name) => {
    const filePath = path.join(directory, name);
    const [comparison, signature] = await Promise.all([
      sharp(filePath).greyscale().resize(96, 54, { fit: "fill", kernel: "cubic" }).raw().toBuffer().catch(() => null),
      colorSignature(filePath),
    ]);
    return comparison && signature ? { comparison, signature } : null;
  });
  const valid = samples.filter(
    (sample): sample is { comparison: Buffer; signature: Float64Array } => sample !== null,
  );
  if (valid.length < 2) return null;

  let differenceTotal = 0;
  let similarityTotal = 0;
  for (let index = 1; index < valid.length; index += 1) {
    differenceTotal += meanAbsoluteDifference(valid[index - 1].comparison, valid[index].comparison);
    similarityTotal += correlation(valid[index - 1].signature, valid[index].signature);
  }
  const pairs = valid.length - 1;
  const meanDifference = differenceTotal / pairs;
  const meanSimilarity = similarityTotal / pairs;

  return {
    sampled: valid.length,
    meanDifference: round(meanDifference, 3),
    meanSimilarity: round(meanSimilarity, 3),
    coverage: meanDifference < MIN_VIEWPOINT_DIFFERENCE ? "insufficient" : "plausible",
    overlap: meanSimilarity < MIN_NEIGHBOUR_SIMILARITY ? "insufficient" : "plausible",
  };
}
