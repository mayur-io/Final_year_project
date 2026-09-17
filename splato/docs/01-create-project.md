# Feature 01 - Create Project

## Goal
- Create a project and save it to PostgreSQL.

## Concepts
- useState
- Props
- Controlled Inputs
- fetch()
- API Route
- Prisma
- router.refresh()

## Flow
Dashboard
↓
Modal
↓
React State
↓
POST /api/projects
↓
Prisma
↓
PostgreSQL
↓
router.refresh()

## Mistakes
- Wrong import path.
- Forgot to pass onClose prop.
- Forgot to pass onCreated prop.

## Learned
- Parent owns state.
- Child communicates through props.
- API routes handle database operations.