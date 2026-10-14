"use client";

import { useState } from "react";

import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Textarea from "../ui/Textarea";

export default function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the project a name first.");
      return;
    }
    setCreating(true);
    setError(null);
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: trimmed,
        description,
      }),
    }).catch(() => null);
    setCreating(false);

    if (!response) {
      setError("Could not reach the server. Try again.");
      return;
    }
    if (response.status === 409) {
      setError(`A project named "${trimmed}" already exists. Choose a different name.`);
      return;
    }
    if (!response.ok) {
      setError("Failed to create project. Try again.");
      return;
    }

    onClose();
    onCreated();
  }

  return (
    <Modal title="New Project">
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
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

          <Button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
