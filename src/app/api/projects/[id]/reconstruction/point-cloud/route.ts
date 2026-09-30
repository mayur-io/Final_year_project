import fs from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import { projectStorageDirectory } from "@/lib/storage";

const MAX_POINTS = 20000;

function parseTextPoints(contents: string) {
  const rows = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
  const points: Array<[number, number, number, number, number, number]> = [];

  for (const row of rows) {
    const values = row
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (values.length < 8) {
      continue;
    }

    const x = Number(values[1]);
    const y = Number(values[2]);
    const z = Number(values[3]);
    const r = Number(values[4]);
    const g = Number(values[5]);
    const b = Number(values[6]);

    if ([x, y, z, r, g, b].some((value) => !Number.isFinite(value))) {
      continue;
    }

    points.push([x, y, z, r, g, b]);
    if (points.length >= MAX_POINTS) {
      break;
    }
  }

  return points;
}

/**
 * COLMAP sparse `points3D.bin` record layout, as written by the COLMAP build
 * that produced this project's reconstruction:
 *
 *   u64  record count
 *   per record (51-byte header):
 *     u32 point3D_id
 *     u32 (reserved)
 *     f64 x, f64 y, f64 z        <- 8-byte coordinates, not f32
 *     u8  r, u8 g, u8 b
 *     f64 error
 *     u64 track_length
 *     track: track_length * (i32 image_id, i32 point2D_idx)   <- 8 bytes/entry
 *
 * Coordinates are interleaved with variable-length tracks, so the file must be
 * walked sequentially; it cannot be read as a fixed-stride array of records.
 */
const POINT_HEADER_BYTES = 51;
const TRACK_ENTRY_BYTES = 8;

function parseBinaryPoints(buffer: Buffer) {
  if (buffer.length < 8) {
    return [] as Array<[number, number, number, number, number, number]>;
  }

  const count = Number(buffer.readBigUInt64LE(0));
  const points: Array<[number, number, number, number, number, number]> = [];
  let offset = 8;

  for (let index = 0; index < count && points.length < MAX_POINTS; index += 1) {
    if (offset + POINT_HEADER_BYTES > buffer.length) {
      break;
    }

    const x = buffer.readDoubleLE(offset + 8);
    const y = buffer.readDoubleLE(offset + 16);
    const z = buffer.readDoubleLE(offset + 24);
    const r = buffer.readUInt8(offset + 32);
    const g = buffer.readUInt8(offset + 33);
    const b = buffer.readUInt8(offset + 34);
    const error = buffer.readDoubleLE(offset + 35);

    const trackLength = Number(buffer.readBigUInt64LE(offset + 43));
    if (!Number.isFinite(trackLength) || trackLength < 0 || trackLength > 1_000_000) {
      break;
    }

    offset += POINT_HEADER_BYTES + trackLength * TRACK_ENTRY_BYTES;

    if ([x, y, z, error].some((value) => !Number.isFinite(value))) {
      continue;
    }

    points.push([x, y, z, r, g, b]);
  }

  return points;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const reconstructionDirectory = path.join(
      projectStorageDirectory(id),
      "reconstruction",
      "sparse",
      "0",
    );

    const pointCloudText = path.join(reconstructionDirectory, "points3D.txt");
    const pointCloudBinary = path.join(reconstructionDirectory, "points3D.bin");

    try {
      const text = await fs.readFile(pointCloudText, "utf8");
      return NextResponse.json({ points: parseTextPoints(text) });
    } catch {
      // Fall through to the binary format if the text export is not present.
    }

    try {
      const binary = await fs.readFile(pointCloudBinary);
      const points = parseBinaryPoints(binary);
      return NextResponse.json({ points });
    } catch {
      return NextResponse.json(
        { error: "Sparse point cloud not found." },
        { status: 404 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load point cloud.",
      },
      { status: 500 },
    );
  }
}
