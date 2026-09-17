"use client";

import { FolderOpen, LoaderCircle, Orbit, Video } from "lucide-react";
import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

import { useStagePanels } from "@/components/workspace/WorkspacePanels";

import type { Media } from "@/types/media";
import {
  IMAGE_SEQUENCE_INPUT_ACCEPT,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  VIDEO_INPUT_ACCEPT,
} from "@/lib/media/supportedFormats";

type SourceIntent = "normal-video" | "360-video" | "image-sequence";

interface UploadSceneProps {
  projectId: string;
  media: Media[];
  loading: boolean;
  onUploadComplete: () => void | Promise<void>;
}

export default function UploadScene({
  projectId,
  media,
  loading,
  onUploadComplete,
}: UploadSceneProps) {
  const normalVideoInput = useRef<HTMLInputElement>(null);
  const viewerVideoInput = useRef<HTMLInputElement>(null);
  const imageSequenceInput = useRef<HTMLInputElement>(null);
  const imageFolderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function collectDroppedFiles(
    dataTransfer: DataTransfer,
  ): Promise<File[]> {
    const fileList = Array.from(dataTransfer.files);
    if (fileList.length) return fileList;

    const entries = Array.from(dataTransfer.items ?? []);
    const files: File[] = [];

    async function walk(entry: DataTransferItem | FileSystemEntry) {
      if ((entry as DataTransferItem).webkitGetAsEntry) {
        const itemEntry = (entry as DataTransferItem).webkitGetAsEntry?.();
        if (!itemEntry) return;

        if (itemEntry.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            (itemEntry as FileSystemFileEntry).file(resolve, reject);
          });
          files.push(file);
          return;
        }

        if (itemEntry.isDirectory) {
          const reader = (itemEntry as FileSystemDirectoryEntry).createReader();
          const entries = await new Promise<FileSystemEntry[]>(
            (resolve, reject) => reader.readEntries(resolve, reject),
          );
          for (const child of entries)
            await walk(child as DataTransferItem & FileSystemEntry);
        }
        return;
      }

      if ((entry as FileSystemEntry).isFile) {
        const file = await new Promise<File>((resolve, reject) => {
          (entry as FileSystemFileEntry).file(resolve, reject);
        });
        files.push(file);
      } else if ((entry as FileSystemEntry).isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => reader.readEntries(resolve, reject),
        );
        for (const child of children) await walk(child);
      }
    }

    for (const entry of entries) {
      await walk(entry);
    }

    return files;
  }

  async function upload(files: File[], intent: SourceIntent) {
    if (!files.length || media.length > 0) return;

    const extensions = files.map((file) =>
      file.name.slice(file.name.lastIndexOf(".")).toLowerCase(),
    );
    const validVideos = extensions.every((extension) =>
      SUPPORTED_VIDEO_EXTENSIONS.includes(
        extension as (typeof SUPPORTED_VIDEO_EXTENSIONS)[number],
      ),
    );
    const validImages =
      extensions.length > 0 &&
      extensions.every((extension) =>
        SUPPORTED_IMAGE_EXTENSIONS.includes(
          extension as (typeof SUPPORTED_IMAGE_EXTENSIONS)[number],
        ),
      );

    if (
      (intent === "360-video" && (!validVideos || files.length !== 1)) ||
      (intent === "normal-video" && !validVideos) ||
      (intent === "image-sequence" && !validImages)
    ) {
      setError(
        intent === "image-sequence"
          ? "Choose valid image files or a folder containing supported images."
          : intent === "360-video"
            ? "Choose one 360° video."
            : "Choose supported video clips.",
      );
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("sourceIntent", intent);
      files.forEach((file) => formData.append("files", file));
      const response = await fetch(`/api/projects/${projectId}/media`, {
        method: "POST",
        body: formData,
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Upload failed.");
      await onUploadComplete();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "Upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  function selectFiles(
    event: ChangeEvent<HTMLInputElement>,
    intent: SourceIntent,
  ) {
    void upload(Array.from(event.target.files ?? []), intent);
    event.target.value = "";
  }

  async function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const files = await collectDroppedFiles(event.dataTransfer);
    const areImages =
      files.length > 0 &&
      files.every((file) =>
        SUPPORTED_IMAGE_EXTENSIONS.includes(
          file.name
            .slice(file.name.lastIndexOf("."))
            .toLowerCase() as (typeof SUPPORTED_IMAGE_EXTENSIONS)[number],
        ),
      );
    void upload(files, areImages ? "image-sequence" : "normal-video");
  }

  const disabled = loading || uploading || media.length > 0;
  const panels = useMemo(
    () => ({
      left: (
        <div className="space-y-6">
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Source capture
            </p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Choose one route. The workspace changes into the matching video or
              image stage after import.
            </p>
          </section>
          <section className="border-y border-zinc-800 py-4">
            <p className="text-xs font-medium text-zinc-300">Accepted inputs</p>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-zinc-500">
              <li>• One 360° equirectangular video</li>
              <li>• One regular capture video</li>
              <li>• At least 100 matching capture images</li>
            </ul>
          </section>
          <p className="text-xs leading-5 text-zinc-600">
            Drag-and-drop automatically detects regular video versus image
            sequence. Use the 360° button for panoramic video.
          </p>
        </div>
      ),
      right: (
        <div className="space-y-6">
          <section>
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Import status
            </p>
            <p className="mt-2 text-sm text-zinc-300">
              {uploading
                ? "Copying source files…"
                : loading
                  ? "Reading project media…"
                  : "Ready for a source capture."}
            </p>
          </section>
          <section className="border-y border-zinc-800 py-4">
            <p className="text-xs font-medium uppercase tracking-[.16em] text-zinc-500">
              Pipeline preview
            </p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              360° video → normal views → frame extraction → image gallery.
            </p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Regular video → frame extraction → image gallery.
            </p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Images → quality filtering → image gallery.
            </p>
          </section>
          {error ? (
            <p className="border border-red-900 bg-red-950/30 p-2 text-xs text-red-200">
              {error}
            </p>
          ) : null}
        </div>
      ),
    }),
    [error, loading, uploading],
  );
  useStagePanels(panels);

  return (
    <section
      className="grid h-full min-h-[620px] place-items-center bg-[#0b0b0e] p-6 text-zinc-100"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={dropFiles}
    >
      <input
        ref={normalVideoInput}
        className="hidden"
        type="file"
        multiple
        accept={VIDEO_INPUT_ACCEPT}
        onChange={(event) => selectFiles(event, "normal-video")}
      />
      <input
        ref={viewerVideoInput}
        className="hidden"
        type="file"
        accept={VIDEO_INPUT_ACCEPT}
        onChange={(event) => selectFiles(event, "360-video")}
      />
      <input
        ref={imageSequenceInput}
        className="hidden"
        type="file"
        multiple
        accept={IMAGE_SEQUENCE_INPUT_ACCEPT}
        onChange={(event) => selectFiles(event, "image-sequence")}
      />
      <input
        ref={imageFolderInput}
        className="hidden"
        type="file"
        multiple
        accept={IMAGE_SEQUENCE_INPUT_ACCEPT}
        onChange={(event) => selectFiles(event, "image-sequence")}
        {...{ webkitdirectory: "" }}
      />

      <div
        className={`w-full max-w-4xl border p-8 transition ${dragging ? "border-zinc-300 bg-zinc-900" : "border-zinc-800 bg-[#111114]"}`}
      >
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
          Source capture
        </p>
        <h1 className="mt-3 text-3xl font-medium tracking-tight">
          Start with one capture session.
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400">
          Choose a 360° video, regular video clips, or an image sequence. All
          routes become one prepared image set.
        </p>

        <div className="mt-8 grid gap-px border border-zinc-800 bg-zinc-800 md:grid-cols-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => normalVideoInput.current?.click()}
            className="bg-[#111114] p-5 text-left transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Video className="h-5 w-5 text-zinc-300" />
            <span className="mt-6 block text-sm font-medium">Normal video</span>
            <span className="mt-1 block text-xs leading-5 text-zinc-500">
              One direct capture video.
            </span>
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => viewerVideoInput.current?.click()}
            className="bg-[#111114] p-5 text-left transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Orbit className="h-5 w-5 text-zinc-300" />
            <span className="mt-6 block text-sm font-medium">360° video</span>
            <span className="mt-1 block text-xs leading-5 text-zinc-500">
              One equirectangular capture.
            </span>
          </button>
          <div className="bg-[#111114] p-5 text-left">
            <FolderOpen className="h-5 w-5 text-zinc-300" />
            <span className="mt-6 block text-sm font-medium">
              Image sequence
            </span>
            <span className="mt-1 block text-xs leading-5 text-zinc-500">
              At least 100 matching images.
            </span>
            <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" disabled={disabled} onClick={() => imageSequenceInput.current?.click()} className="border border-zinc-700 px-2 py-2 text-xs text-zinc-300 disabled:opacity-50">Choose images</button><button type="button" disabled={disabled} onClick={() => imageFolderInput.current?.click()} className="border border-zinc-700 px-2 py-2 text-xs text-zinc-300 disabled:opacity-50">Choose folder</button></div>
          </div>
        </div>

        <p className="mt-5 text-xs text-zinc-500">
          Or drop regular video clips or an image sequence here.
        </p>
        {uploading ? (
          <p className="mt-5 flex items-center gap-2 text-sm text-zinc-300">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Importing source
            capture…
          </p>
        ) : null}
        {error ? (
          <p className="mt-5 border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
