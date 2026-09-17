import { spawn } from "child_process";
import type { Dirent } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { storagePath } from "@/lib/storage";

const MANAGED_RUNTIME_DIRECTORY = storagePath("runtime", "colmap");
const GITHUB_API = "https://api.github.com/repos/colmap/colmap/releases/latest";

type ReleaseAsset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: ReleaseAsset[] };

function run(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const process = spawn(command, args, { windowsHide: true });
    process.on("close", (code) => resolve(code === 0));
    process.on("error", () => resolve(false));
  });
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function findExecutable(directory: string): Promise<string | null> {
  let entries: Dirent[];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(candidate);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === "colmap.bat" || entry.name.toLowerCase() === "colmap.exe") return candidate;
  }
  return null;
}

export async function resolveColmapRuntime() {
  const configured = process.env.COLMAP_BINARY_PATH;
  if (configured && await fs.access(configured).then(() => true).catch(() => false)) return { path: configured, managed: false };
  const managed = await findExecutable(MANAGED_RUNTIME_DIRECTORY);
  return managed ? { path: managed, managed: true } : null;
}

async function hasNvidiaGpu() { return run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]); }

export async function installManagedColmap() {
  if (os.platform() !== "win32") throw new Error("Managed COLMAP setup currently supports Windows only.");
  const existing = await resolveColmapRuntime();
  if (existing) return existing;

  const releaseResponse = await fetch(GITHUB_API, { headers: { "User-Agent": "Splato local reconstruction runtime" }, cache: "no-store" });
  if (!releaseResponse.ok) throw new Error("Could not retrieve the official COLMAP release.");
  const release = await releaseResponse.json() as Release;
  const useCuda = await hasNvidiaGpu();
  const expectedName = useCuda ? "colmap-x64-windows-cuda.zip" : "colmap-x64-windows-nocuda.zip";
  const asset = release.assets.find((item) => item.name === expectedName);
  if (!asset || !asset.browser_download_url.startsWith("https://github.com/colmap/colmap/releases/")) throw new Error("The official Windows COLMAP runtime asset was not found.");

  const downloadResponse = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Splato local reconstruction runtime" }, redirect: "follow" });
  if (!downloadResponse.ok) throw new Error("Could not download the official COLMAP runtime.");
  const archive = storagePath("runtime", `${release.tag_name}-${expectedName}`);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, Buffer.from(await downloadResponse.arrayBuffer()));
  await fs.rm(MANAGED_RUNTIME_DIRECTORY, { recursive: true, force: true });
  await fs.mkdir(MANAGED_RUNTIME_DIRECTORY, { recursive: true });

  const expanded = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath ${quotePowerShell(archive)} -DestinationPath ${quotePowerShell(MANAGED_RUNTIME_DIRECTORY)} -Force`,
  ]);
  await fs.rm(archive, { force: true });
  if (!expanded) throw new Error("COLMAP downloaded, but its archive could not be extracted.");
  const runtime = await resolveColmapRuntime();
  if (!runtime) throw new Error("COLMAP extracted, but its executable was not found.");
  return runtime;
}
