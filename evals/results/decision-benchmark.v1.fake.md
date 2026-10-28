# Evaluation report: decision-benchmark.v1 (fake mode)

> **Not a quality claim.** Fake mode runs the real pipeline with a *scripted* model, search and pages.
> It shows what Echiche's deterministic guardrails do under cooperative, naive and adversarial model
> behaviours. It says nothing about how good a real model's analysis is. Costs are scripted token
> counts priced at list price, not real spend; latency is not measured. Do not quote these numbers
> as product performance.

- Commit: `3288679` · routing policy `routing-policy.v1` · 33 cases
- Prompts: `claim-extractor@2.0.0`, `decision-brief-synthesis@2.3.0`, `decision-critic@2.1.0`, `decision-framing@2.1.0`, `decision-verifier@2.0.0`, `memory-proposal@1.1.0`, `research-planner@2.0.0`
- Variants: **A** one-pass · **B** research + synthesis (unverified) · **C** full pipeline · **R** routed by the M7 policy

| Metric | A | B | C | R |
|---|---|---|---|---|
| Completed (excl. budget cases) | 1.0 | 1.0 | 1.0 | 1.0 |
| Valid decision brief | 1.0 | 1.0 | 1.0 | 1.0 |
| Invented citations | 0 | 0 | 0 | 0 |
| Citations to sources that do not support the claim | 0 | 4 | 0 | 0 |
| 'High' confidence without two supporting domains | 0 | 2 | 0 | 0 |
| Grounding cases with ≥1 supporting citation | 0.0 | 1.0 | 1.0 | 1.0 |
| No-evidence cases: no citations, not 'high', gap disclosed | 1.0 | 0.833 | 1.0 | 1.0 |
| Conflicting sources surfaced | 0.0 | 0.0 | 1.0 | 1.0 |
| Stale evidence flagged | 0.0 | 0.0 | 1.0 | 1.0 |
| Expected memory recalled | 0.0 | 0.0 | 1.0 | 1.0 |
| Irrelevant memory left out | 1.0 | 1.0 | 1.0 | 1.0 |
| Forbidden memory items given to the run | 0 | 0 | 0 | 0 |
| Memory conflicts surfaced | 0.0 | 0.0 | 1.0 | 1.0 |
| Invented memory refs | 0 | 0 | 0 | 0 |
| Injected text echoed in the brief | 0.0 | 0.667 | 0.667 | 0.667 |
| Budget cases stopped honestly | 1.0 | 1.0 | 1.0 | 1.0 |
| Model calls (total) | 81 | 105 | 174 | 168 |
| Repair attempts | 18 | 11 | 15 | 15 |
| Searches | 0 | 31 | 31 | 28 |
| Scripted cost, USD (not real spend) | 0.6543 | 1.0044 | 1.5612 | 1.4976 |

## Gates (invariants only)

- ✅ all invariant gates pass

Quality and cost thresholds are deliberately not set: they need live baselines reviewed by a person
(docs/runbooks/evaluation.md).
