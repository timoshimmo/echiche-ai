# ECHICHE

Founding Blueprint, PRD & Engineering Handoff

Long-Reasoning AI Thought Partner | Version 1.0 | 9 October 2026

Purpose: give product, engineering and technical leadership a practical specification for starting production implementation of Echiche 1.0.


### Core thesis

Echiche helps a person think through consequential problems over time by maintaining structured, user-controlled memory; conducting evidence-grounded research; challenging assumptions; tracking decisions; and revisiting conclusions when circumstances change.

Tagline: Echiche — Think Further.


## Document control and how to use this package


|Item|Definition|

|---|---|

|Status|Engineering-ready baseline for implementation planning. This document does not claim that software has already been built, tested or deployed.|

|Audience|Founder/product lead, technical co-founder, software engineers, AI engineer, designer and QA/security lead.|

|Source thesis|The Echiche Concept Note: long-horizon reasoning, cognitive continuity, cognitive graph, adaptive cognitive teams, decision history, verification and human authority controls.|

|Normative terms|MUST = release-blocking; SHOULD = expected unless a documented exception is approved; MAY = optional.|

|Engineering principle|Ship a small, safe, measurable product first. Do not start by building a new foundation model, marketplace, enterprise platform or unrestricted autonomous agent.|

|Start condition|Confirm stack and providers, set up repo/environments, convert requirements into issues, establish secrets policy and create an evaluation dataset.|




## Contents

1. 1. Executive decision and product thesis
1. 2. PRD, scope and user journeys
1. 3. Functional requirements and acceptance criteria
1. 4. Technical architecture and workflow
1. 5. Data model and cognitive memory
1. 6. APIs and contracts
1. 7. Technology stack and official resources
1. 8. Security, privacy and reliability
1. 9. Evaluation and release gates
1. 10. Cost-conscious implementation
1. 11. 90-day roadmap
1. 12. Production engineering playbook
1. 13. Risks and open decisions
1. 14. Engineer handoff checklist

## 1. Executive decision and product thesis


### 1.1 Recommended first product

Build Echiche Deep Thought for Startup Strategy Continuity. A founder creates a persistent project around one important decision. Echiche frames the problem, records assumptions, researches evidence, tests counterarguments, recommends a decision or next experiment, and saves the rationale so later sessions can assess what changed.


### 1.2 Product promise

“Echiche remembers the reasoning behind your decisions and helps you think through what comes next.”


### 1.3 Target user and job-to-be-done

Primary user: startup founder or small-team operator facing a high-value, uncertain decision over days or weeks. Job: connect what I know, what I believe, what evidence says, what could prove me wrong, and what I should do next—without starting from zero each time.


### 1.4 Why start here

- High consequence: better framing and evidence can change what a founder builds, tests or stops.
- Natural longitudinal use: decisions evolve as customer interviews, competitors and costs change.
- Clear MVP boundary: one project, a decision workflow, research, memory and a saved decision record.
- Testable differentiation: recall of prior rationale, evidence quality, contradiction detection and return-session usefulness.

### 1.5 Product principles

- Continuity over chat volume: optimize completed thinking workflows, not messages sent.
- Evidence before confidence: expose sources, assumptions, uncertainty and alternatives.
- Inspectable memory: users can view, correct, export and delete durable memories.
- Adaptive complexity: use the least expensive workflow that meets the quality bar.
- Human authority: Echiche may think, recommend and prepare; consequential external actions require explicit approval.
- Model independence: provider adapters allow model changes without rewriting domain logic.
- Measure before claiming: all performance claims require evaluation evidence.

## 2. PRD, scope and user journeys


### 2.1 Goals

- Create and resume a persistent strategic decision project.
- Run a bounded, resumable workflow combining context, research, hypotheses, critique and synthesis.
- Store structured decisions, assumptions, evidence and open questions.
- Show citations for researched claims and label unsupported uncertainty.
- Let users correct memories and record eventual decision outcomes.
- Provide run status, failure recovery, usage visibility and cost controls.
- Establish a repeatable benchmark for continuity and decision-support quality.

### 2.2 Non-goals for v1

- Training or hosting a foundation model from scratch.
- Always-on autonomous agents acting without user approval.
- Enterprise ingestion/SSO/SCIM, on-premise deployments or complex admin console.
- A public agent marketplace or user-created specialist-agent store.
- Guaranteed correctness or replacement for professional judgment.
- Integrations with every email, calendar, CRM, finance or project-management provider.
- A graph database before relational records and links prove insufficient.

### 2.3 Success metrics


|Metric|Definition|Proposed early gate|

|---|---|---|

|Workflow completion|Runs ending in a useful brief without unrecoverable error.|Baseline first; aim ≥85% completion in controlled test runs.|

|Memory fidelity|Correct recall of seeded facts/decisions and abstention when absent.|≥90% on curated benchmark before broader launch.|

|Citation validity|Sources open and plausibly support cited claims.|≥95% URL/source validity; human audit of support quality.|

|Continuity|Correctly identifies relevant prior assumptions and what changed.|≥80% on longitudinal benchmark as initial gate.|

|User-rated usefulness|Post-session rating that workflow advanced the decision.|Median ≥4/5 over at least 20 sessions; directional, not proof.|

|Repeat use|Design partners return to revisit a decision with new evidence.|At least 5 of first 10 active partners complete a second session.|

|Cost per successful run|Model, search, worker and storage costs per completed workflow.|Measured by run and bounded before paid pilots.|

|Security|Tenant isolation, secrets, authorization and dependency checks.|No unresolved critical/high issue at release.|



Targets are proposals, not achieved results. Revise them after baseline measurements. Do not market them as achieved until verified.


### 2.4 MVP feature list


|Priority|Feature|Acceptance summary|

|---|---|---|

|P0|Authentication|Secure sign-in/out; every private record scoped to authenticated owner.|

|P0|Project workspace|Create, rename, archive and reopen project with goal, context and status.|

|P0|Decision workflow|Submit question; see progress, citations, assumptions, risks and recommendation.|

|P0|Persistent history|Previous sessions retrievable within project.|

|P0|Structured memory|Save goals, assumptions, decisions, evidence and open questions with provenance.|

|P0|Decision journal|Record chosen option, rationale, rejected options, confidence and review trigger.|

|P0|Research and citations|Approved search provider; source title/URL/date linked to claims.|

|P0|Critic/verifier|Challenge claims, identify missing evidence and validate citations/schema.|

|P0|Checkpointing|Long runs resume/retry safely after transient failure.|

|P0|Budget guard|Limit steps, time, model/search calls and estimated cost.|

|P0|Memory controls|Inspect, correct, delete and export stored project data.|

|P1|Outcome review|Compare actual outcome with original expectation.|

|P1|Document upload|Safe text/PDF ingestion with size/type limits and provenance.|

|P1|Adaptive specialist roles|Researcher/strategist/skeptic invoked only where justified.|

|P2|Team workspaces and enterprise|Only after individual workflow proves value.|

|P2|Marketplace/API|Only after repeatable demand and stable evaluation.|




### 2.5 Primary user journey

- User signs in and creates a project: “Should we enter market X?”
- User supplies background, constraints, time horizon and decision criteria.
- Echiche restates the decision and asks for clarification only when a missing detail materially affects analysis.
- A run starts and displays stages: framing, assumptions, research, critique, verification and synthesis.
- Research tools gather evidence; source metadata and claims are stored with provenance.
- Critic identifies counterarguments and missing evidence; verifier checks citations and output structure.
- Decision brief presents recommendation, alternatives, evidence, uncertainty, risks and next experiments.
- User accepts, edits or rejects recommendation and saves the decision record.
- Later, user adds new evidence; Echiche compares it to prior assumptions and explains what changed.
- User records outcome; history is appended, not rewritten.

### 2.6 Decision brief schema

Every brief MUST include: decision question/scope; short recommendation; criteria; key assumptions; strongest supporting evidence; strongest counterevidence; alternatives; confidence/uncertainty; what would change the recommendation; next actions/experiments; citations; proposed memory updates.

Distinguish fact, inference, hypothesis, speculation and unknown. Do not expose or promise hidden chain-of-thought. Provide concise reasoning summaries, evidence, assumptions and decision-relevant explanations.


## 3. Functional requirements and acceptance criteria


|ID|Requirement|Acceptance criteria|

|---|---|---|

|AUTH-01|Authentication|Protected routes reject unauthenticated requests; logout invalidates session.|

|AUTH-02|Authorization|Reading/updating/deleting another user's project/run/file/memory is denied server-side.|

|PROJ-01|Project CRUD|Create/read/update/archive works; owner assigned from session, never client input.|

|RUN-01|Start run|Run ID, status, timestamps and budget persisted; UI shows queued/running/completed/failed.|

|RUN-02|Resumable execution|Checkpoint after meaningful stages; retry does not duplicate decisions/memory writes.|

|RUN-03|Budget enforcement|Pause/stop or ask approval when configured limit reached; never silently exceed cap.|

|RES-01|Source provenance|Store URL, title, retrieval time and relevant excerpt/summary when permitted.|

|RES-02|Citation grounding|Final citations map to stored sources; invalid references fail validation.|

|MEM-01|Memory writes|Propose durable memories; v1 should require confirmation for consequential beliefs/decisions.|

|MEM-02|Memory lifecycle|Correction supersedes old version; deletion cleans associated search/vector entries.|

|DEC-01|Decision history|Revision creates new version/event; original rationale remains auditable.|

|SAFE-01|External action approval|No external write/action without explicit user authorization and visible summary.|

|OBS-01|Telemetry|Log run/stage/provider/model/latency/usage/retries/error category; omit secrets and unnecessary private content.|

|TEST-01|CI gates|Lint, typecheck, unit, integration, authorization and production-build tests run in CI.|

|EXPORT-01|Data export|User can request machine-readable export of project and decision history.|




### 3.1 Run states

queued → planning → researching → critiquing → verifying → synthesizing → awaiting_user_review → completed. Any active state can become failed, cancelled or paused_for_budget. Persist state and timestamps. Retries must be idempotent and auditable.


### 3.2 Edge cases

- No sources found: disclose the limitation and lower confidence; ask for context if needed.
- Search/model provider unavailable: bounded retry with backoff, then fail safely or continue with explicit limitation.
- Malformed structured output: validate, attempt one bounded repair, then fail safely.
- Budget reached: checkpoint and ask whether to continue.
- Conflicting memories: show dated versions and explain proposed update; do not silently overwrite.
- Prompt injection in documents/web pages: treat content as untrusted data, never as system instructions.
- Project deletion: define confirmation, raw file removal, index cleanup and retention behavior.

## 4. Technical architecture and workflow


### 4.1 Logical architecture

Browser UI → application/API → authentication/authorization → run orchestration → model/tool adapters → research/evidence processing → critic/verifier → synthesis → project/decision/memory persistence. A background worker handles long-running jobs. PostgreSQL is the system of record; semantic retrieval is a permission-scoped index, not a replacement for canonical records.


### 4.2 Proposed deployment topology


|Layer|MVP choice|Reason|

|---|---|---|

|Frontend|Next.js App Router + TypeScript|Mature web stack and Node/container deployment options.|

|API|Next.js Route Handlers initially|Avoid separate API service overhead until scale justifies it.|

|Long jobs|Managed queue/background worker|Reasoning may take minutes; requests return run ID rather than waiting.|

|Database|Managed PostgreSQL|Relational records, migrations, JSONB where appropriate; pgvector only if useful.|

|Authentication|Managed auth provider|Avoid custom password/session code unless justified.|

|Files|Private object storage + short-lived signed URLs|Separate uploaded documents from public assets.|

|Models|Provider adapter; start with one strong API|Avoid integration sprawl while preserving switchability.|

|Search|One approved research/search API|Normalize results behind adapter and preserve citations.|

|Observability|Structured logs + error tracking + LLM tracing/evaluation|Trace stages and costs while minimizing private data in logs.|

|Hosting|Managed Node-compatible app host and managed DB|Reduce operational burden; choose region and terms carefully.|

|CI/CD|GitHub repository + Actions or equivalent|Automated gates, protected branches and deployment discipline.|




### 4.3 Architecture rules

- Use a deterministic state machine/workflow. Evaluate LangGraph when branching, checkpointing and human approval become complex; do not adopt it just because the product uses agents.
- Start with relational records and foreign-key links. Add pgvector only after retrieval tests prove value. Do not add a graph database in v1.
- Run deep thought asynchronously. Persist run ID/status and let UI poll or subscribe to updates.
- Implement provider-neutral interfaces with typed outputs, timeouts, retries and usage metadata.
- Tools are least-privileged and explicit. Model proposes calls; application validates arguments and permissions before execution.

### 4.4 Reasoning workflow

- Intake: validate user, project ownership, question, constraints and budget.
- Context assembly: retrieve relevant facts, decisions, sources and open questions with provenance/timestamps.
- Frame: define decision statement, success criteria, assumptions and research questions.
- Plan: create bounded tasks, dependencies, stop conditions and budget.
- Research: search, normalize source metadata, extract claims and store citations.
- Generate hypotheses: compare options and evidence; label fact vs inference.
- Critique: challenge claims, alternative explanations and missing evidence.
- Verify: source support, contradictions, output schema and budget.
- Synthesize: recommendation, uncertainty, alternatives and next actions.
- User review: accept/edit/reject brief and proposed memories.
- Persist: save brief, decision, sources, approved memory and safe run metadata.
- Revisit: compare new evidence to prior assumptions; preserve decision history.

### 4.5 Adaptive compute policy

Start with a simple, auditable router—not a learned routing model. Classify low/medium/high complexity using consequence, uncertainty, novelty, evidence needs and requested depth. Set model/search/step/time caps for each run. Escalate to a stronger model or critic only when justified. Log the route and compare quality/cost by class.


|Tier|Example|Workflow|Guardrail|

|---|---|---|---|

|Low|Summarize saved project or retrieve memory|Retrieval + one model call|Low cap; no debate.|

|Medium|Compare a few options with existing context|Targeted research + synthesis + critic on key claims|Limited searches and bounded output.|

|High|Consequential market-entry decision|Structured plan, multiple searches, critique and verification|Explicit budget, checkpoint and approval to extend.|




## 5. Data model and cognitive memory


### 5.1 Core entities


|Entity|Important fields|Purpose|

|---|---|---|

|users|id, auth_subject, created_at, settings|Account identity; auth provider is source of truth.|

|projects|id, owner_user_id, name, goal, context, status, timestamps|Long-lived decision workspace.|

|runs|id, project_id, owner_user_id, question, status, attempt, budget, timestamps, error_code|One workflow execution.|

|run_events|id, run_id, sequence, stage, event_type, safe_payload, created_at|Progress, checkpoint and audit metadata.|

|messages|id, project_id, run_id, role, content, created_at|Transcript, not the sole memory system.|

|sources|id, project_id, run_id, url, title, publisher, published_at, retrieved_at, hash, excerpt|Evidence provenance.|

|claims|id, project_id, run_id, text, claim_type, confidence_label|Claims extracted or asserted.|

|claim_sources|claim_id, source_id, relation_type, support_note|Support/contradict/context relationships.|

|memories|id, project_id, owner_user_id, type, content, provenance, confidence, valid_from/to, supersedes_id, confirmed, deleted_at|Durable facts, goals, beliefs and open questions.|

|decisions|id, project_id, run_id, question, option, rationale, alternatives, assumptions, confidence, review_trigger, version|Versioned decision record.|

|outcomes|id, decision_id, observed_outcome, observed_at, expected_vs_actual, notes|Feedback after a decision.|

|documents|id, project_id, storage_key, filename, mime_type, size, hash, ingest_status|Private uploads and ingestion state.|

|usage_events|id, user_id, run_id, provider, model, tokens, tool_cost, estimated_cost, latency|Cost attribution.|




### 5.2 Memory taxonomy

- Episodic: what happened in a session or experiment.
- Semantic: what is currently known, with provenance.
- Strategic: goals, constraints and success criteria.
- Decision: chosen options, rejected alternatives and rationale.
- Causal: why the decision was made and which assumptions mattered.
- Hypothesis: current belief and confidence.
- Evidence: support and contradiction for a claim.
- Temporal: how belief, plan or decision changed.

### 5.3 Memory write and retrieval policy

- Do not write every chat message to long-term memory.
- Extract candidates after a completed run; score durability, relevance, confidence and sensitivity.
- For v1, show proposed durable memories for user confirmation, especially consequential decisions and personal beliefs.
- Every memory has provenance: source run/message/document, timestamp, origin and confidence label.
- Represent changes as superseding/versioned records, not silent overwrites.
- Allow correction, deletion and export; propagate lifecycle changes to search/vector indexes.
- Filter by user/project permissions before semantic retrieval. Similarity never bypasses authorization.
- Hybrid retrieval: hard permission/project/type filters, explicit decision links, recency, keyword search, optional vector similarity and reranking.
- Prefer canonical decision records over vaguely similar chat snippets; benchmark retrieval using known answers.

### 5.4 Database constraints

- Owner/project scoping on all project records; enforce in application and database policy where supported.
- Foreign keys prevent orphaned decisions, sources, runs and documents.
- Idempotency keys prevent duplicate run-stage outputs and memory writes.
- Index owner_user_id, project_id, status, created_at and common foreign keys.
- All schema changes through reviewed migrations; no manual-only production changes.
- Define hard-delete versus soft-delete and retention rules before launch.

## 6. APIs and contracts


|Method + path|Purpose|Key behavior|

|---|---|---|

|GET /api/projects|List projects|Owner derived from session; paginated.|

|POST /api/projects|Create project|Validate fields; set owner server-side.|

|GET/PATCH /api/projects/:id|Read/update/archive|Authorize ownership on server.|

|GET /api/projects/:id/runs|List runs|Paginated and owner-scoped.|

|POST /api/projects/:id/runs|Start run|Validate, create run, enqueue, return 202 + run ID.|

|GET /api/runs/:id|Read status/result|Return only to authorized owner.|

|POST /api/runs/:id/cancel|Cancel run|Idempotent; worker checks between stages.|

|GET /api/projects/:id/memories|List memories|Filter by type/status; paginate.|

|PATCH /api/memories/:id|Correct/confirm|Create audit/version record.|

|DELETE /api/memories/:id|Delete memory|Clean linked indexes/derived data.|

|POST /api/decisions/:id/outcomes|Record outcome|Append outcome; do not rewrite original decision.|

|POST /api/projects/:id/export|Request export|Async export; short-lived private download URL.|




### 6.1 Example run request

{
  "question": "Should we enter market X in the next 12 months?",
  "constraints": {
    "budget": "limited",
    "time_horizon": "12 months",
    "risk_tolerance": "moderate"
  },
  "depth": "high",
  "budget": {
    "max_steps": 18,
    "max_search_calls": 8,
    "max_wall_time_seconds": 600
  }
}


### 6.2 Error contract

Return stable machine-readable codes such as UNAUTHENTICATED, FORBIDDEN, VALIDATION_ERROR, RATE_LIMITED, BUDGET_EXCEEDED, PROVIDER_TIMEOUT, PROVIDER_UNAVAILABLE, RUN_CANCELLED and INTERNAL_ERROR. Never expose stack traces, provider credentials or internal prompts to clients.


### 6.3 Internal interfaces

- ModelProvider.generateStructured(input, schema, options) → validated result + usage metadata.
- ResearchProvider.search(query, options) → normalized source records.
- MemoryService.retrieve(projectId, question, filters) → ranked records with provenance.
- MemoryService.proposeWrites(runId, brief) → candidates, not silent writes.
- RunOrchestrator.start(input) → runId; resume(runId); cancel(runId).
- Verifier.verify(brief, claims, sources) → validation report.
- BudgetService.authorizeStep(runId, plannedStep) → allow/deny/approval-required.
Use TypeScript strict mode, shared runtime schemas (e.g. Zod), explicit domain types, server-side authorization, idempotent writes and provider adapters. Version prompts in source control. Keep business logic out of UI components.


## 7. Technology stack and official resources


|Concern|Recommended default|Decision rule|

|---|---|---|

|Language|TypeScript for web and first backend|Python worker only if AI/data libraries materially improve velocity.|

|Web|Next.js App Router|Use team expertise; avoid multiple frameworks without reason.|

|UI|React + accessible component system|Use consistent design tokens and accessible components.|

|Database|Managed PostgreSQL|Provider-neutral migrations and backups.|

|Vector retrieval|pgvector only if benchmarked need|Relational links and full-text search may be enough initially.|

|Authentication|Managed auth provider|Compare security, pricing, region, export and integration.|

|Orchestration|Explicit state machine; evaluate LangGraph|Choose durable checkpoints, human approval and recoverability over agent hype.|

|Model API|One high-quality provider with structured outputs|Add another only when quality, availability or cost data justifies it.|

|Research|One search API behind adapter|Check terms, freshness, citations and source availability.|

|Queue|Managed queue/durable job service|Postgres-backed queue acceptable only if semantics are tested.|

|Testing|Vitest/Jest + Playwright|Unit, integration, auth and browser E2E coverage.|

|Observability|Structured logs, error tracking, LLM traces/evals|Minimize private content in telemetry.|

|CI/CD|GitHub Actions or equivalent|Protected branches, checks, scoped secrets and controlled deploys.|



These are recommendations, not mandatory vendors. Check current pricing, data-processing terms, region availability, API limits and versions before implementation.


|Official resource|URL|Use|

|---|---|---|

|Next.js App Router|https://nextjs.org/docs/app|Application structure and server/client components.|

|Next.js Authentication|https://nextjs.org/docs/app/guides/authentication|Auth/session concepts; use a mature auth library.|

|Next.js Deployment|https://nextjs.org/docs/app/getting-started/deploying|Node server, Docker and deployment options.|

|Supabase RLS|https://supabase.com/docs/guides/database/postgres/row-level-security|Database-level authorization and policy testing.|

|Supabase security|https://supabase.com/docs/guides/security/product-security|Auth, database, storage and production hardening.|

|OpenAI background mode|https://developers.openai.com/api/docs/guides/background|Reference for asynchronous long tasks if using this API; verify current retention/availability.|

|LangGraph persistence|https://langchain-ai.github.io/langgraph/concepts/durable_execution/|Checkpoints, resumability and long-lived workflows if selected.|

|LangGraph reference|https://langchain-ai.github.io/langgraph/reference/|Durable execution, human-in-loop and stateful agent patterns.|

|OWASP LLM Top 10|https://genai.owasp.org/llm-top-10/|Prompt injection, sensitive-data disclosure and output handling.|

|GitHub Actions|https://docs.github.com/en/actions|CI workflows and secrets.|

|Playwright|https://playwright.dev/docs/intro|Browser end-to-end tests.|

|Vitest|https://vitest.dev/guide/|TypeScript unit tests.|




### 7.1 Engineering study order

- Read Next.js App Router, authentication and deployment guides.
- Read chosen database provider's RLS, migrations, backup and storage-security guides.
- Read model API docs for structured outputs, tool calls, rate limits, usage, retention and background execution.
- Read OWASP LLM risks and create a threat model before enabling document ingestion/tools.
- Prototype one long-running workflow and test checkpoint/retry before building the full UI.
- Create a small benchmark before prompt tuning; version prompts and model settings.
- Review costs and data terms before users upload confidential documents.

## 8. Security, privacy and reliability


### 8.1 Minimum security controls

- Authenticate private API requests and authorize every resource server-side.
- Enable/test row-level security on exposed tables; test allowed and denied SELECT/INSERT/UPDATE/DELETE cases.
- Never expose service-role, model, search or database keys in browser bundles.
- Validate requests and all model outputs against schemas before storage/tool execution.
- Rate-limit sign-in, run creation, uploads, exports and expensive endpoints.
- Apply upload size/type limits, safe parsers and malware scanning where available.
- Treat web pages, documents and tool results as untrusted; defend against prompt injection.
- Never let model text decide authorization; enforce policy in deterministic code.
- Use least-privilege credentials and separate development/staging/production secrets.
- Encrypt in transit, use managed encryption at rest, and test backup/restore/deletion.
- Redact secrets and minimize private content in logs/traces/evaluation data.
- Audit permission denials, exports, deletion requests and approved external actions.

### 8.2 Privacy requirements

- Publish plain-language notice covering data collected, purposes, retention and provider processing.
- Make document ingestion and durable memory visible to users.
- Provide project export and deletion workflows.
- Define retention for transcripts, uploads, extracted text, embeddings, logs and provider records.
- Do not use private content for training/evaluation outside disclosed purposes without appropriate legal basis and consent where required.
- Obtain privacy/legal review for target markets and applicable data protection obligations.

### 8.3 AI safety controls

- Separate untrusted external content from system instructions.
- Use allowlisted tools and narrow arguments; never expose unrestricted shell, arbitrary SQL, filesystem or HTTP tools to the model.
- Require approval before sending messages, spending money or changing external records.
- Check that sources support claims; a citation existing does not prove it supports the claim.
- Prevent cross-user memory/source leakage.
- Run prompt-injection and data-exfiltration tests on documents and retrieved pages.
- Maintain audit trail for decision revisions and approvals.
- Do not position Echiche as a substitute for professional judgment in regulated/high-stakes domains.

### 8.4 Reliability targets


|Area|Initial policy|

|---|---|

|Availability|Set a target after provider choice; measure before making claims.|

|Timeouts|Bounded stage timeouts, retries with exponential backoff/jitter and checkpoint recovery.|

|Idempotency|Repeated start/retry does not duplicate durable decisions/memory.|

|Backups|Automated database backup and tested restore before paid pilot.|

|Recovery|Runbooks for stuck jobs, retry, cancellation, provider disablement and rollback.|

|Data loss|Persist checkpoint/final result before reporting completion.|

|Incident handling|Define severity, owner, communication and post-incident review.|




## 9. Evaluation and release gates


### 9.1 Benchmark design

Build evaluation before optimizing prompts. Every material prompt/model/retrieval/workflow change must run against a versioned benchmark. Keep a held-out test set. Start with 30–50 carefully authored cases and grow toward 100+; use synthetic, public or consented data.

- Known facts and absent facts: memory recall and abstention.
- Decision history: recall rationale and rejected alternatives.
- Changed evidence: test whether conclusions update rather than anchor.
- Conflicting sources: test uncertainty and disagreement handling.
- Prompt injection in document/page: test untrusted-content handling.
- Insufficient evidence: test whether system admits it cannot conclude.
- Budget exhaustion/provider timeout: checkpointing and honest failure.
- Cross-user access attempts: tenant isolation.
- Duplicate retries: idempotency.
- Outcome review: preserve expected vs actual without rewriting original decision.

### 9.2 Dimensions and scoring


|Dimension|Method|Score/measure|

|---|---|---|

|Factual correctness|Human-reviewed rubric/source check|0–4: incorrect to correct and qualified.|

|Citation support|Reviewer checks claim-source relation|Supported / partial / unsupported / invalid.|

|Memory retrieval|Seed known memories and distractors|Precision, recall, wrong-memory rate, abstention accuracy.|

|Temporal consistency|Add new evidence to historical versions|Correctly distinguishes old/new and explains changes.|

|Critical reasoning|Rubric for assumptions, alternatives and counterevidence|0–4 issue detection; track false alarms.|

|Decision usefulness|Blind user/expert ratings against criteria|0–5 usefulness plus rationale.|

|Cost efficiency|Usage telemetry per successful run|Cost/run and cost per benchmark point.|

|Latency/reliability|Repeated runs and fault injection|Completion rate, p50/p95 duration, recovery rate.|

|Security|Authorization, injection, dependency and secret scans|Zero critical/high unresolved issues for release.|




### 9.3 Required baselines

- A: one capable model call with the user's current prompt/context.
- B: research + synthesis without persistent memory.
- C: Echiche with persistent memory and critic/verifier.
- Compare on the same test set. Complex workflow ships only if meaningful quality improvement justifies extra cost/latency.

### 9.4 Release gates

- All P0 acceptance criteria pass in staging.
- CI passes lint, typecheck, unit/integration/E2E and production build.
- Authorization/RLS tests pass for allowed and denied operations.
- No unresolved critical/high security issue; no secrets in repository/client bundle.
- Evaluation report records benchmark/model/prompt versions, scores, costs and known failure modes.
- Manual review of at least 20 complete decision briefs before broader external pilot.
- Backup restore, cancellation, retry and provider outage procedures tested.
- Privacy notice, terms, support channel and deletion procedure ready.

## 10. Cost-conscious implementation


### 10.1 Cost strategy

- Start with one model and one research provider.
- Use complexity-based model tiers; don't debate on simple memory lookups.
- Set hard per-run limits for steps, time, model calls, searches and estimated cost.
- Retrieve relevant memory rather than replaying entire history.
- Cache stable research where permitted, with source timestamps/freshness rules.
- Deduplicate searches and sources.
- Use critic/verifier on consequential claims or sampled low-risk runs only if evaluations justify it.
- Checkpoint long runs to avoid repeating completed stages.
- Track costs by user/project/model/stage and alert on anomalies.
- Use low-cost managed tiers for prototype, but pay for backups/privacy/reliability needed in production.
Planning ranges below are estimates, not vendor quotes. Exclude founder salary, legal incorporation, major security audits, marketing and custom model training. Verify vendor prices before committing.


|Cost category|Lean prototype/month|Early pilot/month|Notes|

|---|---|---|---|

|App hosting/worker|$0–50|$20–150|Free tiers may not support reliable long-running jobs.|

|Database/auth/storage|$0–50|$25–150|Backups, bandwidth and storage drive cost.|

|Model inference|$50–300|$200–1,500|Highly variable; cap depth and measure cost per successful run.|

|Search API|$0–100|$50–300|Depends on query volume and provider.|

|Monitoring/evaluation|$0–50|$25–200|Avoid logging raw private content by default.|

|Domain/email/misc|$10–40|$20–80|Domain and transactional email.|

|Indicative total|$60–590|$340–2,380|Planning only, not a guaranteed cap.|



Initial management guardrail: aim to keep pilot infrastructure/API spend below roughly $500–$1,000/month until usage data justifies scaling. This is a target, not a guarantee.


### 10.2 Cost model and controls

Track total_run_cost = model input cost + model output cost + search cost + embedding/reranking cost + worker/storage allocation. Separate provider-reported values from estimates.

- Configure MAX_RUN_STEPS, MAX_SEARCH_CALLS, MAX_MODEL_CALLS, MAX_WALL_TIME and MAX_ESTIMATED_COST.
- Check budget before each expensive stage; pause and ask for approval if user budget would be exceeded.
- Use cheaper models for classification/extraction only after benchmark verification.
- Store compact summaries with source links but preserve causal rationale and key evidence.
- Build internal cost breakdown by stage before expensive plans are offered.
- Alert at 50%, 80% and 100% of monthly budget; rate-limit abuse.

## 11. 90-day roadmap


|Period|Workstream|Deliverables|Exit criteria|

|---|---|---|---|

|Week 1|Product/repo|Confirm wedge, stories, repo, ADRs, CI, environments, secrets policy and tracker.|App runs locally; CI passes.|

|Weeks 2–3|Core application|Auth, project CRUD, migrations, authorization, UI shell.|Cross-user denial tests pass.|

|Weeks 4–5|Runs/orchestration|Async lifecycle, worker/queue, state machine, timeline, retry/cancel/checkpoint.|Worker-failure test recovers without duplicate writes.|

|Weeks 6–7|Research/synthesis|Search adapter, source store, decision brief, citations, schema validation.|Run yields inspectable sources and structured brief.|

|Weeks 8–9|Memory/journal|Memory proposals, confirm/edit/delete, versioned decisions, retrieval.|Seeded memory benchmark meets agreed gate.|

|Weeks 10–11|Critic/budgets|Critic/verifier, adaptive tiers, caps, cost telemetry, fault handling.|Baseline comparison and cost/run report available.|

|Weeks 12–13|Hardening/pilot|Security, RLS, E2E, restore, privacy, onboarding and design-partner pilot.|Release gates pass; limitations and support path documented.|



This schedule assumes an experienced small team. If one engineer builds the product, reduce P1/P2 scope or extend the timeline rather than skipping authorization, data lifecycle, testing or evaluation.


## 12. Production engineering playbook


### 12.1 Suggested repository layout

echiche/
  apps/web/                 # Next.js UI and API routes
  apps/worker/              # Background worker if separate
  packages/domain/          # Domain types and business rules
  packages/schemas/         # Shared request/response/output schemas
  packages/ai/              # Model adapters and versioned prompts
  packages/orchestration/   # Run state machine and stage handlers
  packages/memory/          # Retrieval, write proposals, lifecycle
  packages/research/        # Search adapters and source normalization
  packages/evaluation/      # Benchmark runner, fixtures and scoring
  packages/observability/   # Logs, costs and traces
  db/migrations/
  db/tests/
  e2e/
  docs/ADRs/
  docs/runbooks/
  docs/security/
  .github/workflows/
  .env.example
  README.md


### 12.2 Branch and review policy

- Protect main; production deploys from reviewed, passing commits.
- Require review for auth, authorization, migrations, tool execution, tool-enabled prompts and deletion logic.
- Keep PRs small with purpose, screenshots, test evidence, migration notes and rollback plan.
- Use feature flags for risky workflows and model/provider changes.
- Never commit secrets, user data, raw production traces or customer documents.
- Pin dependencies and review vulnerability alerts in controlled batches.

### 12.3 Definition of done

- Requirement and acceptance criteria linked to issue/PR.
- Typecheck, lint, unit, integration and relevant E2E pass.
- Authorization/input validation covered.
- Telemetry added without secrets/unnecessary private content.
- Loading, empty, error, cancellation and retry states implemented.
- Migrations tested against staging data shape; rollback/forward-fix documented.
- Accessibility/responsive layout checked.
- Docs/runbooks updated; staging test and rollback plan complete.

### 12.4 Environments and secrets


|Environment|Rules|

|---|---|

|Local|Ignored .env.local; non-production keys and synthetic data.|

|CI|Scoped secrets; never print values in logs.|

|Staging|Separate DB, storage, auth config, API keys and webhook endpoints.|

|Production|Least privilege, rotation on exposure, restricted maintainer access and audit.|



.env.example contains variable names and descriptions only, never real values. Startup should fail clearly when required variables are missing.


## 13. Deployment, monitoring and incident response


### 13.1 Deployment sequence

- Provision separate development/staging/production resources.
- Apply reviewed migrations in staging; run database policy tests.
- Deploy app/worker from known commit; record release version.
- Smoke-test login, project access, run creation/status, memory correction and export/delete.
- Monitor error rate, completion, provider failure, queue age, cost and latency.
- Roll out to a small design-partner cohort; feature-flag new critic/routing logic.
- Keep prior release and rollback/forward-fix instructions available.

### 13.2 Monitoring signals


|Signal|Why it matters|

|---|---|

|Failure by run stage|Find whether issues originate in planning, research, verification or synthesis.|

|Queue age/worker heartbeat|Detect stuck jobs.|

|Provider timeout/rate-limit|Decide retry, fallback or provider disablement.|

|Cost per run/user|Protect unit economics and detect abuse.|

|Citation failure rate|Detect broken/unsupported research.|

|Memory correction/deletion rate|Signals memory quality or trust issues.|

|Authorization denials|Detect attack attempts or broken access assumptions.|

|p50/p95 latency|Sets user experience expectations.|

|Retry/idempotency metrics|Detects reliability issues and duplicate writes.|




### 13.3 Runbooks required before paid pilot

- Model provider outage/degraded quality.
- Search provider outage or terms change.
- Unexpected spend spike or abuse.
- Suspected cross-user data exposure.
- Bad migration/data corruption.
- Prompt injection causing unsafe tool behavior.
- Stuck jobs or duplicate outputs.
- Deletion/export failure.

## 14. Risks, open decisions and engineer handoff


|Risk/assumption|Mitigation|

|---|---|

|Memory may be inaccurate|Benchmark recall/abstention; show provenance; correction and version history.|

|Users may not pay|Test paid pilots; treat proposed price points as unvalidated.|

|Multi-agent debate may not help|Compare with single-agent baseline; enable only when quality lift justifies cost.|

|Long runs may time out|Async jobs, checkpoints, bounded retries and cancellation.|

|Strategy data is sensitive|Minimize data, isolate tenants, disclose provider processing and support export/delete.|

|Sources may conflict or be poor|Preserve dates/provenance, counterevidence and source-support checks.|

|90 days may be optimistic|Cut P1/P2 before weakening security/evaluation.|

|Vendor pricing/limits change|Recheck docs/pricing at implementation and quarterly.|

|Personalization can increase overconfidence|Distinguish user belief from verified fact; familiarity is not proof.|

|Competitors can copy features|Build measured workflow quality, trusted continuity, evaluations and integrations.|




### 14.1 Architecture decision records (ADRs)

- ADR-001: model provider and adapter contract.
- ADR-002: database/auth/storage provider and data region.
- ADR-003: background queue and resumability model.
- ADR-004: orchestration framework vs explicit state machine.
- ADR-005: memory taxonomy, write policy and deletion lifecycle.
- ADR-006: retrieval approach and vector index decision.
- ADR-007: search provider and source retention.
- ADR-008: tracing/logging privacy policy.
- ADR-009: provider data retention and training settings.
- ADR-010: run budgets and escalation behavior.

### 14.2 Engineer kickoff checklist

- Product owner confirms user, workflow, P0 scope and non-goals.
- Tech lead records architecture choices and verifies current pricing/terms.
- Repo, branch protection, CI, lint, typecheck and tests configured.
- Separate environments and secret-handling rules established.
- Schema/migrations reviewed; owner authorization tests written early.
- Auth and project CRUD implemented/tested.
- Run state machine, worker, checkpointing, cancellation and idempotency implemented.
- Research adapter stores provenance; citations render and validate.
- Decision brief schema, critic/verifier and budget guard implemented.
- Memory proposal/correction/deletion/provenance/versioning implemented.
- Evaluation dataset, baseline comparison and cost telemetry available.
- Threat model covers injection, data leakage, tool abuse, tenant isolation and cost abuse.
- Backup restore, incident runbooks, monitoring and rollback tested.
- Pilot consent/feedback/support/deletion-export path ready.
- Release gate report signed off before public or paid launch.

## Final implementation directive

Build Echiche as a dependable decision workflow with continuity—not an unrestricted agent swarm. Keep the first version small enough to ship, but production-minded: typed contracts, durable run state, traceable evidence, inspectable memory, strict authorization, cost limits and measurable evaluations.

Do not claim Echiche reasons better until benchmark results support that statement. The first defensible promise is narrower and testable: it can carry a strategic decision across sessions, preserve rationale and evidence, and help the user reassess when new information arrives.

End of blueprint.
