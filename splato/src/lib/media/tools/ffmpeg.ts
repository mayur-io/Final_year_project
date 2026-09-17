import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

export interface ExtractFramesOptions {
  input: string;
  outputDirectory: string;
  fps?: number;
  format?: "jpg" | "png" | "webp";
  quality?: number;
  startTime?: number;
  endTime?: number;
  outputPrefix?: string;
}

export interface Convert360ViewOptions {
  input: string;
  output: string;
  yaw: number;
  pitch: number;
  fieldOfView: number;
  outputWidth?: number;
  outputHeight?: number;
}

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ??
  "C:\\Users\\Mayur\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe";
const FFPROBE_PATH =
  process.env.FFPROBE_PATH ?? path.join(path.dirname(FFMPEG_PATH), "ffprobe.exe");
let nvencUnavailable = false;

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, args);
    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`FFmpeg exited with code ${code}\\n${stderr}`));
    });

    ffmpeg.on("error", reject);
  });
}

export async function probeVideoDuration(input: string) {
  return new Promise<number>((resolve, reject) => {
    const probe = spawn(FFPROBE_PATH, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      input,
    ]);
    let output = "";
    let error = "";
    probe.stdout.on("data", (data) => {
      output += data.toString();
    });
    probe.stderr.on("data", (data) => {
      error += data.toString();
    });
    probe.on("error", reject);
    probe.on("close", (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) {
        resolve(duration);
        return;
      }
      reject(new Error(`FFprobe could not read the video duration. ${error}`));
    });
  });
}

function buildExtractFramesArgs(options: ExtractFramesOptions): string[] {
  const args: string[] = ["-y"];

  if (options.startTime !== undefined) {
    args.push("-ss", options.startTime.toString());
  }

  args.push("-i", options.input);

  if (options.endTime !== undefined && options.startTime !== undefined) {
    args.push("-t", Math.max(options.endTime - options.startTime, 0.1).toString());
  }

  if (options.fps) {
    args.push("-vf", `fps=${options.fps}`);
  }

  if (options.quality !== undefined && options.format === "jpg") {
    args.push("-q:v", options.quality.toString());
  }

  const format = options.format ?? "jpg";
  args.push(`${options.outputDirectory}/${options.outputPrefix ?? "frame"}_%06d.${format}`);

  return args;
}

export async function extractFrames(options: ExtractFramesOptions) {
  return runFfmpeg(buildExtractFramesArgs(options));
}

export async function convert360View(options: Convert360ViewOptions) {
  const outputWidth = options.outputWidth ?? 1600;
  const outputHeight = options.outputHeight ?? 900;
  const horizontalFov = Math.min(Math.max(options.fieldOfView, 55), 120);
  const verticalFov =
    (2 * Math.atan(Math.tan((horizontalFov * Math.PI) / 360) / (outputWidth / outputHeight)) * 180) /
    Math.PI;
  const filter = [
    "v360=input=equirect:output=flat",
    "interp=lanczos",
    `yaw=${-options.yaw}`,
    `pitch=${options.pitch}`,
    `h_fov=${horizontalFov}`,
    `v_fov=${verticalFov}`,
    `w=${outputWidth}`,
    `h=${outputHeight}`,
  ].join(":");

  const parsedOutput = path.parse(options.output);
  const temporaryOutput = path.join(
    parsedOutput.dir,
    `${parsedOutput.name}.partial${parsedOutput.ext}`,
  );

  await fs.rm(temporaryOutput, { force: true });

  const commonArgs = [
      "-y",
      "-i",
      options.input,
      "-vf",
      filter,
      "-an",
    ];

  try {
    if (!nvencUnavailable) {
      try {
      await runFfmpeg([
        ...commonArgs,
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p4",
        "-cq",
        "22",
        "-movflags",
        "+faststart",
        temporaryOutput,
      ]);
      } catch {
        nvencUnavailable = true;
      }
    }

    if (nvencUnavailable) {
      await fs.rm(temporaryOutput, { force: true });
      await runFfmpeg([
        ...commonArgs,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
        temporaryOutput,
      ]);
    }

    await fs.rename(temporaryOutput, options.output);
  } catch (error) {
    await fs.rm(temporaryOutput, { force: true });
    throw error;
  }
}
