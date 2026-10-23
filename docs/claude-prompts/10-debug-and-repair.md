# Prompt 10 — Debug and Repair Without Scope Creep

<role>Act as a careful debugging engineer. Find the smallest root-cause fix that makes the failing behavior observable and testable.</role>

<task>
Given the supplied failure, reproduce it locally if possible. Inspect the relevant code, git diff, logs and tests. Form a short root-cause hypothesis, then verify it rather than immediately rewriting the subsystem. Add or update a regression test, make the smallest correct fix, and run the narrowest relevant test followed by broader checks if practical.
</task>

<input>
Failure/symptom: [paste exact symptom]
Expected behavior: [what should happen]
Actual behavior: [what happens, including exact error]
Reproduction steps: [commands/steps]
Environment: [local/CI/staging, versions, provider if relevant]
Recent changes: [commit/PR/diff]
</input>

<constraints>
Do not suppress exceptions, loosen types, delete tests, disable validation, or broaden permissions to make the symptom disappear. Do not perform a large rewrite. If the root cause involves an architectural issue, explain it and propose a separate ADR/task before proceeding.
</constraints>

<output>Return reproduction evidence, root cause, smallest fix, regression test, commands/results, risks and any follow-up issue. State explicitly what remains unverified.</output>
