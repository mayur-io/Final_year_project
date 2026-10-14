import { NextResponse } from "next/server";

import {
  readFramesManifest,
  readPreparationReport,
} from "@/lib/media/prepareReport";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [report, manifest] = await Promise.all([
    readPreparationReport(id),
    readFramesManifest(id),
  ]);
  return NextResponse.json({
    report,
    manifest: manifest
      ? { sourceType: manifest.sourceType, count: manifest.frames.length }
      : null,
  });
}
