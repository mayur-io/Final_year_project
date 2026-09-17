import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

import fs from "fs/promises";
import path from "path";

import { projectStorageDirectory } from "@/lib/storage";

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      orderBy: {
        createdAt: "desc",
      },
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

    const project = await prisma.project.create({
      data: {
        name: body.name,
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
