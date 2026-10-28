# Cross-service contracts

Versioned JSON Schema files shared by the TypeScript web app and the Python worker ([ADR-001](../docs/decisions/001-language-and-service-boundary.md), D1).

- **Current:**
  - Stored run results: `decision-brief.v1` (model-generated, M4) and `reasoning-scaffold.v1` (demo mode).
  - Stage checkpoints: `stage-output.v2` (adds `data_schema` and `data`); M3 `stage-output.v1` checkpoints are still read.
  - Model outputs, sent to the provider as strict schemas: `decision-frame.v1`, `critique.v1`, `decision-brief.v1`, and (M5) `research-plan.v1`, `claim-set.v1`, `claim-verification.v1`.
  - Application-built checkpoint data (M5): `evidence-set.v1` (sources read, with passages) and `verification-report.v1` (claims, verdicts, freshness, contradictions).
  - The web app also validates the research rows it reads (`src/lib/domain/evidence.ts`), allowing https links only.
  - Shared fixtures live in `fixtures/`; both the worker (pytest) and the web app (`contracts.test.ts`) validate them.
- **String bounds:** OpenAI strict mode does not support string-length keywords, so string limits (non-blank; 200/500/1500 characters) are Pydantic validators and do not appear in the JSON Schemas. The Zod mirror re-applies them. The invalid fixtures that break only a string bound are therefore rejected by the mirror and the worker, not by the generated schema.
- **Source of truth:** a Pydantic model in `worker/src/echiche_worker/contracts.py`. Regenerate with `uv run python -m echiche_worker.contracts --write`. Its exported JSON Schema is committed here, and TypeScript derives its types from these files. Never hand-edit a generated schema.
- **The writer owns the schema.** Payloads the web app writes (API request bodies) stay as Zod schemas in `src/lib/domain/`.
- **Versioning:** filenames carry the version (`decision-brief.v1.schema.json`). Every stored payload records its `schema_version`. A breaking change gets a new version, not an edit.
- **CI:** fails if a committed schema is stale relative to its Pydantic model (`--check`).
