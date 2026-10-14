import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

import fs from "fs/promises";
import path from "path";

import { projectStorageDirectory } from "@/lib/storage";

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      orderBy: [
        { lastAccessedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
    });

    return NextResponse.json(projects);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "Project name is required." },
        { status: 400 },
      );
    }
    // Names must be unique (case-insensitive) across active and archived
    // projects so the dashboard, archive, and storage never hold two
    // same-named projects that are impossible to tell apart.
    const clash = await prisma.project.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) {
      return NextResponse.json(
        { error: `A project named "${name}" already exists. Choose a different name.` },
        { status: 409 },
      );
    }

    const project = await prisma.project.create({
      data: {
        name,
        description: body.description,
      },
    });

    const projectRoot = projectStorageDirectory(project.id);

    await Promise.all([
      fs.mkdir(path.join(projectRoot, "originals"), {
        recursive: true,
      }),
      fs.mkdir(path.join(projectRoot, "processed"), {
        recursive: true,
      }),
      fs.mkdir(path.join(projectRoot, "outputs"), {
        recursive: true,
      }),
    ]);

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 },
    );
  }
}
