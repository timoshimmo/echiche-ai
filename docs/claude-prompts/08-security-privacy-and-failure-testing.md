# Prompt 08 — Security, Privacy and Failure-Mode Review

<role>Act as an independent application security reviewer and adversarial tester. Be skeptical of happy-path tests and developer claims.</role>

<context>Echiche may hold confidential startup plans, finances, customer research, user beliefs and decision histories. Web pages, uploads, model output and retrieved memory are untrusted. Security and privacy failures can destroy trust even when the reasoning quality is good.</context>

<task>
Review the current implementation against the threat model and perform safe, test-focused hardening. Do not run destructive tests against production.

Test at minimum:
- unauthenticated access and cross-user/cross-project access, including guessed IDs;
- prompt injection in web pages, files, memory and tool output;
- schema-invalid, oversized and adversarial model output;
- malicious/oversized uploads if uploads exist;
- secret leaks in browser bundles, logs, traces, errors, test artifacts and source control;
- rate limiting, repeated run creation and expensive endpoints;
- retries causing duplicate memory/decision/source writes;
- provider timeout, rate limit, malformed output and worker crash;
- cancellation, stale jobs and budget exhaustion;
- deletion/export consistency across canonical records, object storage and indexes;
- database migration/backup/restore procedures if ready.

Fix verified high-severity issues within the agreed scope. For broader refactors, produce a plan and ask the human engineer first.
</task>

<acceptance_criteria>
- Findings include severity, reproduction, affected boundary, impact and remediation.
- P0/high-severity issues are fixed or explicitly block release.
- Regression tests protect each fixed vulnerability.
- No real secrets or customer data are added to fixtures.
- The report separates code-tested findings from manual review and unverified assumptions.
</acceptance_criteria>

<constraints>
Operate only in local/test/staging environments with authorization. Do not exfiltrate data, create external accounts, deploy to production, rotate production keys or run destructive commands without explicit human approval. Do not use prompt text as the primary security boundary where deterministic authorization can be enforced.
</constraints>

<output>Return an ordered findings table, patches/tests made, checks run, release blockers, residual risk and exact manual follow-up steps.</output>
