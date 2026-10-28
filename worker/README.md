# Echiche worker (Python)

Owns run execution ([ADR-001](../docs/decisions/001-language-and-service-boundary.md), [ADR-006](../docs/decisions/006-durable-run-orchestration.md)). It claims queued runs from Postgres, executes the five stages with checkpoints, leases, retries, budgets and cancellation, and writes the result for the user's review. Deployed as a Render Background Worker ([ADR-005](../docs/decisions/005-hosting.md)).

Two reasoning providers sit behind `ReasoningProvider` ([ADR-007](../docs/decisions/007-model-provider-and-prompt-registry.md)):
- **`deterministic`** (default): the demo scaffold. No model, no network, no cost.
- **`openai`**: model-backed framing, critique and synthesis. It uses versioned prompts from `prompts/runtime/`, strict structured outputs, one repair attempt, a citation guard, per-run spend caps and per-call telemetry in `echiche.model_calls`.

Research is optional ([ADR-008](../docs/decisions/008-research-provenance-and-verification.md)). With `RESEARCH_PROVIDER=brave`:
- Brave finds candidate pages; its results are never stored.
- `fetch.py` reads the pages under strict guards.
- `passages.py` keeps short relevant passages.
- The verifying stage checks every quote against the stored passage, then has the model judge support independently.
- Sources, claims and research telemetry go to `echiche.sources`, `echiche.claims` / `claim_sources` and `echiche.research_calls`.

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12.

```bash
cd worker
uv sync --locked
uv run ruff check . && uv run ruff format --check . && uv run pyright
uv run pytest                                   # unit tests (no database, no network; includes a local mock OpenAI server)
uv run python -m echiche_worker.contracts --check

# Integration tests: a disposable DB prepared by `npm run test:db:prepare` at the repo root
TEST_ADMIN_DATABASE_URL=postgresql://postgres@localhost:5432/echiche_test \
WORKER_TEST_DATABASE_URL=postgresql://echiche_worker:test-only-password@localhost:5432/echiche_test \
  uv run pytest -m integration

# Run it
DATABASE_URL=postgresql://echiche_worker:...@.../postgres uv run echiche-worker          # until SIGTERM
DATABASE_URL=... uv run echiche-worker --once                                            # drain queue, exit
DATABASE_URL=... uv run echiche-worker --check-config                                    # validate env + provider + prompts (exit 0/2)

# Opt-in, REAL and billed: one framing call with your own key (never in CI)
ECHICHE_LIVE_OPENAI=1 OPENAI_API_KEY=... uv run pytest -m live -s
# Opt-in, REAL: one Brave search plus page fetches through the production guards
ECHICHE_LIVE_BRAVE=1 BRAVE_SEARCH_API_KEY=... uv run pytest -m live -s -k research
```

Docker (same image Render builds; context is the repo root because the image includes `prompts/runtime`): from the repo root, `docker build -f worker/Dockerfile -t echiche-worker . && docker run --env-file .env.worker echiche-worker`.

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Connect **as `echiche_worker`** (migration 0003; password per the runbook). Never `postgres`. Transaction-mode poolers are supported. |
| `WORKER_POLL_INTERVAL_SECONDS` | no | `2` | 0.1–60; idle wait between claims |
| `WORKER_LEASE_SECONDS` | no | `60` | 10–600; a crashed worker's run is reclaimable after this |
| `WORKER_STAGE_TIMEOUT_SECONDS` | no | `120` | 1–1800; also capped by the run's remaining time budget |
| `WORKER_ID` | no | `worker-<hostname>` | ≤64 chars of `[A-Za-z0-9._-]`; unique per instance |
| `REASONING_PROVIDER` | no | `deterministic` | `deterministic` (demo) or `openai` |
| `OPENAI_API_KEY` | with `openai` | — | Secret. Worker only; the web app refuses to start if it is set there. Redacted from config output. |
| `OPENAI_MODEL` | no | `gpt-6.1-sol` | Must have a verified price in `llm.OPENAI_PRICES`, otherwise start-up fails |
| `OPENAI_REASONING_EFFORT` | no | unset | One of the SDK's values (`none`…`max`); not every model supports every value |
| `OPENAI_DATA_RESIDENCY` | no | `global` | `global` or `eu` (`eu` needs OpenAI's approval; +10% price) |
| `OPENAI_MAX_OUTPUT_TOKENS` | no | `4000` | 256–32000; also the output term of the worst-case cost check |
| `ECHICHE_PROMPTS_DIR` | no | `<repo>/prompts/runtime` | Set in the Docker image |
| `RESEARCH_PROVIDER` | no | `none` | `none` or `brave` (`brave` requires `REASONING_PROVIDER=openai`) |
| `BRAVE_SEARCH_API_KEY` | with `brave` | — | Secret. Worker only; redacted from config output |
| `RESEARCH_MAX_QUERIES` | no | `3` | 1–8 searches per run, also capped by the run's research budget |
| `RESEARCH_RESULTS_PER_QUERY` | no | `5` | 1–20 candidate URLs per search |
| `RESEARCH_MAX_PAGES` | no | `6` | 1–12 sources kept per run |
| `FETCH_TIMEOUT_SECONDS` | no | `8` | 1–30, per page (robots.txt included) |
| `FETCH_MAX_BYTES` | no | `2000000` | 10 KB–10 MB, enforced while reading |
| `RESEARCH_STALE_DAYS` | no | `730` | Sources older than this mark a claim as stale |

## Layout

| Module | Role |
|---|---|
| `contracts.py` | Pydantic payloads (results, checkpoints, model outputs), the source of truth for `contracts/*.schema.json` |
| `provider.py` | `ReasoningProvider` protocol, error classes, call records and the deterministic provider |
| `prompts.py` | Prompt registry: TOML frontmatter, load-time checks, fenced untrusted inputs |
| `llm.py` | Provider-neutral `ModelClient` port, token usage, verified price table, worst-case cost |
| `openai_adapter.py` | OpenAI Responses API adapter (`store=False`, no SDK retries, strict schema, error mapping) |
| `model_provider.py` | Model pipeline: stages, validation, one repair, citation guard, budget preflight |
| `factory.py` | Builds the configured provider; every problem is a start-up `CONFIG_INVALID` |
| `research.py` | Search port and Brave adapter; research errors and call records |
| `fetch.py` | Safe page fetcher: https, public addresses with pinned connections, robots.txt, publisher opt-outs, limits, text and metadata extraction |
| `passages.py` | Passage splitting and selection (lexical, deterministic), quote matching |
| `research_pipeline.py` | Evidence gathering, the claim/judgment guards, and the deterministic verification report |
| `retry.py` | Bounded retry with full-jitter backoff (transient errors only) |
| `store.py` | Lease-guarded Postgres reads and writes; transactional checkpoints |
| `executor.py` | One run: resume, cancel and budget checks, stage calls, failure policy |
| `__main__.py` | Claim loop, heartbeats, reconnect with backoff, SIGTERM handling |

## Boundary rules

- **Isolation:** never import or call the web app. Read and write only what migration 0004 grants `echiche_worker`; the transition trigger rejects anything else.
- **Secrets:** model and research provider keys live only in the worker's environment.
- **Prompts:** user content goes only into fenced data blocks (`prompts.render`), never into instructions. Add or change prompts only through the registry, with a version bump and a changelog entry.
- **Logging:** use `echiche_worker.log.log` (fields shared with the web app). Never log prompts, user content, model output or raw driver error messages.
