import fs from "fs/promises";
import path from "path";

import { projectStorageDirectory } from "@/lib/storage";

/**
 * The shared preparation contract.
 *
 * Every input path (normal video, 360 projections, image sequence) must finish
 * with these two artifacts, so the UI never has to guess what happened and the
 * reconstruction job can read provenance instead of sorting filenames.
 *
 *   processed/frames-manifest.json     ordered accepted frames + provenance
 *   processed/preparation-report.json  one PASS / WARN / REJECT verdict
 */

export type SourceType = "normal-video" | "360-video" | "image-sequence";
export type ReconstructionIntent = "object" | "environment";
export type PreparationVerdict = "PASS" | "WARN" | "REJECT";

export interface PreparedFrame {
  filename: string;
  relativePath: string;
  sourceKind: "normal-video" | "360-projection" | "image-sequence";
  sourceFilename: string;
  sourceOrder: number;
  timestampSeconds?: number;
  projection?: { viewId: string; yaw: number; pitch: number; roll: number; fov: number };
  acceptedAt: string;
}

export interface FramesManifest {
  version: 1;
  projectId: string;
  sourceType: SourceType;
  frames: PreparedFrame[];
}

export interface PreparationReport {
  version: 1;
  projectId: string;
  sourceType: SourceType;
  reconstructionIntent: ReconstructionIntent | null;
  verdict: PreparationVerdict;
  reasons: string[];
  warnings: string[];
  source: {
    filenames: string[];
    durationSeconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
  };
  selection: {
    candidates: number;
    accepted: number;
    rejected: number;
    unreadable: number;
    blurry: number;
    duplicates: number;
    textureless: number;
    outliers: number;
    manuallyRejected: number;
    maxAccepted: number;
  };
  evidence: {
    motion: "static" | "low" | "usable" | "unknown";
    motionScore?: number;
    overlap: "insufficient" | "plausible" | "unknown";
    overlapScore?: number;
    coverage: "insufficient" | "plausible" | "unknown";
    coverageScore?: number;
    sky: "masked_and_consumed" | "warned" | "not_implemented" | "not_checked";
    dynamicObjects: "masked_and_consumed" | "manual_review" | "not_implemented" | "not_checked";
  };
  projection?: {
    enabled: boolean;
    fov?: number;
    overlap?: number;
    outputWidth?: number;
    outputHeight?: number;
    views?: Array<{ id: string; yaw: number; pitch: number; roll: number; fov: number }>;
  };
  settings: Record<string, unknown>;
  createdAt: string;
  elapsedMs: number;
}

export function processedDirectory(projectId: string) {
  return path.join(projectStorageDirectory(projectId), "processed");
}

export function framesManifestPath(projectId: string) {
  return path.join(processedDirectory(projectId), "frames-manifest.json");
}

export function preparationReportPath(projectId: string) {
  return path.join(processedDirectory(projectId), "preparation-report.json");
}

/** Write JSON via a temp file + rename so readers never see a half-written file. */
async function writeJsonAtomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeFramesManifest(projectId: string, manifest: FramesManifest) {
  await writeJsonAtomic(framesManifestPath(projectId), manifest);
}

export function readFramesManifest(projectId: string) {
  return readJson<FramesManifest>(framesManifestPath(projectId));
}

export async function writePreparationReport(projectId: string, report: PreparationReport) {
  await writeJsonAtomic(preparationReportPath(projectId), report);
}

export function readPreparationReport(projectId: string) {
  return readJson<PreparationReport>(preparationReportPath(projectId));
}
