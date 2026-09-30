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

/**
 * ffmpeg sizes its frame pools from the decoder and encoder thread counts, so
 * thread count drives peak memory far more than resolution does. A 4K equirect
 * H.264 source on 16 threads needs multiple gigabytes of frame buffers; on a
 * machine with under a gigabyte free the process died with "Cannot allocate
 * memory" (exit 69) before writing a single frame. Cap both sides, then step
 * down further if a run still cannot allocate.
 */
const THREAD_LADDER = [4, 2, 1];

function isAllocationFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /cannot allocate memory|out of memory|malloc of size \d+ failed|error code: -12|ENOMEM/i.test(
    error.message,
  );
}

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

function buildExtractFramesArgs(options: ExtractFramesOptions, threads: number): string[] {
  const args: string[] = ["-y"];

  if (options.startTime !== undefined) {
    args.push("-ss", options.startTime.toString());
  }

  // Cap the decoder: a 4K source otherwise allocates frame buffers for every
  // core and can fail outright on a machine that is already short on memory.
  args.push("-threads", String(threads), "-filter_threads", "1");
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
  let lastError: unknown;

  for (const threads of THREAD_LADDER) {
    try {
      await runFfmpeg(buildExtractFramesArgs(options, threads));
      return;
    } catch (error) {
      lastError = error;
      if (!isAllocationFailure(error)) throw error;
    }
  }

  throw lastError;
}

/**
 * ffmpeg's v360 filter only accepts yaw in [-180, 180] and pitch in [-90, 90].
 * Planner presets step yaw past 180 (the horizon preset emits 0/45/.../315) and
 * the filter is driven with a negated yaw, so a 225° view reached ffmpeg as
 * -225° and aborted the whole conversion job. Normalize before we build the
 * filter string.
 */
function wrapYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const wrapped = ((yaw + 180) % 360 + 360) % 360 - 180;
  // -180 and 180 are the same view; keep the positive edge that presets use.
  return wrapped === -180 ? 180 : wrapped;
}

function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  return Math.min(Math.max(pitch, -90), 90);
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
    `yaw=${-wrapYaw(options.yaw)}`,
    `pitch=${clampPitch(options.pitch)}`,
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

  let lastError: unknown;

  for (const threads of THREAD_LADDER) {
    // Decoder limit goes before -i, encoder limit after the output options.
    const decodeArgs = ["-threads", String(threads), "-filter_threads", "1"];
    const encodeArgs = ["-threads", String(threads)];
    const commonArgs = ["-y", "-i", options.input, "-vf", filter, "-an"];
    let encoder: "nvenc" | "x264" = nvencUnavailable ? "x264" : "nvenc";

    try {
      if (encoder === "nvenc") {
        try {
          await runFfmpeg([
            ...decodeArgs,
            ...commonArgs,
            ...encodeArgs,
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
        } catch (error) {
          // An allocation failure is a memory problem, not a missing encoder.
          // Retrying on the next rung of the ladder handles it; flipping the
          // global nvenc flag here would disable the GPU path for the whole run.
          if (isAllocationFailure(error)) throw error;
          nvencUnavailable = true;
          encoder = "x264";
        }
      }

      if (encoder === "x264") {
        await fs.rm(temporaryOutput, { force: true });
        await runFfmpeg([
          ...decodeArgs,
          ...commonArgs,
          ...encodeArgs,
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
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(temporaryOutput, { force: true });
      if (!isAllocationFailure(error)) throw error;
    }
  }

  throw lastError;
}
