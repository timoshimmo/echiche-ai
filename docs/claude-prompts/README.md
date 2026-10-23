# Echiche Claude Engineering Prompt Kit

This kit is designed for an engineer building Echiche alongside Claude Code (or Claude in a coding workspace). It is intentionally staged: **one prompt, one reviewable work unit, one verified result at a time**.

## Before starting
1. Put the project blueprint/PRD and concept note where Claude can read them. Do not rely on chat history as the only copy of requirements.
2. Keep the current repository as the starting point. The existing starter is a prototype scaffold, not a production-ready application.
3. Read `CLAUDE.md` in the repository root. Claude Code loads this project context automatically.
4. Open the repository in Claude Code. Use plan mode or explicitly request a plan-only first pass for Prompt 00.
5. Ask the engineer/product owner to approve the architecture decision before any major framework migration.

## Prompt operating loop
For each stage:
1. Paste the matching prompt from this folder.
2. Review the plan and trade-offs before implementation where the prompt requests approval.
3. Ask Claude to implement only that stage's acceptance criteria.
4. Require tests and actual command output.
5. Review the git diff, security/privacy implications and cost implications.
6. Merge/commit only after the human engineer accepts the result.
7. Update status/ADRs and move to the next stage.

Do not paste every staged prompt in one giant message. That makes scope harder to control and testing weaker.

## Recommended sequence
- `00-repository-audit-and-architecture.md` — first; audit current code and choose a language/service boundary consciously.
- `01-stabilize-the-foundation.md` — reproducible local setup, baseline tests and CI.
- `02-auth-tenancy-and-data-security.md` — authentication, ownership checks and database security before private customer data.
- `03-durable-run-orchestration.md` — async state machine, checkpoints, retries, cancellation, budgets and idempotency.
- `04-provider-adapter-and-prompt-registry.md` — real model integration with provider-neutral interfaces and versioned prompts.
- `05-research-evidence-and-verification.md` — source provenance, claim-to-source links, citations and verification.
- `06-memory-and-decision-journal.md` — visible, approved, versioned memory and durable decision continuity.
- `07-evaluation-and-adaptive-compute.md` — benchmark, quality/cost telemetry and simple complexity routing.
- `08-security-privacy-and-failure-testing.md` — adversarial and abuse-path review.
- `09-release-readiness-review.md` — evidence-based release gate and go/no-go report.
- `10-debug-and-repair.md` — use for bugs without allowing broad rewrites.
- `11-feature-request-template.md` — template for future scoped tasks.

## Runtime prompt templates
The `prompts/runtime/` directory contains draft product prompts for framing a decision, planning research, extracting claims, critique, verification, synthesis and memory proposals. These are **not magic system prompts**. Treat them as starting versions: give each a version ID, validate output against a schema, build representative test cases, and compare results against an agreed rubric before promotion.

## Critical rule for the current prototype
The scaffold includes a deterministic example flow. Do not describe it as AI-powered until a real provider adapter is implemented and tests demonstrate it. Do not expose it to customers as a production multi-user service until authentication, ownership enforcement, data security, durable jobs, budgets and release gates are addressed.
