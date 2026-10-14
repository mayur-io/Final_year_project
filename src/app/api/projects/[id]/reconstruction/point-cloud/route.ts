import fs from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

import { projectStorageDirectory } from "@/lib/storage";

const MAX_POINTS = 20000;

function parseTextPoints(contents: string) {
  const rows = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
  const points: Array<[number, number, number, number, number, number]> = [];
  let total = 0;

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

    total += 1;
    if (points.length < MAX_POINTS) {
      points.push([x, y, z, r, g, b]);
    }
  }

  return { points, total };
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
    return { points: [] as Array<[number, number, number, number, number, number]>, total: 0 };
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

  return { points, total: count };
}

/** Minimal fused.ply reader (COLMAP ascii or binary_le): x/y/z + rgb. */
function parsePlyPoints(buffer: Buffer) {
  const headerEnd = buffer.indexOf("end_header");
  if (headerEnd === -1) return { points: [], total: 0 };
  const header = buffer.subarray(0, headerEnd).toString("ascii").split("\n");
  const format = (header.find((line) => line.startsWith("format")) ?? "").split(/\s+/)[1] ?? "";
  let count = 0;
  const names: string[] = [];
  const sizes: number[] = [];
  for (const line of header) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element" && parts[1] === "vertex") count = Number(parts[2]);
    if (parts[0] === "property" && parts.length === 3) {
      names.push(parts[2]);
      sizes.push(parts[1] === "uchar" || parts[1] === "uint8" ? 1 : parts[1] === "double" ? 8 : 4);
    }
  }
  const xi = names.indexOf("x");
  const yi = names.indexOf("y");
  const zi = names.indexOf("z");
  let ci = ["red", "green", "blue"].map((key) => names.indexOf(key));
  if (ci.some((index) => index === -1)) ci = ["r", "g", "b"].map((key) => names.indexOf(key));
  if ([xi, yi, zi, ...ci].some((index) => index === -1) || !count) return { points: [], total: 0 };

  const readRow = (values: number[]): [number, number, number, number, number, number] | null => {
    const x = values[xi];
    const y = values[yi];
    const z = values[zi];
    let [r, g, b] = ci.map((index) => values[index]);
    if (Math.max(r, g, b) <= 1) {
      r *= 255;
      g *= 255;
      b *= 255;
    }
    if ([x, y, z, r, g, b].some((value) => !Number.isFinite(value))) return null;
    return [x, y, z, r, g, b];
  };

  const body = buffer.subarray(headerEnd + "end_header".length);
  const points: Array<[number, number, number, number, number, number]> = [];
  const stride = Math.max(1, Math.floor(count / MAX_POINTS));
  if (format === "ascii") {
    const lines = body.toString("utf8").split("\n");
    for (let i = 0; i < count && points.length < MAX_POINTS; i += stride) {
      const values = (lines[i] ?? "").trim().split(/\s+/).map(Number);
      if (values.length < names.length) continue;
      const point = readRow(values);
      if (point) points.push(point);
    }
    return { points, total: count };
  }
  if (format === "binary_little_endian") {
    const rowBytes = sizes.reduce((sum, size) => sum + size, 0);
    const offset = body[0] === 10 ? 1 : 0;
    for (let i = 0; i < count && points.length < MAX_POINTS; i += stride) {
      const at = offset + i * rowBytes;
      if (at + rowBytes > body.length) break;
      const values: number[] = [];
      let cursor = at;
      for (const size of sizes) {
        values.push(size === 1 ? body.readUInt8(cursor) : size === 8 ? body.readDoubleLE(cursor) : body.readFloatLE(cursor));
        cursor += size;
      }
      const point = readRow(values);
      if (point) points.push(point);
    }
    return { points, total: count };
  }
  return { points: [], total: 0 };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const source = new URL(request.url).searchParams.get("source") === "dense" ? "dense" : "sparse";
    if (source === "dense") {
      try {
        const binary = await fs.readFile(
          path.join(projectStorageDirectory(id), "reconstruction", "dense", "fused.ply"),
        );
        const { points, total } = parsePlyPoints(binary);
        if (!points.length) {
          return NextResponse.json(
            { error: "The dense point cloud exists but contains no readable points." },
            { status: 422 },
          );
        }
        return NextResponse.json({ points, source, count: points.length, totalPoints: total, label: "Dense point cloud (COLMAP fused.ply)" });
      } catch {
        return NextResponse.json({ error: "Dense point cloud not found." }, { status: 404 });
      }
    }
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
      const { points, total } = parseTextPoints(text);
      if (!points.length) {
        return NextResponse.json(
          { error: "The sparse point cloud exists but contains no readable points." },
          { status: 422 },
        );
      }
      return NextResponse.json({ points, source, count: points.length, totalPoints: total, label: "Sparse point cloud (COLMAP)" });
    } catch {
      // Fall through to the binary format if the text export is not present.
    }

    try {
      const binary = await fs.readFile(pointCloudBinary);
      const { points, total } = parseBinaryPoints(binary);
      if (!points.length) {
        return NextResponse.json(
          { error: "The sparse point cloud exists but contains no readable points." },
          { status: 422 },
        );
      }
      return NextResponse.json({ points, source, count: points.length, totalPoints: total, label: "Sparse point cloud (COLMAP)" });
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
