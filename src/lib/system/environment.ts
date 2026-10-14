import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

export interface EnvironmentStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  colmap: boolean;
  python: boolean;
  numpy: boolean;
  gpu: string | null;
  checkedAt: string;
}

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ??
  "C:\\Users\\Mayur\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe";

function ffprobePath() {
  return process.env.FFPROBE_PATH ?? path.join(path.dirname(FFMPEG_PATH), "ffprobe.exe");
}

function canSpawn(command: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function gpuName(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const name = output.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? null;
      resolve(name);
    });
  });
}

let cached: { at: number; status: EnvironmentStatus } | null = null;
let cachedPython: string | null = null;

/** "python" is not on PATH here (only the `py` launcher) — probe once. */
export async function pythonBinary(): Promise<string> {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  if (cachedPython) return cachedPython;
  cachedPython = (await canSpawn("python", ["--version"])) ? "python" : "py";
  return cachedPython;
}

/**
 * Verify the local tools every job assumes exist. Checked once a minute;
 * every failure here used to surface as a cryptic mid-job crash instead.
 */
export async function checkEnvironment(): Promise<EnvironmentStatus> {
  if (cached && Date.now() - cached.at < 60_000) return cached.status;
  const python = await pythonBinary();
  const [ffmpeg, ffprobe, hasPython, numpy, gpu] = await Promise.all([
    fs.access(FFMPEG_PATH).then(() => true).catch(() => false),
    fs.access(ffprobePath()).then(() => true).catch(() => false),
    canSpawn(python, ["--version"]),
    canSpawn(python, ["-c", "import numpy"]),
    gpuName(),
  ]);
  const { resolveColmapRuntime } = await import("@/lib/reconstruction/colmapRuntime");
  const colmap = Boolean(await resolveColmapRuntime());
  const status: EnvironmentStatus = {
    ffmpeg,
    ffprobe,
    colmap,
    python: hasPython,
    numpy,
    gpu,
    checkedAt: new Date().toISOString(),
  };
  cached = { at: Date.now(), status };
  return status;
}
