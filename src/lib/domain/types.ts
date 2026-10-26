// No runtime dependencies (only `import type`): safe to import from client components.
import type { ReasoningResult } from "./reasoning";

export type { ReasoningResult, ReasoningStage } from "./reasoning";

/** Owner is implicit (the signed-in user) and never serialised to clients. */
export type Project = {
  id: string;
  title: string;
  problemStatement: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Execution stages, in order (blueprint §3.1). The worker owns these transitions. */
export const RUN_STAGES = ["planning", "researching", "critiquing", "verifying", "synthesizing"] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const RUN_STATUSES = [
  "queued", ...RUN_STAGES, "awaiting_user_review", "completed", "failed", "cancelled", "paused_for_budget"
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** No further automatic progress: the UI stops polling. */
export const SETTLED_STATUSES: readonly RunStatus[] = ["awaiting_user_review", "completed", "failed", "cancelled", "paused_for_budget"];

export const RUN_EVENT_TYPES = ["status", "stage", "result", "error", "budget"] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunEvent = {
  id: string;
  runId: string;
  /** 1-based, strictly increasing per run. The only reliable event order. */
  sequence: number;
  type: RunEventType;
  stage: string;
  message: string;
  createdAt: string;
};

export type RunBudget = { maxSteps: number; maxActiveSeconds: number; maxResearchCalls: number; maxCostUsd: number };
export type RunUsage = { steps: number; activeSeconds: number; researchCalls: number; costUsd: number };

export type ThoughtRun = {
  id: string;
  projectId: string;
  prompt: string;
  status: RunStatus;
  result: ReasoningResult | null;
  /** Stable machine-readable reason (failed, paused, or the last transient retry). See RUN_ERROR_MESSAGES. */
  errorCode: string | null;
  cancelRequested: boolean;
  attempt: number;
  budget: RunBudget;
  usage: RunUsage;
  /** Stages with a committed checkpoint, in order. */
  completedStages: RunStage[];
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
};

export type ThoughtRunWithEvents = ThoughtRun & { events: RunEvent[] };

/** Safe, user-facing explanations for stable run error codes. */
export const RUN_ERROR_MESSAGES: Record<string, string> = {
  BUDGET_STEPS: "Paused: the step budget for this run was used up.",
  BUDGET_TIME: "Paused: the processing-time budget for this run was used up.",
  BUDGET_RESEARCH: "Paused: the research budget for this run was used up.",
  BUDGET_COST: "Paused: the spending budget for this run was used up.",
  PROVIDER_TIMEOUT: "The reasoning service took too long to respond.",
  PROVIDER_UNAVAILABLE: "The reasoning service was temporarily unavailable.",
  INVALID_PROVIDER_OUTPUT: "The reasoning service returned output that failed validation.",
  RESULT_INVALID: "The final result failed validation and was not saved.",
  CHECKPOINT_INVALID: "Saved progress for this run could not be read.",
  RUN_RETRIES_EXHAUSTED: "The run failed after several attempts.",
  RUN_ABANDONED: "This run was interrupted before background processing existed.",
  WORKER_SHUTDOWN: "The run was paused for maintenance and will continue automatically.",
  INTERNAL_ERROR: "Something went wrong while processing this run."
};

export type CreateProjectInput = {
  title: string;
  problemStatement: string;
};

/** At least one field. `archived: true` archives (idempotent); `false` unarchives. */
export type UpdateProjectInput = {
  title?: string;
  problemStatement?: string;
  archived?: boolean;
};

export type StartRunInput = {
  prompt: string;
};

export type CurrentUser = { id: string; email: string | null };
