import type {
  CreateProjectInput, Project, RunBudget, RunEvent, RunEvidence, StartRunInput, ThoughtRun, UpdateProjectInput
} from "@/lib/domain/types";

/**
 * Storage scoped to ONE owner. Every method only ever sees that owner's rows:
 * another owner's ID behaves exactly like a nonexistent ID (null / []).
 * Obtain one with Store.forOwner(userId) using an ID from a verified session; never
 * from request input. Callers pass already-validated input; IDs are UUIDs.
 *
 * Since M3 the web app never executes runs: it creates them (queued) and applies the
 * three user decisions (cancel, accept, resume). The Python worker does the rest, and
 * the database trigger rejects any other transition (migration 0004).
 */
export interface OwnerScopedRepository {
  readonly ownerId: string;
  /** Throws RateLimitError when the owner created `maxPerHour` projects in the last hour. */
  createProject(input: CreateProjectInput, maxPerHour: number): Promise<Project>;
  listProjects(options: { includeArchived: boolean }): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  updateProject(id: string, patch: UpdateProjectInput): Promise<Project | null>;
  /**
   * Queues a run. null when the project does not exist for this owner.
   * With an idempotency key, a repeat of the same request returns the original run
   * (`created: false`); reusing the key for a different request throws IdempotencyConflictError.
   * Throws ProjectArchivedError / RateLimitError.
   */
  createRun(projectId: string, input: StartRunInput, options: CreateRunOptions): Promise<{ run: ThoughtRun; created: boolean } | null>;
  getRun(id: string): Promise<ThoughtRun | null>;
  listRuns(projectId: string): Promise<ThoughtRun[]>;
  /** Events in sequence order. */
  listEvents(runId: string): Promise<RunEvent[]>;
  /** Sources the worker read and the claims verified against them (empty lists when none). */
  getEvidence(runId: string): Promise<RunEvidence>;
  /**
   * Idempotent. queued/paused → cancelled immediately; active → cancel requested (the worker
   * stops between stages); already cancelled → unchanged. Throws RunStateError for runs that
   * are awaiting review, completed or failed.
   */
  cancelRun(runId: string): Promise<ThoughtRun | null>;
  /** awaiting_user_review → completed. Idempotent for completed. RunStateError otherwise. */
  acceptRun(runId: string): Promise<ThoughtRun | null>;
  /**
   * paused_for_budget → queued, raising each cap by `increment` (explicit user approval).
   * Idempotent: a run that is no longer paused is returned unchanged if queued or active.
   * RunStateError for finished runs.
   */
  resumeRun(runId: string, increment: RunBudget): Promise<ThoughtRun | null>;
}

export type CreateRunOptions = { maxPerHour: number; budget: RunBudget; idempotencyKey?: string };

export interface Store {
  /** Throws if ownerId is not a UUID. */
  forOwner(ownerId: string): OwnerScopedRepository;
  /** Cheap connectivity probe for readiness checks. */
  ping(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertOwnerId(ownerId: string): void {
  if (!UUID.test(ownerId)) throw new Error("ownerId must be a UUID from a verified session");
}

export class RunStateError extends Error {
  readonly code = "RUN_STATE_CONFLICT";
  constructor(readonly runId: string, readonly status: string) {
    super(`Run is in state "${status}"`);
    this.name = "RunStateError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() {
    super("Idempotency key was already used for a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  constructor(readonly resource: "projects" | "runs", readonly retryAfterSeconds: number) {
    super(`Hourly ${resource} limit reached`);
    this.name = "RateLimitError";
  }
}

export class ProjectArchivedError extends Error {
  readonly code = "PROJECT_ARCHIVED";
  constructor(readonly projectId: string) {
    super("Project is archived");
    this.name = "ProjectArchivedError";
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

/** Single source for the web side of the user-decision rules (the DB trigger is authoritative). */
export const ACTIVE_STATUSES = ["planning", "researching", "critiquing", "verifying", "synthesizing"] as const;
