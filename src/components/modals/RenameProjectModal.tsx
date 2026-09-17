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

  async function handleRename() {
    const response = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        description,
      }),
    });

    if (!response.ok) {
      alert("Failed to rename project");
      return;
    }

    onClose();
    onCreated();
  }

  return (
    <Modal title="Rename Project">
      <div className="space-y-5">
        <Input
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

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>

          <Button onClick={handleRename}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
