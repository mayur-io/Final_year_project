import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { loadEnvironment } from "./env.ts";

loadEnvironment();

/**
 * Everything the engine produces stays on this machine.
 * SPLATO_DATA_DIR is the single knob; falls back to SPLATO_STORAGE_ROOT
 * (kept for continuity with the web app), then to ~/.splato.
 */
export function resolveDataDirectory(): string {
  const configured = process.env.SPLATO_DATA_DIR ?? process.env.SPLATO_STORAGE_ROOT;
  return configured
    ? path.resolve(configured)
    : path.join(homedir(), ".splato");
}

export function projectDirectory(dataDirectory: string, projectId: string) {
  return path.join(dataDirectory, "projects", projectId);
}

export async function ensureDataDirectory(dataDirectory: string) {
  await mkdir(path.join(dataDirectory, "projects"), { recursive: true });
  await mkdir(path.join(dataDirectory, "artifacts"), { recursive: true });
}