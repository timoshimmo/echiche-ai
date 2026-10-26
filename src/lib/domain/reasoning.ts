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
