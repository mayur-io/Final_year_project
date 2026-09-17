import WorkspaceLayout from "@/components/layout/WorkspaceLayout";
import ArchiveDashboard from "@/components/dashboard/ArchiveDashboard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const projects = await prisma.project.findMany({
    where: {
      isArchived: true,
    },
    orderBy: {
      archivedAt: "desc",
    },
  });

  return (
    <WorkspaceLayout>
      <div className="max-w-6xl mx-auto">
        <ArchiveDashboard projects={projects} />
      </div>
    </WorkspaceLayout>
  );
}
