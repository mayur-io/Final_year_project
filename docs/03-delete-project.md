# Feature 03 – Delete Project

## Objective

Allow users to permanently delete a project.

---

## Files Modified

- `src/app/api/projects/[id]/route.ts`
- `src/components/projects/ProjectDashboard.tsx`

---

## Concepts Learned

- HTTP `DELETE` requests
- Deleting a record with Prisma
- Calling dynamic API routes
- Refreshing the UI with `router.refresh()`

---

## API Endpoint

### DELETE `/api/projects/:id`

Deletes a project by its ID.

### Response

```json
{
  "message": "Project deleted successfully"
}
```

---

## Result

- Users can delete projects.
- The project is removed from the database.
- The dashboard refreshes automatically.