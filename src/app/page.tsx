import WorkspaceLayout from "@/components/layout/WorkspaceLayout";
import ProjectDashboard from "@/components/dashboard/ProjectDashboard";
import { prisma } from "@/lib/prisma";

export default async function Home() {
  const projects = await prisma.project.findMany({
    where: {
      isArchived: false,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return (
    <WorkspaceLayout>
      <div className="max-w-6xl mx-auto">
        <ProjectDashboard projects={projects} />
      </div>
    </WorkspaceLayout>
  );
}
