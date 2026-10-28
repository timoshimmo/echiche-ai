# M9 release-readiness review: first design-partner pilot

- **Date:** 2026-10-28, 17:27 WAT (16:27 UTC)
- **Commit reviewed:** `c6e7eb5` (M8)
- **Reviewer:** Claude. This is a read-only assessment: nothing was deployed, and no code was changed during it.
- **Environment:** local Linux. Node 22.22.0, PostgreSQL 16.15, Python 3.12.3, uv 0.11.32, Chromium (Playwright).
- **Not available here:** GitHub Actions (the repository has **no git remote**, so CI has never run on GitHub), Docker, hosted Supabase or Render, OpenAI and Brave keys.

**Labels:**
- **PASS** means a command or test was run here and its result observed.
- **NOT VERIFIED** means the evidence would require something unavailable here. It is never upgraded because code exists.
- **PARTIAL** means part is evidenced and part is missing.
- **FAIL** means checked, and the requirement is not met.

## Status update (2026-10-28, 18:45 WAT)
| P0 | Status |
|---|---|
| P0-1 privacy notice, terms, support | **Drafted.** `/privacy` and `/terms` are public pages with a "draft for legal review" banner. Support contact `info@echiche-ai.com` · `+234 805 752 7307` appears on every page. **Still open:** legal review, plus the bracketed items: legal entity and address, legal bases, transfer safeguards, backup and log retention, response time. Then set `LEGAL.status = "final"` in `src/lib/domain/site.ts`. |
| P0-3 user-visible limitations and copy | **Done.** New hero copy; the workflow strip shows the 5 stages plus a quick-run note; a pilot and "not professional advice" notice with legal and support links is on every page, including login. Unit-tested; rendered and checked at desktop width and 390 px. |
| P0-6 spend ceilings | **Set:** $2 per user and $15 overall per rolling 24 hours (ADR-011 accepted). The defaults, `render.yaml` and `.env.example` all carry these values. Sign-up policy, Auth rate limits and backups remain to do in staging. |
| P0-7 incident plan | Owner to be named by Tokmang. |
| P0-4 CI and staging | Waiting on the GitHub connection and the staging accounts. |
| P0-2, P0-5, P0-8 | Unchanged. |

## 1. Recommendation: **NO-GO today; CONDITIONAL GO** for a small invited pilot once the 8 P0s in §3 are closed

The engineering core is in good shape and well evidenced:
- tenant isolation, durable runs, budgets, provenance, memory controls, abuse limits and the security fixes;
- every local gate is green from a clean clone.

The release is blocked by what surrounds that core:
- **No privacy notice, terms or support channel exists**, for a product that holds confidential plans and sends them to OpenAI (and, with research on, queries to Brave).
- **The UI cannot reopen past runs.** After a reload, a brief, its sources and any run paused for budget can no longer be reached in the UI, so a paused run can't be resumed there. "Resume a decision project" is the core journey.
- **Nothing has run against a hosted environment, CI, or the real model.** The quality of model-written briefs is entirely unmeasured.
- **No incident plan** exists for a suspected data exposure.

**Narrowest defensible pilot scope** (after the P0s):
- **Cohort:** 3–5 invited design partners who are told it is an early pilot, with sign-up disabled.
- **Model:** the live model on the default `gpt-6.1-sol`; **escalation off** (`OPENAI_ESCALATION_MODEL` unset).
- **Research:** off, unless Brave's written licensing confirmation (ADR-008) is in hand. Without it, briefs say clearly that they are unresearched.
- **Spend ceilings:** low, for example `USER_DAILY_SPEND_LIMIT_USD=2` and `GLOBAL_DAILY_SPEND_LIMIT_USD=15`.
- **Excluded:** document upload (not built), team use, and regulated or high-stakes domains, with the disclaimer shown in the UI.

## 2. Acceptance-criteria evidence matrix

### v1 functional requirements (blueprint §3)
| ID | Requirement | Status | Evidence / gap |
|---|---|---|---|
| AUTH-01 | Protected routes reject unauthenticated requests; logout invalidates the session | **PARTIAL** | PASS: the access matrix shows all 28 handlers, private ones return 401 (`access-matrix.test.ts`, in the 104 unit tests); middleware redirects pages. **NOT VERIFIED** against real Supabase Auth: logout revocation was shown against a local stand-in (M3 smoke), and the CI `supabase-stack` job that checks the real Auth server has never run. |
| AUTH-02 | Another user's project, run or memory is denied server-side | **PASS** | Access matrix: a byte-identical 404, nothing changed, the probe audited, on every handler with an ID. RLS suite as the runtime role (allowed and denied SELECT/INSERT/UPDATE/DELETE). Re-run on the Supabase-like non-superuser cluster (M8). No file feature exists. |
| PROJ-01 | Create/read/update/archive; owner from the session | **PARTIAL** | PASS at the API (route and RLS tests: rename, archive and unarchive, owner smuggling ignored). **FAIL in the UI:** there is no rename or archive control, only create, select and delete. |
| RUN-01 | Run ID, status, timestamps and budget persisted; UI shows the states | **PARTIAL** | PASS: persistence and status tests (M3); the UI shows stage progress and status for a run started in this page session. **FAIL:** the UI cannot list or reopen earlier runs (P0-2). |
| RUN-02 | Checkpoints; retry doesn't duplicate decisions or memory | **PASS** | Crash-resume without duplicates (M3, M5); 5 concurrent accepts record one decision; a retried proposal insert is a no-op (M8). Residual: client retries of POST memory and outcome can duplicate (M8 F9, accepted). |
| RUN-03 | Budgets pause or ask; never silently exceed | **PASS** | Steps, time, research and cost pauses; worst-case preflight before each model call; explicit resume (M3/M4 integration). Daily spend ceilings (M8; HTTP smoke `SPEND_LIMIT_REACHED`). Live spend is **NOT VERIFIED** (no real call made). |
| RES-01 | Source URL, title, retrieval time, excerpt | **PASS** (local) / **NOT VERIFIED** (live) | Research integration over a local TLS site and the cross-language E2E (M5). A live Brave search was never run, and Brave licensing for excerpt storage is unconfirmed. |
| RES-02 | Citations map to stored sources; invalid references fail | **PASS** | Citation guard plus repair; E2E: every citation resolves to a stored, verified quote; fake benchmark: 0 invented or unsupported citations in C/R (gates in CI). |
| MEM-01 | Proposals need confirmation | **PASS** | Worker writes proposals only (DB guards); approval required, with an extra confirmation for sensitive ones (M6 tests). |
| MEM-02 | Correction supersedes; deletion cleans indexes | **PASS** | Versioned correction with history; lineage hard delete (M6). No search or vector index exists. Catalog test: every table cascades from the account (M8). |
| DEC-01 | Revisions add versions; rationale auditable | **PASS** | Revision adds v2 and keeps v1; outcomes are append-only (M6 Postgres tests). |
| SAFE-01 | No external write without authorization | **PASS** | No external-write capability exists. Code review: the worker's outbound calls are model inference and HTTP GETs (search, page fetch) only. The model cannot choose URLs or tools. |
| OBS-01 | Telemetry: run, stage, provider, model, latency, usage, retries, error; no secrets | **PASS** (local) | `model_calls` rows: tokens, cost, latency, prompt version and hash, repair flag, error code (M4 tests); structured logs without content (M8 review). Dashboards and p50/p95 views don't exist (see ops). |
| TEST-01 | Lint, typecheck, unit, integration, authorization, build in CI | **PARTIAL** | All pass **locally** from a clean clone (§6). `.github/workflows/ci.yml` defines them, but CI has **never run** (no remote). There is no browser (Playwright) E2E. |
| EXPORT-01 | Machine-readable export | **PASS** | `echiche-export.v1` attachment, owner only (M6 tests); export rate limit (M8). |

### Areas Prompt 09 asks about
| Area | Status | Evidence / gap |
|---|---|---|
| Real model provider and prompt-version tracking | Tracking **PASS**; provider **NOT VERIFIED** | Registry versions and hashes are recorded per call and shown in the UI (M4 tests, scripted model). No live OpenAI call has ever been made; the opt-in smoke test is unrun. The model ID and price come from M4's dated price table. |
| Decision brief schema and uncertainty labels | **PASS** (contract) / **NOT VERIFIED** (live quality) | `decision-brief.v1` covers every §2.6 section, with epistemic labels and calibrated confidence, enforced by Pydantic, a Zod mirror and confidence guards. Real briefs have never been reviewed (blueprint gate: 20 manual reviews). |
| Reproducibility: tests, lint, types, build, migrations | **PASS** | §6: clean clone, 9 migrations from empty, then a no-op re-run; upgrading a populated M7 database applied only 0009 and kept all data (M8). |
| Privacy notice, retention, deletion behaviour | **FAIL** | No privacy notice, terms or support channel. Deletion behaviour PASS (hard delete, export, cascades); `data-lifecycle.md` documents storage and deletion, but retention periods are **undecided**. |
| Backups and restore | **PARTIAL** | Local `pg_dump` → `pg_restore` drill: security configuration identical, full suites pass on the copy (M8). Hosted backups (enabled? PITR?) and a hosted restore are **NOT VERIFIED**. |
| Cost and latency visibility | **PARTIAL** | Per-run cost, tokens and calls in the UI; SQL runbooks for spend and the ledger; per-call latency recorded. No dashboard, no p50/p95 view, no live numbers. |
| Rate limits | **PASS** (app) / **NOT VERIFIED** (hosted Auth) | Ledger-based limits and spend ceilings (M8 tests and HTTP smoke). Supabase Auth email limits and the sign-up policy in the hosted dashboard are unverified. |
| Alerting | **FAIL** | Visibility only (heartbeat table, `ops_run_health` view, log events). Nothing alerts on a dead worker, stale runs, a spend spike or a provider outage. |
| Basic runbooks | **PARTIAL** | Present: deploy, rollback (app only), Supabase setup, run operations (stuck runs, spend, research, memory, routing, abuse, audit, backup drill), evaluation. Missing from blueprint §13.3: model-provider outage, search outage or terms change, suspected cross-user exposure, bad migration or data corruption, prompt injection, deletion or export failure. No incident severity, owner or communication plan. |
| UI clarity: incomplete features, model vs deterministic output | **PARTIAL** | PASS: every result is labelled "Demo mode · deterministic scaffold, no AI model" or "Live model (provider · model)"; quick runs show skipped stages and a limitation; brief limitations are always shown. FAIL: the hero still reads "FOUNDING BUILD · 0.1.0 … This first slice proves the … scaffold flow"; the workflow strip shows 3 stages, but runs have 5; there is no "not professional advice" notice (blueprint §8.3), no pilot notice, and no link to privacy or support. |
| Security (no unresolved critical/high) | **PASS** (self-review) | M8: the High finding (F1) is fixed with regression tests; all 12 mutation checks caught. **Self-review, not independent.** |
| ADRs | **PARTIAL** | 001–009 Accepted. 010 (routing and evaluation) and 011 (ledger and ceilings) are **Proposed**: the ceiling values and the escalation choice need the owner. |

### Release gates (blueprint §9.4)
| Gate | Status |
|---|---|
| All P0 acceptance criteria pass **in staging** | **NOT VERIFIED**: no staging exists. Locally: see the matrix (two PARTIALs from UI gaps). |
| CI passes lint, typecheck, unit, integration, **E2E** and build | **PARTIAL**: local only; CI never run; no browser E2E. |
| Authorization and RLS tests, allowed and denied | **PASS** |
| No unresolved critical/high; no secrets in the repository or bundle | **PASS** (self-review) |
| Evaluation report with versions, scores, costs, failure modes | **PARTIAL**: the fake-mode report is versioned (ADR-010); there is no live report. |
| Manual review of ≥20 briefs before a broader pilot | **FAIL**: 0 reviewed (P1 for broader, but see P0-5 for the small pilot). |
| Backup restore, cancellation, retry, provider-outage procedures tested | **PARTIAL**: cancellation, retry and outage behaviour tested in code; restore drilled locally only; no provider-outage runbook. |
| Privacy notice, terms, support channel, deletion procedure | **FAIL**: only the deletion procedure exists. |

## 3. P0 release blockers (before any invited user enters real data)
| # | Blocker | Why | Proposed owner |
|---|---|---|---|
| P0-1 | **Privacy notice, terms and a support contact**, linked from the login page and the app. The notice names OpenAI (and Brave, if research is on), what is stored, the retention periods (decide them: see `data-lifecycle.md`), the deletion and export path, and the pseudonymous logs. | Blueprint §8.2 and the §9.4 gate. The product holds confidential plans and processes them with third parties. | Tokmang (content; legal review recommended); engineering (pages and links) |
| P0-2 | **Run history in the UI.** List a project's runs (the API exists), reopen any brief with its sources and memory context, and resume a run paused for budget after a reload. Fix the misleading "refresh to try again" message. | Core journey (PRD §2.4 P0 "Persistent history"). Today results and paused runs become unreachable in the UI. | Engineering |
| P0-3 | **User-visible limitations and copy.** Remove the stale "0.1.0 / scaffold" hero, show the real 5 stages, add a pilot notice and "decision support, not professional advice" (§8.3), and link privacy and support. | Prompt 09 criterion: "known limitations are user-visible". | Engineering (copy approved by Tokmang) |
| P0-4 | **First green CI run and a staging deploy.** Push to GitHub and get all four CI jobs green (including `supabase-stack` and the Docker build). Then deploy to a **staging** Supabase and Render pair from that commit, apply 0001–0009, and run the render-deploy smoke test: login, logout revocation, project, run, memory correction, export and delete. | Nothing hosted has ever been verified: Auth, pooler roles, the image, the CSP behind TLS. | Tokmang (accounts and secrets); engineering (fixes) |
| P0-5 | **Live model smoke and internal brief review in staging.** Run the opt-in live OpenAI test, then ≥10 internal runs across quick, standard and deep. Review each brief with the evaluation runbook's sheet, and record the actual cost and latency per tier. | Real output quality and cost are unmeasured. Partners should not see the first-ever real briefs. | Tokmang (key, spend approval, reviewer); engineering |
| P0-6 | **Hosted security settings.** Disable sign-up (invite-only); set Auth email rate limits; set the spend ceilings (ADR-011: accept or change the values); keep escalation off; confirm automated backups (PITR or daily) are enabled. | M8 follow-ups; cost and availability protection. | Tokmang |
| P0-7 | **Minimal incident plan.** Severity levels, owner and contact, what to do on a suspected cross-user exposure (disable sign-in, preserve logs, notify affected users per the privacy notice), on a spend spike (lower the ceilings, set `REASONING_PROVIDER=deterministic`), and on a provider outage. | Blueprint §8.4 and §13.3. There is no plan today for the worst case with private data. | Tokmang (owner); engineering (runbook) |
| P0-8 | **Research decision.** Either obtain Brave's written confirmation (ADR-008) and enable research, or pilot with `RESEARCH_PROVIDER=none`, with the UI and the notice saying briefs are unresearched. | Licensing for stored excerpts is unconfirmed. | Tokmang |

## 4. P1: before a broader pilot (more than 5 partners, or paid)
1. **Monitoring:** alerting on worker heartbeats, stale or queued run age, the failure rate per stage, spend against the ceilings, and provider errors. Also p50/p95 latency and cost-per-run views (blueprint §13.2).
2. **Testing and evaluation:**
   - browser E2E (Playwright) in CI for the main journey, including the CSP check;
   - the live evaluation baseline plus ≥20 human-reviewed briefs (ADR-010), with quality, cost and latency gates set from the results (`gates.v2`).
3. **Recovery and runbooks:** a hosted restore drill (runbook §Backup and restore); the remaining §13.3 runbooks; a tested rollback across a migration.
4. **Security and privacy:** an independent security review; self-hosted fonts (M8 F10); retention periods implemented, with self-service account deletion.
5. **Product:**
   - project rename and archive controls in the UI;
   - an Idempotency-Key for memory and outcome posts (M8 F9);
   - accepting ADR-010 and ADR-011.

## 5. Accepted limitations for a small invited test (stated to partners)
- **Text only:** no document upload, PDFs or JavaScript-rendered pages; English is the assumed language.
- **Wording-sensitive matching:** routing and memory recall are lexical. Users can pick a depth themselves, and goals, constraints and the current decision are always recalled.
- **Prompt injection:** fencing and guards reduce it but can't eliminate it. A model may echo injected page text; it cannot cite unsupplied sources or claim unearned confidence.
- **Spend reservations over-count:** heavy users may hit the daily ceiling early.
- **The UI polls** rather than streaming. A clarifying question from framing appears as a limitation, without an answer-and-continue round trip.
- **Retried "add memory" or "add outcome" requests can duplicate;** the user can delete the extra item.
- **Single user per account:** no team workspaces.

## 6. Commands and results
Run from a clean clone of `c6e7eb5`, local Linux, 2026-10-28 (UTC):

| Time (UTC) | Command | Result |
|---|---|---|
| 16:27:25 | `npm ci` | exit 0 |
| 16:27:29 | typecheck (`tsc --noEmit`) | exit 0 |
| 16:27:33 | `npm run lint` | exit 0 |
| 16:27:36 | `npm test` | 104 passed |
| 16:28:01 | `npm run build` · client-bundle scan · `scan-secrets` | exit 0 · clean · 224 files, none |
| 16:28:02 | `npm audit` (including dev) | 0 vulnerabilities |
| 16:28:03 | `uv sync --locked` · ruff · ruff format · pyright strict · `contracts --check` | exit 0 · pass · pass · 0 errors · exit 0 |
| 16:28:34 | `uv run pytest` (worker unit) | 165 passed |
| 16:28:37 | `uv run python -m evals.run` (fake) | all invariant gates pass |
| 16:28:54 | Postgres had stopped (environment restart). The first database steps errored (connection refused); restarted and re-run: | |
| 16:28:55 | `npm run test:db:prepare` from empty, then re-run | 9 migrations applied · no-op |
| 16:29:05 | `npm run test:integration` (repository, RLS, abuse limits, deletion, cross-language E2E) | 54 passed |
| 16:29:12 | `uv run pytest -m integration` | 48 passed |

Earlier milestone evidence used in this review:
- M8 (2026-10-28): the production-mode HTTP smoke test, the CSP and framing check in Chromium, the backup and restore drill, the Supabase-like cluster runs and the 12 mutation checks ([review](../security/review-m8.md)).
- M7: the fake evaluation report.

Raw log: kept with the review artifacts, not committed.

## 7. Rollback and incident-plan gaps
- **Rollback, application:** Render's rollback is documented. **Database:** forward-only by design, but no corrective-migration procedure has been rehearsed, and migrations must stay compatible with the previous release. There is no record of which commit is deployed (the blueprint asks to "record release version").
- **Kill switches exist but are undocumented as incident steps:** `REASONING_PROVIDER=deterministic`, `RESEARCH_PROVIDER=none`, lowering the spend ceilings, and disabling sign-in in Supabase. Switching the provider mid-run fails in-flight runs with `REASONING_MODE_MISMATCH`; that's safe but not explained to users.
- **Process gaps:**
  - no incident severity scale, owner, on-call or communication channel;
  - no breach-notification procedure;
  - no status page or user contact path (see P0-1);
  - log retention on Render unknown;
  - no alerting (§2), so an incident is noticed only if someone looks.

## 8. Exact next actions
1. **Tokmang:**
   - draft the privacy notice, terms and support contact (P0-1);
   - choose the research option (P0-8);
   - accept or set the ceilings and keep escalation off (P0-6);
   - name the incident owner (P0-7).
2. **Engineering, next milestone and in parallel with step 1:**
   - P0-2 run history UI, P0-3 UI copy and disclaimers, plus privacy and support pages once the content exists;
   - the P0-7 incident runbook;
   - tests, including a Playwright check of the history flow if E2E is added.
3. **Tokmang:** create the GitHub remote and push, then create the staging Supabase and Render pair (P0-4); engineering fixes whatever CI or staging turns up.
4. **Tokmang + engineering, in staging:**
   - the live OpenAI smoke test, then ≥10 internally reviewed briefs with cost and latency recorded (P0-5);
   - confirm backups and the hosted Auth settings (P0-6).
5. **Re-run this review** against staging. Go if every P0 is closed with evidence; then invite 3–5 partners with the §1 scope.

Deployment has **not** been performed and is not implied by this document.
