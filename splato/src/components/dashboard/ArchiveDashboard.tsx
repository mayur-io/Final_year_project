"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ConfirmDialog from "../modals/ConfirmDialog";

import Button from "../ui/Button";

type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
};

export default function ArchiveDashboard({
  projects,
}: {
  projects: Project[];
}) {
  const router = useRouter();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(false);

  async function restoreProject(id: string) {
    const response = await fetch(`/api/projects/${id}/restore`, {
      method: "PATCH",
    });

    if (!response.ok) {
      alert("Failed to restore project");
      return;
    }

    router.refresh();
  }

  async function deleteProject() {
    if (!selectedProjectId) return;

    setLoading(true);

    try {
      const response = await fetch(`/api/projects/${selectedProjectId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error();
      }

      setSelectedProjectId(null);
      router.refresh();
    } catch {
      alert("Failed to delete project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Archived Projects</h1>
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
                onClick={() => restoreProject(project.id)}
              >
                Restore
              </Button>

              <Button
                variant="danger"
                onClick={() => setSelectedProjectId(project.id)}
              >
                Delete Permanently
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={selectedProjectId !== null}
        title="Delete Project"
        description="This action will permanently delete this project and all of its media, processed files, outputs and database records. This action cannot be undone."
        confirmText="Delete Permanently"
        loading={loading}
        onCancel={() => setSelectedProjectId(null)}
        onConfirm={deleteProject}
      />
    </>
  );
}
