# M8 security, privacy and failure-mode review

- **Date:** 2026-10-28
- **Scope:** the whole repository at M7 (`d3e4037`) plus the fixes below. That covers:
  - the web app and API (28 route handlers);
  - auth flows and the Postgres schema (15 tables and a view, RLS, grants, functions);
  - the Python worker (model, research and memory pipelines);
  - CI, deployment config and dependencies.
- **Environment:** local and test only. Postgres 16 (a superuser cluster and a Supabase-like non-superuser cluster), `next start` in production mode, a local HTTPS stand-in for Supabase Auth, and Chromium. No hosted service, production data, real key or live provider was touched.
- **Reviewer:** Claude, the same agent that wrote the code under review. **This is not an independent audit.** An external review before real users remains recommended (see follow-ups).

Evidence is labelled throughout:
- **[tested]**: a test or command was run and its result observed;
- **[manual]**: reasoning from reading the code or configuration;
- **[unverified]**: an assumption about something outside this environment.

## Findings (most severe first)

| ID | Severity | Boundary | Finding | Status |
|---|---|---|---|---|
| F1 | **High** | Cost and abuse (per user and global) | Hourly limits counted rows a user can delete. Deleting a project reset the run and project limits, and erased the run's spend record (`model_calls` cascades). Nothing bounded total spend per user or across users. | **Fixed** [tested] |
| F2 | Medium | Authentication | Login CSRF: the magic-link callback redeemed `token_hash` links in any browser. An attacker could sign a victim into the attacker's account, where the victim might type confidential plans. | **Fixed** [tested] |
| F3 | Medium | Browser | No security headers: the app could be framed (clickjacking on two-click actions such as "Delete project"), and there was no CSP, HSTS or `nosniff` on pages. | **Fixed** [tested] |
| F4 | Medium | Audit | Exports, deletions, run actions and probes of other users' IDs were not logged with the acting user (blueprint §8.1: audit denials, exports, deletions). | **Fixed** [tested] |
| F5 | Low | Prompt injection (all untrusted text) | The data-fence escape missed spacing variants such as `< /untrusted>`, so web, user or memory text could imitate a closing fence. | **Fixed** [tested] |
| F6 | Low (dev only) | Supply chain | Dev dependency advisories: `tinypool` (2 critical, prototype pollution leading to RCE) and `@vitest/mocker` (2), via Vitest 3. Production dependencies were clean. | **Fixed**: Vitest 4.1.12 [tested] |
| F7 | Low | Secrets in source control | `.gitignore` covered `.env` and `.env.local` but not `.env.production` and similar. There was no repository secret scan in CI. | **Fixed** [tested] |
| F8 | Low | Test coverage | The unauthenticated-access test predated the M6 journal routes, the auth routes had no tests, and retries of accept and proposal writes were untested. No vulnerability was behind these gaps. | **Fixed**: an access matrix over every handler, plus tests [tested] |
| F9 | Low | Integrity | Creating a memory or outcome has no idempotency key, so a client retry creates a duplicate. The UI disables the button while a request is in flight. | Accepted (residual) [manual] |
| F10 | Low | Privacy | The stylesheet loads Google Fonts from Google, which discloses users' IP addresses to Google. This is a GDPR concern for an EU deployment. | **Fixed** (UI Stage 2, 2026-10-29): brand fonts self-hosted via @fontsource-variable; Google origins removed from the CSP |
| F11 | Info | Browser | The CSP needs `'unsafe-inline'` for scripts (Next.js App Router bootstrap; no nonce pipeline). React's escaping remains the XSS defence. | Residual [manual] |
| F12 | Info | Abuse (unauthenticated) | No per-IP or edge rate limits. Sign-in relies on Supabase Auth's email limits, and the hosted settings are unverified. | Manual follow-up [unverified] |
| F13 | Info | Prompt injection | A model that obeys injected page text can echo it in the brief. The guards still stop invented citations and unearned confidence. (From M7; ADR-010.) | Open decision [tested in M7] |

**No P0 issue was found.** The one High (F1) is fixed with regression tests. Nothing found is left open at High.

### F1: abuse limits bypassable by deletion; no aggregate spend bound
- **Reproduction [tested]:** with `maxPerHour: 2` for runs and projects, loop: create project → create run → delete project. Result: 10 runs and 5 projects in one hour (temporary repro test, `PostgresStore`, real Postgres). The deleted runs' `model_calls` rows disappear with them (FK cascade, confirmed in `pg_constraint`).
- **Impact:** once `OPENAI_API_KEY` is set, each run can spend up to its cap (up to $0.50 by default). Sign-up is open, and nothing bounded spend per account or in total, so operator cost was effectively unbounded.
- **Remediation:**
  - **Migration 0009:** `echiche.usage_ledger`, append-only and content-free (kind, reserved $, time; no project ID). RLS lets an owner insert and read only their own rows; nobody can update or delete them. It cascades only from `auth.users`, so account deletion removes it.
  - Hourly limits (projects, runs, **exports**, **journal writes**) count ledger rows.
  - **Spend ceilings over a rolling 24 hours, per user and globally.** Each run's spend cap, and each resume's increment, is *reserved in full* when queued, so actual spend can only be lower. The global total is read through a `SECURITY DEFINER` function that returns one number. Advisory locks make both ceilings exact under concurrency.
  - New configuration (defaults are a **decision for the owner**): `USER_DAILY_SPEND_LIMIT_USD` (5), `GLOBAL_DAILY_SPEND_LIMIT_USD` (50), `EXPORT_LIMIT_PER_HOUR` (10), `JOURNAL_WRITE_LIMIT_PER_HOUR` (300). A response over a ceiling is `429 SPEND_LIMIT_REACHED` with `Retry-After`.
- **Regression tests:**
  - `abuse-limits.integration.test.ts` (9 tests, real Postgres): delete-and-recreate; reservation survives deletion; user ceiling; global ceiling under 8 concurrent requests; resume reservation; export and journal limits; the ledger's columns, RLS and append-only rules; cascade on account deletion.
  - `abuse-limits.test.ts` (4 HTTP-level tests).
  - **Production smoke** (`next start`, real HTTP): every control triggered as designed, including `SPEND_LIMIT_REACHED` for both the user and global ceilings.
- **Mutation checks [tested]:** counting from deletable rows again, removing either reservation, removing the global lock (race), and dropping the export limit each fail tests.

### F2: login CSRF through magic links
- **Reproduction [manual + tested]:** `GET /auth/callback?token_hash=<attacker's>&type=magiclink` called `verifyOtp` with no tie to the browser (the PKCE `code` flow is already browser-bound by its verifier cookie). The new test shows that before the fix the callback redeemed the attacker's link.
- **Remediation:**
  - `POST /auth/sign-in` sets `echiche_signin`: random, httpOnly, SameSite=Lax, path `/auth/callback`, 15 minutes (the OTP lifetime).
  - The callback refuses any link without it ("open the link in the browser where you requested it"), and clears it on success.
  - Link types Echiche doesn't offer (invite, recovery, email change) are refused.
- **Regression tests:** `src/app/auth/auth-routes.test.ts` (6): the cookie's attributes; refusal without the marker for both flows, with no redemption call; success with the marker; refused link types; cross-origin sign-in refused; no open redirect; no account enumeration. **Mutation checks:** removing the marker check, or re-allowing the unused types, fails tests.
- **Residual:** opening the link on another device now fails with a clear message. This is already the case for the default PKCE flow.

### F3: browser security headers
- **Remediation:** `next.config.ts` sets on every path:
  - a CSP: `default-src 'self'`; scripts from self plus inline; styles and fonts from self plus Google Fonts; `connect-src 'self'`; `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'none'`; `object-src 'none'`; `upgrade-insecure-requests` in production;
  - `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and COOP;
  - HSTS (2 years) in production.
- **Zod and the CSP:** Zod's eval probe triggered a CSP report in the browser, so Zod is set to jitless (`src/lib/domain/zod-setup.ts`).
- **Verified [tested]:** headers on pages and API responses from `next start`. In Chromium, the login page and the signed-in workspace load with **zero CSP violations**, and a foreign page cannot frame the login form. Unit tests cover the policy, and removing `frame-ancestors` fails them.

### F4: audit trail
- **Remediation:** every not-found answer to a signed-in user logs `resource_not_found` with `user_id`, route and resource type. That covers the other-owner probes the API deliberately answers like a missing ID. Exports log `project_exported`; journal changes and deletions log `journal_change`; run actions and run creation carry `user_id`. User IDs are pseudonymous UUIDs, and no content is logged.
- **Tests:** the access matrix asserts an audit line for every cross-user probe on every handler with an ID. Removing it fails the test.

### F5: fence-tag variants
- **Remediation:** `_FENCE` now matches `<\s*/?\s*untrusted` (case-insensitive) and escapes only the `<`, so exact-quote checks keep working.
- **Test:** `test_fence_variants_in_data_are_neutralised`. The old regex fails it.

## Areas tested with no finding

| Prompt 08 area | Evidence |
|---|---|
| Unauthenticated, cross-user and cross-project access, guessed and malformed IDs | **New access matrix** (`access-matrix.test.ts`) discovers all 28 handlers on disk; an unclassified new route fails it. Every private handler returns 401 with nothing stored. Every handler with an ID gives Bob a 404 byte-identical to a missing ID, with Alice's data unchanged. Malformed IDs (`../../etc/passwd`, `1 OR 1=1`, `%00`) get 404. Plus the existing RLS suite (owner, other user, no claims, forged claims, column grants). All 15 tables have RLS enabled **and forced**; the one view (`ops_run_health`) is readable only by `postgres`. |
| Prompt injection: web pages, memory, user text, model output between stages | All untrusted text, including the remembered items given to framing and synthesis, goes only into fenced data blocks, never instructions (M4 and M5 tests, now including fence variants, F5). Citation, memory-ref and confidence guards are deterministic (M4–M7). Search results contribute URLs only. See F13. |
| Schema-invalid, oversized and adversarial model output | Every model string is bounded by validators (`Short` / `Medium` / `Long`, list caps), checked here. Strict schemas; one repair, then fail; refusal and truncation are permanent (M4 tests). |
| Uploads | None exist; nothing to test. |
| Secrets in bundles, logs, errors, artifacts and source control | Client-bundle scan clean. **Full git history** scanned for key patterns: only synthetic test strings. New `scripts/ci/scan-secrets.mjs` in CI (catches a planted key). Log and error fields reviewed: no prompts, content, provider messages or values. Test TLS certificates are generated at run time and not committed. |
| Rate limiting, repeated run creation, expensive endpoints | F1 (ledger limits, spend ceilings, export and journal limits); Idempotency-Key replay (M3). |
| Retries duplicating memory, decision or source writes | **New:** 5 concurrent accepts record one decision; a retried proposal insert is a no-op (unique run + index). Existing: a resume after a crash neither repeats research nor duplicates sources; checkpoints are written once (M3, M5). |
| Provider timeout, rate limit, malformed output, worker crash | Existing worker suites: timeouts requeue with backoff then fail; 429 `Retry-After`; invalid output fails without retry; crash mid-run resumes from the checkpoint; a lost lease cannot write; unexpected exceptions fail safely (M3, M4). |
| Cancellation, stale jobs, budget exhaustion | Existing: cancellation between stages; expired leases are reclaimed; stale-run visibility; budget pause, explicit resume, wall-time pause (M3–M7). Resume is now also bounded by the spend ceilings (F1). |
| Deletion and export consistency | **New catalog test:** every table cascades from `auth.users`. A table added without a cascade fails it (mutation-checked). Project delete and export completeness were tested in M6. There is no object storage and no derived index. |
| Migration, backup and restore | **Local drill [tested]:** `pg_dump -Fc` → `pg_restore` into a fresh database. RLS flags, 52 policies, table and column grants, function ACLs, row counts and migration history are all identical. The **full** web (52) and worker (48) integration suites pass against the restored copy. Roles are cluster-level and not in a database dump (see the runbook). |
| Dependencies | `npm audit` (all, including dev): 0 after F6. `pip-audit` on the worker's locked production set: no known vulnerabilities. |

## Checks run (all local)
- **Web:** typecheck, lint, 104 unit tests and 54 integration tests (including the cross-language E2Es), on a fresh database and on the Supabase-like non-superuser cluster.
- **Build and bundle:** production build, client-bundle scan, secret scan, `npm audit`.
- **Worker:** ruff, ruff format, pyright strict, 165 unit and 48 integration tests, contracts check, evaluation gates.
- **Migrations:** 0001–0009 from empty, then a re-run (no-op); upgrading a populated M7 database (only 0009 applies).
- **Smoke:** a production-mode smoke test over HTTP; a Chromium CSP and framing check; the backup and restore drill.
- **Mutation checks:** 12, all caught: F1 ×5, F2 ×2, F3, F4, an authorization owner check removed from the store, F5, and a table without a cascade.

## Release blockers and decisions
Nothing in this review blocks a **private, invite-only** pilot once the manual steps below are done. Before **open sign-up**:
1. **Set the spend ceilings deliberately** (F1 defaults: $5 per user and $50 globally per rolling day), and decide whether sign-up stays open. An open sign-up plus a global ceiling means one abuser can exhaust the day's budget for everyone: the ceiling bounds cost, not availability.
2. **Verify Supabase Auth's hosted rate limits and sign-up policy** (F12) in the dashboard.
3. **Decide on Google Fonts** (F10): self-host the font files (the recommendation for an EU service), or name Google in the privacy notice.
4. **Commission an independent security review.** This one was performed by the code's author.

## Residual risk
- **Worker compromise is total:** the worker role reads every owner's data by design, so the database credentials and the worker host are high-value.
- **XSS:** with the CSP allowing inline scripts (F11), XSS prevention rests on React's escaping. No `dangerouslySetInnerHTML` exists in the app.
- **Injection (F13):** fencing reduces it; it can't eliminate it.
- **Duplicates (F9):** retried memory or outcome posts can still create duplicates.
- **Reservations:** they over-count. A cancelled or cheap run still holds its full cap for 24 hours, so legitimate heavy users may hit the ceiling early.
- **Hosted configuration** (Supabase Auth, backups, Render) is unverified here.

## Manual follow-up steps
1. **Hosted Supabase Auth:**
   - Authentication → Rate Limits: keep the email-sending limits low (for example, at most 30 per hour project-wide).
   - Authentication → Sign In / Providers: disable sign-ups for an invite-only pilot, or enable CAPTCHA if sign-up stays open.
2. **Render, web service:** set `USER_DAILY_SPEND_LIMIT_USD` and `GLOBAL_DAILY_SPEND_LIMIT_USD` to what you will pay per day. They are in `render.yaml` with the defaults.
3. **Apply migration 0009 before deploying this build:** [render-deploy.md](../runbooks/render-deploy.md), migrations first.
4. **Backup restore drill on Supabase:** restore the latest backup or PITR into a **new, temporary** project. Then follow [run-operations.md → Backup and restore drill](../runbooks/run-operations.md#backup-and-restore-drill-m8) to recreate the login roles and passwords, run the read-only checks, and delete the temporary project. Record the date.
5. **Fonts (F10):** download the WOFF2 files under their open licences, serve them from `public/fonts`, and drop the Google entries from the CSP.
6. **Logs:** confirm the retention period of Render's log stream. Logs now carry pseudonymous user IDs; [data lifecycle](data-lifecycle.md) covers this.
7. **Independent review:** an external security review before open sign-up.
