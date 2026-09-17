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

function parseBinaryPoints(buffer: Buffer) {
  if (buffer.length < 8) {
    return [] as Array<[number, number, number, number, number, number]>;
  }

  const count = Number(buffer.readBigUInt64LE(0));
  const points: Array<[number, number, number, number, number, number]> = [];
  let offset = 8;

  for (let index = 0; index < count && points.length < MAX_POINTS; index += 1) {
    if (offset + 8 * 3 + 3 + 4 + 8 > buffer.length) {
      break;
    }

    const x = buffer.readFloatLE(offset);
    offset += 4;
    const y = buffer.readFloatLE(offset);
    offset += 4;
    const z = buffer.readFloatLE(offset);
    offset += 4;
    const r = buffer.readUInt8(offset);
    offset += 1;
    const g = buffer.readUInt8(offset);
    offset += 1;
    const b = buffer.readUInt8(offset);
    offset += 1;

    const error = buffer.readFloatLE(offset);
    offset += 4;
    const trackLength = Number(buffer.readBigUInt64LE(offset));
    offset += 8;

    const payloadSize = trackLength * 16;
    if (offset + payloadSize > buffer.length) {
      break;
    }
    offset += payloadSize;

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
