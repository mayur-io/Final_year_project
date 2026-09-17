import fs from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import { projectStorageDirectory } from "@/lib/storage";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const processedDirectory = path.join(projectStorageDirectory(id), "processed");

  async function filesIn(directory: string, extensions: string[]) {
    try {
      const files = await fs.readdir(directory);
      return files.filter((file) => extensions.includes(path.extname(file).toLowerCase()));
    } catch {
      return [];
    }
  }

  const [frames, candidates, convertedVideos] = await Promise.all([
    filesIn(path.join(processedDirectory, "frames"), [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]),
    filesIn(path.join(processedDirectory, "candidates"), [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]),
    filesIn(path.join(processedDirectory, "converted"), [".mp4"]),
  ]);

  return NextResponse.json({
    frames: frames.sort(),
    candidates: candidates.sort(),
    convertedVideos: convertedVideos.sort(),
  });
}
