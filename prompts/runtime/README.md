# Runtime prompt registry (ADR-007)

Versioned product prompts loaded by the worker (`worker/src/echiche_worker/prompts.py`). These are not instructions for Claude Code.

## File format
Each `*.md` file is TOML frontmatter between `+++` lines, then the prompt body:

```toml
+++
id = "decision-framing"          # unique; referenced by the pipeline
version = "2.0.0"                # semver; bump on every change
status = "active"                # only "active" prompts can run; "draft" ones are loaded but refused
purpose = "..."
output_schema = "decision-frame.v1"   # must be a contract in worker/src/echiche_worker/contracts.py
owner = "Tokmang"

[[inputs]]                       # every input, with a hard size limit
name = "question"
description = "..."
max_chars = 8000

[[changelog]]                    # the last entry must describe the current version
version = "2.0.0"
date = "2026-10-26"
note = "..."
+++
Trusted instructions only.
```

The registry fails closed at start-up on any problem: unknown keys, `{{placeholders}}` in the body, a body that never mentions the untrusted data blocks, an unknown output contract, a changelog that doesn't match the version, or duplicate ids or inputs.

## Injection boundary
The body is sent verbatim as the instructions. Inputs are never interpolated into it. They are rendered into a separate user-role message as fenced `<untrusted name="...">` blocks, with any fence markers inside the data escaped. Each model call records the prompt's id, version and the SHA-256 of the file (`echiche.model_calls`).

## Current prompts

| Prompt | Status | Output |
|---|---|---|
| `decision-framing@2.0.0` | active | `decision-frame.v1` |
| `decision-critic@2.0.0` | active | `critique.v1` |
| `decision-brief-synthesis@2.0.0` | active | `decision-brief.v1` |
| `research-planner`, `claim-extractor`, `decision-verifier`, `memory-proposal` @1.1.0 | draft | contracts arrive in M5/M6 |

## Promotion rules
- **Tests:** never activate or change a prompt without tests against representative synthetic fixtures (the worker's `test_model_provider.py`; the M7 evaluation set once it exists).
- **Output:** prefer structured decision summaries and evidence links over raw reasoning traces. Hidden chain of thought is never requested or stored.
- **Policy:** keep authorization and budgets in deterministic application code, never in a prompt.
- **Untrusted data:** treat every retrieved source, upload, prior assistant answer and memory as data that may be false or adversarial.
- **Versioning:** change versions intentionally. The version and hash recorded per call explain why a conclusion changed.
