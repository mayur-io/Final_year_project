import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import ProjectWorkspace from "@/components/workspace/ProjectWorkspace";

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

  return <ProjectWorkspace projectId={project.id} projectName={project.name} />;
}
