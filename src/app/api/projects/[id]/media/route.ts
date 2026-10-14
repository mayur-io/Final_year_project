import fs from "fs/promises";
import path from "path";

import { NextRequest, NextResponse } from "next/server";

import { detectAssetType, isSupportedExtension, type AssetType } from "@/lib/media/fileUtils";
import { getAvailablePipelines } from "@/lib/media/processing";
import { validateImageSet } from "@/lib/media/tools/openCv";
import { probeVideoInfo } from "@/lib/media/tools/ffmpeg";
import { prisma } from "@/lib/prisma";
import { projectStorageDirectory } from "@/lib/storage";
import { startProcessJob } from "@/lib/media/processJob";

type SourceIntent = "normal-video" | "360-video" | "image-sequence";
type UploadSource = { file: File; filename: string; assetType: AssetType };

function isSourceIntent(value: FormDataEntryValue | null): value is SourceIntent {
  return value === "normal-video" || value === "360-video" || value === "image-sequence";
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const media = await prisma.media.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } });
  return NextResponse.json(media);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let stagingDirectory: string | null = null;
  try {
    const formData = await request.formData();
    const sourceIntent = formData.get("sourceIntent");
    const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (!isSourceIntent(sourceIntent)) return NextResponse.json({ error: "Choose a source type." }, { status: 400 });
    if (!files.length) return NextResponse.json({ error: "No source files were selected." }, { status: 400 });

    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    if (await prisma.media.count({ where: { projectId: id } })) return NextResponse.json({ error: "This project already has a source capture." }, { status: 409 });

    const sources: UploadSource[] = files.map((file) => ({ file, filename: file.name.trim(), assetType: detectAssetType(file.name) }));
    if (sources.some((source) => !source.filename || !isSupportedExtension(source.filename))) return NextResponse.json({ error: "One or more selected files are not supported." }, { status: 400 });
    const expectedType = sourceIntent === "image-sequence" ? "image" : "video";
    if (sources.some((source) => source.assetType !== expectedType)) return NextResponse.json({ error: "The selected files do not match the chosen source type." }, { status: 400 });
    if ((sourceIntent === "360-video" || sourceIntent === "normal-video") && sources.length !== 1) return NextResponse.json({ error: `${sourceIntent === "360-video" ? "360° capture" : "Normal video capture"} accepts one source video.` }, { status: 400 });
    if (sourceIntent === "image-sequence" && sources.length < 100) return NextResponse.json({ error: "An image sequence requires at least 100 images." }, { status: 400 });
    if (new Set(sources.map((source) => source.filename)).size !== sources.length) return NextResponse.json({ error: "Source files need unique filenames." }, { status: 400 });

    const projectDirectory = projectStorageDirectory(id);
    stagingDirectory = path.join(projectDirectory, ".staging");
    const originalsDirectory = path.join(projectDirectory, "originals");
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    await fs.mkdir(stagingDirectory, { recursive: true });
    await Promise.all(sources.map(async (source) => fs.writeFile(path.join(stagingDirectory!, source.filename), Buffer.from(await source.file.arrayBuffer()))));

    let acceptedNames = sources.map((source) => source.filename);
    let rejectedNames: string[] = [];
    if (sourceIntent === "image-sequence") ({ accepted: acceptedNames, rejected: rejectedNames } = await validateImageSet(stagingDirectory));
    const minimumAccepted = sourceIntent === "image-sequence" ? 100 : 1;
    if (acceptedNames.length < minimumAccepted) return NextResponse.json({ error: `The capture consistency check accepted only ${acceptedNames.length} files; at least ${minimumAccepted} are required.`, acceptedFiles: acceptedNames, rejectedFiles: rejectedNames }, { status: 400 });

    // The selected button is the declared input type. Validate it instead of
    // silently switching paths: a 360° upload must actually be stitched
    // equirectangular footage, or it is rejected with its measured resolution.
    let sourceMetadata: Record<string, unknown> | undefined;
    if (expectedType === "video") {
      const stagedVideo = path.join(stagingDirectory, acceptedNames[0]);
      let info;
      try {
        info = await probeVideoInfo(stagedVideo);
      } catch {
        return NextResponse.json(
          { error: `“${acceptedNames[0]}” could not be read as video. The file may be corrupt or use an unsupported codec.` },
          { status: 400 },
        );
      }
      sourceMetadata = {
        width: info.width,
        height: info.height,
        fps: info.fps,
        durationSeconds: info.duration,
      };
      if (sourceIntent === "360-video") {
        const ratio = info.width / info.height;
        if (Math.abs(ratio - 2) > 0.04) {
          return NextResponse.json(
            {
              error: `This clip is ${info.width}×${info.height} (${ratio.toFixed(2)}:1), not equirectangular 360°. Upload a stitched 2:1 panorama (for example 5760×2880, 3840×1920, or 2880×1440). A normal 16:9 video cannot become 360° by picking the 360° button.`,
              sourceMetadata,
            },
            { status: 400 },
          );
        }
        if (info.width < 1920 || info.height < 960) {
          return NextResponse.json(
            {
              error: `This 360° clip is ${info.width}×${info.height}, below the minimum 1920×960 usable for projection. Export a higher-resolution stitched panorama.`,
              sourceMetadata,
            },
            { status: 400 },
          );
        }
      }
    }

    await fs.mkdir(originalsDirectory, { recursive: true });
    const acceptedSources = sources.filter((source) => acceptedNames.includes(source.filename));
    await Promise.all(acceptedSources.map((source) => fs.rename(path.join(stagingDirectory!, source.filename), path.join(originalsDirectory, source.filename))));
    const workspace = sourceIntent === "360-video" ? "VIEWER_360" : "UPLOADER";
    const media = await prisma.$transaction(acceptedSources.map((source) => prisma.media.create({ data: { filename: source.filename, filepath: path.join("projects", id, "originals", source.filename), filesize: source.file.size, mimetype: source.file.type || "application/octet-stream", assetType: source.assetType === "video" ? "VIDEO" : "IMAGE", workspace, projectId: id } })));
    if (sourceIntent === "image-sequence") await startProcessJob(id, "image-preparation", { source: "image-sequence" });
    const nextAction =
      sourceIntent === "360-video"
        ? "Plan perspective projections, then extract frames."
        : sourceIntent === "normal-video"
          ? "Extract frames, then review the image gallery."
          : "Image filtering is already running.";
    return NextResponse.json(
      {
        media,
        sourceType: sourceIntent,
        acceptedFiles: acceptedNames,
        rejectedFiles: rejectedNames,
        sourceMetadata,
        nextAction,
        availablePipelines: getAvailablePipelines(expectedType),
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload failed." }, { status: 500 });
  } finally {
    if (stagingDirectory) await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}
