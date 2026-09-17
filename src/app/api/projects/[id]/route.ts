import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { projectStorageDirectory } from "@/lib/storage";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { name, description } = await request.json();

    const project = await prisma.project.update({
      where: { id },
      data: {
        name,
        description,
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Failed to rename project" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      return NextResponse.json(
        {
          error: "Project not found",
        },
        {
          status: 404,
        },
      );
    }

    const fs = await import("fs/promises");
    const projectDirectory = projectStorageDirectory(id);

    // Delete related media records first
    await prisma.media.deleteMany({
      where: {
        projectId: id,
      },
    });

    // Delete project
    await prisma.project.delete({
      where: {
        id,
      },
    });

    // Delete storage folder (originals, processed, outputs)
    await fs.rm(projectDirectory, {
      recursive: true,
      force: true,
    });

    return NextResponse.json({
      message: "Project deleted permanently",
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Failed to delete project",
      },
      {
        status: 500,
      },
    );
  }
}
