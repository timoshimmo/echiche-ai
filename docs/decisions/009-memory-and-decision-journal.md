# ADR-009: User-controlled memory and decision journal

- Status: **Accepted** (2026-10-28). The decision owner chose three things on 2026-10-28: hard delete, approved memories and the current decision feed later runs (with provenance), and JSON export.
- Date: 2026-10-28
- Decision owner: Tokmang
- Related: blueprint §5 (MEM-01, MEM-02, DEC-01, EXPORT-01), §5.3; ADR-004 (tenancy); ADR-007 (prompts); ADR-008 (evidence)

## Decision

### What is remembered (migration 0007)
| Table | Purpose |
|---|---|
| `echiche.memories` | Versioned items of kind `goal`, `constraint`, `assumption`, `decision`, `open_question` or `fact`. Each has a status (`proposed`, `active`, `superseded`, `rejected`), an origin (`model_proposal` or `user`), an `edited` flag, a sensitivity, an optional confidence, its source run, and lineage, version and supersedes links. Dates: observed, reviewed, valid from, valid to. |
| `echiche.decisions` | One versioned decision line per project. A new version comes from an accepted brief (`accepted_brief`) or a user revision (`user_revision`). Each version stores the choice, rationale, alternatives, assumptions, confidence, review triggers ("what would change this") and next actions. |
| `echiche.decision_outcomes` | Append-only observations: result, what happened, the date observed, notes. |
| `echiche.run_memory_context` | A snapshot of the remembered items (refs M1…, D1) each run was given: the provenance of every brief. |

Chat messages are not stored as memory. Hidden reasoning is never stored.

### Lifecycle
```
run completes ──▶ proposed ──approve (may edit)──▶ active ──correct──▶ superseded  (+ new active version)
                     │                               │
                     └──reject──▶ rejected           └──delete──▶ gone (whole lineage, hard delete)
```
- **Proposals:** the worker writes `proposed` rows from the brief's `proposed_memory_updates` when the run finishes, idempotently per run and proposal index. **Nothing is durable until the owner approves it (MEM-01).** A conservative keyword screen flags proposals that may touch sensitive personal categories (health, finances, religion, politics, legal status and similar); those need an explicit confirmation to save.
- **Corrections:** a correction never edits an active row. It supersedes the row (setting `valid_to`) and inserts a new version with `supersedes_id`, so earlier statements stay inspectable (MEM-02).
- **Decisions:** accepting a brief records it as the project's current decision. Revising appends a version and supersedes the previous one; earlier rationale is never rewritten (DEC-01). Outcomes are appended to a version; they never change it.
- **Database guards (`enforce_memory_change`, `enforce_decision_change` and column grants):**
  - the worker can only insert proposals;
  - users can only insert active, user-origin memories;
  - provenance columns are immutable;
  - allowed memory transitions are `proposed → active | rejected` and `active → superseded` (with unchanged content);
  - decision versions are immutable apart from `active → superseded`;
  - outcomes are insert-only.

### Retrieval for runs (`worker/src/echiche_worker/memory.py`)
1. **Hard filters in SQL, before any ranking:** this owner, this project, `status = 'active'` (never proposals, rejected or superseded rows), and the project's active decision.
2. **Canonical first:** the active decision as **D1**, then all goals and constraints, newest first.
3. **Assumptions, open questions, facts and decision notes:** included only if they share a *distinctive* term with the question. That means IDF-weighted overlap within the project's own items, at or above 1.0. Otherwise nothing is recalled (abstention).
4. **Caps:** 20 items and 6,000 characters.

The selection is written to `run_memory_context` in the same transaction as the planning checkpoint. A resumed run reuses the same snapshot.

**No embeddings or vector store.** The seeded benchmark below is met with deterministic filters and lexical ranking. Per the blueprint, semantic retrieval needs an evaluation-backed reason, which there is not yet.

### How runs use memory (prompts: framing 2.1.0, synthesis 2.2.0)
- **Framing and synthesis** get a fenced, untrusted `project_memory_json` block. Each item has a ref, a kind, "remembered" text and a "recorded_on" date.
- **Framing** must label anything taken from it as remembered, never claim to remember anything else, and list contradictions in `memory_conflicts` (the new `decision-frame.v2`).
  - A deterministic guard rejects refs that were not supplied (invented recall gets one repair, then fails).
  - Conflicts are appended to the brief's limitations as "Remembered item M*n* may be outdated: …". They are surfaced, never silently resolved.
- **Synthesis** must say whether the recommendation keeps or changes D1. It may not cite memory as evidence; only stored sources are citable (ADR-008).
- **Provenance:** the UI shows which remembered items a run was given (`GET /api/runs/:id` → `remembered`).

### Deletion and export
- **Hard delete:**
  - deleting a memory removes its whole lineage;
  - deleting a project cascades to runs, events, checkpoints, telemetry, sources, claims, memories, decisions, outcomes and memory snapshots;
  - account deletion (operator) cascades everything;
  - rows remain only in Supabase backups until those expire.
- **There is no partial "forget one version"** (deliberately: deleting a middle version would break the lineage). The user can correct a memory or delete the whole lineage.
- **Export:** `GET /api/projects/:id/export` returns `echiche-export.v1` JSON as an attachment, generated on request with `no-store`. It includes:
  - the project;
  - each run with its prompt, status, result, usage, events, remembered context, sources (with stored passages) and claims;
  - a model-call summary;
  - every memory version;
  - every decision version with its outcomes.

  Checkpoints and per-call telemetry rows are summarised, not exported verbatim.
- **Derived indexes:** none exist, so there is nothing to propagate. If an index is added later, it must be deleted with its source rows, tested the same way.

## Seeded benchmark (`worker/tests/fixtures/memory_benchmark.json`, `test_seeded_retrieval_benchmark`)
- **Corpus:** 14 memories across 2 owners and 3 projects, covering every status, plus a superseded constraint, an unapproved proposal, a rejected item, and cross-project and cross-user distractors that share wording (for example "80 dollars").
- **Queries:** 8 queries, 3 of which should recall nothing.
- **Result (real Postgres, as `echiche_worker`):** recall 1.00, precision 1.00, abstention 1.00. No superseded, unapproved, rejected or other-project item ever surfaced. The canonical decision always came first.
- **Caveat:** the corpus is small and synthetic. It is a regression gate, not evidence of real-world quality; the M7 evaluation set should extend it.

## Consequences
- **Coverage:** recall depends on shared vocabulary. A relevant memory worded very differently from the question can be missed. It is still in the journal, but the run doesn't see it. Goals, constraints and the decision record are always included, which bounds the impact.
- **Sensitivity screen:** keyword-based, so it can miss sensitive content or flag harmless text. It only gates the explicit confirmation; nothing is stored silently either way.
- **Retention (open, before the pilot):** how long inactive projects, rejected proposals and superseded versions are kept. Today, everything stays until the user deletes it.
