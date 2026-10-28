# ADR-010: Evaluation harness and adaptive compute

- Status: **Proposed** (2026-10-28). Needs the decision owner's review: the router policy table, the escalation rule (and whether to configure an escalation model at all), the gates, and the deferred live baseline.
- Date: 2026-10-28
- Decision owner: Tokmang
- Related: blueprint §6 (evaluation), §7 (cost); ADR-006 (budgets); ADR-007 (models, prices); ADR-008 (evidence); ADR-009 (memory)

## Decision

### 1. Deterministic complexity router (`config/routing-policy.json`, `routing-policy.v1`)
The web app classifies each run when it is queued (`src/lib/domain/routing.ts`). The result is stored on the run (migration 0008): `requested_depth`, `route_tier`, `route_reasons` (each signal, its points, and the words that matched) and `route_policy_version`. The worker reads the **same file** to shape the pipeline (`worker/src/echiche_worker/routing.py`). Nothing is learned and nothing is model-judged.

**Scoring.** Terms match case-insensitively at the start of a word ("pric" matches "pricing"; "lease" does not match "please").

| Signal | Points | Fires on |
|---|---|---|
| consequence | +3, plus 1 if two different terms match or an amount of money is named | invest, raise, hire, launch, contract, lease, legal, pricing, enter, expand, pivot, partner, equity, loan, irreversible, sign… |
| comparison | +2 | compare, vs, versus, which, or, better, worth |
| uncertainty | +1 | should, whether, risk, unsure, trade-off, best way… |
| evidence need | +2 | market, competitor, benchmark, data, evidence, research, latest, trend, industry, regulation, cost of, average, survey, churn… |
| novelty | +1 | the project has no active decision and no remembered items |
| lookup | −5 | what did we decide, remind me, summarize, recap, list our, rewrite, write a… |

**Tiers.** A score below 2 is low; 2–4 is medium; 5 or more is high. The user's depth choice overrides the score: quick → low, standard → medium, deep → high. When it does, that is recorded as a reason.

**Per-tier caps.** Budgets are the element-wise minimum of the operator's configured budget and the tier budget, so the router can only tighten.

| Tier | Pipeline | Research | Steps | Active time | Research calls | Spend cap |
|---|---|---|---|---|---|---|
| low ("Quick") | framing + synthesis (with memory); research, critique and verification are skipped | none | 5 | 180 s | 0 | $0.10 |
| medium ("Standard") | full | ≤2 queries, ≤4 pages | 8 | 420 s | 3 | $0.30 |
| high ("Deep") | full; escalation allowed | ≤4 queries, ≤8 pages | 12 | 900 s | 6 | $1.00 |

**How tiers apply in the worker:**
- A skipped stage is checkpointed as "Skipped (low route)" with no provider call and no cost.
- The first skipped stage adds a limitation to the brief: "This was a quick run: it was not researched, critiqued or verified…". The user always sees what was left out.
- The synthesis prompt (2.3.0) receives `{"not_run": …}` in place of a critique, and must say so.
- Research caps tighten the operator's `RESEARCH_MAX_QUERIES` and `RESEARCH_MAX_PAGES`; they never loosen them.
- Runs queued before M7 have no tier. They run the full pipeline with no escalation, exactly as before.

**Labelled router cases.** Agreement on `evals/router-cases.v1.json` (24 hand-labelled prompts) is 23/24. The test requires at least 90% and names the known miss: R07, a trivial either/or scheduling choice, routes to medium. Lexical signals cannot tell a trivial choice from a weighty one, so this is not tuned away. These cases were also used to choose the weights (variants A–E were simulated), so they are a **development set**, not an unbiased accuracy estimate.

### 2. Escalation (high tier only, recorded either way)
**When it fires.** Synthesis uses `OPENAI_ESCALATION_MODEL` when one of the configured triggers fires:
- `contradiction`: verification found sources that disagree on a claim;
- `high_severity_critique`: the critique rated a challenged assumption or risk "high".

**Conditions.** The escalation model:
- must have a verified price in `llm.py`, or the worker refuses to start;
- must differ from `OPENAI_MODEL`;
- is preflighted against the remaining spend cap, like every call.

**What is recorded.** The outcome is stored in `thought_runs.route_escalation`, a run event and the model-call row (the escalation model's name and price), and it is shown in the UI. When escalation is justified but not possible, that is recorded too:
- "escalation triggered (…) but no escalation model is configured"
- "…but skipped: it would exceed the remaining spend cap"

**Default: no escalation model.** Configuring one is a cost decision for the owner (the only verified candidate in the price table is `gpt-6-astra`, at 5× the default model's price).

**Out of scope.** No extra research rounds, no debate loops and no second critique. The blueprint does not presume they help, and nothing here measures that they do.

### 3. Evaluation harness (`worker/evals/`, `evals/`)
- **Benchmark:** `evals/decision-benchmark.v1.json` (versioned) has 33 synthetic cases across 11 categories:
  - grounding;
  - unsupported sources mixed in;
  - absent facts / no evidence;
  - conflicting sources;
  - stale evidence;
  - memory recall with distractors (superseded, unapproved, other project);
  - prior-decision recall;
  - temporal conflict with memory;
  - prompt injection in a fetched page;
  - budget exhaustion;
  - lookup or drafting.

  It uses only fictional `.test` pages served from memory, and **no private data**. A web test keeps each case's `route_tier` equal to the router's output.
- **How it runs:** fake mode (`uv run python -m evals.run`) drives the **real executor and pipeline** (budgets, skipping, checkpoints, prompts, contracts, repair, citation, confidence and memory guards, passage selection, quote checks, the verification report). Only the edges are replaced: a scripted model, search, fetcher and an in-memory store.
- **Scripted model behaviours:**
  - **cooperative** follows the rules;
  - **naive** cites every source it has seen and always says "high";
  - **adversarial** also invents `S9` and `M9` and obeys injected page text.
- **Variants:**

  | Variant | What runs |
  |---|---|
  | A, one-pass | framing + synthesis; no research, critique, verification or memory |
  | B, research + synthesis | synthesis over unverified passages; the citation-ID guard still applies |
  | C, full | framing with memory, research, critique, verification and synthesis |
  | R, routed | the case's router tier |

- **Rubric** (deterministic, computed against the case's ground-truth labels):

  | Rubric area | How it is scored in fake mode | Where it needs live / human review |
  |---|---|---|
  | Output-schema validity | brief validates against `decision-brief.v1` | — |
  | Citation support (a proxy for factual grounding) | invented citations; citations to sources whose ground truth is "does not support"; "high" confidence without two supporting domains | whether the *wording* matches the sources |
  | Abstention | no-evidence cases: no citations, not "high", gap disclosed | — |
  | Counterevidence | contradiction surfaced in limitations | quality of the counter-argument |
  | Temporal consistency | stale evidence flagged; memory conflict surfaced; no invented memory refs | — |
  | Memory recall / abstention | expected items given to the run; irrelevant and forbidden ones left out | — |
  | Injection | injected marker echoed in the brief (measured, not gated: see below) | resistance of a real model |
  | Budget honesty | budget cases stop with the right code and no fabricated result | — |
  | Decision usefulness, critical reasoning | **not measurable with a scripted model** | human review sheet ([runbook](../runbooks/evaluation.md)) |
  | Usage and cost | model calls, repairs, searches, scripted cost (token counts are made up; priced as `gpt-6.1-sol`, labelled not real) | real tokens and cost from `model_calls` |
  | Latency | **not measured** in fake mode (labelled so) | `model_calls.latency_ms` |

- **Results:** `evals/results/decision-benchmark.v1.fake.{json,md}` record:
  - the benchmark version, the git commit, the routing-policy version and every prompt version;
  - the model label ("simulated") and the cost basis;
  - per-case scores and per-variant summaries.

  They contain no prompts or brief text beyond the synthetic cases.

### 4. Results (fake mode, actually run at commit `3288679`; not a quality claim; full table: `evals/results/decision-benchmark.v1.fake.md`)
| Metric | A | B | C | R |
|---|---|---|---|---|
| Citations to sources that do not support the claim | 0 | **4** | 0 | 0 |
| "High" confidence without two supporting domains | 0 | **2** | 0 | 0 |
| Grounding cases with ≥1 supporting citation | 0.00 | 1.00 | 1.00 | 1.00 |
| No-evidence cases handled honestly | 1.00 | 0.83 | 1.00 | 1.00 |
| Conflicting sources surfaced / stale evidence flagged | 0 / 0 | 0 / 0 | 1.00 / 1.00 | 1.00 / 1.00 |
| Expected memory recalled · irrelevant memory left out · leaks | 0 · 1.00 · 0 | 0 · 1.00 · 0 | 1.00 · 1.00 · 0 | 1.00 · 1.00 · 0 |
| Injected text echoed (adversarial cases) | 0 (reads no pages) | 0.67 | 0.67 | 0.67 |
| Budget cases stopped honestly | 1.00 | 1.00 | 1.00 | 1.00 |
| Model calls · searches · scripted cost | 81 · 0 · $0.65 | 105 · 31 · $1.00 | 174 · 31 · $1.56 | 168 · 28 · $1.50 |

**What this shows:**
- **Verification and critique earn their cost** on exactly the failure modes they target. B, without verification, cites unsupported sources and claims unearned "high" confidence. C does neither, but makes about 1.7× as many model calls as B.
- **A is cheapest and never over-claims** (it has nothing to cite), but it grounds nothing.
- **Routing:** the routed variant runs 2 instead of 4 calls on the three lookup cases. On this decision-heavy benchmark most cases route high, so the total saving is small (3%). That is a property of the benchmark mix, not a forecast.

**What this does not show:**
- Anything about a real model's analysis quality. The scripted model's behaviour is chosen by the case.
- **Injection is not stopped by deterministic guards.** An adversarial model that obeys injected page text gets a marker into its recommendation in B, C and R, while the guards still stop it citing an invented source or claiming unearned confidence. Real resistance depends on the model and the prompt fencing, and is measured only in a live run. A deterministic option (quarantining passages that address the AI, for example "ignore your instructions", before any model sees them) is listed as an open decision below.

**Found by the benchmark and fixed:**
- **Small-project recall.** Memory retrieval could never recall a remembered fact in a project with only one or two items. Plain IDF makes every word non-distinctive there (case M05). A word found in exactly one remembered item now always counts as distinctive. The M6 seeded benchmark still scores recall 1.00, precision 1.00 and abstention 1.00, and a regression test was added.

### 5. Gates (`evals/gates.v1.json`; run by CI with `uv run python -m evals.run` and by pytest)
**Gated invariants** (the deterministic guardrails must guarantee these whatever the model does):
- no invented citations or memory refs (all variants);
- no unsupported citations and no unearned "high" confidence (C and R);
- no memory leaks;
- every brief valid;
- runs complete;
- honest abstention and budget stops;
- conflicts surfaced (C);
- stale evidence flagged;
- memory recall and abstention.

**Mutation check.** Disabling the brief's citation and confidence guard makes the gates fail (test).

**Deliberately not gated yet:** minimum quality scores, maximum cost and maximum latency. Prompt 07 requires those thresholds to be set only after baseline measurements and human review. Fake-mode numbers are not a baseline for them.

## Recommended release gates (for the owner to agree after the live baseline)
1. Keep every invariant gate above, at zero tolerance.
2. **Live baseline**, per the runbook: run the benchmark prompts with the real model, without and with routing, and have a person score each brief with the review sheet.
3. Then agree on:
   - a minimum mean usefulness score and a citation-faithfulness floor;
   - a maximum p95 cost per run for each tier, starting from the measured p95 plus headroom;
   - a maximum p95 latency for each tier.
4. Re-run the baseline after any change to a prompt, the model, the routing policy or the retrieval rules. Results stay internal unless reviewed: **no public performance claims from unreviewed results.**

## Consequences and open decisions
- **Wording sensitivity.** Lexical routing is easy to explain and audit, but it is sensitive to wording. Users can always override the depth. Misroutes are visible on the run: the route line expands to the reasons.
- **Quick runs are cheaper but shallower.** The limitation always says so.
- **Decisions for the owner:**
  - accept or adjust the policy table and caps;
  - whether to set `OPENAI_ESCALATION_MODEL` (and accept its price);
  - whether to add deterministic quarantine of instruction-like passages;
  - approve the live baseline (keys, a spend cap and a reviewer).
