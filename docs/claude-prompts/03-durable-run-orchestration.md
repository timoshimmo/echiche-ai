# Prompt 03 — Durable Run Orchestration

<role>Act as a senior distributed-systems engineer implementing recoverable long-running workflows.</role>

<context>Echiche's reasoning can take minutes and must not depend on a single HTTP request. Follow the founding blueprint state machine: queued → planning → researching → critiquing → verifying → synthesizing → awaiting_user_review → completed. Active runs may also become failed, cancelled or paused_for_budget. The approved architecture determines queue/worker technology.</context>

<task>
Implement the smallest durable run lifecycle that fits the approved architecture:
1. API creates a run, persists run ID/status/timestamps/budget and returns promptly (normally HTTP 202 or an equivalent accepted response).
2. A worker owns execution. Persist stage transitions and safe run events.
3. Checkpoint after meaningful stages so a worker restart or provider timeout does not require starting from scratch.
4. Add bounded retries with backoff for transient failures; do not endlessly retry invalid output or permanent errors.
5. Make run creation and stage writes idempotent. A retried stage must not duplicate a decision, source, event or memory proposal.
6. Implement cancellation and enforce budgets for steps, research calls, wall time and spend estimates where usage data exists.
7. Represent pause/failure/cancel outcomes with stable error codes and a safe user-visible explanation.
8. Add stale-run and worker-health visibility sufficient for basic operations.
</task>

<acceptance_criteria>
- API returns run identifier/status without waiting for the entire reasoning workflow.
- State transitions are validated server-side; invalid transitions are rejected.
- Restart/duplicate-delivery tests demonstrate checkpoint recovery without duplicate writes.
- Cancellation is checked between stages and does not report false success.
- Budget exhaustion pauses/stops safely and never silently increases caps.
- Provider timeout, malformed output and worker crash are covered by tests.
- UI can distinguish queued, active stage, completed, failed, cancelled and budget-paused states.
</acceptance_criteria>

<constraints>
Do not introduce LangGraph or another orchestration framework unless the approved ADR and a concrete checkpoint/branching need justify it. Avoid distributed locks or additional services if a simpler durable queue fits. Never keep an entire long-running job inside a browser request.
</constraints>

<output>Report the state machine, persistence/checkpoint design, idempotency key strategy, failure policy, test matrix, commands/results, operational runbook gaps and estimated cost drivers.</output>
