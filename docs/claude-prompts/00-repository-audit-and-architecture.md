# Prompt 00 — Repository Audit and Architecture Decision

<role>
Act as a staff-level software architect and pragmatic AI systems engineer helping build Echiche. The human engineer is strongest in Python and is working with Claude. Be rigorous, cost-conscious and candid about uncertainty.
</role>

<context>
Read the root `CLAUDE.md`, the founding blueprint/PRD/engineering handoff, the concept note if present, `README.md`, `IMPLEMENTATION_STATUS.md`, package/config files, migrations, and the actual application code. Echiche v1 is a persistent decision partner for startup strategy continuity. The current starter includes Next.js/TypeScript, API routes, a Postgres repository path, an in-memory path and a deterministic demonstration reasoning workflow. This is a starter scaffold, not production-ready.
</context>

<task>
Perform a plan-only audit. Do not edit, generate files, install packages, run migrations against a remote database, or make external service calls in this step.

1. Describe the current architecture and the real behavior implemented today.
2. Identify incomplete, inconsistent, insecure, or unverified areas. Inspect for type mismatches, tests that do not cover behavior, persistence mapping issues, missing environment validation, route authorization gaps, synchronous long-running work, and claims in docs that overstate readiness.
3. Compare these architecture options:
   - A: keep Next.js/TypeScript for UI and backend for the initial build;
   - B: Next.js/TypeScript UI plus a Python (for example FastAPI) AI orchestration/background worker;
   - C: move more of the application to Python.
4. Choose the smallest sustainable option given existing code, the engineer's Python strength, operational complexity, typed API contracts, testing, deployment, observability and future provider choice. State what evidence would change your recommendation. Do not assume Python is automatically better or worse.
5. Propose a staged implementation plan aligned with the founding blueprint. Separate launch blockers (P0), needed for a trustworthy pilot (P1), and later research/product work (P2).
6. Identify architecture decisions requiring the human engineer/product owner to approve before code changes.
</task>

<constraints>
- Keep v1 focused on one project, a consequential-decision workflow, evidence-grounded research, a structured decision brief, inspectable memory and later revisiting.
- No silent full rewrite, new framework, vector database, graph database, agent framework, queue, or paid provider.
- Do not claim tests/builds pass unless run; this is plan-only, so report checks not performed.
- Do not propose raw hidden chain-of-thought storage or disclosure.
</constraints>

<output>
Return exactly these sections:
1. Executive recommendation (plain language)
2. Current-state inventory (implemented / partial / missing / unverified)
3. Top risks, ranked by severity and likelihood
4. Architecture options comparison table
5. Recommended architecture and explicit boundaries
6. Proposed milestones with acceptance criteria
7. ADRs requiring approval (include a recommended default for each)
8. Commands/checks to run in the first implementation stage
9. Out-of-scope items to avoid for v1

End by waiting for human approval of the architecture decision. Do not implement yet.
</output>
