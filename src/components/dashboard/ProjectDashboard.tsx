"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "../modals/ConfirmDialog";

import Button from "../ui/Button";

import NewProjectModal from "../modals/NewProjectModal";
import RenameProjectModal from "../modals/RenameProjectModal";
import { formatDateTime, formatRelativeTime } from "@/lib/formatRelativeTime";

type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string | Date;
  lastAccessedAt: string | Date | null;
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
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"archive" | "delete" | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  const allChecked = projects.length > 0 && checked.size === projects.length;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setChecked(allChecked ? new Set() : new Set(projects.map((project) => project.id)));
  }

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

  async function runBulk() {
    if (!bulkAction || checked.size === 0) return;
    setBulkLoading(true);
    try {
      const response = await fetch("/api/projects/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: bulkAction, ids: [...checked] }),
      });
      if (!response.ok) throw new Error();
      setChecked(new Set());
      setBulkAction(null);
      router.refresh();
    } catch {
      alert(`Failed to ${bulkAction} selected projects`);
    } finally {
      setBulkLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Projects</h1>

        <Button onClick={() => setIsOpen(true)}>New Project</Button>
      </div>

      {projects.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm">
          <label className="flex cursor-pointer items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              className="h-4 w-4 accent-white"
            />
            {allChecked ? "Deselect all" : "Select all"}
          </label>
          <span className="text-gray-500">
            {checked.size} of {projects.length} selected
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setBulkAction("archive")}
              disabled={checked.size === 0}
            >
              Archive selected
            </Button>
            <Button
              variant="danger"
              onClick={() => setBulkAction("delete")}
              disabled={checked.size === 0}
            >
              Delete selected
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4">
        {projects.map((project) => (
          <div
            key={project.id}
            className="rounded-xl border border-white/10 p-5"
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                aria-label={`Select ${project.name}`}
                checked={checked.has(project.id)}
                onChange={() => toggle(project.id)}
                className="mt-1 h-4 w-4 shrink-0 accent-white"
              />
              <div className="min-w-0 flex-1">
                <Link href={`/projects/${project.id}`}>
                  <h2 className="text-xl font-semibold">{project.name}</h2>
                </Link>

                {project.description && (
                  <p className="mt-2">{project.description}</p>
                )}

                <p className="mt-3 text-sm">Status: {project.status}</p>
                <p className="mt-1 text-sm text-gray-400">
                  {formatRelativeTime(project.lastAccessedAt)}
                  {" · "}Created {formatDateTime(project.createdAt)}
                </p>
              </div>
            </div>

            <div className="mt-5 flex gap-2 pl-7">
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

      <ConfirmDialog
        open={bulkAction !== null}
        title={bulkAction === "delete" ? `Delete ${checked.size} projects?` : `Archive ${checked.size} projects?`}
        description={
          bulkAction === "delete"
            ? "This permanently deletes the selected projects and all of their media, processed files, outputs and database records. This cannot be undone."
            : "The selected projects will be moved to the archive. You can restore them later at any time."
        }
        confirmText={bulkAction === "delete" ? "Delete permanently" : "Archive"}
        loading={bulkLoading}
        onCancel={() => setBulkAction(null)}
        onConfirm={runBulk}
      />
    </>
  );
}
