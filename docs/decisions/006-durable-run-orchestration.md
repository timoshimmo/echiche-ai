# ADR-006: Durable run orchestration

- Status: **Accepted** (2026-10-26). Design shared with the decision owner before implementation. ADR-001 D6–D8 accepted the same day.
- Date: 2026-10-26
- Decision owner: Tokmang
- Related: blueprint §3.1 (run states), RUN-01/02/03, §8.4; ADR-001 (D2 polling worker, D6 cancellation, D7 logs, D8 E2E CI); ADR-003; ADR-005

## Decision

### State machine (migration 0004)
`queued → planning → researching → critiquing → verifying → synthesizing → awaiting_user_review → completed`, plus `failed`, `cancelled` and `paused_for_budget`. A `BEFORE UPDATE` trigger enforces the allowed transitions **per role**; operators (postgres) are exempt for repairs.

| Role | May do |
|---|---|
| `echiche_end_user` (web, per user) | cancel a `queued`/`paused_for_budget` run; request cancellation of an active run, once, never cleared; accept `awaiting_user_review → completed`; resume `paused_for_budget → queued`, raising budget caps only upwards and only in that transition |
| `echiche_worker` | move active stages forward only; release a run to `queued`; end with `awaiting_user_review` (from `synthesizing`), `failed`, `cancelled` or `paused_for_budget`. It cannot touch settled runs except to drop a lease. |

The trigger also maintains `updated_at`, and `completed_at` on terminal transitions. Column grants stop the web role writing results, usage or leases, and stop the worker editing prompts, owners or budgets.

### Execution model
- **Starting a run:** the web app inserts a `queued` run and answers **202** (`Location: /api/runs/:id`). An optional `Idempotency-Key` header makes retries safe: the key is unique per owner, a same-body replay returns 200, and a different body returns 409.
- **Claiming:**
  - The worker claims with `FOR UPDATE SKIP LOCKED`. Any run with a **live lease** is excluded whatever its status; this exclusion fixed a double-claim race found in testing.
  - The lease (`WORKER_LEASE_SECONDS`, default 60) is renewed by a keeper thread on its own connection while a stage runs.
  - An expired lease makes the run reclaimable, with `attempt + 1`.
- **Checkpoints:**
  - Each stage's output goes to `run_stage_outputs`, with primary key (run, stage), **in the same transaction** as the usage counters and the stage event.
  - Every worker write is guarded by `claimed_by = me AND lease_expires_at > now()`. A worker that lost its lease writes nothing.
  - A resumed run skips its checkpointed stages.
- **Failure policy (stable `error_code`):**

  | Situation | Outcome |
  |---|---|
  | Transient provider error | Up to 3 tries with full-jitter backoff within the claim. Then back to the queue with exponential delay (`available_at`), or `failed` once `max_attempts` (3) is used. |
  | Invalid output or permanent provider error | `failed` immediately, no retry |
  | Composed result breaks its contract | `RESULT_INVALID` |
  | Bad checkpoint | `CHECKPOINT_INVALID` |
  | Claims beyond max attempts | `RUN_RETRIES_EXHAUSTED` |
  | Anything unexpected | `INTERNAL_ERROR`. A run is never left active by a handled error. |

- **Cancellation (D6):** checked before every stage. The current stage finishes, then the run becomes `cancelled`, never `completed`.
- **Budgets:**
  - Caps on steps (18), active processing time (600 s), research calls (8) and estimated spend ($0.50), set from server config (`RUN_BUDGET_*`).
  - Checked before every stage; hitting one sets `paused_for_budget` with a `BUDGET_*` code.
  - Only the user's explicit **resume** raises caps, by half the initial budget each time. Nothing is raised automatically.
- **Timeouts:** each stage has a deadline of `min(WORKER_STAGE_TIMEOUT_SECONDS, remaining time budget)`. Overrunning it counts as a transient timeout.
- **Graceful shutdown:** on SIGTERM the worker stops claiming. The current stage completes, then the run is released without consuming an attempt (`WORKER_SHUTDOWN`). Render's `maxShutdownDelaySeconds` (120) exceeds the stage timeout (90).
- **Operations:**
  - `worker_heartbeats` (upserted every lease/3).
  - `echiche.ops_run_health` view: `lease_expired`, `queued_too_long`.
  - Shared JSON log fields (D7).

### Contracts
The result (`reasoning-scaffold.v1`) and checkpoint (`stage-output.v1`) models are Pydantic. JSON Schemas are committed in `contracts/`. TypeScript validates stored results with a Zod mirror, which a test proves agrees with the generated schema on shared fixtures. CI fails if a schema is stale.

### Removed
TypeScript run execution (`run-service.ts`). Only the worker runs reasoning.

## Not chosen
- **LangGraph / Temporal / a managed queue:** our workflow is linear with checkpoint-per-stage. Postgres already gives transactional checkpoints, leases and auditability, so a framework adds a dependency without a concrete branching or human-in-the-loop need (blueprint §4.3).
- **Migrations in Render's pre-deploy step:** that would place admin database credentials in the web service's environment. Migrations are an explicit operator step instead (runbook).

## Consequences
- **Positive:** runs survive crashes, deploys and provider blips without duplicate writes. Every transition is enforced in the database. Run creation returns at once.
- **Negative:**
  - The UI polls (1.5 s) rather than streams.
  - The deterministic stages finish in milliseconds, so the lease, timeout and budget paths are exercised mainly by tests until M4 adds a real provider.
  - Time spent in a timed-out stage isn't counted in `active_seconds_used`.
- **Tested:** see `worker/tests/test_worker_integration.py` and `src/lib/server/postgres-repository.integration.test.ts` (including the cross-language E2E).

## Revisit trigger
- Real workflows need branching, parallel stages or long human waits mid-run.
- Queue depth or claim contention becomes measurable.
- Polling cost or latency matters (consider SSE).
