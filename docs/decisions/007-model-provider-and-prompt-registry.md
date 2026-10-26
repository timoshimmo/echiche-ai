# ADR-007: Model provider adapter and prompt registry

- Status: **Accepted** (2026-10-26). The decision owner approved D9–D12 on 2026-10-26. Implemented in M4 behind `REASONING_PROVIDER`, which still defaults to the deterministic demo mode: **no paid call happens until the decision owner sets an API key and switches the provider**.
- Date: 2026-10-26
- Decision owner: Tokmang
- Related: blueprint §2.6 (decision brief), §3.1, §8.3 (provider data use), §8.4 (budgets); ADR-001 (D1 contracts, D3 worker deps); ADR-003 (result storage); ADR-006 (execution, failure policy)

## Context
M3 executes runs durably with a deterministic, non-LLM scaffold. M4 puts a real model behind the same `ReasoningProvider` port. The first provider is OpenAI, which the decision owner chose on 2026-10-26. Requirements: no new framework, strict structured outputs validated by the application, prompt-injection boundaries, bounded retries and spend, no stored hidden reasoning, and no secrets outside the worker.

## Decision

### Layers (worker only; the web app never calls a model)
| Module | Responsibility |
|---|---|
| `prompts.py` + `prompts/runtime/*.md` | Versioned prompt registry. TOML frontmatter between `+++` lines: id, semver, status (`active`/`draft`), purpose, output contract, owner, declared inputs with `max_chars`, and a changelog. The body is **trusted instructions only**: `{{placeholders}}` are rejected at load. Only `active` prompts can be used in runs. |
| `llm.py` | Provider-neutral `ModelClient` port, `TokenUsage`, and the **price table** with the date and source it was checked against |
| `openai_adapter.py` | OpenAI Responses API: `store=False`, SDK retries off (`max_retries=0`), strict JSON-schema output derived from the Pydantic contract, and error mapping. It returns raw text plus usage; it never validates content. |
| `model_provider.py` | Stage pipeline, validation, the single repair attempt, the citation guard, budget preflight, and call records |
| `factory.py` | Builds the configured provider. Any problem (unknown model price, missing key, broken prompt file) is a `CONFIG_INVALID` exit at start-up, never a run failure. |

### Stage plan
| Stage | M4 behaviour | Output contract |
|---|---|---|
| planning | model: `decision-framing@2.0.0` | `decision-frame.v1` |
| researching | deterministic skip, disclosed as a limitation (no research until M5) | — |
| critiquing | model: `decision-critic@2.0.0` | `critique.v1` |
| verifying | deterministic: frame and critique are re-validated against their contracts | — |
| synthesizing | model: `decision-brief-synthesis@2.0.0` | `decision-brief.v1` (every section of blueprint §2.6) |

The stored result is `decision-brief.v1` (`result_schema_version`). If framing set `clarification_needed`, its question is appended to the brief's limitations when it is composed. Demo runs keep `reasoning-scaffold.v1`. Checkpoints are now `stage-output.v2`: v1 plus `data_schema` and `data`, re-validated on load. M3 `stage-output.v1` checkpoints still load. A model stage that finds a demo checkpoint from an earlier stage fails with `REASONING_MODE_MISMATCH` instead of mixing modes.

### Prompt-injection boundary
User text (the project, the question) and earlier model output go only into the **user-role data message**, as fenced `<untrusted name="…">` blocks. Anything inside that could open or close a fence is escaped. The instructions are sent exactly as reviewed, and each call records the prompt's id, version and SHA-256 of the file. Authorization and budgets are enforced in code, never by the prompt.

### Validation, repair and citations
1. The output is parsed against the Pydantic contract. OpenAI strict mode does not support string-length keywords, so string bounds (200/500/1500 characters, non-blank) are Pydantic validators; the web app's Zod mirror re-applies them.
2. **Citation guard (deterministic):** every `source_id` must be one the application supplied. M4 supplies none, so any citation is invalid.
3. On failure there is **exactly one repair attempt**. The repair note names the failing JSON paths and rules and never echoes the model's content. A second failure gives `INVALID_PROVIDER_OUTPUT`.
4. A refusal (`PROVIDER_REFUSED`) or a truncated output (`PROVIDER_OUTPUT_TRUNCATED`) is permanent and is not repaired.

### Errors, retries, timeouts
| Situation | Code | Policy (ADR-006) |
|---|---|---|
| Rate limited (429) | `PROVIDER_RATE_LIMITED` | Transient. `Retry-After` is honoured, bounded within a claim and as the minimum requeue delay. |
| Timeout · connection · 5xx / 408 / 409 | `PROVIDER_TIMEOUT` · `PROVIDER_UNAVAILABLE` | Transient |
| 401 / 403 | `PROVIDER_AUTH` | Permanent |
| Other 4xx | `PROVIDER_REQUEST_INVALID` | Permanent |

Each call's timeout is the time left in the stage (`WORKER_STAGE_TIMEOUT_SECONDS`, capped by the run's time budget). Raw provider error messages are never logged or stored, because they can echo request content.

### Spend
- **Preflight:** before every call, a worst-case cost is computed: every input byte counted as a token, nothing cached, output at `OPENAI_MAX_OUTPUT_TOKENS`. If that exceeds the run's remaining `budget_max_cost_usd`, the run pauses with `BUDGET_COST` and nothing is sent. A cap of 0 allows no model calls. The user resumes by approving more budget, as for the other budgets.
- **Actual cost** comes from the reported usage and the verified price table. An **unknown model has no price and is refused at start-up**.
- **Every call counts**, including failed, repaired and retried ones. Cost is added to `cost_usd_used` on commit, failure, requeue and pause, with each increment rounded up to the column's precision. Migration 0005 forbids the worker from ever decreasing usage counters.

Prices, verified 2026-10-26 at <https://openai.com/api/pricing/> (USD per 1M tokens):

| Model | Input | Cached input | Output |
|---|---|---|---|
| gpt-6-astra | 10 | 1 | 50 |
| gpt-6.1-sol | 2 | 0.10 | 10 |
| gpt-6-luna | 0.10 | 0.01 | 0.50 |

The EU data-residency endpoint is billed at +10%.

### Telemetry (migration 0005)
`echiche.model_calls` holds one row per call: stage, attempt, provider, the model as reported, prompt id/version/hash, output contract, repair flag, outcome, error code, token counts (input, cached, output, reasoning), cost and latency. It holds **no prompts, inputs or outputs**. RLS: the owner can read their own rows; the worker can insert and read; nobody can update or delete except through cascade (deleting a run or account removes them). The web API exposes a per-run `generation` summary, and the UI labels each result "Live model (OpenAI · model)" or "Demo mode".

### Secrets
`OPENAI_API_KEY` exists only in the worker's environment (Render dashboard, `sync: false`). The web app refuses to start if it is set there. The worker's config `repr` redacts it, and tests assert it never appears in configuration error messages.

## Approved decisions (2026-10-26)
- **D9 Paid calls:** Echiche sends project and question text to OpenAI when `REASONING_PROVIDER=openai`. Retention verified 2026-10-26 from OpenAI's API data-controls documentation:
  - API data is not used for training by default.
  - Abuse-monitoring logs are kept for up to 30 days.
  - `store=false` means no Responses application state is kept.

  Approval covers sending this data. The privacy notice must still say this before real users ([data lifecycle](../security/data-lifecycle.md)).
- **D10 Default model `gpt-6.1-sol`**, with `OPENAI_MAX_OUTPUT_TOKENS=4000` and the default cap of $0.50 per run. Not verified: this model's context window and supported reasoning-effort values. The effort setting is optional and unset by default; the pinned SDK accepts `none … max`, but not every model supports every value.
- **D11 Data residency:** default is `global`. `eu` (eu.api.openai.com) requires OpenAI's approval for EU data residency first, and costs +10%.
- **D12** The telemetry table design above, and the decision that the brief's `proposed_memory_updates` are only displayed in M4. Saving memory is a later milestone and needs user review.

## Consequences
- The SDK is pinned exactly (`openai==3.29.0`). The adapter imports the SDK's own strict-schema converter (`openai.lib._pydantic.to_strict_json_schema`), so an SDK upgrade must re-run `test_strict_schemas_are_closed_and_fully_required` and the adapter tests.
- The worker image now builds from the repo root, because it needs `prompts/runtime`. The root `.dockerignore` whitelists what the image contains.
- **Not verified here:** a live OpenAI call (none was made), the Docker build, and the Render deploy. There is an opt-in live smoke test (`ECHICHE_LIVE_OPENAI=1 uv run pytest -m live`) for the decision owner to run with their own key.
- **Quality is not yet evaluated.** M7 adds the evaluation set; until then, briefs must be presented as unverified analysis, which the UI does.
- Python cannot cancel a thread, so a call that outlives its stage timeout keeps running in the background. Its usage is then unrecorded. The per-call SDK timeout matches the stage deadline to keep this window small.
