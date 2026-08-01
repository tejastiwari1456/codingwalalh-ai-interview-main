# AI Interview System

An MVP teaching project for an AI-assisted interview workflow. It includes an admin dashboard, candidate code entry, timed chat interview, transcript storage, and AI review handoff.

## What is implemented

- Admin login screen.
- Admin form to create an interview from candidate, role, experience, topics, and duration.
- Admin prompt library for editing or adding role-specific interview tracks.
- Unique candidate link plus one-time code generation.
- Candidate interview screen with timer.
- Chat-style AI interview flow.
- Automatic finish and review generation.
- Local mock server for classroom use.
- Cloudflare Pages Function scaffold for Supabase and OpenAI.
- Supabase SQL schema with RLS policies.

## Local development

This project has no install step for the local mock mode.

```bash
npm run dev
```

Open:

```txt
http://localhost:8788
```

Use any email and password with at least 4 characters in local mock mode.

## Production architecture

```txt
Browser
  -> Cloudflare Pages static frontend
  -> Cloudflare Pages Functions API
  -> Supabase Auth + Postgres
  -> OpenAI Responses API
```

Admins authenticate through Supabase Auth. Candidate access is code-based and limited to a single interview session. The browser never receives Supabase service keys or OpenAI keys.

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Create admin users in Supabase Auth.
4. Add Cloudflare environment variables from `.env.example`.
5. Deploy the Pages project.

## API routes

- `POST /api/admin/login`
- `GET /api/interviews`
- `POST /api/interviews`
- `GET /api/prompts`
- `POST /api/prompts`
- `PATCH /api/prompts/:template_key`
- `POST /api/interviews/verify`
- `POST /api/interviews/:id/messages`
- `POST /api/interviews/:id/finish`
- `GET /api/interviews/:id/review`

## Teaching notes

Suggested lessons:

1. Requirements and product flow.
2. Database schema design.
3. Authentication and RLS.
4. Candidate access tokens.
5. Prompt template selection.
6. AI chat orchestration.
7. AI review as a background-style step.
8. Deployment and environment variables.
9. Privacy, audit logs, and abuse prevention.

## Next production hardening steps

- Move review generation to a queue for long interviews.
- Add rate limiting per interview code and IP.
- Add prompt versioning in the admin UI.
- Add CSV export for candidate reports.
- Add resume upload through Supabase Storage.
- Add richer rubric management for instructors.
