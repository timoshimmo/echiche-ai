# ADR-004: Authentication, tenancy and data security

- Status: **Accepted** (2026-10-25). Defaults approved by the decision owner: Supabase Auth, email magic link, ADR-001 D5 roles, direct Postgres connection with per-transaction role + claims, `@supabase/ssr` + `@supabase/supabase-js` for sessions only.
- Two implementation choices were made within those defaults and flagged for review: the private `echiche` schema, and removal of in-memory runtime mode. Both are reversible.
- Date: 2026-10-25
- Decision owner: Tokmang
- Related: Blueprint AUTH-01, AUTH-02, PROJ-01, §5.4, §8.1; ADR-001 D5; prompt 02

## Threat assumptions
- **In scope:**
  - Any authenticated user acting maliciously, including guessing or enumerating IDs.
  - Unauthenticated internet clients.
  - Cross-site requests from malicious pages (CSRF).
  - Anyone holding the Supabase publishable key (public by design).
  - Oversized or malformed payloads.
  - Cost abuse via repeated run creation.
- **Out of scope for M2:**
  - Compromised server or database credentials.
  - Malicious infrastructure operators.
  - XSS: React escapes output, and no HTML rendering of user content exists yet.
  - Volumetric DDoS: handle at the hosting edge.

## Decision

### Identity
Supabase Auth with **email magic links**. All auth calls are server-side:
- `/auth/sign-in`
- `/auth/callback`, using the PKCE `code`, or `token_hash` for custom templates
- `/auth/sign-out`

Session tokens live in `@supabase/ssr` cookies set **httpOnly, SameSite=Lax, Secure in production**. The browser never holds a Supabase key or calls Supabase.

Every API request verifies the session with the Auth server (`supabase.auth.getUser()`), not by decoding the cookie. So a signed-out session is rejected immediately, and an unreachable Auth server yields **503**, never access.

### Three enforcement layers

| Layer | Where | What it enforces | Tested by |
|---|---|---|---|
| 1. Authentication | `requireUser()` in every private route; middleware for pages | Valid, server-verified session or 401 / redirect | `routes.test.ts`, E2E smoke |
| 2. Application scoping | `Store.forOwner(userId)`. Every query has `owner_user_id = $user`; another owner's ID behaves as nonexistent (404) | Ownership on every read/write path | `routes.test.ts`, `postgres-repository.integration.test.ts` |
| 3. Database | Each transaction: `set_config('request.jwt.claims', {sub})` and `SET LOCAL ROLE echiche_end_user`. RLS policies `owner_user_id = echiche.current_user_id()`, FORCE RLS, column-scoped grants, composite FKs (child owner must equal parent owner) | Isolation even if layer 2 has a bug | `rls.integration.test.ts` (raw SQL, no app filters) |

Each of layers 2 and 3 was shown to block cross-user access with the other disabled (mutation checks, 2026-10-25).

### Roles (ADR-001 D5)
- **`echiche_web`** (login): NOINHERIT, so it has no table privileges of its own. It may only `SET ROLE echiche_end_user`.
- **`echiche_end_user`** (no login):
  - SELECT on the tables, plus column-scoped INSERT/UPDATE.
  - **No DELETE** until export/delete ships (M6).
  - `thought_runs` UPDATE is temporary, while runs execute in the web request; M3 moves it to the worker.
- **`echiche_worker`** (login, M3): reads all owners' runs and writes execution facts only.
- Passwords are never in migrations; they're set per environment out of band (runbook).

### Supabase Data API exposure
Tables live in a **private `echiche` schema** (not `public`). The `anon`, `authenticated` and `service_role` roles hold no privileges on it, so the publishable key cannot reach Echiche data through Supabase's REST or GraphQL APIs even if RLS were misconfigured.

### Policy helper
`echiche.current_user_id()` reads the transaction's claims and returns NULL when they're unset, which matches nothing. It's independent of `auth.uid()`, so policies don't depend on privileges in Supabase's `auth` schema.

### CSRF
- SameSite=Lax cookies.
- An exact `Origin` == `APP_ORIGIN` check on every state-changing route.
- JSON APIs require `content-type: application/json`, which blocks text/plain form posts.

### Abuse limits
- **Per-user hourly caps** on project creation (30) and run creation (20). They're configurable, enforced in Postgres under a per-user advisory lock, so they're exact under concurrency and across instances.
- **Request bodies** are capped at 32 KB, streamed and enforced even without `content-length`.
- **Sign-in emails** are rate-limited by Supabase Auth (local `config.toml`; dashboard for hosted projects).
- **IP-level rate limiting:** not implemented in the app. Use the hosting edge/WAF if needed.

### Configuration fails closed
- `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are always required.
- In production, `APP_ORIGIN` is also required, and https is enforced.
- The server refuses to start if a service-role or secret key is present in its environment or supplied as the publishable key.

### No in-memory runtime mode
Removed, since it would require an auth bypass. `MemoryStore` remains a test double only.

## Consequences
- **Positive:**
  - Cross-tenant access requires defeating two independent layers.
  - The publishable key exposes nothing.
  - Logout takes effect at once.
- **Negative:**
  - One Auth-server round trip per API request (latency, and Auth availability becomes a dependency).
  - Local development needs Docker for `supabase start`.
  - Pre-auth rows cannot be migrated: 0003 refuses non-empty `projects`.
- **Privacy:** the owner ID is never serialised to clients. Logs carry route, event and error code only.
- **Operations:** role passwords and Auth URL settings are manual per-environment steps (runbook).

## Revisit trigger
- Auth round-trip latency becomes material: consider `getClaims()` with asymmetric JWT keys plus a short revocation window.
- Team workspaces (P2) are needed: ownership becomes membership.
- The worker needs per-user DB context.
