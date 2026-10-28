# Implementation and verification status

_Last updated: 2026-10-28 (M8, "Security, privacy and failure-mode review")_

"Verified" means the check was actually run, with the stated result, in the environment noted. Code presence alone is not verification.

## Verified locally (Linux, Node 22.22.0, PostgreSQL 16.15, Supabase CLI 2.120.0, Python 3.12.3, uv 0.11)

From a **clean clone** against a **fresh database**:

| Check | Result |
|---|---|
| `npm ci` · typecheck · lint | ✅ · 0 errors · 0 problems |
| `npm test` (web unit: routes incl. owner-scoped evidence, the memory/decision journal and routing; config incl. refusing `OPENAI_API_KEY`; contracts; the router incl. labelled cases and benchmark drift; **M8:** an access matrix over every route handler, auth routes, security headers, abuse limits over HTTP) | ✅ 104 tests |
| `npm run build` (no env); client-bundle scan; `npm audit --omit=dev` | ✅ · none found · 0 vulnerabilities |
| `npm run test:db:prepare` from empty (0001–0009 via Supabase CLI), then re-run | ✅ · ✅ no-op |
| `npm run test:integration`: repository + RLS as `echiche_web`, plus **three cross-language E2Es**: the demo worker CLI; the model pipeline with a scripted model; research over a local TLS site, where every brief citation resolves to a stored source and a verified quote, read by TS through RLS; memory continuity across runs; the quick route in the real worker CLI. Plus journal tests on real Postgres and, since M8, abuse limits and spend ceilings, duplicate-write retries and catalog-level deletion consistency. | ✅ 54 tests |
| Worker: `uv sync --locked`, ruff, ruff format, pyright strict (incl. tests), `contracts --check` | ✅ |
| Worker unit tests (incl. prompt registry, model pipeline, OpenAI adapter, Brave adapter, fetcher guards over real TLS, research and verification pipeline with adversarial fixtures, memory selection, routing and escalation, **the fake evaluation benchmark and its gates**, fence-tag variants) | ✅ 165 tests |
| Worker integration (as `echiche_worker`, incl. the memory benchmark and routed runs) | ✅ 48 tests |
| `uv run python -m evals.run` (33 cases × variants A/B/C/R, scripted model) | ✅ all 13 invariant gates pass |
| Same web and worker integration suites on a **fresh cluster with a Supabase-like admin** (non-superuser, CREATEROLE, BYPASSRLS) | ✅ 54 + 48 |
| `npm audit` (including dev) · `pip-audit` (worker production set) · `scripts/ci/scan-secrets.mjs` | ✅ 0 · none known · clean |
| Upgrading an M3 database with 25 runs: only 0005 applied; M3 `stage-output.v1` checkpoints still load (integration test) | ✅ |

**M8 checks** (full report: [docs/security/review-m8.md](docs/security/review-m8.md); self-review, not independent).
- **Findings:**
  - **F1 (High), fixed:** deleting projects reset hourly limits and erased spend records, and there was no aggregate spend bound. Reproduced: 10 runs with a limit of 2. Fixed with the usage ledger and per-user and global spend ceilings (ADR-011).
  - **Medium, fixed:** F2 login CSRF via magic links, F3 missing security headers, F4 an audit trail without user IDs.
  - **Low, fixed:** F5 fence-tag variants, F6 dev-dependency advisories (Vitest 3 → 4.1.12), F7 env-file ignore rules and a CI secret scan, F8 test-coverage gaps.
  - **Open or residual:** F9 duplicate memory or outcome posts on client retry, F10 Google Fonts privacy, F11 the CSP's `'unsafe-inline'`, F12 hosted Auth limits unverified, F13 model-obeyed injection.
- **Production smoke over HTTP** (`next start`, Auth stand-in): delete-and-recreate refused, both spend ceilings answer `429 SPEND_LIMIT_REACHED`, project and export limits answer `429`, another user's project returns 404. Chromium loaded the login page and the signed-in workspace with zero CSP violations, and framing was blocked.
- **Backup and restore drill (local):** `pg_dump -Fc` → `pg_restore`. RLS, policies, grants, function ACLs, rows and migration history are identical, and the full web (52) and worker (48) integration suites pass on the restored copy.
- **Mutation checks** (all 12 caught):
  - F1 ×5: counting deletable rows, the run reservation, the resume reservation, the global lock, the export limit;
  - F2 ×2: the browser binding, unused OTP types;
  - F3: framing;
  - F4: probe audit;
  - an authorization owner check removed from the store;
  - F5: the old fence regex;
  - a table added without a cascade.

**M7 checks.** No live model or search call was made. Fake mode only; every number below comes from a scripted model and is **not a quality claim**.
- **Router:**
  - deterministic, with every point of the score explained;
  - the user's depth overrides it;
  - budgets are the element-wise minimum of configured and tier;
  - agreement 23/24 on the labelled cases (the known miss, R07, is documented, not tuned away);
  - the benchmark's recorded tiers match the router (drift test);
  - matching is on word starts ("lease" ≠ "please"), and reasons quote the user's own words.
- **Worker routing:**
  - low-tier runs checkpoint research, critique and verification as skipped, make 2 model calls, use 5 steps, and disclose it in the brief;
  - medium never escalates;
  - high escalates synthesis on a contradiction or a high-severity critique, records the model in `model_calls`, and writes `route_escalation` and an event;
  - when escalation is justified but no model is configured, or it would exceed the cap, that is recorded too;
  - pre-M7 runs (no tier) run the full pipeline;
  - the worker cannot change the route decision (column grants);
  - an unpriced escalation model, or a missing or invalid policy file, fails start-up (exit 2).
- **Cross-language:** the web queues, the real worker CLI runs the quick route, and the web reads the skipped stages. The deep-tier research E2E records "escalation triggered (contradiction, high_severity_critique) but no escalation model is configured".
- **Evaluation benchmark:** 33 synthetic cases, 11 categories, four variants, results versioned with commit, prompt and policy versions ([ADR-010 §4](docs/decisions/010-evaluation-and-adaptive-compute.md)).
  - B (no verification) cited unsupported sources 4 times and claimed unearned "high" confidence twice. C and R did neither.
  - **Injected text was echoed** by the adversarial scripted model in B, C and R (2 of 3 cases). This is measured, not gated: deterministic guards don't stop it.
- **Found and fixed:** memory retrieval could not recall a fact in a one- or two-item project (case M05). The M6 seeded benchmark still scores 1.00 / 1.00 / 1.00.
- **Mutation checks** (each makes tests fail):
  - ignoring tier skipping;
  - loosening tier budgets;
  - not recording escalation;
  - escalating outside the high tier;
  - loosening tier research caps;
  - removing the small-project recall floor;
  - dropping the quick-route disclosure;
  - substring term matching;
  - disabling the brief guard (eval gates).
- **UI:** the depth selector (with a hint) and the route line (tier, how it was chosen, escalation, expandable reasons, skipped stages) were rendered and inspected at desktop and 390 px widths, with no horizontal scroll.

**M6 checks.**
- **Seeded retrieval benchmark** (real Postgres, as `echiche_worker`; 14 memories, 2 owners, 3 projects, 8 queries incl. 3 that must recall nothing): recall 1.00, precision 1.00, abstention 1.00. No superseded, unapproved, rejected, other-project or other-user item surfaced. The canonical decision always came first.
- **Proposals:** written only as `proposed` rows. Sensitive-looking ones need explicit confirmation. They are never given to runs until approved.
- **Lifecycle:** approve with edit, reject, correction as a new version with history, hard delete of the whole lineage.
- **Decision journal:** accepting a brief records version 1; a revision adds version 2 and keeps v1's rationale; outcomes are appended.
- **Database rules:** the worker can only insert proposals; provenance and decision versions are immutable; superseded memories are frozen.
- **Isolation:** owner-only reads and writes across every route and table (RLS and the app's owner filters).
- **Runs and memory:**
  - invented memory refs are rejected and repaired;
  - conflicts with remembered items appear in the brief's limitations;
  - the remembered snapshot each run saw is stored and shown;
  - a cross-language E2E checks that TypeScript approves, the worker's next run reads it, and TypeScript shows the provenance.
- **Export and delete:** export returns a JSON attachment with everything. Project delete leaves no dependent row (runs, sources, memories, decisions).
- **Mutation checks** (each makes tests fail):
  - giving proposals or superseded rows to runs;
  - allowing invented refs;
  - dropping the abstention threshold;
  - skipping sensitive confirmation;
  - correcting or revising without superseding.
- **UI:** the memory and decision journal panel was rendered and inspected at desktop and 390 px widths.

**M5 checks.** No live Brave or web request was made. All fetching runs against a local HTTPS fixture site with a throwaway certificate, using real TLS and hostname checks.

Adversarial fixtures are covered:
- no results;
- invalid URLs: ftp, http, credentials in the URL, odd ports;
- refused pages: robots.txt, `noarchive`/`noai` in meta and headers, PDF, oversize, too short, 404, redirect loop, redirect to a private address, https→http downgrade, slow page;
- a mis-quoted claim and an unsupported claim;
- a contradicting source and a stale (2014) source;
- a page with hidden prompt-injection text that tries to cite S9 and force high confidence.

What is enforced:
- **Addresses:** non-public addresses are refused, including IPv4-mapped IPv6, CGNAT and metadata IPs, and a host with any bad address.
- **Limits:** search and page limits, the research budget (it pauses before research when used up), and a spend pre-check before each search.
- **Search outages:** they retry; on the last attempt the run degrades explicitly. A rejected key fails the run.
- **Citations:** the brief may cite only sources behind verified claims, and "high" confidence needs two domains.
- **Limitations:** those from research and verification are carried into the brief.
- **Persistence:** sources and claims are written once even across a crash and resume. Research rows are owner-scoped and append-only for both roles.

**Mutation checks** (each makes tests fail):
- disabling the quote check, the address guard, robots.txt or the meta opt-out;
- disabling the brief citation guard;
- swallowing search outages before the last attempt.

**Upgrade and image:**
- Upgrading a populated M4 database applied only 0006, and its 25 runs were kept.
- The worker image layout, replayed outside Docker, passes `--check-config` with OpenAI and Brave configured and placeholder keys.

**UI:** the sources view (links, verified quotes, sources read but not cited, claims that failed verification) was rendered and inspected at desktop and 390 px widths.

**M4 checks (no live API call was made; there is no key in this environment):**
- **Prompt registry:** loads 3 active and 4 draft prompts. It rejects placeholders, unknown keys, unknown contracts, a changelog that doesn't match the version, and duplicate ids. Draft prompts cannot run.
- **Injection fencing:** user text never reaches the instructions; fence markers in the data are escaped.
- **Model pipeline:**
  - one repair attempt, then `INVALID_PROVIDER_OUTPUT`;
  - an invented citation triggers a repair;
  - refusal and truncation are permanent, and recorded with their cost;
  - the budget preflight pauses with `BUDGET_COST` before anything is sent, and resume continues without re-running stages;
  - a 429 `Retry-After` delays the requeue;
  - switching modes mid-run fails safely with `REASONING_MODE_MISMATCH`;
  - a corrupt model checkpoint is rejected.
- **OpenAI adapter, against the local mock server:**
  - request shape: `store=false`, a strict schema, instructions separate from the data, reasoning effort sent only when set;
  - errors: 429, 5xx, 401/403 and 400 mapped, provider messages never propagated, exactly one HTTP request (SDK retries off);
  - timeout, connection failure, refusal, `incomplete`, and invalid JSON.
- **Spend:** costs match the verified price table (incl. EU +10%); an unknown model fails start-up with exit code 2; every call, including failed ones, counts toward `cost_usd_used`; the worker cannot decrease usage counters; `model_calls` is owner-scoped and append-only.
- **Mutation checks:** removing spend recording on failures fails the integration suite; removing fence escaping fails two unit tests.
- **Worker image:** the image layout was replayed outside Docker (repo-root context, `ECHICHE_PROMPTS_DIR`). `--check-config` with `REASONING_PROVIDER=openai` and a placeholder key loads the registry (exit 0), and fails closed without the prompts directory (exit 2).
- **UI:** the decision-brief view was rendered and inspected at desktop and 390 px widths (no horizontal scroll).

**Bug found and fixed by these tests:** two workers could claim the same queued run. A claimed run stays `queued` until its first stage starts, and `FOR UPDATE` rechecks the predicate against the committed row. The claim query now excludes any run with a live lease. Removing that guard makes the concurrency tests fail (mutation check).

**Production smoke test** (`next start` in production mode, a continuously running worker process, local HTTPS stand-in for Supabase Auth, real session cookies):
- 202 with `Location`; Idempotency-Key replay returns 200.
- The worker ran 3 stages and paused at the 3-step budget. Another user's resume returned 404.
- The owner's resume raised the caps and continued from the checkpoint to "awaiting review". Accept then gave `completed`, and cancelling the finished run returned 409.
- Events were sequenced 1–12.
- On SIGTERM the worker exited cleanly and removed its heartbeat.

**Worker image:** the Dockerfile's build steps were replayed outside Docker (`uv sync --locked --no-dev`, then the entry point). The production environment has no dev tools, and config exit codes are 0/2. The Docker build itself runs in CI.

## Not yet verified (no Docker, hosted accounts or API keys in the build environment)

- **A live Brave search and live page fetching.** The opt-in test (`ECHICHE_LIVE_BRAVE=1 … pytest -m live -k research`) is for the decision owner to run.
- **Brave's written confirmation** of transient result use and excerpt storage on the chosen plan (licensing; ADR-008).
- **A live OpenAI call.** The opt-in smoke test (`ECHICHE_LIVE_OPENAI=1 … pytest -m live`) is for the decision owner to run with their own key.
- **A live, human-reviewed evaluation baseline** (procedure: [evaluation runbook](docs/runbooks/evaluation.md)). Real model quality, cost and latency are unmeasured, so no quality, cost or latency gates exist yet.
- **Escalation with a real second model.** It is tested only with a scripted client.
- **Hosted security settings (M8):** Supabase Auth rate limits and sign-up policy, a restore drill on Supabase backups, Render log retention, and whether Supabase's restore-to-new-project carries custom roles.
- **Not verified in OpenAI's docs:** the context window and supported reasoning-effort values of `gpt-6.1-sol`. The official model page was unreachable.

- **GitHub Actions jobs:** `supabase-stack` (real local Supabase), the worker Docker build/run, and the overall first CI run.
- **Render deployment:** the Blueprint, the health check, and the Supabase pooler accepting the `echiche_web.<ref>` / `echiche_worker.<ref>` custom roles. See [render-deploy.md](docs/runbooks/render-deploy.md).
- **The magic-link email round trip** (manual, local stack).

## Implemented

**M8** (ADR-011 **proposed**: confirm the ceiling defaults)
- **Migration 0009:** `usage_ledger` (append-only, content-free, owner RLS) and `global_reserved_spend()` (security definer, returns one number).
- **Web, abuse limits:** limits for projects, runs, exports and journal writes come from the ledger; runs and resumes reserve their spend against per-user and global ceilings (`429 SPEND_LIMIT_REACHED`).
- **Web, auth and browser:**
  - the magic-link callback requires the requesting browser's marker cookie, and only the OTP types Echiche uses are accepted;
  - security headers (CSP, frame-ancestors / X-Frame-Options, HSTS in production, nosniff, Referrer-Policy, Permissions-Policy, COOP);
  - Zod set to jitless so the CSP reports no violations.
- **Web, audit:** `user_id` on run, journal, export and not-found events.
- **Worker:** the data-fence escape covers spacing variants. Version 0.8.0.
- **Tests and CI:**
  - an access matrix over every handler (fails on an unclassified new route);
  - auth-route tests; abuse-limit tests (HTTP and Postgres);
  - duplicate-write retries; catalog-level deletion consistency;
  - a repository secret scan in CI; `.gitignore` covers every `.env*` except the example; Vitest 4.1.12.
- **Docs:** the security review, ADR-011, run-operations (ledger queries, the audit trail, the backup and restore drill), data lifecycle, README, `.env.example`, `render.yaml`.

**M7** (ADR-010 **proposed**, awaiting the owner's review)
- **Migration 0008:** route columns on `thought_runs` (requested depth, tier, reasons, policy version, escalation outcome), with column grants.
- **Routing:**
  - `config/routing-policy.json` (`routing-policy.v1`), shared by both services;
  - the web router (`src/lib/domain/routing.ts`) classifies at queue time and tightens budgets by tier;
  - the worker (`routing.py`) skips stages per tier, tightens research caps, and escalates synthesis on configured triggers (`OPENAI_ESCALATION_MODEL`, optional, must be priced);
  - synthesis prompt 2.3.0 handles a critique that was not run.
- **Memory:** a word unique to one remembered item now always counts as distinctive (small-project recall).
- **Evaluation:**
  - `evals/` holds the router cases, `decision-benchmark.v1`, `gates.v1` and the committed fake report;
  - `worker/evals/` holds the harness (scripted model, search and pages; an in-memory store driving the real executor; scoring; the CLI);
  - CI runs the gates.
- **Web:** the API accepts `depth`; runs carry `route`. The UI has a depth selector and a route line with reasons and skipped stages.
- **Docs:** ADR-010, the evaluation runbook (live-baseline procedure and review sheet), README, worker README, `render.yaml`.

**M6** (ADR-009 accepted 2026-10-28: hard delete; approved memory feeds later runs with provenance; JSON export)
- **Migration 0007:** versioned `memories`, `decisions` and `decision_outcomes`, plus `run_memory_context`. Includes transition triggers, column grants and RLS, and project delete for owners.
- **Worker:**
  - proposals written from the brief at finish, with a sensitivity screen;
  - deterministic, abstaining memory selection (`memory.py`), fed to framing 2.1.0 (`decision-frame.v2` with `memory_conflicts` and a ref guard) and synthesis 2.2.0;
  - memory snapshots persisted per run.
- **Web:**
  - repository and routes for proposals, corrections, history, delete, the decision journal (from accepted briefs and revisions), outcomes, project delete and JSON export;
  - the "Memory and decisions" panel;
  - remembered items shown in the brief.
- **Docs and tests:** ADR-009, data lifecycle, runbook queries, and the seeded benchmark corpus `worker/tests/fixtures/memory_benchmark.json`.

**M5** (ADR-008 accepted 2026-10-28: Brave for discovery; the worker reads pages itself; research is off until a key is set)
- **Migration 0006:** `sources`, `claims`, `claim_sources`, `research_calls`, with RLS (owner reads; worker inserts; nobody updates or deletes).
- **Worker modules:** Brave adapter (`research.py`), safe fetcher (`fetch.py`), deterministic passages and quote matching (`passages.py`), pipeline and verification rubric (`research_pipeline.py`).
- **Prompts and contracts:** prompts `research-planner`, `claim-extractor` and `decision-verifier` are active at 2.0.0, and critic and synthesis are at 2.1.0. New contracts: `research-plan.v1`, `claim-set.v1`, `claim-verification.v1`, `evidence-set.v1`, `verification-report.v1`.
- **Web:** `evidence` on `GET /api/runs/:id` (Zod-validated, https only); the sources view in the brief.
- **Deployment, docs and tests:**
  - `render.yaml` research variables (off by default); the CI image check builds the research pipeline;
  - opt-in live research test;
  - ADR-008 and runbooks.

**M4** (ADR-007 accepted 2026-10-26, D9–D12 approved; paid calls stay off until a key is set)
- **Prompt registry** (`prompts/runtime/`, TOML frontmatter, fail-closed loading). The 3 active prompts were rewritten to v2.0.0; the other 4 are drafts.
- **Contracts:** `decision-frame.v1`, `critique.v1`, `decision-brief.v1` (every blueprint §2.6 section), `stage-output.v2`; shared fixtures; Zod mirror with string bounds.
- **`ModelClient` port, OpenAI adapter, model pipeline:** one repair attempt, citation guard, worst-case spend preflight, and call records. The verified price table is dated, with the source URL.
- **Migration 0005:** `echiche.model_calls` (RLS, no content) and monotonic usage counters for the worker.
- **Web:**
  - tagged result union (`schemaVersion`) and a `generation` summary;
  - "Live model (OpenAI · model)" vs "Demo mode" labels, and the brief view;
  - `OPENAI_API_KEY` refused in the web environment; bundle scan extended.
- **Deployment and tests:**
  - worker image built from the repo root (whitelisting `.dockerignore`, `ECHICHE_PROMPTS_DIR`); `render.yaml` provider variables, demo by default; CI image check loads the registry;
  - opt-in live test marker.
- **Docs:** ADR-007, runbooks (enabling live reasoning, spend queries, new error codes), data lifecycle (provider data use), worker and prompt READMEs.

**M3**
- **Migration 0004:**
  - blueprint run states with a per-role transition trigger;
  - leases, attempts, backoff (`available_at`), budgets and usage, and idempotency keys;
  - `run_stage_outputs` checkpoints, `worker_heartbeats`, and the `ops_run_health` view;
  - least-privilege grants: end users can't write results, events or execution fields; the worker can't edit prompts, owners, budgets or `completed_at`.
- **Python worker:**
  - claim loop (`SKIP LOCKED` + leases) with a lease-keeper thread;
  - transactional checkpoints, and lease-guarded writes;
  - bounded jittered retries, stage timeouts, the failure policy with stable codes, budgets, cancellation;
  - SIGTERM drain, reconnect with backoff, heartbeats, and `--once` / `--check-config`.
- **Contracts:** Pydantic models are the source; JSON Schemas are committed; shared fixtures; the TypeScript mirror is checked against them; CI fails on stale schemas.
- **Web:**
  - `POST /runs` returns 202 plus Idempotency-Key handling; budgets come from config;
  - cancel / accept / resume endpoints (idempotent, owner-scoped, CSRF-checked);
  - safe error-code messages; the UI polls with stage progress and actions.
  - The TypeScript execution path is removed.
- **Deployment:** `render.yaml` (Frankfurt; web plus Background Worker; secrets `sync: false`), `worker/Dockerfile` (non-root, locked, no dev tools).
- **Docs:** ADR-006, ADR-001 D6–D8 accepted, Render deploy runbook, run-operations runbook (SQL verified), README, worker README, data lifecycle.

**M1–M2** (still in place):
- patched dependencies;
- error contract, health/readiness;
- Supabase Auth magic links, owner scoping plus RLS (private schema, roles), CSRF, size and rate limits;
- fail-closed config.

## Known gaps before real users

| Gap | Milestone |
|---|---|
| Retention for rejected proposals and superseded versions; self-service account deletion; account-wide export | before pilot |
| Lexical memory recall (differently worded memories can be missed; goals, constraints and the decision are always included). The fake benchmark covers recall and abstention; real-world recall needs the live review. | live baseline |
| Lexical routing (wording-sensitive; the user can override; R07-type trivial choices route to medium) | revisit after the live baseline |
| Deterministic guards do not stop a model that obeys instructions injected into fetched pages (it still can't cite unsupplied sources or claim unearned confidence) | decision: passage quarantine (ADR-010) |
| Brave licensing confirmation; retention period for stored excerpts; privacy notice mention of Brave | before enabling research for real users |
| No PDF or JavaScript-rendered pages; lexical passage selection; no cross-run search cache | later |
| No live evaluation baseline yet; quality, cost and latency gates unset | before pilot (needs approval and a spend cap) |
| Privacy notice must mention OpenAI (data sent, retention) | before real users |
| A clarifying question from framing is shown as a limitation in the brief; there is no answer-and-continue round-trip yet | later |
| No alerting on worker heartbeats or stale runs (visibility only); no Playwright E2E in CI | M9 readiness |
| Hosted Supabase Auth rate limits and sign-up policy unverified; spend-ceiling values to confirm; Google Fonts loads from Google (self-host); no independent security review yet | before pilot / open sign-up ([review](docs/security/review-m8.md)) |
| The UI polls (1.5 s) rather than streaming. Time spent in a timed-out stage isn't added to `active_seconds_used`. | — |
| Custom SMTP, sign-up policy, hosted Auth settings | before pilot |

Dev-only advisories: `eslint-config-next@15`'s glob dependencies (lint-time only).
