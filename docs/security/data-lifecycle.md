# Data lifecycle: what is stored, export, deletion, retention

_Status as of M6 (2026-10-28). Items marked **open** need a decision before the paid pilot (blueprint §8.2)._

## What Echiche stores

| Data | Where | Contains user content? |
|---|---|---|
| Account (email, auth metadata, sessions) | Supabase Auth (`auth` schema) | Email address |
| Projects (title, problem statement, archived flag) | `echiche.projects` | **Yes**, potentially confidential strategy |
| Thought runs (prompt, structured result, status) | `echiche.thought_runs` | **Yes** |
| Run events (stage names and fixed status messages) | `echiche.run_events` | No (fixed strings today) |
| Stage checkpoints (intermediate stage outputs) | `echiche.run_stage_outputs` | **Yes**: derived from the prompt; deleted with the run |
| Stage checkpoints from the model (frame, critique, brief as structured data) | `echiche.run_stage_outputs` (`stage-output.v2`) | **Yes**: model output derived from the prompt; deleted with the run |
| Model-call telemetry (tokens, cost, latency, prompt id/version/hash, outcome) | `echiche.model_calls` | No: never prompts, inputs or outputs; deleted with the run |
| Sources the worker read (URL, title, publisher, dates, hash, ≤3 short passages, the search query that found it) | `echiche.sources` | **Yes**: the query is derived from the user's question; passages are third-party text; deleted with the run |
| Claims and their quote links, verdicts and notes | `echiche.claims`, `echiche.claim_sources` | Derived from sources and the question; deleted with the run |
| Research telemetry (search/fetch outcome, status, domain, bytes, cost, latency) | `echiche.research_calls` | No: no query text, no content; deleted with the run |
| Memories (proposed, active, superseded, rejected versions), with provenance | `echiche.memories` | **Yes**: statements about the user's project; proposals are kept only as proposals until reviewed |
| Decision versions and outcomes | `echiche.decisions`, `echiche.decision_outcomes` | **Yes** |
| What each run was given from memory (snapshot) | `echiche.run_memory_context` | **Yes**: copies of remembered items; deleted with the run or the memory |
| Worker liveness (worker ID, version, current run ID) | `echiche.worker_heartbeats` | No |
| Application logs | hosting platform stdout | No: route, event, error code, IDs only (enforced in `log.ts` conventions and tests) |
| Supabase Auth logs | Supabase | Email, IP and user agent (provider-side) |

Every Echiche row carries `owner_user_id`. Only that user can read it (ADR-004).

## Archive vs delete
**Archiving** a project hides it from the default list and blocks new runs. It is **not deletion**; the data remains.

## Deletion
- **In the app (M6, ADR-009), all hard deletes:**
  - **Memory:** deleting one removes every version of it.
  - **Project:** deleting one removes it and everything under it: runs, events, checkpoints, telemetry, sources, claims, memories, decisions, outcomes and memory snapshots. Integration tests check that no dependent row is left.
  - **Runs and events** cannot be deleted individually.
- **Account deletion (operator-run):** deleting the user in Supabase Auth (dashboard, or the Admin API with the service-role key, which the app never uses) removes `auth.users`, which cascades to **all** of their data. Self-service account deletion in the app is **not yet** available.
- **Backups:** deleted rows persist in Supabase backups until those backups expire. **Open:** confirm the backup retention window for the chosen plan and state it in the privacy notice.

## Export (EXPORT-01)
**In the app (M6):** "Export project data" downloads `echiche-export.v1` JSON, generated on request and never cached or stored. It contains:
- the project;
- every run: prompt, status, result, usage, events, remembered context, sources with their stored passages, and claims;
- a model-call summary;
- every memory version;
- every decision version with its outcomes.

Stage checkpoints and per-call telemetry rows are summarised. An account-wide export is an operator task for now (SQL filtered by `owner_user_id`).

## Retention (open)
No automatic expiry exists yet. Decide before the pilot:
- retention for inactive accounts;
- retention for archived projects;
- whether rejected proposals and superseded memory or decision versions expire (today they stay until the user deletes them);
- log retention on the hosting platform and in Supabase;
- what the privacy notice promises.

## Model provider (M4, ADR-007)
With `REASONING_PROVIDER=openai`, the worker sends the project title, the problem statement, the run's question, and the model's own earlier outputs for that run to OpenAI. As verified on 2026-10-26 in OpenAI's API data-controls documentation:
- API data is not used for training by default.
- Abuse-monitoring logs are retained for up to 30 days.
- Calls use `store=false`, so no Responses application state is kept.

Endpoint: `global` by default. The EU data-residency endpoint requires OpenAI's approval (ADR-007 D11).

**Open:** add this to the privacy notice before real users. Decide whether to apply for Zero Data Retention.

In demo mode nothing leaves Echiche's infrastructure (Render, Supabase).

## Research provider and web fetching (M5, ADR-008)
With `RESEARCH_PROVIDER=brave`, the worker sends search queries written by the model from the user's decision frame to Brave Search. It then fetches public web pages directly, identifying itself as `EchicheResearchBot`.
- **Kept from Brave:** nothing; results are used once to find pages.
- **Kept from publisher pages:** short passages, kept only when robots.txt and the page's `noarchive`/`noai` directives allow it.

**Open before real users:**
- Brave's written confirmation of the permitted use on the chosen plan.
- The retention period for stored excerpts.
- A privacy-notice line saying that queries derived from the user's question are sent to Brave.
