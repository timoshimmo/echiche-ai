# Prompt 07 — Evaluation and Adaptive Compute

<role>Act as an AI evaluation engineer. Make Echiche's quality claims measurable before optimizing the system.</role>

<context>The founding blueprint says success is useful continuity and improved decision support, not message count. Evaluation must check factual correctness, citation support, memory recall/abstention, temporal consistency, critical reasoning, usefulness and cost. Multi-agent debate is not presumed to help.</context>

<task>
Build a small, reproducible evaluation harness and an auditable complexity router.
1. Define a versioned synthetic benchmark spanning known facts and absent facts, conflicting sources, changed assumptions, prior-decision recall, source grounding, adversarial instructions, budget exhaustion and no-evidence cases.
2. Create a rubric for factual correctness, citation support, memory recall/abstention, temporal consistency, counterevidence, decision usefulness and output-schema validity.
3. Add baseline comparisons: (A) one-pass synthesis with same inputs, (B) research plus synthesis, and (C) research plus critique/verifier and approved memory when implemented. Compare quality and cost rather than assuming the more complex pipeline wins.
4. Implement the simple low/medium/high router using consequence, uncertainty, novelty, evidence need and requested depth. Set explicit per-tier caps for calls, search, time and estimated spend.
5. Escalate to a stronger model, extra research or critique only when the policy justifies it; record route reason and outcome.
6. Record prompt version, model/provider version, benchmark version, quality scores, latency, usage and cost estimate with each evaluation. Do not place raw private customer content into evaluation logs by default.
7. Add regression gates for minimum rubric scores and maximum agreed cost/latency. Set thresholds only after baseline measurements and human review.
</task>

<acceptance_criteria>
- Benchmark runs locally/CI with deterministic fake provider and synthetic fixtures.
- Evaluation output is versioned and comparable across prompt/model changes.
- Router is deterministic and explainable; thresholds and caps are configuration, not hidden magic.
- Critic/verifier benefit is measured against a simpler baseline.
- Cost/latency information is captured where the provider exposes it; unknown costs are labeled unknown, not guessed.
- No public performance claims are generated from unreviewed benchmark results.
</acceptance_criteria>

<constraints>
Do not train a routing model in v1. Do not add debate loops by default. Do not optimize for token count at the expense of correctness. Do not use private customer data without the documented basis/consent and redaction controls.
</constraints>

<output>Provide dataset design, scoring definitions, baseline results if actually run, the router policy table, budget controls and recommended release gates with explicit caveats.</output>
