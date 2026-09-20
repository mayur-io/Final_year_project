import type { HardwareProfile, ReconstructionPlan, PlannedStep } from "./types.ts";

export interface PlanningInput {
  /** Duration of the source video in seconds. */
  videoSeconds: number;
  /** 15-minute hackathon budget by default. */
  budgetSeconds?: number;
  /** What the user wants out. */
  desiredOutputs?: ("sparse" | "dense" | "splat")[];
}

interface TierModel {
  keyframeBudget: number;
  /** Relative speed for COLMAP/GLOMAP SfM work (1.0 = baseline notebook). */
  sfmFactor: number;
  /** Ability to run dense (patch_match_stereo CUDA). 0 = off. */
  denseAvailable: boolean;
  /** Ability to train gaussian splats. */
  splatAvailable: boolean;
}

const TIER_MODELS: Record<HardwareProfile["tier"], TierModel> = {
  low: { keyframeBudget: 200, sfmFactor: 0.55, denseAvailable: false, splatAvailable: false },
  medium: { keyframeBudget: 350, sfmFactor: 1.0, denseAvailable: true, splatAvailable: false },
  high: { keyframeBudget: 500, sfmFactor: 1.7, denseAvailable: true, splatAvailable: true },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Hardware-aware planner (v1 heuristic).
 * Turns a hardware profile + capture info + time budget into a stepped plan,
 * dropping expensive stages (dense / splat) when they would exceed the budget.
 */
export function planReconstruction(hardware: HardwareProfile, input: PlanningInput): ReconstructionPlan {
  const budget = input.budgetSeconds ?? 15 * 60;
  const desired = new Set(input.desiredOutputs ?? ["sparse", "dense"]);
  const model = TIER_MODELS[hardware.tier];

  // Frame-thinning scales with video length but is cheap (OpenCV motion scoring).
  const frameThinSeconds = Math.round(clamp(input.videoSeconds * 0.12, 20, 150));

  // Keyframe budget shrinks if the video is too short to sustain it.
  const durationBasedCap = Math.max(60, Math.round(input.videoSeconds / 3));
  let keyframes = clamp(model.keyframeBudget, 100, Math.min(model.keyframeBudget, durationBasedCap));

  const estimateSfm = (frames: number, factor: number) =>
    Math.round((frames * 0.85) / Math.max(factor, 0.4));
  const estimateDense = (frames: number, factor: number) =>
    Math.round((frames * 0.65) / Math.max(factor, 0.4));
  const splatSeconds = 190;

  const steps: PlannedStep[] = [];
  const notes: string[] = [];

  steps.push({
    id: "frame-thinning",
    label: "Frame thinning",
    engine: "open-cv",
    estimatedSeconds: frameThinSeconds,
  });
  notes.push(`${keyframes} keyframes budgeted from ${Math.round(input.videoSeconds)}s of video.`);

  const glomapSeconds = estimateSfm(keyframes, model.sfmFactor);
  steps.push({
    id: "glomap",
    label: "GLOMAP sparse reconstruction",
    engine: "glomap",
    estimatedSeconds: glomapSeconds,
  });

  const wantDense = desired.has("dense") && model.denseAvailable;
  const wantSplat = desired.has("splat") && model.splatAvailable;

  let runningTotal = frameThinSeconds + glomapSeconds;

  const canFit = (estimate: number) => runningTotal + estimate <= budget;

  if (wantDense && !canFit(estimateDense(keyframes, model.sfmFactor))) {
    // Try halving the keyframe budget to make dense fit.
    keyframes = Math.max(100, Math.round(keyframes / 2));
    notes.unshift(`Keyframes reduced to ${keyframes} so dense reconstruction fits the time budget.`);
  }

  let denseSeconds: number | null = null;
  if (wantDense) {
    denseSeconds = estimateDense(keyframes, model.sfmFactor);
    if (canFit(denseSeconds)) {
      steps.push({ id: "dense", label: "Dense point cloud (patch-match CUDA)", engine: "dense", estimatedSeconds: denseSeconds });
      runningTotal += denseSeconds;
    } else {
      notes.push("Dense reconstruction dropped: it would exceed the 15:00 budget on this hardware.");
    }
  }

  if (wantSplat && canFit(splatSeconds)) {
    steps.push({ id: "splat", label: "Gaussian splatting training", engine: "splat", estimatedSeconds: splatSeconds });
    runningTotal += splatSeconds;
  } else if (wantSplat) {
    notes.push("Gaussian splatting is a stretch goal — not enough headroom in the budget on this hardware.");
  }

  const artifacts: string[] = ["point-cloud (sparse)"];
  if (steps.some((step) => step.id === "dense")) artifacts.push("point-cloud (dense)");
  if (steps.some((step) => step.id === "splat")) artifacts.push("gaussian-splat scene");

  if (stepTotalEstimate(steps) > budget) {
    notes.push(`Estimate (${formatSeconds(stepTotalEstimate(steps))}) exceeds the 15:00 budget — this machine will run the sparse stage only at reduced quality.`);
  }

  return {
    engine: "glomap",
    steps,
    estimatedTotalSeconds: stepTotalEstimate(steps),
    expectedArtifacts: artifacts,
    notes,
  };
}

function stepTotalEstimate(steps: PlannedStep[]) {
  return steps.reduce((sum, step) => sum + (step.estimatedSeconds ?? 0), 0);
}

export function formatSeconds(total: number | null) {
  if (total === null) return "unknown";
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}