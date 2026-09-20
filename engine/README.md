# Splato Engine

The local reconstruction runtime. Runs on the user's own machine and owns all
processing and storage. The browser connects straight to it over WebSocket —
no file bytes ever pass through the hosted UI.

## Run

```bash
npm install
npm start          # http://localhost:4380  (WS on the same port)
```

The engine reads configuration from the repository-root `.env`
(`SPLATO_DATA_DIR`). If unset it falls back to `~/.splato`.

## What it does today (M1)

- **Hardware probe** — `nvidia-smi` GPU/VRAM/CUDA, CPU, RAM, disk; derives a
  `low | medium | high` capability tier.
- **Hardware planner** — maps hardware + capture + 15-min budget to a stepped
  plan (frame thinning → GLOMAP → dense → splat) with time estimates.
- **WebSocket protocol** (JSON, tunnel-ready): `hello` / `hardware`, `submit`,
  `job.accepted`, `job.progress`, `job.complete`, `job.failed`,
  `job.rejected`, `job.cancelled`, `error`.
- **JobManager + adapters** — pluggable `ReconstructionEngine` adapters with
  progress, cancel, and artifact collection. `demo` adapter proves the full
  round-trip (see `scripts/test-protocol.mjs`).
- **Artifact server** — `GET /artifacts/<path>` serves anything under the data
  directory to the browser (models, clouds, splats later).

## Status page

Open `http://localhost:4380/` — live WebSocket handshake, hardware profile,
recommended plan, and a one-click demo job showing the protocol streaming.

## Smoke test

```bash
npm run test   # hello → submit → progress → complete round-trip
```

## Protocol (v0.1)

```ts
// client → engine
{ type: "hello", version, name? }
{ type: "ping", at? }
{ type: "submit", jobId, projectId, pipeline, payload }
{ type: "cancel", jobId }

// engine → client
{ type: "hello", hardware, engines, ready }
{ type: "pong", at }
{ type: "job.accepted", jobId, startedAt }
{ type: "job.progress", jobId, phase, progress, completed, total, current?, logs? }
{ type: "job.complete", jobId, artifacts: Record<key, "/artifacts/..."> }
{ type: "job.failed", jobId, error }
{ type: "job.cancelled", jobId }
{ type: "error", jobId?, message }
```

## Roadmap (per PLAN.md)

- M2: `frame-thinning` (OpenCV) + `glomap` (CUDA) adapters, upload streaming.
- M3: `dense` (patch-match CUDA) adapter, viewer rewiring.
- M5: `splat` (Gaussian) adapter if budget allows. SLAM = future adapter.