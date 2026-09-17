import { NextRequest, NextResponse } from "next/server";

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import { storageRoot } from "@/lib/storage";

const mimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path: segments } = await params;
  if (segments[0] !== "projects" || segments[1] !== id) {
    return NextResponse.json({ error: "Media path does not belong to this project." }, { status: 403 });
  }

  const filePath = path.resolve(storageRoot, ...segments);
  const projectRoot = path.resolve(storageRoot, "projects", id) + path.sep;
  if (!filePath.startsWith(projectRoot)) {
    return NextResponse.json({ error: "Invalid media path." }, { status: 400 });
  }

  try {
    const stat = await fsp.stat(filePath);

    const extension = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[extension] ?? "application/octet-stream";

    const range = request.headers.get("range");

    if (!range) {
      const file = await fsp.readFile(filePath);

      return new NextResponse(file, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": stat.size.toString(),
          "Accept-Ranges": "bytes",
        },
      });
    }

    const matches = /bytes=(\d*)-(\d*)/.exec(range);

    if (!matches) {
      return new NextResponse(null, {
        status: 416,
      });
    }

    const start = matches[1] ? Number(matches[1]) : 0;
    const end = matches[2] ? Number(matches[2]) : stat.size - 1;

    if (start >= stat.size || end >= stat.size || start > end) {
      return new NextResponse(null, {
        status: 416,
      });
    }

    const stream = fs.createReadStream(filePath, {
      start,
      end,
    });

    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": (end - start + 1).toString(),
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "File not found",
      },
      {
        status: 404,
      },
    );
  }
}
