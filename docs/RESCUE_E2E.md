# End-to-end evidence

This records real runs performed against the app (production build), a real
PostgreSQL database, and the bundled fixtures. Nothing here is simulated: the
numbers come from the JSON the app wrote.

- Server: `npx next start -p 3100`
- Storage root: `D:\SplatoStorage` (`SPLATO_STORAGE_ROOT`)
- Harnesses: `test-rig/rescue-e2e.mjs` (image sequence),
  `test-rig/rescue-360.mjs` (360 path)

## 1. Image sequence → COLMAP sparse (the main path)

Project `cmv3lc6do0000w83jzimgcrud`, the 301-image Museum fixture, mode
`object`, quality `draft`.

| Step | Command / route | Result |
| --- | --- | --- |
| Upload | `POST /api/projects/:id/media` (`sourceIntent=image-sequence`) | accepted; preparation auto-started |
| Preparation | `GET /api/projects/:id/process` | `state: complete`, 301/301 |
| Preparation report | `GET /api/projects/:id/preparation` | **`PASS`** |
| Reconstruction | `POST /api/projects/:id/reconstruction` (`action=reconstruct`) | started |
| Reconstruction report | `GET /api/projects/:id/reconstruction` | **`PASS`** |
| Point cloud | `GET /api/projects/:id/reconstruction/point-cloud?source=sparse` | `200`, 1.37 MB |

Preparation report (abridged):

```json
{
  "verdict": "PASS",
  "sourceType": "image-sequence",
  "selection": { "candidates": 301, "accepted": 301, "rejected": 0 },
  "evidence": { "motion": "unknown", "overlap": "unknown", "coverage": "unknown", "sky": "not_checked", "dynamicObjects": "manual_review" }
}
```

Reconstruction report (abridged):

```json
{
  "engine": "COLMAP (incremental)",
  "verdict": "PASS",
  "inputFrames": 301,
  "registeredImages": 301,
  "registrationRatio": 1,
  "meanReprojectionErrorPx": 0.731827,
  "sparsePointCount": 94028,
  "densePointCount": null,
  "stageTimesMs": { "features": 12666, "matching": 79501, "mapping": 361205 },
  "warnings": [],
  "qualityNotes": [
    "Matching uses the preparation manifest order with a sequential overlap window; 360 projections are interleaved by view and timestamp.",
    "Draft quality stops at the sparse model; choose Balanced or High for a dense point cloud.",
    "Sparse output is readable with an adequate registration ratio for this fixture."
  ]
}
```

Point-cloud response (abridged):

```json
{ "source": "sparse", "count": 20000, "totalPoints": 94028, "label": "Sparse point cloud (COLMAP)" }
```

`totalPoints` (94028) matches the reconstruction report; `count` is the subset
returned to the browser for rendering. No fabricated numbers are involved.

### 1b. Re-verified after adding measured coverage/overlap and the geometry gate

Project `cmv3ncric0000j83je9f04c6l`, same 301-image Museum fixture, quality
`draft`. Preparation now *measures* the two properties the Scope requires
instead of reporting them as `unknown`:

```json
{
  "verdict": "PASS",
  "selection": { "candidates": 301, "accepted": 301, "rejected": 0 },
  "evidence": {
    "motion": "unknown",
    "overlap": "plausible", "overlapScore": 0.735,
    "coverage": "plausible", "coverageScore": 50.72,
    "sky": "not_checked", "dynamicObjects": "manual_review"
  }
}
```

Reconstruction passed with the new minimum-geometry gate in place:

```json
{
  "verdict": "PASS",
  "inputFrames": 301,
  "registeredImages": 301,
  "registrationRatio": 1,
  "meanReprojectionErrorPx": 0.730076,
  "sparsePointCount": 95219,
  "densePointCount": null,
  "stageTimesMs": { "features": 12656, "matching": 61311, "mapping": 383806 },
  "warnings": []
}
```

Point-cloud `source=sparse` → `200`, 1.37 MB. `sparsePointCount` (95219) is far
above the 100-point failure floor, so the gate does not block a genuine result.

## 2. The `REJECT` gate blocks reconstruction

A synthetic `preparation-report.json` with `verdict: "REJECT"` was placed in a
project, then:

| Request | Result |
| --- | --- |
| `POST /api/projects/:id/reconstruction` | **`409`** — `"Preparation was rejected, so reconstruction will not start. …"` + the report |
| `GET /api/projects/:id/preparation` | `REJECT` |

The synthetic file was removed afterwards.

## 3. 360 intake is strict

A 16:9 clip (`15537907-hd_1920_1080_30fps.mp4`) declared `360-video`:

```json
{
  "error": "This clip is 1920×1080 (1.78:1), not equirectangular 360°. Upload a stitched 2:1 panorama (for example 5760×2880, 3840×1920, or 2880×1440). A normal 16:9 video cannot become 360° by picking the 360° button.",
  "sourceMetadata": { "width": 1920, "height": 1080 }
}
```

Status `400`. The measured resolution is reported; the input is not rerouted.

## 4. 360 planning and honest static rejection

A genuine 2:1 clip (`testRoom1_1920Mono (1).mp4`, 1920×960) declared
`360-video`:

- Upload `201` with `sourceMetadata: { width: 1920, height: 960 }`.
- `360-conversion` planned **11 views** with the default 90° FOV / 15 % overlap
  (`processed/projection.json`), not a fixed 6/8-view preset.
- Converted views raised a sky warning and were **kept**:
  `"View \"p11_y254 …\" contains a large sky/bright area. It was kept; extraction will filter frames. No semantic sky mask is applied."`
- `frame-extraction` then **`REJECT`ed** the capture as static, and recorded
  why in `preparation-report.json`:

```json
{
  "verdict": "REJECT",
  "sourceType": "360-video",
  "reasons": ["This capture looks static (frames 5s apart barely differ). …"],
  "evidence": { "motion": "static", "motionScore": 0.3618827, "dynamicObjects": "not_implemented" },
  "projection": { "enabled": true, "fov": 90, "overlap": 0.15, "views": [ … 11 views … ] }
}
```

This is the intended behaviour: the app refuses to claim a reconstruction from a
capture that cannot support one, and says so.

## 5. 360 positive path: genuine 2:1 clip → auto-plan → extract

Project `cmv3mbtws0000to3jma3dw370`, `4k30fps_RICOH_THETA_X.mp4` (3840×1920,
2:1, 16.4 s), declared `360-video`.

| Step | Result |
| --- | --- |
| Upload | `201`, `sourceMetadata: { width: 3840, height: 1920 }` |
| 360-conversion | planned **11 views** (90° FOV / 15 % overlap), completed |
| frame-extraction | completed, 419 accepted frames |
| Preparation report | **`WARN`** — one sky/bright warning, no reasons |

One downward view (`p-39_y270`) was judged *largely blank or textureless*. It was
**kept with a warning** rather than failing the run: the read-only planner can
only apply a global seam shift, so aborting on a single auto-planned view would
be a dead end. Extraction simply drops its frames.

Preparation report (abridged):

```json
{
  "verdict": "WARN",
  "sourceType": "360-video",
  "reasons": [],
  "warnings": [
    "124 frame(s) contain large sky or bright uniform regions. They were kept because they also contain scene detail — no semantic sky mask was applied."
  ],
  "selection": { "accepted": 419 },
  "projection": { "enabled": true, "fov": 90, "overlap": 0.15, "views": 11 }
}
```

Manifest provenance (first frame):

```json
{
  "filename": "p-39_y0_000001.jpg",
  "sourceKind": "360-projection",
  "sourceFilename": "4k30fps_RICOH_THETA_X.mp4",
  "sourceOrder": 1,
  "timestampSeconds": 0.333,
  "projection": { "viewId": "p-39_y0", "yaw": 0, "pitch": -39.2, "roll": 0, "fov": 90 }
}
```

## Build / type / lint

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | **passes** |
| Types (app) | `npx tsc --noEmit` (filtered to `src/`) | **clean** |
| Lint | `npm run lint` | pre-existing React-hooks baseline (see `RESCUE_STATUS.md`) |

Note on the build: Next 16's dev server writes `.next/dev/types`, which can leave
a stale, non-module `routes.d.ts` that makes a later `next build` fail its type
check. A `prebuild` step now removes `.next/dev` before every build so this
cannot recur.

## Fixtures used

- `test samples/image samples/Museum/Museum` — 301 images, known-good.
- `test samples/360 video samples/testRoom1_1920Mono (1).mp4` — 1920×960 (2:1), static.
- `test samples/360 video samples/15537907-hd_1920_1080_30fps.mp4` — 16:9, must be rejected as 360.
