# ADR-005: Hosting for the web app and worker

- Status: **Accepted** (2026-10-26)
- Date: 2026-10-26
- Decision owner: Tokmang
- Related: ADR-001 (TS web + Python worker, D2 polling worker), ADR-004 (auth, DB roles), blueprint §4.2 and §8.4

## Context
- **Web app:** Echiche needs an always-reachable Next.js server.
- **Worker:** it also needs a long-running Python process that claims runs from Postgres (ADR-001 D2). Runs may take minutes.
- **Database:** Supabase stays the database and auth provider.
- **Users:** the first users are expected near Lagos.

## Options considered (prices and limits checked 2026-10-25/26)
- **Vercel:**
  - Excellent for Next.js.
  - Serverless functions cap at 300 s (Hobby) or 800 s (Pro).
  - The worker would need Vercel Daemons, which are in public beta and production-only.
  - Hobby is restricted to non-commercial use.
- **Render:** an always-on web service plus a first-class Background Worker. Blueprint (`render.yaml`) infrastructure as code. Health checks, zero-downtime deploys, and full-stack previews on the Pro workspace.
- **Railway:** usage-based and cheap when idle, with good developer experience. Bills are less predictable.
- **Fly.io / DigitalOcean App Platform / self-managed VPS:** viable, but either more operations work or no advantage for this setup.

## Decision
**Render, Frankfurt region**, for both services:
- **`echiche-web`:** Node web service running `next start`. Health check `GET /api/ready`. Starts on the 1 CPU / 2 GB plan; 512 MB is too small for a production Next.js server.
- **`echiche-worker`:** Background Worker built from `worker/Dockerfile`, a plain Python process polling Postgres. Starts on 0.5 CPU / 512 MB.
- **Supabase project in `eu-central-1` (Frankfurt)**, co-located with both services. Every API request makes an Auth call and a DB round trip.
- Defined in a repo-level `render.yaml` (added in M3). Deploys from GitHub. Secrets are set in Render, never committed.

## Consequences
- **Positive:**
  - ADR-001 and ADR-004 run as designed: no function time limits, the boot-time config check exits the process as intended, and DB connections are long-lived.
  - The worker is a stable product, not a beta.
  - Previews can include the worker (Pro workspace).
- **Negative:**
  - Render can't change a service's region after creation, so moving off Frankfurt means recreating services.
  - Price steps are coarse (2 GB at $25 to 4 GB at $85).
  - Included bandwidth is small (5 GB Hobby / 25 GB Pro, then $0.15/GB). Acceptable for a text-centric app; monitor it.
- **Cost (planning estimate, not a quote):** about $32/month compute, plus a $25 Pro workspace if previews are wanted, plus Supabase.
- **Portability:**
  - The worker is a standard container image.
  - The web app is a standard `next start` server.
  - Moving to Railway, Fly.io or a VPS needs no code changes.

## Revisit trigger
- Bandwidth or compute cost becomes material.
- Users concentrate outside Europe or Africa.
- Render reliability incidents affect the pilot.
- Autoscaling needs exceed manual instance counts.
