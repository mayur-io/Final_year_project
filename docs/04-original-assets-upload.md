# Original Assets Upload

## Goal

Replace the fake upload flow with a real file upload system that stores the original user files on disk while preserving metadata in the database.

This is the foundation for future preprocessing, asset detection, reconstruction pipelines, and branching.

---

# Previous Flow

```
User Selects File
        │
        ▼
Metadata Only
(filename, filepath=file.name, filesize, mimetype)
        │
        ▼
Database
```

No actual file was stored.

The application only knew that a file existed.

---

# New Flow

```
User Selects File
        │
        ▼
Browser sends FormData
        │
        ▼
API receives File
        │
        ▼
Create Project Storage

storage/
└── projects/
    └── {projectId}/
        └── originals/

        │
        ▼

Save Original File
        │
        ▼
Save Metadata in Prisma
        │
        ▼
Refresh Original Assets Panel
```

---

# Storage Structure

```
storage/
└── projects/
    └── project-id/
        └── originals/
            drone.mp4
            IMG_0001.jpg
            scene.splat
```

The `originals` folder always contains the files exactly as uploaded by the user.

These files are never modified.

---

# Original Assets Philosophy

Splato never edits or renames uploaded files.

Original assets are treated as immutable source files.

Every processing stage generates new assets rather than modifying originals.

Example:

Original

```
drone.mp4
```

↓

Generated

```
frames/
000001.jpg
000002.jpg
000003.jpg
```

The original video always remains available for future processing or branching.

---

# UI Update

The previous **Media Library** became **Original Assets**.

Purpose changed from:

> Showing imported files.

to

> Showing immutable source assets belonging to the project.

This aligns with Splato's future workspace architecture.

---

# Future Pipeline

```
Original Assets
        │
        ▼
Asset Detection
        │
        ▼
Stage Identification
        │
        ▼
Workspace
        │
        ▼
Preprocessing
        │
        ▼
Generated Assets
        │
        ▼
Reconstruction
```

---

# Why This Matters

This upload architecture enables:

- preprocessing
- frame extraction
- image sequence generation
- asset detection
- branching
- reproducible reconstruction pipelines
- preserving user originals

without ever destroying uploaded data.