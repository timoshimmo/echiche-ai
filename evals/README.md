# Evaluation data (ADR-010)

| File | What it is |
|---|---|
| `router-cases.v1.json` | 24 hand-labelled prompts for the complexity router (development set; agreement is tested in `src/lib/domain/routing.test.ts`). |
| `decision-benchmark.v1.json` | 33 synthetic cases (fictional `.test` pages, no private data) for the pipeline benchmark. |
| `gates.v1.json` | Regression gates: guardrail invariants only. |
| `results/decision-benchmark.v1.fake.{json,md}` | The committed fake-mode report: scripted model, **not a quality claim**. |

Run: `cd worker && uv run python -m evals.run` (procedure and live baseline: [docs/runbooks/evaluation.md](../docs/runbooks/evaluation.md)).
