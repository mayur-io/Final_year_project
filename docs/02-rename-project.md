# Feature 02 – Rename Project

## Objective

Allow users to rename an existing project.

---

## Files Modified

- `src/components/projects/ProjectDashboard.tsx`
- `src/components/projects/RenameProjectModal.tsx`
- `src/app/api/projects/[id]/route.ts`

---

## Files Created

- `src/app/api/projects/[id]/route.ts`

---

## Concepts Learned

- Dynamic API Routes (`[id]`)
- HTTP `PATCH` requests
- Passing objects as React props
- Updating a single record using Prisma
- Refreshing UI with `router.refresh()`

---

## API Endpoint

### PATCH `/api/projects/:id`

Updates the name of a project.

### Request Body

```json
{
  "name": "New Project Name"
}
```

### Response

```json
{
  "id": "...",
  "name": "New Project Name",
  ...
}
```

---

## Project Structure

```
src/app/api/projects/
├── route.ts          // GET, POST
└── [id]/
    └── route.ts      // PATCH
```

---

## Result

- Users can rename projects.
- Database updates successfully.
- UI refreshes automatically.