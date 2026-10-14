import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import ProjectWorkspace from "@/components/workspace/ProjectWorkspace";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function ProjectPage({ params }: PageProps) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: {
      id,
    },
  });

  if (!project) {
    notFound();
  }

  // Recency signal for the dashboard: every open refreshes lastAccessedAt so
  // the most recently used project sorts to the top of the home page.
  await prisma.project.update({
    where: { id: project.id },
    data: { lastAccessedAt: new Date() },
  });

  return <ProjectWorkspace projectId={project.id} projectName={project.name} />;
}
