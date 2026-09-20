import { createReadStream, promises as fsp } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import { generateHardwareProfile } from "./hardware.ts";
import { JobManager, type EngineEvent } from "./jobs.ts";
import { demoAdapter } from "./adapters/demo.ts";
import { formatSeconds, planReconstruction } from "./planner.ts";
import type { PlanningInput } from "./planner.ts";
import { ENGINE_PROTOCOL_VERSION, type EngineMessage, type EngineReply, type HardwareProfile } from "./types.ts";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".ply": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
};

/** Representative planning input for the status page: a 10-minute video, dense + splat wanted. */
const SAMPLE_PLANNING_INPUT: PlanningInput = {
  videoSeconds: 600,
  desiredOutputs: ["sparse", "dense", "splat"],
};

export interface EngineServerOptions {
  port: number;
  dataDirectory: string;
  version: string;
  name: string;
}

export class EngineServer {
  private readonly hardware: Promise<HardwareProfile>;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly port: number;
  private readonly jobManager: JobManager;

  constructor(options: EngineServerOptions) {
    this.hardware = generateHardwareProfile(options.dataDirectory);
    this.port = options.port;
    this.jobManager = new JobManager(options.dataDirectory, (event) => this.broadcast(event));
    this.jobManager.register(demoAdapter);
    this.server = createServer((request, response) => void this.handleHttp(request, response, options));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (socket) => this.handleSocket(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, () => {
        this.server.removeListener("error", reject);
        const address = this.server.address();
        resolve(typeof address === "object" && address ? address.port : this.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handleHttp(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, options: EngineServerOptions) {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await this.renderStatusPage(options);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (url.pathname === "/health") {
        this.json(response, 200, { ok: true, name: options.name, version: options.version, uptimeSeconds: Math.round(process.uptime()) });
        return;
      }
      if (url.pathname === "/engine") {
        const hardware = await this.hardware;
        this.json(response, 200, {
          name: options.name,
          version: options.version,
          protocolVersion: ENGINE_PROTOCOL_VERSION,
          hardware,
          plan: planReconstruction(hardware, SAMPLE_PLANNING_INPUT),
        });
        return;
      }
      if (url.pathname.startsWith("/artifacts/")) {
        await this.handleArtifact(response, url.pathname.slice("/artifacts/".length), options);
        return;
      }
      this.json(response, 404, { error: "Not found" });
    } catch (error) {
      this.json(response, 500, { error: error instanceof Error ? error.message : "Internal engine error" });
    }
  }

  private json(response: import("node:http").ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private async handleArtifact(response: import("node:http").ServerResponse, relativePath: string, options: EngineServerOptions) {
    const target = path.resolve(options.dataDirectory, relativePath);
    const root = path.resolve(options.dataDirectory) + path.sep;
    if (!target.startsWith(root)) {
      this.json(response, 400, { error: "Invalid artifact path" });
      return;
    }
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        this.json(response, 404, { error: "Not a file" });
        return;
      }
      const contentType = MIME_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
      createReadStream(target).pipe(response);
    } catch {
      this.json(response, 404, { error: "Artifact not found" });
    }
  }

  private handleSocket(socket: WebSocket) {
    socket.on("message", (data) => void this.handleMessage(socket, data));
  }

  private async handleMessage(socket: WebSocket, data: unknown) {
    let message: EngineMessage;
    try {
      message = JSON.parse(String(data)) as EngineMessage;
    } catch {
      this.send(socket, { type: "error", message: "Malformed JSON message." });
      return;
    }

    switch (message.type) {
      case "hello": {
        const hardware = await this.hardware;
        this.send(socket, {
          type: "hello",
          version: ENGINE_PROTOCOL_VERSION,
          protocolVersion: ENGINE_PROTOCOL_VERSION,
          hardware,
          engines: this.jobManager.engineIds(),
          ready: true,
        });
        break;
      }
      case "ping": {
        this.send(socket, { type: "pong", at: message.at });
        break;
      }
      case "submit": {
        this.jobManager.submit({
          jobId: message.jobId,
          projectId: message.projectId,
          pipeline: message.pipeline,
          payload: message.payload,
        });
        break;
      }
      case "cancel": {
        this.jobManager.cancel(message.jobId);
        break;
      }
    }
  }

  private broadcast(event: EngineEvent) {
    const payload = JSON.stringify(event);
    for (const socket of this.wss.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private send(socket: WebSocket, reply: EngineReply) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(reply));
    }
  }

  private async renderStatusPage(options: EngineServerOptions): Promise<string> {
    const hardware = await this.hardware;
    const plan = planReconstruction(hardware, SAMPLE_PLANNING_INPUT);
    const planRows = plan.steps
      .map(
        (step) =>
          `<tr><td>${step.label}</td><td class="mono">${step.engine}</td><td class="mono">${formatSeconds(step.estimatedSeconds)}</td></tr>`,
      )
      .join("");
    const notes = plan.notes.map((note) => `<li>${note}</li>`).join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Splato Engine</title>
<style>
  body { margin:0; background:#0a0a0c; color:#e4e4e7; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  main { max-width:760px; margin:0 auto; padding:48px 24px; }
  h1 { font-size:20px; font-weight:600; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e; margin-right:8px; }
  pre { background:#111114; border:1px solid #27272a; border-radius:8px; padding:16px; overflow:auto; font-size:12px; }
  .row { display:flex; gap:8px; align-items:center; margin-top:4px; }
  .muted { color:#71717a; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #27272a; }
  th { color:#71717a; font-weight:500; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#a1a1aa; }
</style>
</head>
<body>
<main>
  <h1><span class="dot" id="dot"></span>Splato Engine <span class="muted">v${options.version}</span></h1>
  <p class="muted">Local reconstruction runtime · everything stays on this device</p>
  <h2 style="margin-top:32px">Connection (WebSocket handshake)</h2>
  <div class="row"><span id="state" class="muted">connecting…</span></div>
  <h2 style="margin-top:32px">Hardware profile</h2>
  <pre id="hardware">…</pre>
  <h2 style="margin-top:32px">Recommended plan · 10-min video · 15:00 budget</h2>
  <table>
    <thead><tr><th>Step</th><th>Engine</th><th>Estimate</th></tr></thead>
    <tbody>${planRows}</tbody>
  </table>
  <p class="muted" style="margin-top:8px">Total estimate: <strong>${formatSeconds(plan.estimatedTotalSeconds)}</strong> → artifacts: ${plan.expectedArtifacts.join(", ")}</p>
  <ul style="color:#a1a1aa;font-size:12px;line-height:1.7">${notes}</ul>
  <h2 style="margin-top:32px">Demo job · full protocol round-trip</h2>
  <p class="muted">Submit a job over WebSocket and watch accepted → progress → complete events stream back.</p>
  <div class="row" style="margin-top:8px">
    <button id="run-demo" style="background:#e4e4e7;color:#09090b;border:0;border-radius:6px;padding:8px 14px;font-family:inherit;font-size:13px;cursor:pointer">Run demo job</button>
    <span id="job-state" class="muted">idle</span>
  </div>
  <pre id="job-log" style="margin-top:12px;min-height:120px">—</pre>
</main>
<script>
const host = location.host;
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + host);
const state = document.getElementById("state");
const dot = document.getElementById("dot");
ws.onopen = () => {
  state.textContent = "connected → ws://" + host;
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0", name: "browser-test" }));
};
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "hello") {
    document.getElementById("hardware").textContent = JSON.stringify({ hardware: message.hardware, engines: message.engines, ready: message.ready }, null, 2);
    dot.style.background = message.ready ? "#22c55e" : "#f59e0b";
    return;
  }
  if (message.type.startsWith("job.")) {
    renderJobEvent(message);
  }
};
const jobState = document.getElementById("job-state");
const jobLog = document.getElementById("job-log");
function jobAppend(html) {
  jobLog.innerHTML += html + "\\n";
  jobLog.scrollTop = jobLog.scrollHeight;
}
function renderJobEvent(message) {
  switch (message.type) {
    case "job.accepted":
      jobState.textContent = "accepted";
      jobAppend("→ accepted " + message.jobId + " started " + message.startedAt);
      break;
    case "job.progress":
      jobState.textContent = message.phase + " · " + message.progress + "%";
      jobAppend("· " + message.phase + " — " + message.progress + "%" + (message.current ? " (" + message.current + ")" : ""));
      break;
    case "job.complete":
      jobState.textContent = "complete";
      jobAppend("✓ complete — artifacts:");
      for (const [key, url] of Object.entries(message.artifacts || {})) jobAppend('  ' + key + ' → <a href="' + url + '" target="_blank">' + url + '</a>');
      document.getElementById("run-demo").disabled = false;
      break;
    case "job.failed":
      jobState.textContent = "failed";
      jobAppend("✗ failed — " + message.error);
      document.getElementById("run-demo").disabled = false;
      break;
    case "job.rejected":
      jobState.textContent = "rejected";
      jobAppend("! rejected — " + message.reason);
      document.getElementById("run-demo").disabled = false;
      break;
    case "job.cancelled":
      jobState.textContent = "cancelled";
      jobAppend("× cancelled " + message.jobId);
      document.getElementById("run-demo").disabled = false;
      break;
  }
}
document.getElementById("run-demo").addEventListener("click", () => {
  const jobId = "demo-" + Date.now();
  jobLog.textContent = "submitting " + jobId + " …";
  jobState.textContent = "submitting";
  document.getElementById("run-demo").disabled = true;
  ws.send(JSON.stringify({ type: "submit", jobId, projectId: "demo-project", pipeline: "demo", payload: {} }));
});
ws.onerror = () => { state.textContent = "connection failed — is the engine running?"; dot.style.background = "#ef4444"; state.style.color = "#ef4444"; };
ws.onclose = () => { state.textContent = "connection closed"; dot.style.background = "#71717a"; };
</script>
</body>
</html>`;
  }
}