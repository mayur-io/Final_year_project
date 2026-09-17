import path from "path";

export const storageRoot = path.resolve(
  process.env.SPLATO_STORAGE_ROOT ?? path.join(process.cwd(), "storage"),
);

export function projectStorageDirectory(projectId: string) {
  return path.join(storageRoot, "projects", projectId);
}

export function storagePath(...segments: string[]) {
  return path.join(storageRoot, ...segments);
}
