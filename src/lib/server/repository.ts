import type { CreateProjectInput, Project, ReasoningResult, RunEvent, StartRunInput, ThoughtRun } from "@/lib/domain/types";

export type AppendEventInput = Omit<RunEvent, "id" | "createdAt" | "sequence">;

/**
 * Storage port. Callers pass already-validated input; IDs are UUIDs.
 * NOTE (M2): every method gains an ownerId parameter; until then this is single-user only.
 */
export interface EchicheRepository {
  createProject(input: CreateProjectInput): Promise<Project>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createRun(projectId: string, input: StartRunInput): Promise<ThoughtRun>;
  getRun(id: string): Promise<ThoughtRun | null>;
  listRuns(projectId: string): Promise<ThoughtRun[]>;
  /** Assigns the next per-run sequence number. Assumes one writer per run (true until M3). */
  appendEvent(event: AppendEventInput): Promise<RunEvent>;
  /** Events in sequence order. */
  listEvents(runId: string): Promise<RunEvent[]>;
  /** running → succeeded. Throws RunStateError if the run is missing or not running. */
  completeRun(runId: string, result: ReasoningResult): Promise<ThoughtRun>;
  /** running → failed with a stable error code. Throws RunStateError if the run is missing or not running. */
  failRun(runId: string, errorCode: string): Promise<ThoughtRun>;
  /** Cheap connectivity probe for readiness checks. */
  ping(): Promise<void>;
}

export class RunStateError extends Error {
  readonly code = "RUN_STATE_CONFLICT";
  constructor(readonly runId: string, readonly expected: string) {
    super(`Run is missing or not in state "${expected}"`);
    this.name = "RunStateError";
  }
}

/** Raised when stored data no longer matches its contract (e.g. a JSONB result fails schema validation). */
export class DataIntegrityError extends Error {
  readonly code = "DATA_INTEGRITY";
  constructor(readonly entity: string, readonly entityId: string) {
    super(`Stored ${entity} failed contract validation`);
    this.name = "DataIntegrityError";
  }
}
