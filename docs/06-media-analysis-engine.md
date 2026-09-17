# Media Analysis Engine

## Overview

The Media Analysis Engine is responsible for extracting technical information from uploaded assets immediately after they have been classified by the Asset Detection Engine.

Unlike Asset Detection, which answers **"What is this file?"**, Media Analysis answers **"What do we know about this file?"**

The extracted information becomes part of the asset's metadata and is used throughout Splato's reconstruction pipeline.

---

## Problem

Knowing that a file is a video or image is not enough.

The reconstruction pipeline needs technical information such as:

- Resolution
- FPS
- Duration
- Camera
- Lens
- Orientation
- Codec

Without a centralized analysis stage, every processing module would need to inspect the file independently.

This would duplicate work and increase processing time.

---

## Solution

A dedicated Media Analysis Engine is executed immediately after Asset Detection.

```
Upload
    │
    ▼
Asset Detection
    │
    ▼
Media Analysis
    │
    ▼
Metadata Database
```

Every uploaded asset is analyzed exactly once.

All future processing modules reuse this metadata.

---

## Responsibilities

The Media Analysis Engine does **not** modify files.

Its responsibility is to inspect uploaded assets and produce metadata.

It never performs preprocessing.

It never performs reconstruction.

It only gathers information.

---

# Analysis Categories

## General

Collected for every asset.

- File Name
- File Extension
- File Size
- MIME Type
- Created Date
- Modified Date

---

## Image Analysis

Images produce additional metadata.

- Width
- Height
- Aspect Ratio
- Color Space
- Orientation
- EXIF Metadata
- Camera Manufacturer
- Camera Model
- Lens
- ISO
- Exposure
- Focal Length
- GPS Coordinates

---

## Video Analysis

Videos produce additional metadata.

- Width
- Height
- Aspect Ratio
- FPS
- Duration
- Codec
- Bitrate
- Frame Count
- Rotation Metadata
- Audio Stream
- Variable FPS Detection

---

## 360° Detection

Future versions will automatically recognize

- Equirectangular
- Cubemap
- Dual Fisheye
- VR180

This information will determine which preprocessing pipeline should be executed.

---

## Mesh Analysis

Future versions will inspect

- Vertices
- Faces
- Materials
- Textures
- UV Channels
- Bounding Box

---

## Point Cloud Analysis

Future versions will inspect

- Point Count
- Color Information
- Normals
- Bounding Box
- Coordinate System

---

## Gaussian Splat Analysis

Future versions will inspect

- Splat Count
- SH Degree
- Opacity
- Bounding Box
- Training Software

---

# Why Analysis Happens Once

Media analysis is intentionally centralized.

Advantages

- No duplicated FFprobe calls
- Faster preprocessing
- Consistent metadata
- Single source of truth
- Better UI performance

---

# Future Database Structure

The current Media table only stores upload information.

Future versions will introduce dedicated analysis fields.

Example

```text
Media
│
├── Upload Information
├── Asset Type
├── Image Metadata
├── Video Metadata
├── Mesh Metadata
└── Analysis Results
```

This allows every subsystem to access metadata without re-analyzing the original file.

---

# Relationship With Other Systems

The Media Analysis Engine becomes the foundation of every intelligent processing decision.

```
Original Assets
        │
        ▼
Asset Detection
        │
        ▼
Media Analysis
        │
        ▼
Decision Engine
        │
        ▼
Preprocessing
        │
        ▼
Reconstruction
```

The processing pipeline never guesses.

It relies on analyzed metadata.

---

# Example

Example 1

```
Input

DJI_0001.mp4
```

Analysis

```
Video

3840 × 2160

60 FPS

HEVC

Duration: 02:41

Camera: DJI Mini 4 Pro
```

This metadata allows Splato to choose an appropriate preprocessing pipeline.

---

Example 2

```
Input

RoomScan.jpg
```

Analysis

```
Image

4032 × 3024

Canon EOS R6

24 mm Lens

GPS Available

Landscape
```

Again, preprocessing decisions are driven by metadata rather than assumptions.

---

# Future Expansion

The Media Analysis Engine will eventually support

- Camera profile detection
- Lens profile detection
- Motion estimation
- Scene complexity estimation
- Lighting analysis
- Blur estimation
- Noise estimation
- Exposure analysis
- Compression analysis

These analyses will feed directly into the Decision Engine.

---

# Summary

The Media Analysis Engine transforms uploaded assets into fully described reconstruction assets.

Instead of storing only files, Splato stores structured knowledge about every asset.

Every later subsystem depends on this metadata, making Media Analysis the second foundational stage of the reconstruction pipeline after Asset Detection.