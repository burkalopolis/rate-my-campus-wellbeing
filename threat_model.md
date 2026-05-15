# Threat Model

## Project Overview

Rate My Campus Wellbeing is a Node.js/Express application that serves public campus wellbeing pages, accepts anonymous student submissions, stores data in Supabase/PostgreSQL, and exposes a session-protected admin dashboard for moderation. The production application is primarily implemented in `server.js`; generated API helper libraries under `lib/` are not production entry points for this deployment. Production traffic is assumed to run with `NODE_ENV=production` and platform-managed TLS.

## Assets

- **Anonymous student submissions** — free-text feedback, guidance text, self-reported year/major/community tags, and numeric wellbeing ratings. Exposure or tampering affects user privacy, data integrity, and platform trust.
- **Submitter-linked metadata** — submitter IDs, community tags, archetype selections, and optional email subscriptions. This data can partially de-anonymize contributors when combined.
- **Admin session and moderation authority** — the admin dashboard can flag, archive, delete, and restore submissions. Compromise allows content tampering and broad access to moderation data.
- **Supabase credentials and service-role access** — `SUPABASE_SERVICE_KEY` bypasses RLS and is used for privileged reads/writes. Compromise would expose and modify all application data.
- **CampusMind integration data** — secondary Supabase-backed assessment data used for public comparison views.

## Trust Boundaries

- **Browser to Express server** — all request bodies, query parameters, and route params are untrusted, including anonymous submissions and receipt/admin requests.
- **Express server to Supabase** — the app uses both anon and service-role clients; any bug in the Express layer can turn into broad database access or disclosure.
- **Public to admin boundary** — `/`, `/submit`, `/campus/:slug`, `/receipt`, and public APIs are unauthenticated; `/burkmin/*` and `/api/burkmin/*` are session-gated and must remain isolated.
- **Primary app to CampusMind service** — public request parameters influence a server-side query to a second Supabase project.
- **Production vs dev-only code** — `server.js`, `public/`, and runtime configuration are in production scope; generated libraries in `lib/` are shared artifacts but not direct runtime entry points here unless imported by `server.js`.

## Scan Anchors

- **Production entry points:** `server.js` routes for `/`, `/submit`, `/campus/:slug`, `/receipt`, `/api/submit`, `/api/subscribe`, `/api/campus-ratings`, `/api/campus-radar`, `/burkmin/*`, `/api/burkmin/*`.
- **Highest-risk areas:** admin auth/session setup near `server.js:45-107`, public submission handling near `server.js:503-636`, public rendering functions near `server.js:753-2692`, and CampusMind query construction near `server.js:189-244` and `server.js:357-381`.
- **Surface split:** public read surfaces, anonymous write surfaces, and session-authenticated moderation surfaces.
- **Usually ignore unless reachability changes:** `lib/**` generated packages and local task/skill files.

## Threat Categories

### Spoofing

The admin surface relies on an application-managed session cookie and a shared admin password. All admin pages and moderation APIs must require a valid server-side admin session, and session secrets must be unpredictable in production so attackers cannot forge authenticated cookies.

### Tampering

Anonymous users can submit campus ratings and free-text content that later influences public and admin pages. The server must validate and constrain every user-controlled field before persistence, and moderation actions must be protected against unauthorized cross-site or forged requests.

### Information Disclosure

The application stores sensitive narrative feedback plus optional email subscriptions while marketing the experience as anonymous. Public pages and APIs must only disclose intended aggregated data, and any rendered user-controlled content must not expose other users, secrets, or admin state through script execution.

### Denial of Service

Public write endpoints (`/api/submit`, `/api/subscribe`) and admin login can be abused for spam or credential attacks. The application must bound request volume and expensive operations so unauthenticated traffic cannot overwhelm the service or force weak-admin credential guessing.

### Elevation of Privilege

The service-role Supabase client gives the Express app broad data access, so any weakness in input handling, session integrity, or admin-route protection can become full moderation or data-layer compromise. Public input must never be able to execute script in admin/public browsers or influence privileged queries beyond intended scope.
