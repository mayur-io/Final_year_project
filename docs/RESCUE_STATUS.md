# Splato rescue status

This document is the evidence record for the rescue pass. It states what is
implemented, what is verified, and what is deliberately not claimed. Every
claim below is tied to a command or a file in this repository.

## Mission

```text
one selected input type
  → validation and capture-quality diagnosis
  → standard reconstruction-ready image sequence
  → evidence-selected reconstruction engine
  → quality-gated sparse/dense result
  → basic viewer of the exact resulting artifact
```

The complete product scope also includes three input modes and trained Gaussian
output. This rescue makes the pipeline honest about which of those exist.

## Machine, date, and repository status

- Date: 2026-10-11. Windows, Node.js, Next.js 16.2.10, Python 3.13.15,
  NVIDIA RTX 3050 (4 GB, driver 591.44, CUDA 13.1).
- Storage root: `SPLATO_STORAGE_ROOT` = `D:\SplatoStorage`.
- Git: the working tree was **already dirty** before this pass (many modified and
  untracked files, plus pre-existing deletions under `docs/`, and `PLAN.md`,
  `demo-footage/`). This rescue **preserved** that state — it neither committed
  nor discarded unrelated changes. The rescue's own edits are listed under
  "Changed files" below.

## Engine decision

Candidates considered: COLMAP (incremental SfM/MVS), GLOMAP, and a trained
Gaussian-splatting optimizer. Only COLMAP was present and executable on this
machine, so it was selected. See the capability matrix.

| Capability | Status | Evidence |
| --- | --- | --- |
| COLMAP incremental SfM/MVS | **Available and used** | `storage/runtime/colmap/bin/colmap.exe` present (`Test-Path` → True). Not on `PATH`; resolved by `resolveColmapRuntime`. |
| Trained 3D Gaussian Splatting | **Not available** | `py -c "import torch"` → `ModuleNotFoundError`. `gsplat` not installed. Only `numpy 2.5.2`. |
| FFmpeg / FFprobe | **Available** | `ffmpeg -version` → `8.1.2-full_build`. Resolved from `PATH`, overridable by `FFMPEG_PATH` / `FFPROBE_PATH`. |
| Python | **Available** | `py --version` → `Python 3.13.15`. |
| GPU | **Present, small** | NVIDIA RTX 3050, 4 GB, driver 591.44, CUDA 13.1. Dense patch-match is best-effort; a dense failure is downgraded to a warning and the sparse result is preserved. |

### Gaussian output is labeled honestly (Branch B)

There is no real 3DGS optimizer in this environment. `splatBootstrap.py` assigns
fixed Gaussian parameters (position, color, fixed scale/opacity/rotation) to
reconstruction points. It does not use a loss, camera poses, images, or
iterations. The UI, logs, and viewer therefore label the output
**"Gaussian initialization preview"**, never a trained splat. The PLY is still a
standard 3DGS-format file, so it renders in a splat viewer.

## Input handling (no silent rerouting)

`src/app/api/projects/[id]/media/route.ts`:

- The user's selected source type is the declaration. It is **validated**, never
  silently changed based on file content.
- `360-video`: exactly one file, `.mp4`/`.mov`, and the decoded frame must be
  equirectangular **2:1 (±2 %)** and at least **1920×960**. Otherwise the upload
  is rejected with the measured `WIDTHxHEIGHT` and a re-export instruction.
- `normal-video`: exactly one video file.
- `image-sequence`: at least 100 supported images.
- 16:9 clips are rejected when declared 360 (they are not stitched 2:1 panoramas).

## Preparation contract

Every pipeline writes two artifacts into `storage/projects/<id>/processed/`:

- `frames-manifest.json` — ordered accepted frames with provenance
  (source file, order, timestamp, and for 360 the exact view yaw/pitch/roll/FOV).
- `preparation-report.json` — one `PASS` / `WARN` / `REJECT` verdict with
  reasons, warnings, selection counts, and evidence.

Rules enforced:

- `REJECT` prevents reconstruction in the API (`409`) and in the UI.
- A `WARN` carries an actionable sentence (sky kept, low motion, partial
  registration, dense failure), not a raw exception.
- Sky is **not** hard-rejected. A frame with a large bright/sky region is kept
  when it still has scene detail, and reported as `sky: "warned"`. No semantic
  sky mask is applied, and the report says so.
- A static capture (probe frames nearly identical) is `REJECT` before COLMAP.
- Coverage/overlap are **measured**, not assumed: `analyzeSequenceCoverage`
  records the mean frame-to-frame viewpoint change (`coverageScore`) and
  neighbour similarity (`overlapScore`) of the accepted set. Near-zero viewpoint
  change → `REJECT`; weak neighbour similarity → `WARN`.

## Reconstruction (COLMAP)

`src/lib/reconstruction/colmapJob.ts`:

- Refuses to start without a non-empty `frames-manifest.json`; verifies every
  manifest frame still exists.
- Records per-stage wall-clock time (features, matching, mapping, dense).
- Parses `model_analyzer` defensively. If the format differs, registration is
  reported as unavailable rather than as a fake zero.
- Gate: `< 45 %` registered images → `FAIL`; `45–70 %` → `WARN`; fewer than 100
  sparse points → `FAIL` (a model can register most images yet contain almost no
  coherent geometry); 100–500 points → `WARN` (thin geometry); dense failure →
  `WARN` with the sparse artifact preserved.
- Quality tiers: `draft` (the default) stops at the sparse model — fast, and it
  already proves whether the capture reconstructs — while `balanced` and `high`
  also build the dense cloud (downsampled or full). Draft therefore never waits
  on the slowest stage.
- Writes `reconstruction/report.json` with engine, intent, registration,
  reprojection error, point counts, stage times, warnings and verdict.
  The UI reads this report instead of inferring success from an exit code.

## Viewers

- `PointCloudViewer` renders the exact COLMAP sparse/dense artifact. The route
  now returns a source label, the parsed point count, and a clear 404/422 when
  absent or empty.
- `SplatViewer` remains, but is labeled as an initialization preview.
- The frame gallery is **read-only** (no reject/restore) and surfaces the
  preparation verdict; reconstruction is disabled when the verdict is `REJECT`.

## 360 view planning

`src/lib/media/planViews.ts` derives the default view count from the requested
field of view and overlap (`step = fov × (1 − overlap)`, rings from pole to pole,
azimuth per ring scaled by `cos(pitch)`), replacing the old fixed 6/8-view
preset. `convert360View` accepts a 50–120° projection FOV so overlap is possible.

## Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Types (app) | `npx tsc --noEmit` | **clean** |
| Build | `npm run build` | **passes** — compiles, type-checks, and generates all routes (including `/api/projects/[id]/preparation`) |
| Lint | `npm run lint` | fails on a **pre-existing baseline** of React-hooks rule violations (`react-hooks/set-state-in-effect`, `react-hooks/purity`) that exist across untouched files (`ProjectWorkspace`, `useProjectMedia`, `ViewerRenderer`, …). The rescue did not add a new class of violation. Next 16 does not run ESLint during `next build`, so the build is unaffected. |
| End-to-end | `node test-rig/rescue-e2e.mjs` | **PASS** — 301/301 images registered, 0.73 px reprojection, 95,219 sparse points (draft), with measured coverage 50.72 / overlap 0.735. See `docs/RESCUE_E2E.md`. |
| End-to-end (360) | `node test-rig/rescue-360.mjs` | **WARN** — genuine 2:1 clip accepted, 11 views auto-planned, 419 frames extracted with provenance. See `docs/RESCUE_E2E.md`. |

### Build fix

The root `tsconfig.json` included `**/*.ts`, which pulled the separate `engine/`
service into the Next.js type-check and failed the build on its pre-existing
`.ts`-extension imports. The rescue added `"engine"` to `tsconfig.json`'s
`exclude`; the engine still type-checks through its own script
(`npm run engine:typecheck`).

A second, unrelated failure came from Next 16 writing dev-only types into
`.next/dev/types`: a stale, non-module `routes.d.ts` left there made a later
`next build` fail. A `prebuild` step now deletes `.next/dev` before every build.

## Coverage / overlap validation result

Media preparation now **measures** the two properties the Scope requires before
reconstruction instead of reporting them as `unknown`:

- **Parallax / viewpoint change** (`coverage`): mean absolute difference between
  consecutive *accepted* frames in capture order. A near-zero value is a static
  or duplicate set that no SfM pipeline can solve → **REJECT** with the measured
  value.
- **Frame-to-frame overlap** (`overlap`): mean colour-histogram correlation
  between consecutive accepted frames. Unrelated neighbours are reported as a
  **WARN** (the proxy is not strong enough to justify a hard reject on its own,
  so it never fabricates a failure).

Both numbers (`coverageScore`, `overlapScore`) are stored in
`processed/preparation-report.json` and shown in the read-only gallery.

## Sky and dynamic-mask capability result

- **Sky:** a brightness / bright-region heuristic only. Frames with large sky
  areas are **kept** when they also hold scene detail and reported as a warning;
  no semantic sky mask is computed or applied.
- **Dynamic objects:** **not implemented**. The report records
  `dynamicObjects: "manual_review"`. The legacy manual reject/restore endpoint
  still exists, but the UI no longer calls it and it is never described as
  segmentation.

## Known limitations (explicitly not claimed)

- No trained Gaussian Splatting. The preview is an initialization, not a model.
- 360 support requires a genuine stitched 2:1 equirectangular file. Raw dual-fisheye
  (`.insv`/`.360`) is not decoded.
- Dynamic-object masking is not implemented (`dynamicObjects: "manual_review"`).
- Matching uses the manifest order with COLMAP sequential overlap; it is not a
  learned or vocabulary-tree matcher.
- The pipeline is validated through typechecking, linting, and a real COLMAP run
  on the bundled fixtures; it is not tuned on arbitrary consumer footage.

## Changed files (rescue pass)

| File | Purpose |
| --- | --- |
| `src/lib/media/prepareReport.ts` | Preparation/frames-manifest contract, paths, readers. |
| `src/lib/media/planViews.ts` | FOV/overlap equirectangular view planner. |
| `src/lib/media/processJob.ts` | Manifest + report across modes; strict 360 plan; blank-view warning. |
| `src/lib/media/tools/ffmpeg.ts` | Portable resolution probing and projection FOV clamp. |
| `src/lib/media/tools/openCv.ts` | Frame scoring; sky/bright warning counters; `analyzeSequenceCoverage` (parallax + overlap). |
| `src/lib/reconstruction/colmapJob.ts` | Manifest-driven COLMAP, registration + sparse-point gate, report; draft = sparse only. |
| `src/app/api/projects/[id]/media/route.ts` | Strict input validation; no silent rerouting. |
| `src/app/api/projects/[id]/reconstruction/route.ts` | 409 gate on `REJECT`; default quality `draft`. |
| `src/app/api/projects/[id]/reconstruction/point-cloud/route.ts` | Source label and true total point count. |
| `src/app/api/projects/[id]/preparation/route.ts` | `GET` report + manifest summary. |
| `src/components/stage/FrameGallery.tsx` | Read-only gallery with verdict; blocks `REJECT`. |
| `src/components/stage/ReconstructionStage.tsx` | Surfaces preparation/reconstruction reports; draft default; tier labels. |
| `src/modules/360-player/components/Viewer360.tsx` | Auto-planned locked views + single global seam shift. |
| `tsconfig.json` | Exclude `engine/` from the app type-check. |
| `package.json` | `prebuild` removes stale `.next/dev`. |
| `test-rig/rescue-e2e.mjs`, `test-rig/rescue-360.mjs` | End-to-end harnesses. |
| `docs/RESCUE_STATUS.md`, `docs/RESCUE_E2E.md`, `README.md` | Evidence and facts. |

## Remaining scope gaps and next safe milestone

- **Trained Gaussian Splatting** — blocked: no `torch`/`gsplat` in this
  environment. Next safe milestone: install a CUDA `torch` + `gsplat`, add an
  optimizer that consumes poses/images, and only then relabel the output.
- **Semantic sky / dynamic masking** — not implemented. Next safe milestone: add
  a real segmentation model and consume its masks during preparation.
- **360 raw dual-fisheye decode** — not supported. Next safe milestone: stitch
  `.insv`/`.360` footage to a 2:1 panorama before upload.
- **Dense reconstruction on large sets is slow** (best-effort on the 4 GB GPU).
  Reachable only via `balanced`/`high`; the default `draft` path never waits on it.
