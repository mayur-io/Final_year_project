"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "../modals/ConfirmDialog";

import Button from "../ui/Button";

import NewProjectModal from "../modals/NewProjectModal";
import RenameProjectModal from "../modals/RenameProjectModal";

type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
};

type Props = {
  projects: Project[];
};

export default function ProjectDashboard({ projects }: Props) {
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [archiveProjectId, setArchiveProjectId] = useState<string | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);

  async function archiveProject() {
    if (!archiveProjectId) return;

    setArchiveLoading(true);

    try {
      const response = await fetch(
        `/api/projects/${archiveProjectId}/archive`,
        {
          method: "PATCH",
        },
      );

      if (!response.ok) {
        throw new Error();
      }

      setArchiveProjectId(null);
      router.refresh();
    } catch {
      alert("Failed to archive project");
    } finally {
      setArchiveLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Projects</h1>

        <Button onClick={() => setIsOpen(true)}>New Project</Button>
      </div>

      <div className="grid gap-4">
        {projects.map((project) => (
          <div
            key={project.id}
            className="rounded-xl border border-white/10 p-5"
          >
            <Link href={`/projects/${project.id}`}>
              <h2 className="text-xl font-semibold">{project.name}</h2>
            </Link>

            {project.description && (
              <p className="mt-2">{project.description}</p>
            )}

            <p className="mt-3 text-sm">Status: {project.status}</p>

            <div className="mt-5 flex gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setSelectedProject(project);
                  setIsRenameOpen(true);
                }}
              >
                Edit
              </Button>

              <Button
                variant="secondary"
                onClick={() => setArchiveProjectId(project.id)}
              >
                Archive
              </Button>
            </div>
          </div>
        ))}
      </div>

      {isOpen && (
        <NewProjectModal
          onClose={() => setIsOpen(false)}
          onCreated={() => router.refresh()}
        />
      )}

      {isRenameOpen && selectedProject && (
        <RenameProjectModal
          project={selectedProject}
          onClose={() => {
            setIsRenameOpen(false);
            setSelectedProject(null);
          }}
          onCreated={() => {
            setIsRenameOpen(false);
            setSelectedProject(null);
            router.refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={archiveProjectId !== null}
        title="Archive Project"
        description="This project will be moved to the archive. You can restore it later at any time."
        confirmText="Archive"
        loading={archiveLoading}
        onCancel={() => setArchiveProjectId(null)}
        onConfirm={archiveProject}
      />
    </>
  );
}
