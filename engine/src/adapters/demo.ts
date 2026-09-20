import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateHardwareProfile } from "../hardware.ts";
import { artifactRelativePath } from "../jobs.ts";
import type { EngineContext, EngineJob, ReconstructionEngine } from "../types.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Demo adapter — proves the full job protocol (submit → progress → complete
 * → artifact URL) end to end. Replaced by frame-thinning / GLOMAP / dense
 * adapters in M2.
 */
export const demoAdapter: ReconstructionEngine = {
  id: "demo",
  label: "Demo probe",
  minimumHardware: "low",

  async run(job: EngineJob, context: EngineContext) {
    context.log("Demo job started — probing this machine and writing a report.");
    const steps: Array<[string, number]> = [
      ["probing hardware", 15],
      ["mapping pipelines", 40],
      ["capturing environment", 65],
      ["writing report", 85],
    ];
    for (const [phase, progress] of steps) {
      if (context.cancelRequested) return;
      context.update(phase, progress);
      await delay(650);
    }

    const hardware = await generateHardwareProfile(path.dirname(path.dirname(context.projectDirectory)));
    const report = {
      jobId: job.jobId,
      projectId: job.projectId,
      finishedAt: new Date().toISOString(),
      hardware,
      note: "Demo adapter output — real reconstruction engines land in M2.",
    };

    const directory = path.join(context.projectDirectory, "artifacts", "demo");
    await mkdir(directory, { recursive: true });
    const filename = "report.json";
    await writeFile(path.join(directory, filename), JSON.stringify(report, null, 2), "utf8");

    context.artifacts["demo-report"] = artifactRelativePath(job.projectId, path.join("artifacts", "demo", filename));
    context.update("complete", 100, { completed: 1, total: 1 });
    context.log("Demo job finished. Report available as an artifact.");
  },
};