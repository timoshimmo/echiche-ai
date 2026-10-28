import "./zod-setup";
import { z } from "zod";

/**
 * Stored-result contract, version "reasoning-scaffold.v1" (ADR-003).
 * The source of truth is the worker's Pydantic model (worker/src/echiche_worker/contracts.py),
 * exported to contracts/reasoning-scaffold.v1.schema.json. This Zod mirror is checked
 * against that schema and the shared fixtures in contracts.test.ts, so drift fails CI.
 * Runs are produced only by the Python worker since M3.
 */
export const REASONING_RESULT_SCHEMA_VERSION = "reasoning-scaffold.v1";

export const reasoningStageSchema = z
  .object({
    stage: z.enum(["frame", "challenge", "synthesize"]),
    title: z.string().min(1),
    content: z.string().min(1)
  })
  .strict();

export const reasoningResultSchema = z
  .object({
    summary: z.string().min(1),
    stages: z.array(reasoningStageSchema).min(1),
    caveat: z.string().min(1)
  })
  .strict();

export type ReasoningStage = z.infer<typeof reasoningStageSchema>;
export type ReasoningResult = z.infer<typeof reasoningResultSchema>;

/**
 * Model-generated decision brief, version "decision-brief.v1" (M4, ADR-007). Mirrors
 * DecisionBriefV1 in the worker's contracts.py and contracts/decision-brief.v1.schema.json.
 * The worker enforces string bounds with Pydantic validators (OpenAI strict mode does not
 * support string-length keywords), so the generated schema has no maxLength; this mirror
 * re-applies them so the web app never renders a payload the worker would have rejected.
 */
export const DECISION_BRIEF_SCHEMA_VERSION = "decision-brief.v1";

const bounded = (max: number) => z.string().trim().min(1).max(max);
const short = bounded(200);
const medium = bounded(500);
const long = bounded(1500);
const epistemicLabel = z.enum(["fact", "inference", "hypothesis", "speculation", "unknown"]);
const level = z.enum(["low", "medium", "high"]);

const assumptionSchema = z.object({ statement: medium, label: epistemicLabel, confidence: level }).strict();
const evidencePointSchema = z.object({ point: medium, label: epistemicLabel, source_ids: z.array(short).max(5) }).strict();

export const decisionBriefSchema = z
  .object({
    decision_question: medium,
    scope: medium,
    recommendation: z.object({ summary: medium, rationale: long }).strict(),
    criteria_and_tradeoffs: z.array(z.object({ criterion: short, tradeoff: medium }).strict()).min(1).max(8),
    key_assumptions: z.array(assumptionSchema).max(10),
    supporting_evidence: z.array(evidencePointSchema).max(8),
    counterevidence: z.array(evidencePointSchema).max(8),
    strongest_objection: long,
    alternatives: z.array(z.object({ option: short, why_not_now: medium }).strict()).min(1).max(6),
    confidence: z.object({ level, explanation: long }).strict(),
    what_would_change: z.array(medium).min(1).max(8),
    next_actions: z.array(z.object({ action: medium, success_signal: medium, reversible: z.boolean() }).strict()).min(1).max(6),
    citations: z.array(z.object({ source_id: short, supports: medium }).strict()).max(20),
    proposed_memory_updates: z
      .array(z.object({ kind: z.enum(["goal", "constraint", "assumption", "decision", "open_question"]), statement: medium }).strict())
      .max(10),
    limitations: z.array(medium).max(10)
  })
  .strict();

export type DecisionBrief = z.infer<typeof decisionBriefSchema>;

/** A stored run result, tagged with the contract version recorded beside it. */
export type RunResult =
  | { schemaVersion: typeof REASONING_RESULT_SCHEMA_VERSION; data: ReasoningResult }
  | { schemaVersion: typeof DECISION_BRIEF_SCHEMA_VERSION; data: DecisionBrief };

/** Validates a stored payload against the contract its version names; null if unknown or invalid. */
export function parseRunResult(schemaVersion: string | null, payload: unknown): RunResult | null {
  if (schemaVersion === REASONING_RESULT_SCHEMA_VERSION) {
    const parsed = reasoningResultSchema.safeParse(payload);
    return parsed.success ? { schemaVersion, data: parsed.data } : null;
  }
  if (schemaVersion === DECISION_BRIEF_SCHEMA_VERSION) {
    const parsed = decisionBriefSchema.safeParse(payload);
    return parsed.success ? { schemaVersion, data: parsed.data } : null;
  }
  return null;
}
