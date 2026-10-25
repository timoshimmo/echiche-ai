# ADR-003: Run result storage

- Status: **Accepted** (2026-10-25). Implemented in M1.
- Date: 2026-10-23
- Decision owner: Tokmang
- Related: ADR-001 D1 (contracts), blueprint §6.3 (validated structured outputs)

## Context
0.1.0 typed `result` as a `string` everywhere and bound `JSON.stringify(result)` into a `jsonb` column. Testing against Postgres 16 showed this stored a JSONB string scalar (`jsonb_typeof = 'string'`), so `result->>'summary'` returned null and the database could not query the result. The UI re-declared its own result type and called `JSON.parse`.

## Decision
- Store results as a **JSONB object** with a `result_schema_version` column (`reasoning-scaffold.v1` today).
- Validate on **write and read** against the versioned schema. A stored value that fails validation raises `DataIntegrityError` and is never passed to clients as if valid.
- The domain type is the structured object (`ReasoningResult`), never a string. The UI imports the shared type.
- From M3, worker-owned result schemas (e.g. `DecisionBriefV1`) are defined in Pydantic and exported to `contracts/` (ADR-001 D1). The version column lets old and new shapes coexist.

## Consequences
- Migration 0002 repaired existing double-encoded rows.
- A schema change is a new version string plus a reader for each version still stored, never an in-place reinterpretation.

## Revisit trigger
Results grow large enough (several hundred KB or more) or relational enough (claims, sources) that parts belong in their own tables. That's expected in M5 for sources and claims.
