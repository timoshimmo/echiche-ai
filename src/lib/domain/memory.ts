import "./zod-setup";
import { z } from "zod";

/** Memory and decision journal (M6, ADR-009). Request schemas are strict: unknown keys are rejected. */
export const MEMORY_KINDS = ["goal", "constraint", "assumption", "decision", "open_question", "fact"] as const;
export const MEMORY_STATUSES = ["proposed", "active", "superseded", "rejected"] as const;
export const OUTCOME_RESULTS = ["as_expected", "better", "worse", "mixed", "too_early"] as const;
const LEVELS = ["low", "medium", "high"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type Memory = {
  id: string;
  lineageId: string;
  version: number;
  supersedesId: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus;
  /** model_proposal = suggested by a run, then reviewed by the user; user = entered or corrected by the user. */
  origin: "model_proposal" | "user";
  edited: boolean;
  sensitivity: "normal" | "sensitive";
  confidence: "low" | "medium" | "high" | null;
  sourceRunId: string | null;
  observedAt: string;
  createdAt: string;
  reviewedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
};

export type DecisionOutcome = {
  id: string;
  result: (typeof OUTCOME_RESULTS)[number];
  observedOutcome: string;
  observedOn: string;
  notes: string | null;
  createdAt: string;
};

export type Decision = {
  id: string;
  version: number;
  supersedesId: string | null;
  status: "active" | "superseded";
  origin: "accepted_brief" | "user_revision";
  sourceRunId: string | null;
  question: string;
  choice: string;
  rationale: string;
  alternatives: { option: string; why_not_now: string }[];
  assumptions: { statement: string; label: string; confidence: string }[];
  confidence: "low" | "medium" | "high" | null;
  reviewTriggers: string[];
  nextActions: { action: string; success_signal: string; reversible: boolean }[];
  createdAt: string;
  supersededAt: string | null;
  outcomes: DecisionOutcome[];
};

/** What a run was given from memory (provenance of the brief). */
export type RememberedContext = { ref: string; kind: string; content: string; observedAt: string; memoryId: string | null; decisionId: string | null };

const content = z.string().trim().min(1).max(500);

export const memoryFilterSchema = z
  .object({
    status: z.enum([...MEMORY_STATUSES, "all"]).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    q: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const createMemorySchema = z
  .object({ kind: z.enum(MEMORY_KINDS), content, confidence: z.enum(LEVELS).optional() })
  .strict();

/** Approving a proposal may edit it first; a sensitive proposal needs explicit confirmation. */
export const approveMemorySchema = z
  .object({ content: content.optional(), kind: z.enum(MEMORY_KINDS).optional(), confirmSensitive: z.boolean().optional() })
  .strict();

/** A correction creates a new version that supersedes the current one. */
export const correctMemorySchema = z
  .object({ content, kind: z.enum(MEMORY_KINDS).optional(), confidence: z.enum(LEVELS).nullable().optional() })
  .strict();

export const reviseDecisionSchema = z
  .object({
    choice: z.string().trim().min(1).max(1000),
    rationale: z.string().trim().min(1).max(4000),
    confidence: z.enum(LEVELS).nullable().optional()
  })
  .strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "invalid date");

export const outcomeSchema = z
  .object({
    result: z.enum(OUTCOME_RESULTS),
    observedOutcome: z.string().trim().min(1).max(2000),
    observedOn: isoDate.refine(v => Date.parse(`${v}T00:00:00Z`) <= Date.now() + 86_400_000, "cannot be in the future"),
    notes: z.string().trim().max(2000).optional()
  })
  .strict();

export type MemoryFilter = z.infer<typeof memoryFilterSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type ApproveMemoryInput = z.infer<typeof approveMemorySchema>;
export type CorrectMemoryInput = z.infer<typeof correctMemorySchema>;
export type ReviseDecisionInput = z.infer<typeof reviseDecisionSchema>;
export type OutcomeInput = z.infer<typeof outcomeSchema>;

export const EXPORT_SCHEMA_VERSION = "echiche-export.v1";
