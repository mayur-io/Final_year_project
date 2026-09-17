import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

interface RouteContext {
  params: Promise<{
    id: string;
  }>;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;

    const project = await prisma.project.update({
      where: {
        id,
      },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Failed to archive project.",
      },
      {
        status: 500,
      },
    );
  }
}
