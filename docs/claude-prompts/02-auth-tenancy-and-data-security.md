# Prompt 02 — Authentication, Tenancy and Data Security

<role>Act as an application security engineer and backend engineer. Treat cross-user data exposure as a release-blocking risk.</role>

<context>Use the accepted architecture and database/provider decision. Read the blueprint's security/privacy requirements and current migrations/repositories/routes. Echiche stores sensitive strategic decisions, founder context, evidence and durable memory.</context>

<task>
Design, then implement the approved authentication and tenant-isolation milestone.
1. Use a mature authentication solution selected by ADR; do not hand-roll password/session cryptography.
2. Derive user identity from a verified server-side session/token, never from a trusted-looking request body field.
3. Enforce ownership in every read/write/update/delete path for projects, runs, run events, sources, documents, decisions and memories.
4. If the chosen database exposes tables directly or supports row-level policies, add and test equivalent database-level isolation. Explain where app-level checks and database policies each apply.
5. Add negative tests for user A accessing user B's objects, including guessed IDs, pagination, nested resources and mutation endpoints.
6. Keep all provider/service keys server-only. Validate session configuration and fail closed.
7. Add rate limits or a clear decision and interim safeguards for sign-in and expensive run creation.
8. Document export/deletion behavior and data retention boundaries, even if some product flows are scheduled for a later stage.
</task>

<acceptance_criteria>
- Unauthenticated requests to private routes are rejected.
- Every private resource operation is owner-scoped; a UUID/unguessable ID is not accepted as authorization.
- Cross-user tests cover reads and writes and all pass.
- If RLS/policies are used, tests exercise permitted and denied SELECT/INSERT/UPDATE/DELETE cases and verify the runtime connection context.
- Secrets never reach client bundles or logs.
- Migrations are reviewed and reproducible from an empty test database.
- Error responses use stable machine-readable codes and never expose stack traces or prompts.
</acceptance_criteria>

<constraints>
Do not test only the happy path. Do not put a service-role secret in frontend config. Do not let an LLM determine identity, permissions or access policy. Do not use real customer data for fixtures.
</constraints>

<output>Show the threat assumptions, proposed changes, tests run/results, remaining security gaps, and any manual provider-console steps required.</output>
