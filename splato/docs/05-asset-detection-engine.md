# Asset Detection Engine

## Overview

The Asset Detection Engine is responsible for identifying the type of every uploaded asset as soon as it enters the system.

Instead of letting every feature inspect file extensions independently, Splato performs detection once during upload and stores the result in the database.

This allows every subsystem to use a single source of truth.

---

## Problem

Previously Splato only stored metadata:

- filename
- filepath
- filesize
- mimetype

Every screen that wanted to know whether an asset was a video, mesh or image had to determine that itself.

This would eventually lead to duplicated logic across:

- Original Assets
- Workspace
- Reconstruction Pipeline
- Viewer
- Export System

---

## Solution

A centralized Asset Detection Engine was introduced.

```
Upload
    │
    ▼
detectAssetType()
    │
    ▼
AssetType Enum
    │
    ▼
Database
```

Every uploaded asset is classified exactly once.

---

## Database Design

A Prisma enum was introduced.

```prisma
enum AssetType {
  IMAGE
  VIDEO
  MESH
  POINT_CLOUD
  GAUSSIAN_SPLAT
  UNKNOWN
}
```

The Media model now stores

```prisma
assetType AssetType
```

This removes the need to repeatedly inspect file extensions throughout the application.

---

## Detection Strategy

Current implementation uses file extensions.

Supported categories:

| Type | Extensions |
|------|------------|
| Image | jpg, png, jpeg, webp... |
| Video | mp4, mov, mkv... |
| Mesh | obj, glb, gltf, fbx... |
| Point Cloud | las, laz, pcd... |
| Gaussian Splat | splat, ply |

---

## Current Limitation

The `.ply` format is ambiguous.

A `.ply` file may represent:

- Mesh
- Point Cloud
- Gaussian Splat

Current implementation assumes Gaussian Splats.

Future versions will inspect the file header instead of relying only on the extension.

---

## Why Detection Happens During Upload

Detection is intentionally performed immediately after upload.

Advantages:

- Only executed once
- Database becomes the source of truth
- Faster UI rendering
- Simpler filtering
- Easier workspace routing

---

## Future Expansion

The detection engine will eventually recognize:

- Image Sequences
- Camera Calibration Projects
- COLMAP Projects
- NeRF Datasets
- Gaussian Splat Projects
- Reconstruction Outputs
- Depth Maps
- HDR Images

Detection will evolve from simple extension matching to content inspection.

---

## Relationship With Other Systems

The Asset Detection Engine is the first decision point in the reconstruction pipeline.

```
Original Assets
        │
        ▼
Asset Detection
        │
        ▼
Workspace Router
        │
        ▼
Preprocessing
        │
        ▼
Reconstruction
        │
        ▼
Viewer
```

Every major subsystem depends on this classification.

---

## Summary

This feature transforms uploaded files into typed reconstruction assets.

Instead of being simple files, every upload now carries semantic meaning that the rest of Splato can understand automatically.