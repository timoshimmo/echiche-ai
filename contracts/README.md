# Cross-service contracts

Versioned JSON Schema files shared by the TypeScript web app and the Python worker ([ADR-001](../docs/decisions/001-language-and-service-boundary.md), D1).

- **Current:** `reasoning-scaffold.v1` (stored run result) and `stage-output.v1` (stage checkpoints). Shared test fixtures live in `fixtures/`; both the worker (pytest) and the web app (`contracts.test.ts`) validate them.
- **Source of truth:** a Pydantic model in `worker/src/echiche_worker/contracts.py`. Regenerate with `uv run python -m echiche_worker.contracts --write`. Its exported JSON Schema is committed here, and TypeScript derives its types from these files. Never hand-edit a generated schema.
- **The writer owns the schema.** Payloads the web app writes (API request bodies) stay as Zod schemas in `src/lib/domain/`.
- **Versioning:** filenames carry the version (`decision-brief.v1.schema.json`). Every stored payload records its `schema_version`. A breaking change gets a new version, not an edit.
- **CI:** fails if a committed schema is stale relative to its Pydantic model (`--check`).
