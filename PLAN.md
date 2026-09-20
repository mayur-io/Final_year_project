# Splato v2 — Rebuild Plan

**Status:** Approved (2026-09-20) — Smart India Hackathon + University Final Year Project
**Timeline:** < 2 weeks to demo-critical build; UX/accessibility features follow after core is solid.

---

## 1. Mission

Splato is a **hardware-adaptive, local-first photogrammetry engine with a web UI**.

- Web-accessible UI, but reconstruction runs **on the user's own device**, scaled to their hardware ("like a PC game").
- **All data is stored locally** on the user's device.
- Supports **multiple reconstruction backends** (GLOMAP, COLMAP incremental, dense MVS, Gaussian Splatting — future: SLAM), not locked to one workflow.
- Hackathon target: **10-minute video → accurate 3D model in under 15 minutes** on whatever hardware is present.

Also a university final year project, portfolio piece, and possible startup.

---

## 2. Locked decisions (from Q&A)

| Topic | Decision |
|---|---|
| Architecture | **Vercel (hosted UI + metadata) + remote local engine.** Browser is the pipe — files never pass through Vercel. |
| Engine language | **Node.js engine**, Python only as subprocesses (OpenCV frame-thinning, optional 3DGS). |
| Demo topology | **Same machine** (browser + engine on one laptop). Protocol designed **tunnel-ready** for multi-machine later. |
| Reconstruction backends | **GLOMAP (priority)** + COLMAP incremental (fallback/accuracy), dense patch-match stereo (CUDA), **Gaussian Splatting = stretch goal**. Future: SLAM via same adapter interface. |
| Output artifact | **Navigable dense point cloud** required; gaussian splat scene if budget allows ("best within budget"). |
| Hardware baseline | Good NVIDIA GPU (CUDA available). Hardware planner must degrade gracefully for weaker machines. |
| Frontend | **Keep current UI/workbench as-is**; all effort on backend rebuild. |

---

## 3. Target architecture

```
┌─ VERCEL (hosted, metadata only) ─┐     ┌─ USER'S MACHINE ─────────────────┐
│  Next.js UI (kept as-is)          │     │  Browser (page from Vercel)       │
│  Postgres: projects, media meta,  │     │    │ ws://localhost:4380          │
│   archive, job records            │     │    ▼                             │
│  No file bytes. No processing.    │     │  Splato Engine (Node service)    │
└───────────────────────────────────┘     │  - hardware probe                │
                                          │  - Hardware Planner              │
                                          │  - engine adapters               │
                                          │     GLOMAP · COLMAP incr.        │
                                          │     Dense PMS · Splat*           │
                                          │  - job queue (cancel/resume)     │
                                          │  - local storage ~/Splato/       │
                                          │  - artifact server   localhost   │
                                          └──────────────────────────────────┘
```

Key rule: **the browser is the pipe.**
- Value bytes (video upload, artifact downloads) flow browser ↔ local engine over `ws://localhost`.
- Vercel stores only metadata (project, media rows, job records) so dashboard/archive work even before connecting.
- Same-machine works today; clean endpoints/WS messages let a tunnel (WebSocket relaying, WebRTC) be added later without redesign.

---

## 4. Engine (local Node service, port 4380)

- Reuses existing patterns: `processJob.ts` checkpoints / cancel / resume, Python subprocess pattern.
- **`hardware.ts`** — probe hardware: `nvidia-smi` (GPU name, VRAM, CUDA), CPU cores, RAM, free disk.
- **`planner.ts`** — the product brain. Input: hardware profile + capture metadata (video duration, source type) + budget (15 min). Output: a concrete plan — frame-thin → ~300 keyframes → GLOMAP (CUDA SiftGPU) → optional dense (patch_match_stereo CUDA) → optional splat, each step with an estimated time; plan shown in UI before running.
- **`engines/`** — adapter interface:
  ```ts
  interface ReconstructionEngine {
    id: string;            // "glomap" | "colmap-incremental" | "dense" | "splat"
    label: string;
    hardwareRequirements: HardwareProfile;
    run(job: EngineJob, ctx: EngineContext): Promise<void>;
  }
  ```
  New backends (SLAM, etc.) = one new adapter.
- **WS protocol** (tunnel-ready, JSON messages): `hello`/`hardware`, `job.submit`, `job.accepted`, `job.progress`, `job.complete`, `error`, plus binary frames for upload streaming.
- **Artifact HTTP server** on localhost: serves stored originals, processed frames, point clouds, splats to the browser (WebGL).
- **Storage:** `<SPLATO_DATA_DIR>/projects/<id>/…` — originals, frames, reconstruction, splats. Everything local.

### 15-minute strategy (the fast lane)
1. Probe hardware (GPU/CUDA, cores, RAM, disk).
2. **Frame-thin** the video with OpenCV motion/parallax scoring → ~300 reliable keyframes (a 10-min, 3 fps video = 1,800 raw frames; never feed them all to SfM).
3. **GLOMAP** global SfM with CUDA feature extraction (SiftGPU) → sparse cloud + camera poses — the workhorse.
4. If budget remains: **dense** via `patch_match_stereo` (CUDA) → dense point cloud.
5. If budget remains and GPU is strong: **Gaussian Splatting** training (stretch).
6. Planner picks per-hardware and shows the user: *"RTX 4070 detected → GLOMAP ~6 min + dense ~7 min"*.
7. COLMAP incremental kept as accuracy mode / fallback for hard captures.

---

## 5. Web side (Vercel)

- **Keep current UI**: dashboard, workbench, upload scene, frame review, 360 viewer, point-cloud viewer, archive — unchanged.
- Rewire data paths:
  - Media upload → streams bytes to the engine (WS) instead of the Next server.
  - Job monitor → reads engine WS instead of `/api/projects/[id]/process`.
  - Viewers → fetch artifacts from localhost engine.
- New **"Connect Engine"** flow: health check → hardware profile → connection state surfaced in the UI.
- Vercel Postgres keeps project/media/archive/job-record CRUD (metadata only).
- Deploy read-only/browsable UI to Vercel; real reconstruction runs against the local engine.

---

## 6. Repo hygiene (during refactor)

- Remove duplicated `splato/` tree (95+ near-identical files) and stale `lib/generated/prisma`.
- Fix hardcoded `C:\Users\Mayur\AppData\Local\Microsoft\WinGet\...\ffmpeg.exe` → env-driven binary discovery (FFMPEG_PATH, COLMAP_BINARY_PATH, PYTHON_PATH, SPLATO_DATA_DIR).
- Add `.env.example` + engine config docs; fix README (currently untouched create-next-app boilerplate).
- Exclude generated Prisma code from ESLint (root lint currently reports ~35k problems from generated files).
- Fix 8 root lint errors (react-hooks/set-state-in-effect, immutability in ViewerRenderer).
- Add `.venv` setup at repo root (only exists under `splato/` today) or document engine bundle installs it.

---

## 7. Milestones (demo-critical first)

| | Scope | Exit criteria |
|---|---|---|
| **M1** (d1–2) | Engine skeleton (`engine/`), WS protocol, hardware probe, browser connect, move existing pipelines into engine | Browser at localhost connects to engine :4380, sees hardware profile |
| **M2** (d3–5) | Frame-thinning + **GLOMAP CUDA** adapter + job streaming | 10-min test video → sparse cloud within budget on dev GPU |
| **M3** (d6–7) | Dense stage (PMS CUDA), point-cloud viewer via localhost, upload/monitor rewired; delete `splato/` + stale prisma; fix binary paths | End-to-end: upload video → orbit dense cloud |
| **M4** (d8–10) | Hardware Planner UI (plan + time estimate before run), error recovery, Vercel deploy, engine install script | Works from hosted URL with engine on the same laptop |
| **M5** (d11–14) | Demo rehearsal, 10-min demo video, README, splash/branding; gaussian splat only if slack | Confident 15-min live demo |

## 8. Cut-list (explicitly out for the demo build)
- SLAM / other new engines (adapter API allows adding later)
- Dynamic Stage Graph navbar redesign (keep current UI)
- Multi-user auth / accounts
- Anything not demo-critical

---

## 9. Phase 2 — UX & accessibility features (after core is built)

Reserved scope, to be defined in detail later. Direction: accessibility + user experience layered on top of the working engine.

- Accessibility: keyboard navigation, focus states, screen-reader labels, WCAG-aware contrast, reduced-motion support, accessible dialogs/file pickers.
- UX: onboarding/first-run wizard, engine install + connect guidance, hardware-aware plan explanations in plain language, empty/loading/error states, progress storytelling, demo mode where the 15-min budget is visualized live.
- User feedback loop: how users see "what the machine can do" before starting (plan preview), and what to do when it doesn't fit the budget.

(Exact list to be confirmed with the user before Phase 2 starts.)

---

## 10. Risks

- Gaussian splat is the cut-list item — add only after dense cloud is solid.
- Mixed-content edge cases (https page → `ws://localhost`): normally allowed; fallback = serve the same UI from localhost during the live demo.
- GLOMAP / CUDA / Windows specifics — resolved in M2.
- Two weeks is brutal: only demo-critical work gets in.