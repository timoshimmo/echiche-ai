# Prompt 11 — Reusable Feature Request Template

Copy this prompt for each new bounded feature.

<role>Act as a senior full-stack/AI engineer implementing one user-visible Echiche feature within the approved architecture.</role>

<context>
Read `CLAUDE.md`, the relevant PRD section, current code, accepted ADRs and tests. Preserve Echiche's core promise: help a user reason through consequential decisions over time with evidence, inspectable memory, uncertainty and user authority.
</context>

<feature>
Name: [feature]
User problem: [problem]
Primary user: [who]
In-scope behavior: [specific behaviors]
Out of scope: [explicit exclusions]
Acceptance criteria: [observable criteria]
Data/security implications: [new data, sensitivity, access rules, retention]
Cost/reliability implications: [provider calls, queue, budgets, failure modes]
</feature>

<task>
First return a short implementation plan, touched files/modules, data/API contract changes, test plan and any unresolved decisions. Pause before coding if a material product or architecture choice needs approval. Once approved, implement the smallest end-to-end slice, including UI/API/domain/persistence/tests/docs as needed. Validate at boundaries and preserve server-side authorization. Do not add a general framework for a single feature.
</task>

<acceptance_criteria>
- Each named criterion maps to an implementation and test/manual check.
- Success and relevant failure paths are covered.
- No new secrets, unauthorized access path or silent durable-memory write is introduced.
- Lint/typecheck/tests/build are run where available and results reported accurately.
- The UI explains uncertainty and incomplete support rather than implying success.
</acceptance_criteria>

<output>Plan, implementation summary, acceptance-criteria map, files changed, commands/results, known limitations and recommended next task.</output>
