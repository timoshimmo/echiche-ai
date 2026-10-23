# Prompt 06 — Cognitive Memory and Decision Journal

<role>Act as a product-minded information retrieval engineer implementing inspectable, privacy-aware longitudinal memory.</role>

<context>Echiche's defensible value is continuity of thinking: what was decided, why it was decided, what evidence mattered, which assumptions remain valid and what changed. The founding blueprint defines episodic, semantic, strategic, decision, causal, hypothesis, evidence and temporal memory. Do not store every chat message as durable memory.</context>

<task>
Implement a user-controlled memory and decision journal:
1. Define a memory record with type, content, source run/document/message reference, provenance, created/observed times, confidence/status, sensitivity, owner/project scope, version/supersedes link and lifecycle status.
2. After a completed run, create proposed memory candidates; do not write permanent memory invisibly. The user can approve, edit or reject each proposal.
3. Support inspect, correction, versioning, deletion and export. Preserve historical decision rationale unless the user explicitly requests deletion under the retention policy; represent changed beliefs as a newer version that supersedes the earlier one.
4. Retrieve only after owner/project permission checks. Filter by project/type/recency and retrieve canonical decisions before optional semantic ranking.
5. If adding embeddings/vector retrieval, justify it with a benchmark and implement permission filtering before similarity search or enforce equivalent isolation in the retrieval layer.
6. Distinguish remembered fact from current fact; show provenance/time and surface contradictions with newer evidence.
7. Handle sensitive or uncertain candidate memories conservatively; ask user confirmation and avoid storing unnecessary sensitive data.
8. Build a synthetic fixture corpus with known memories and distractors to test recall, precision, abstention, temporal conflict and cross-project isolation.
</task>

<acceptance_criteria>
- Memory candidates are user-approved before durable write, except explicitly approved deterministic metadata covered by product policy.
- Each durable memory has retrievable provenance and version lineage.
- Correction, deletion and export tests pass; derived-index lifecycle is documented and tested if an index exists.
- Cross-user and cross-project retrieval isolation tests pass.
- A changed decision does not erase the historical reason for the prior decision.
- When relevant memory cannot be found confidently, Echiche says it does not know rather than fabricating recall.
</acceptance_criteria>

<constraints>
Do not ship a knowledge graph or vector database without an evaluation-backed need. Do not treat a similarity match as proof. Do not silently promote model summaries to user-verified facts. Do not store raw hidden chain-of-thought as memory.
</constraints>

<output>Include schema/migration changes, memory lifecycle diagram or prose, retrieval policy, seeded benchmark results, deletion/export limitations and user-visible correction flows.</output>
