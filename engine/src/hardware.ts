import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";

import type { GpuInfo, HardwareProfile } from "./types.ts";

const execFileAsync = promisify(execFile);

interface NvidiaRow {
  name: string;
  memoryTotalGiB: number;
  computeCapability: number;
  driver: string;
}

function parseNvidiaTableOutput(output: string): NvidiaRow | null {
  // nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader,nounits
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) return null;
  const [name, memoryMiB, computeCap, driver] = first.split(",").map((cell) => cell.trim());
  const memoryTotalGiB = Number(memoryMiB) / 1024;
  return {
    name: name || "NVIDIA GPU",
    memoryTotalGiB: Number.isFinite(memoryTotalGiB) ? memoryTotalGiB : 0,
    computeCapability: Number(computeCap) || 0,
    driver: driver || "",
  };
}

async function probeNvidiaGpu(): Promise<GpuInfo> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,compute_cap,driver_version", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
    );
    const row = parseNvidiaTableOutput(stdout);
    if (!row) return { detected: false, vendor: "unknown", name: null, memoryGB: null, computeCapability: null, driver: null };
    return {
      detected: true,
      vendor: "nvidia",
      name: row.name,
      memoryGB: row.memoryTotalGiB,
      computeCapability: row.computeCapability || null,
      driver: row.driver || null,
    };
  } catch {
    return { detected: false, vendor: "unknown", name: null, memoryGB: null, computeCapability: null, driver: null };
  }
}

function capabilityTier(gpu: GpuInfo, cpuCores: number, memoryGB: number): HardwareProfile["tier"] {
  if (gpu.detected && gpu.memoryGB !== null && gpu.memoryGB >= 8 && cpuCores >= 8 && memoryGB >= 16) {
    return "high";
  }
  if (gpu.detected || (cpuCores >= 8 && memoryGB >= 12)) {
    return "medium";
  }
  return "low";
}

export async function generateHardwareProfile(dataDirectory: string): Promise<HardwareProfile> {
  const [gpu, disk] = await Promise.all([
    probeNvidiaGpu(),
    statfs(dataDirectory).catch(() => statfs(process.cwd())),
  ]);

  const cpu = cpus();
  const cores = cpu.length;
  const memoryTotal = totalmem() / (1024 ** 3);
  const memoryFree = freemem() / (1024 ** 3);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const totalBytes = Number(disk.blocks) * Number(disk.bsize);

  return {
    platform: process.platform,
    arch: process.arch,
    cpu: {
      model: cpu[0]?.model?.trim() ?? "unknown",
      cores,
      speedMHz: cpu[0]?.speed ?? 0,
    },
    memory: { totalGB: memoryTotal, freeGB: memoryFree },
    disk: {
      dataDirectory,
      freeGB: freeBytes / (1024 ** 3),
      totalGB: totalBytes / (1024 ** 3),
    },
    gpu,
    tier: capabilityTier(gpu, cores, memoryTotal),
  };
}