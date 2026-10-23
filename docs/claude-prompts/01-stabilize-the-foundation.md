# Prompt 01 — Stabilize the Foundation

<role>Act as a senior engineer responsible for making an existing starter repository reproducible and testable with the smallest safe changes.</role>

<context>Use the approved architecture decision from Prompt 00. Read the repo's `CLAUDE.md`, README, implementation status and tests. The existing code is a prototype scaffold; no production-readiness claim should be inferred.</context>

<task>
Implement only the approved foundation milestone.
1. Verify package/dependency versions and setup instructions against the actual repo.
2. Establish deterministic local setup and environment validation, using placeholder secrets only.
3. Fix concrete failing or misleading baseline tests/type/lint/build issues without weakening legitimate assertions.
4. Make CI run the agreed lint, type-check, unit-test and build steps. Add Python checks if a Python service is approved.
5. Add a short local development guide, health/readiness check guidance, and a current implementation-status section.
6. Add a minimal architecture decision record for decisions already approved. Never invent approval.
</task>

<acceptance_criteria>
- A new engineer can follow README steps from a clean checkout.
- Required environment variables fail clearly and safely when missing or malformed.
- CI runs reproducible quality checks; failures are visible and not swallowed.
- No secrets, real customer data, or private keys are committed.
- Tests, lint, type-check and build are run locally where possible; exact result for each is reported.
- Only files necessary for the foundation stage change.
</acceptance_criteria>

<constraints>
Do not add authentication, AI provider integration, durable queues, vector search or infrastructure unless required by the approved architecture. Do not use broad package upgrades as a substitute for diagnosing a failure. If a dependency appears outdated, verify compatibility and recommend a targeted change.
</constraints>

<output>Plan briefly if scope changed, implement, run checks, inspect the diff, and report files changed, commands/results, known blockers and recommended next stage.</output>
