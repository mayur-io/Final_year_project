"use client";

import { useState } from "react";

import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Textarea from "../ui/Textarea";

type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
};

export default function RenameProjectModal({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleRename() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the project a name first.");
      return;
    }
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: trimmed,
        description,
      }),
    }).catch(() => null);
    setSaving(false);

    if (!response) {
      setError("Could not reach the server. Try again.");
      return;
    }
    if (response.status === 409) {
      setError(`A project named "${trimmed}" already exists. Choose a different name.`);
      return;
    }
    if (!response.ok) {
      setError("Failed to rename project. Try again.");
      return;
    }

    onClose();
    onCreated();
  }

  return (
    <Modal title="Rename Project">
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleRename();
        }}
      >
        <Input
          autoFocus
          placeholder="Project Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Textarea
          rows={5}
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>

          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
