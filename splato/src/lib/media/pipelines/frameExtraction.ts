import fs from "fs/promises";
import path from "path";

import { extractFrames } from "../tools/ffmpeg";
import { projectStorageDirectory, storageRoot } from "@/lib/storage";

export interface FrameExtractionOptions {
  projectId: string;
  mediaPath: string;
  mediaName: string;
  outputDirectory?: string;
  fps?: number;
  quality?: number;
  startTime?: number;
  endTime?: number;
  outputPrefix?: string;
}

export async function frameExtraction(options: FrameExtractionOptions) {
  const framesDirectory =
    options.outputDirectory ??
    path.join(projectStorageDirectory(options.projectId), "processed", "frames");

  await fs.mkdir(framesDirectory, {
    recursive: true,
  });

  console.log("========== FRAME EXTRACTION ==========");
  console.log("Input :", options.mediaPath);
  console.log("Output:", framesDirectory);

  await extractFrames({
    input: path.isAbsolute(options.mediaPath)
      ? options.mediaPath
      : path.join(storageRoot, options.mediaPath),
    outputDirectory: framesDirectory,
    fps: options.fps ?? 1,
    format: "jpg",
    quality: options.quality ?? 2,
    startTime: options.startTime,
    endTime: options.endTime,
    outputPrefix: options.outputPrefix,
  });

  console.log("Frame extraction completed.");

  return {
    success: true,
    outputDirectory: framesDirectory,
    source: options.mediaName,
  };
}
