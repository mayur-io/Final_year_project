# 07 - Archive System

## Overview

The Archive System replaces direct project deletion with a two-step workflow that prevents accidental data loss.

Instead of immediately deleting a project, users archive it first. Archived projects can either be restored or permanently deleted later.

---

## Workflow

```
Project Dashboard
        │
        ▼
Archive Project
        │
        ▼
Archive Database Flag
        │
        ▼
Archive Page
      ┌───────┴────────┐
      ▼                ▼
 Restore      Delete Permanently
```

---

## Features

### Archive Project

Projects are no longer deleted directly from the Project Dashboard.

Selecting **Archive**:

- Opens a confirmation dialog.
- Sets the project as archived.
- Removes it from the active project list.
- Makes it available inside the Archive page.

---

### Archive Page

A dedicated Archive Dashboard was created.

Features:

- View archived projects
- Restore archived projects
- Permanently delete archived projects

Archived projects remain fully recoverable until they are permanently deleted.

---

## Restore

Restoring a project:

- Removes the archived flag
- Clears the archive timestamp
- Returns the project to the main Project Dashboard

No project data is modified during restoration.

---

## Permanent Delete

Permanent deletion removes the project completely.

The following are deleted:

- Project database record
- Related media records
- Entire project storage directory

```
storage/
└── projects/
    └── <projectId>/
        ├── originals/
        ├── processed/
        └── outputs/
```

Deleting the project directory recursively removes all generated assets automatically.

---

## APIs

### Archive

```
PATCH /api/projects/:id/archive
```

Updates:

- `isArchived = true`
- `archivedAt = current timestamp`

---

### Restore

```
PATCH /api/projects/:id/restore
```

Updates:

- `isArchived = false`
- `archivedAt = null`

---

### Permanent Delete

```
DELETE /api/projects/:id
```

Operations:

1. Delete media records.
2. Delete project record.
3. Delete project storage directory.

---

## UI Components

### ArchiveDashboard

Responsible for:

- Displaying archived projects
- Restore action
- Permanent delete action

---

### ConfirmDialog

A reusable confirmation component introduced to replace browser `confirm()` dialogs.

Current usage:

- Archive Project
- Delete Permanently

Future destructive actions should also use this component.

---

### Modal

The reusable Modal component was improved.

New capabilities:

- Optional close handler
- Click outside to close
- Close (✕) button
- Shared title rendering

All future dialogs should be built using this Modal component.

---

## Files Added

```
src/components/projects/ArchiveDashboard.tsx

src/components/ui/ConfirmDialog.tsx
```

---

## Files Updated

```
app/archive/page.tsx

src/components/projects/ProjectDashboard.tsx

src/components/ui/Modal.tsx

app/api/projects/[id]/route.ts
```

---

## Completed

- ✅ Archive Project
- ✅ Archive Dashboard
- ✅ Restore Project
- ✅ Permanent Delete
- ✅ Recursive Storage Cleanup
- ✅ Reusable Confirmation Dialog
- ✅ Consistent Modal Experience

---

## Next Module

**08 - Media Browser**

The next phase begins the Media Engine by displaying uploaded media and managing project assets.