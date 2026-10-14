# Splato — media-to-3D reconstruction

Splato turns a supported capture into a reconstruction-ready image sequence and a
quality-gated 3D point cloud, viewable in the browser.

```text
choose input type
  → validate + diagnose capture quality
  → standard prepared image sequence (+ manifest + verdict)
  → COLMAP reconstruction (quality gated)
  → point cloud viewer of the exact artifact
```

## What is real today

- **Three input paths**: 360° video (stitched 2:1 equirectangular), one regular
  video, or an image sequence. The selected type is validated, never silently
  changed.
- **Preparation with an explicit verdict**: every run writes
  `processed/preparation-report.json` (`PASS` / `WARN` / `REJECT`) and
  `processed/frames-manifest.json` (ordered frames + provenance). A `REJECT`
  blocks reconstruction in both the API and the UI.
- **Measured capture validation**: preparation measures frame-to-frame
  viewpoint change (parallax) and overlap across the accepted set. A static or
  duplicate capture is rejected with the measured value; weak overlap is warned.
- **COLMAP reconstruction** with a registration gate, a minimum-geometry
  (sparse-point) gate, per-stage timing, and `reconstruction/report.json`.
  Quality tiers: **Draft** = sparse only (fast), **Balanced** / **High** =
  sparse + dense. A dense failure keeps the sparse result.
- **Viewers** for the sparse/dense point cloud and a Gaussian **initialization
  preview**.

## What is not implemented (stated plainly)

- **No trained 3D Gaussian Splatting.** No `torch`/`gsplat` is installed. The
  splat output is an initialization-only preview (points with fixed Gaussian
  parameters, no training loop) and is labeled as such.
- **No semantic sky or dynamic-object masking.** Sky handling is a brightness
  heuristic and is reported as a warning.
- **360 requires genuine stitched 2:1 footage.** Raw dual-fisheye is not decoded.
  A 360 upload must decode to a true 2:1 equirectangular frame (±2 %, e.g.
  5760×2880, 3840×1920, 2880×1440) and be at least 1920×960; anything else is
  rejected with its measured `WIDTHxHEIGHT`.

See [`docs/RESCUE_STATUS.md`](docs/RESCUE_STATUS.md) for the full evidence record.

## Verdicts

- **PASS** — the stage produced a usable result (frames accepted; registration
  ratio ≥ 0.7).
- **WARN** — usable but imperfect (sky kept, partial registration, dense failure).
  Reconstruction is still allowed.
- **REJECT** — the capture cannot support reconstruction (static, too few usable
  frames, empty 360 plan). Reconstruction is blocked (`409`).
- **FAIL** — the engine ran but the result is unusable (registration ratio < 0.45).

## Capture guidance

- **Object** — orbit one subject at a roughly constant distance, keep it filling
  the frame, move slowly, and cover all sides.
- **Environment** — stand near the centre and rotate in place (or walk slowly) so
  views overlap; a 360° clip captures everything in one pass.
- **Image sequence** — at least 100 sharp, well-overlapping images with no gaps.
  Blurry/duplicate frames are filtered automatically but never deleted.

## Viewer behavior

- The point-cloud viewer draws the exact COLMAP artifact, labelled `sparse` or
  `dense`; the API reports both the returned point count and the true total.
- The 360 planner shows the auto-planned views on the dome; it is read-only and
  its only control is a single global seam shift. The frame gallery is read-only.
- The Gaussian output is an initialization preview only (see above).

## Requirements

- Node.js + npm
- **FFmpeg** and **ffprobe** on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`)
- **COLMAP** — either on `PATH`, set `COLMAP_BINARY_PATH`, or use the managed
  runtime under `storage/runtime/colmap/`
- A PostgreSQL database for project metadata (Prisma)

## Getting started

```bash
npm install
npx prisma migrate deploy   # or prisma db push for a fresh database
npm run dev                 # http://localhost:3000
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | development server |
| `npm run build` | production build |
| `npm run lint` | ESLint |
| `npm run engine*` | the separate `engine/` service (not used by the web app) |

## Storage layout

Files live under `storage/` (`SPLATO_STORAGE_ROOT` overrides the root):

```text
storage/projects/<projectId>/
  originals/                       uploaded sources
  processed/
    frames/                        accepted reconstruction frames
    candidates/                    every raw candidate (kept, not deleted)
    frames-manifest.json           accepted frames + provenance
    preparation-report.json        PASS / WARN / REJECT verdict
    projection.json               360 view plan (yaw/pitch/roll/fov)
  reconstruction/
    sparse/0/                      COLMAP sparse model
    dense/fused.ply                dense cloud (best effort)
    splat.ply                      Gaussian initialization preview
    report.json                    engine, registration, counts, verdict
```

## Verification

```bash
npx tsc --noEmit   # expect no errors under src/
npm run lint
npm run build
```

The bundled fixtures under `test samples/` include a known-good 301-image
sequence (Museum), a dimension-valid 2:1 360 clip, and 16:9 clips that must be
rejected when declared 360.

End-to-end harnesses (require a running server and database):
`node test-rig/rescue-e2e.mjs <baseUrl>` (image sequence) and
`node test-rig/rescue-360.mjs <baseUrl> [video]` (360 path). Results are recorded
in [`docs/RESCUE_E2E.md`](docs/RESCUE_E2E.md).
