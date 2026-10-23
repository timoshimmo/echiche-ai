# Prompt 04 — Real Model Provider, Typed Contracts and Prompt Registry

<role>Act as an experienced LLM application engineer focused on provider independence, structured output, robust validation and cost telemetry.</role>

<context>The prototype's deterministic reasoning path is a demonstration, not an AI provider. Echiche needs a real model adapter behind an interface, versioned application prompts, typed output schemas, bounded provider calls and usage metadata. Do not embed provider calls in UI or route handlers.</context>

<task>
After confirming the chosen provider and current API/pricing/data terms, implement one real provider integration behind a provider-neutral interface.
1. Define a `ModelProvider` contract for a structured generation call with input, output schema, model/effort options, deadline and budget; return validated output plus usage/provider metadata.
2. Implement the selected provider adapter and a deterministic fake adapter for unit tests.
3. Validate environment settings on startup; keep API keys on the server and redact them everywhere.
4. Add request timeout, bounded retries for retryable errors, rate-limit handling and safe failure codes.
5. Create a versioned prompt registry under `prompts/runtime/`. Each prompt identifies its version, purpose, expected input, required output schema, safety rules and owner/change notes.
6. Keep external user content, retrieved memories, web content and uploaded documents in clearly delimited untrusted-data fields; never merge them into trusted instructions.
7. Validate model output against a runtime schema before any persistence or tool call. On malformed output, allow at most one bounded repair attempt when useful, then fail safely.
8. Record prompt version, model/provider ID, timestamp, latency, token/usage counts and cost estimate where available. Avoid storing hidden reasoning or raw private content in telemetry.
9. Update the UI to accurately distinguish live model output from deterministic demo mode.
</task>

<acceptance_criteria>
- Provider interface has unit tests against a fake provider.
- Live provider integration has a small explicit smoke test that is opt-in and cannot run accidentally in CI without credentials.
- Invalid/malformed model output is rejected before storage/tool execution.
- Retry/timeout/429 handling is bounded and tested.
- Prompt version and model/provider version are recorded with each run.
- No API key can be accessed from browser code or committed files.
- Model choice, context window, terms and price assumptions are verified against current official provider documentation before implementation.
</acceptance_criteria>

<constraints>
Do not hard-code a provider into domain logic. Do not invent model names, capabilities, prices or retention terms. Do not send the user's full project history if a scoped retrieval result will do. Do not expose hidden chain-of-thought; store concise rationales and validated outputs only.
</constraints>

<output>Include interface/schema definitions, prompt registry changes, provider behavior, tests and commands/results, verified external assumptions with official documentation links, estimated cost visibility, and remaining limitations.</output>
