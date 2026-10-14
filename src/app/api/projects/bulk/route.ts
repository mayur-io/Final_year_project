import fs from "fs/promises";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { projectStorageDirectory } from "@/lib/storage";

type BulkAction = "archive" | "restore" | "delete";

const MAX_IDS = 100;

async function deleteOne(id: string) {
  await prisma.media.deleteMany({ where: { projectId: id } });
  await prisma.project.delete({ where: { id } });
  await fs.rm(projectStorageDirectory(id), { recursive: true, force: true });
}

/** Bulk archive / restore / delete for the dashboard multiselect. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: BulkAction;
      ids?: unknown;
    };
    const { action } = body;
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
    if ((action !== "archive" && action !== "restore" && action !== "delete") || ids.length === 0) {
      return NextResponse.json(
        { error: "Provide an action (archive, restore, delete) and a non-empty ids array." },
        { status: 400 },
      );
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json(
        { error: `Select at most ${MAX_IDS} projects at a time.` },
        { status: 400 },
      );
    }

    if (action === "delete") {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            await deleteOne(id);
            return { id, ok: true as const };
          } catch (error) {
            return {
              id,
              ok: false as const,
              error: error instanceof Error ? error.message : "Delete failed.",
            };
          }
        }),
      );
      return NextResponse.json({ action, results });
    }

    await prisma.project.updateMany({
      where: { id: { in: ids } },
      data:
        action === "archive"
          ? { isArchived: true, archivedAt: new Date() }
          : { isArchived: false, archivedAt: null },
    });
    return NextResponse.json({ action, ids });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Bulk project action failed." },
      { status: 500 },
    );
  }
}
