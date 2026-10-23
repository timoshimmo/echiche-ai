// No runtime dependencies (only `import type`): safe to import from client components.
import type { ReasoningResult } from "./reasoning";

export type { ReasoningResult, ReasoningStage } from "./reasoning";

export type Project = {
  id: string;
  title: string;
  problemStatement: string;
  createdAt: string;
};

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_EVENT_TYPES = ["status", "stage", "result", "error"] as const;
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

export type ThoughtRun = {
  id: string;
  projectId: string;
  prompt: string;
  status: RunStatus;
  result: ReasoningResult | null;
  /** Stable machine-readable reason when status === "failed". */
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ThoughtRunWithEvents = ThoughtRun & { events: RunEvent[] };

export type CreateProjectInput = {
  title: string;
  problemStatement: string;
};

export type StartRunInput = {
  prompt: string;
};

export type PersistenceMode = "postgres" | "in-memory-demo";
