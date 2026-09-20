// Splato Engine — shared protocol types.
// Tunnel-ready: every message is JSON, so a relay (WebSocket bridge / WebRTC) can forward
// these unchanged between a hosted UI and a remote engine.

export const ENGINE_PROTOCOL_VERSION = "0.1.0";

export interface GpuInfo {
  detected: boolean;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown";
  name: string | null;
  /** VRAM in GB (nvidia-smi only) */
  memoryGB: number | null;
  /** Compute capability, e.g. 8.9 (nvidia only) */
  computeCapability: number | null;
  driver: string | null;
}

export interface HardwareProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpu: { model: string; cores: number; speedMHz: number };
  memory: { totalGB: number; freeGB: number };
  disk: { dataDirectory: string; freeGB: number; totalGB: number };
  gpu: GpuInfo;
  /** Derived capability tier used by the planner: low | medium | high */
  tier: "low" | "medium" | "high";
}

export interface EngineCapabilities {
  engineId: "engine";
  name: string;
  version: string;
  protocolVersion: string;
  /** Engine adapter ids that this engine can run (empty in M1 skeleton). */
  engines: string[];
  hardware: HardwareProfile;
}

// ---- WebSocket protocol ---------------------------------------------------

export type EngineMessage =
  | { type: "hello"; version: string; name?: string }
  | { type: "ping"; at?: number }
  | {
      type: "submit";
      jobId: string;
      projectId: string;
      pipeline: "frame-thinning" | "glomap" | "colmap" | "dense" | "splat";
      payload: Record<string, unknown>;
    }
  | { type: "cancel"; jobId: string };

export type EngineReply =
  | { type: "hello"; version: string; protocolVersion: string; hardware: HardwareProfile; engines: string[]; ready: boolean }
  | { type: "pong"; at?: number }
  | { type: "job.accepted"; jobId: string; startedAt: string }
  | { type: "job.rejected"; jobId: string; reason: string }
  | { type: "job.progress"; jobId: string; phase: string; progress: number; completed: number; total: number; current?: string; logs?: string[] }
  | { type: "job.complete"; jobId: string; artifacts: Record<string, string> }
  | { type: "job.failed"; jobId: string; error: string }
  | { type: "job.cancelled"; jobId: string }
  | { type: "error"; jobId?: string; message: string };

// ---- Engine adapters (M2+) ------------------------------------------------

export interface EngineJob {
  jobId: string;
  projectId: string;
  pipeline: EngineMessage extends never ? never : string;
  payload: Record<string, unknown>;
}

export interface EngineContext {
  projectDirectory: string;
  log(message: string): void;
  update(phase: string, progress: number, patch?: { completed?: number; total?: number; current?: string }): void;
}

export interface ReconstructionEngine {
  id: "frame-thinning" | "glomap" | "colmap" | "dense" | "splat";
  label: string;
  minimumHardware: "low" | "medium" | "high";
  run(job: EngineJob, context: EngineContext): Promise<void>;
}

// ---- Hardware planner (M2+) ------------------------------------------------

export interface PlannedStep {
  id: string;
  label: string;
  engine: string;
  estimatedSeconds: number | null;
}

export interface ReconstructionPlan {
  engine: string;
  steps: PlannedStep[];
  estimatedTotalSeconds: number | null;
  expectedArtifacts: string[];
  notes: string[];
}