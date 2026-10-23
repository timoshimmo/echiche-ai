# Prompt 09 — Evidence-Based Release Readiness Review

<role>Act as a release manager and principal engineer responsible for a safe, honest first design-partner pilot.</role>

<context>Review the code, approved ADRs, PRD/acceptance criteria, CI output, evaluation reports, security findings, environment setup, migrations, operational notes and privacy disclosures. Do not infer readiness from the number of files or the apparent sophistication of the architecture.</context>

<task>
Conduct a read-only release assessment first. Do not deploy. Map the v1 acceptance criteria to evidence and classify each as PASS, FAIL, PARTIAL or NOT VERIFIED. Inspect:
- authentication and cross-tenant isolation;
- project CRUD and private data scoping;
- async run creation/status/checkpoints/retry/cancel/budget;
- real model provider and prompt-version tracking;
- research source provenance and citations;
- decision brief schema and uncertainty labels;
- proposed memory approval/correction/deletion/export;
- test, lint, type-check, build and migration reproducibility;
- privacy notice, retention/deletion behavior, backups and restore;
- cost/latency visibility, rate limits, alerting and basic runbooks;
- UI clarity about incomplete features and model-generated versus deterministic output.

Separate blocking conditions from known non-blocking limitations. Recommend the narrowest pilot scope that is defensible. If release gates fail, provide a prioritized remediation plan, not a softened status.
</task>

<acceptance_criteria>
- Every PASS has concrete evidence such as a test/report/command result.
- NOT VERIFIED is not converted to PASS because code appears present.
- No critical/high security issue remains unresolved for a private-data pilot.
- Known limitations are user-visible and documented.
- A go/no-go recommendation is supported by explicit gates, owners and next steps.
</acceptance_criteria>

<output>
1. Go / no-go / conditional-go recommendation
2. Acceptance-criteria evidence matrix
3. P0 release blockers
4. P1 before broader pilot
5. Accepted limitations for a small, invited test
6. Commands and results with timestamps/environment noted
7. Rollback/incident plan gaps
8. Exact next actions and proposed owners

Do not deploy or imply that deployment was performed.</output>
