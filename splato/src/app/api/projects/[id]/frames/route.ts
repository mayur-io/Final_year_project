import fs from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import {
  getFrameReview,
  rejectFrames,
  restoreFrames,
} from "@/lib/media/frameReview";
import { projectStorageDirectory } from "@/lib/storage";

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
]);

async function imagesIn(directory: string) {
  try {
    return (await fs.readdir(directory))
      .filter((file) => imageExtensions.has(path.extname(file).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const processed = path.join(projectStorageDirectory(id), "processed");
  const [frames, candidates, rejected] = await Promise.all([
    imagesIn(path.join(processed, "frames")),
    imagesIn(path.join(processed, "candidates")),
    getFrameReview(id),
  ]);
  return NextResponse.json({ frames, candidates, rejected });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await request.json()) as {
      action?: "reject" | "restore";
      filenames?: string[];
    };
    const filenames = [...new Set(body.filenames ?? [])].slice(0, 1200);
    if (!filenames.length) {
      return NextResponse.json({ error: "Choose at least one frame." }, { status: 400 });
    }
    if (body.action === "reject") await rejectFrames(id, filenames);
    else if (body.action === "restore") await restoreFrames(id, filenames);
    else return NextResponse.json({ error: "Unsupported review action." }, { status: 400 });
    return NextResponse.json({
      ok: true,
      review: await getFrameReview(id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Frame review could not be updated." },
      { status: 400 },
    );
  }
}
