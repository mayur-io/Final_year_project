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
  roll?: number;
  fieldOfView: number;
  outputWidth?: number;
  outputHeight?: number;
}

/**
 * Resolve tools portably. An explicit environment override wins; otherwise the
 * bare command name is used so the system PATH is searched. The previous
 * hardcoded WinGet path made the app work on exactly one machine and fail
 * everywhere else with a raw ENOENT. `toolSpawnError` turns that into an
 * actionable prerequisite message.
 */
const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const FFPROBE_PATH =
  process.env.FFPROBE_PATH?.trim() ||
  (process.env.FFMPEG_PATH?.trim()
    ? path.join(
        path.dirname(process.env.FFMPEG_PATH.trim()),
        process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
      )
    : "ffprobe");
let nvencUnavailable = false;

function toolSpawnError(tool: "ffmpeg" | "ffprobe", error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") {
    const variable = tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
    return new Error(
      `${tool} was not found. Install FFmpeg and add it to PATH, or point ${variable} at the executable. Frame extraction and 360° projection cannot run without it.`,
    );
  }
  return error;
}

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

    ffmpeg.on("error", (error) => reject(toolSpawnError("ffmpeg", error as NodeJS.ErrnoException)));
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
    probe.on("error", (spawnError) => reject(toolSpawnError("ffprobe", spawnError as NodeJS.ErrnoException)));
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

export interface VideoStreamInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
}

/** Probe dimensions + fps + duration in one ffprobe call. */
export async function probeVideoInfo(input: string): Promise<VideoStreamInfo> {
  return new Promise<VideoStreamInfo>((resolve, reject) => {
    const probe = spawn(FFPROBE_PATH, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate:format=duration",
      "-of",
      "default=noprint_wrappers=1",
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
    probe.on("error", (spawnError) => reject(toolSpawnError("ffprobe", spawnError as NodeJS.ErrnoException)));
    probe.on("close", (code) => {
      const get = (key: string) => {
        const match = new RegExp(`^${key}=(.+)$`, "m").exec(output);
        return match ? match[1].trim() : "";
      };
      const width = Number(get("width"));
      const height = Number(get("height"));
      const fpsParts = get("avg_frame_rate").split("/").map(Number);
      const fps = fpsParts.length === 2 && fpsParts[1] ? fpsParts[0] / fpsParts[1] : Number(get("avg_frame_rate"));
      const duration = Number(get("duration"));
      if (code === 0 && width > 0 && height > 0) {
        resolve({ width, height, fps: Number.isFinite(fps) && fps > 0 ? fps : 30, duration: Number.isFinite(duration) ? duration : 0 });
        return;
      }
      reject(new Error(`FFprobe could not read the video stream. ${error}`));
    });
  });
}

/**
 * Equirectangular 360 is 2:1 (width ≈ 2× height). Anything else — 16:9,
 * 4:3, portrait — is a perspective clip misrouted to the 360 pipeline.
 * v360-ing those produces the bent mush users see, so detect and refuse.
 */
export function isEquirectangular(width: number, height: number): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio > 1.85 && ratio < 2.15;
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
    // Drop near-identical consecutive frames at decode time so the candidate
    // budget is spent on changing content (motion), not static holds.
    // The filter stage still validates everything that survives.
    args.push("-vf", `mpdecimate,fps=${options.fps}`);
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

/** Extract one frame at a timestamp — used by the post-conversion quality gate. */
export async function extractSingleFrame(input: string, output: string, timestampSeconds: number) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await runFfmpeg(["-y", "-ss", Math.max(timestampSeconds, 0).toString(), "-i", input, "-frames:v", "1", "-update", "1", "-q:v", "2", output]);
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

function clampRoll(roll: number | undefined): number {
  if (!Number.isFinite(roll as number)) return 0;
  return Math.min(Math.max(roll as number, -45), 45);
}

export async function convert360View(options: Convert360ViewOptions) {
  const outputWidth = options.outputWidth ?? 1600;
  const outputHeight = options.outputHeight ?? 900;
  // Projection FOV is an engine-compatibility knob: wider FOV gives neighbouring
  // views more shared pixels to match on, narrower FOV lowers distortion. Allow
  // the planner's computed range instead of silently clamping to a magic 70–90.
  const horizontalFov = Math.min(Math.max(options.fieldOfView, 50), 120);
  const verticalFov =
    (2 * Math.atan(Math.tan((horizontalFov * Math.PI) / 360) / (outputWidth / outputHeight)) * 180) /
    Math.PI;
  const filter = [
    "v360=input=equirect:output=flat",
    "interp=lanczos",
    `yaw=${-wrapYaw(options.yaw)}`,
    `pitch=${clampPitch(options.pitch)}`,
    `roll=${clampRoll(options.roll)}`,
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
