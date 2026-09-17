import { spawn } from "child_process";
import path from "path";

export interface FrameFilterResult {
  sampledFrames: number;
  acceptedFrames: number;
  rejectedFrames: number;
  blurredFrames: number;
  duplicateFrames: number;
  lowDetailFrames: number;
  frames: string[];
}

export interface FilterFramesOptions {
  sourceDirectory: string;
  outputDirectory: string;
  reportPath: string;
  maxAcceptedFrames?: number;
}

export interface VideoSetValidationResult {
  accepted: string[];
  rejected: string[];
}

export interface ImageSetValidationResult {
  accepted: string[];
  rejected: string[];
}

const PYTHON_PATH = path.join(
  process.cwd(),
  ".venv",
  "Scripts",
  "python.exe",
);
const FILTER_SCRIPT_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "media",
  "scripts",
  "filter_frames.py",
);
const VIDEO_SET_SCRIPT_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "media",
  "scripts",
  "validate_video_set.py",
);
const IMAGE_SET_SCRIPT_PATH = path.join(
  process.cwd(),
  "src",
  "lib",
  "media",
  "scripts",
  "validate_image_set.py",
);

function runPython<T>(script: string, arguments_: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const process = spawn(PYTHON_PATH, [script, ...arguments_]);
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`OpenCV analysis failed. ${stderr}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error("OpenCV analysis returned an invalid result."));
      }
    });
    process.on("error", reject);
  });
}

export function filterFrames(options: FilterFramesOptions): Promise<FrameFilterResult> {
  return runPython<FrameFilterResult>(FILTER_SCRIPT_PATH, [
    "--source-directory",
    options.sourceDirectory,
    "--output-directory",
    options.outputDirectory,
    "--report-path",
    options.reportPath,
    "--max-accepted-frames",
    String(options.maxAcceptedFrames ?? 1200),
  ]);
}

export function validateVideoSet(directory: string) {
  return runPython<VideoSetValidationResult>(VIDEO_SET_SCRIPT_PATH, [
    "--directory",
    directory,
  ]);
}

export function validateImageSet(directory: string) {
  return runPython<ImageSetValidationResult>(IMAGE_SET_SCRIPT_PATH, [
    "--directory",
    directory,
  ]);
}
