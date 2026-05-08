# Rate My Campus Wellbeing

A student-facing platform for rating and exploring wellbeing across UC and CSU campuses. Students submit anonymous feedback tagged by wellness dimension; feedback is moderated before going public.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the web server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript
- Web server: Express 5 (server-rendered HTML, no frontend framework)
- Database: Supabase (PostgreSQL) via `@supabase/supabase-js`
- Logging: pino / pino-http
- Build: esbuild (CJS bundle to dist/)

## Where things live

- `artifacts/api-server/src/app.ts` — Express app setup
- `artifacts/api-server/src/routes/index.ts` — all route handlers
- `artifacts/api-server/src/lib/supabase.ts` — Supabase client + TypeScript types
- `artifacts/api-server/src/lib/logger.ts` — pino logger singleton

## Database Schema (Supabase)

Tables (all in `public` schema, RLS enabled):

| Table | Purpose |
|---|---|
| `campuses` | Reference list of UC/CSU campuses. Seeded with 31 campuses. |
| `submitters` | Anonymised submitter index. No PII. Tags: community, archetype, student type. |
| `submissions` | Core UGC. One row per feedback post. `approved = false` by default. |
| `campus_scores` | Pre-aggregated scores per campus per dimension. Refreshed via `fn_refresh_campus_scores()`. |
| `archetype_scores` | Roll-up to archetype level. `is_dominant` marks the leading archetype. |
| `admin_users` | Links Supabase Auth users to admin role. |

Key enums:
- `dimension_tag`: physical | emotional | intellectual | social | spiritual | environmental | occupational | financial
- `archetype_derived` (auto via trigger): guardian | warrior | healer | guide
- `subject_tag`: campus-overall | department-major | facility | program | resource | transition-experience

RLS summary:
- `campuses` — public read (active only)
- `submitters` — anon insert, admin read
- `submissions` — anon insert, public read approved only, admin full access
- `campus_scores` / `archetype_scores` — public read, admin write
- `admin_users` — admin read only

## Architecture decisions

- Server-rendered HTML with Express — no React/Vue/frontend framework per user requirement
- Supabase anon key only on the server — service role key not stored; admin writes go through Supabase Auth + RLS
- Submissions default to `approved = false` — moderation queue required before public display
- `archetype_derived` computed by Postgres trigger on insert — no application logic needed
- Campus scores are pre-aggregated in `campus_scores` and `archetype_scores` tables — avoids heavy live aggregation queries on public pages

## Environment Variables / Secrets

| Key | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (https://xxxx.supabase.co) |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SESSION_SECRET` | Express session secret |

## User preferences

- Express web app only — no React, Vue, or frontend frameworks
- Use Supabase JS client for all database access
- No postgres/pg direct connections
- No /healthz endpoints
