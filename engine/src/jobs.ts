import { mkdir } from "node:fs/promises";
import path from "node:path";

import { projectDirectory } from "./storage.ts";
import type { EngineContext, ReconstructionEngine } from "./types.ts";

/** Events the JobManager emits outward (to the WS layer). */
export type EngineEvent =
  | { type: "job.accepted"; jobId: string; startedAt: string }
  | { type: "job.rejected"; jobId: string; reason: string }
  | { type: "job.progress"; jobId: string; phase: string; progress: number; completed: number; total: number; current?: string; logs?: string[] }
  | { type: "job.complete"; jobId: string; artifacts: Record<string, string> }
  | { type: "job.failed"; jobId: string; error: string }
  | { type: "job.cancelled"; jobId: string };

interface JobRecord {
  jobId: string;
  projectId: string;
  pipeline: string;
  payload: Record<string, unknown>;
  state: "queued" | "running" | "complete" | "failed" | "cancelled";
  cancelRequested: boolean;
  startedAt: string;
}

export interface SubmitInput {
  jobId: string;
  projectId: string;
  pipeline: string;
  payload: Record<string, unknown>;
}

/**
 * Coordinates engine adapters: accepts jobs, fans progress out as protocol
 * events, supports cancel, and collects artifacts for job.complete.
 * One instance per engine process.
 */
export class JobManager {
  private readonly engines = new Map<string, ReconstructionEngine>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly dataDirectory: string;
  private readonly onEvent: (event: EngineEvent) => void;

  constructor(dataDirectory: string, onEvent: (event: EngineEvent) => void) {
    this.dataDirectory = dataDirectory;
    this.onEvent = onEvent;
  }

  register(engine: ReconstructionEngine): void {
    this.engines.set(engine.id, engine);
  }

  engineIds(): string[] {
    return [...this.engines.keys()];
  }

  /** Returns true when the job was accepted and queued. */
  submit(input: SubmitInput): boolean {
    const engine = this.engines.get(input.pipeline);
    if (!engine) {
      this.onEvent({ type: "job.rejected", jobId: input.jobId, reason: `Reconstruction engine '${input.pipeline}' is not installed on this machine.` });
      return false;
    }
    const record: JobRecord = {
      ...input,
      state: "queued",
      cancelRequested: false,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(input.jobId, record);
    this.onEvent({ type: "job.accepted", jobId: input.jobId, startedAt: record.startedAt });
    void this.run(record, engine);
    return true;
  }

  cancel(jobId: string): void {
    const record = this.jobs.get(jobId);
    if (!record) {
      return;
    }
    record.cancelRequested = true;
    if (!["running", "queued"].includes(record.state)) {
      return;
    }
    // The adapter will observe cancelRequested and stop; the final
    // job.cancelled event is emitted by run()'s cancellation path.
  }

  private async run(record: JobRecord, engine: ReconstructionEngine): Promise<void> {
    record.state = "running";
    const artifacts: Record<string, string> = {};
    const context: EngineContext = {
      projectDirectory: projectDirectory(this.dataDirectory, record.projectId),
      artifacts,
      get cancelRequested() {
        return record.cancelRequested;
      },
      log: (message) => {
        if (record.cancelRequested) return;
        this.onEvent({ type: "job.progress", jobId: record.jobId, phase: "running", progress: 0, completed: 0, total: 1, current: message, logs: [message] });
      },
      update: (phase, progress, patch) => {
        if (record.cancelRequested) return;
        this.onEvent({
          type: "job.progress",
          jobId: record.jobId,
          phase,
          progress,
          completed: patch?.completed ?? 0,
          total: patch?.total ?? 100,
          current: patch?.current,
        });
      },
    };

    try {
      await mkdir(context.projectDirectory, { recursive: true });
      await engine.run({ jobId: record.jobId, projectId: record.projectId, pipeline: record.pipeline, payload: record.payload }, context);
      if (record.cancelRequested) {
        record.state = "cancelled";
        this.onEvent({ type: "job.cancelled", jobId: record.jobId });
        return;
      }
      record.state = "complete";
      const artifactUrls: Record<string, string> = {};
      for (const [key, relativePath] of Object.entries(artifacts)) {
        artifactUrls[key] = `/artifacts/${relativePath.replaceAll("\\", "/")}`;
      }
      this.onEvent({ type: "job.complete", jobId: record.jobId, artifacts: artifactUrls });
    } catch (error) {
      if (record.cancelRequested) {
        record.state = "cancelled";
        this.onEvent({ type: "job.cancelled", jobId: record.jobId });
        return;
      }
      record.state = "failed";
      this.onEvent({ type: "job.failed", jobId: record.jobId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Small helper so adapters can import a project-relative path helper. */
export function artifactRelativePath(projectId: string, relativeWithinProject: string): string {
  return path.join("projects", projectId, relativeWithinProject).replaceAll("\\", "/");
}