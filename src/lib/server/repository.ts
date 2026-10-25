import type {
  CreateProjectInput, Project, ReasoningResult, RunEvent, StartRunInput, ThoughtRun, UpdateProjectInput
} from "@/lib/domain/types";

export type AppendEventInput = Omit<RunEvent, "id" | "createdAt" | "sequence">;

/**
 * Storage scoped to ONE owner. Every method only ever sees that owner's rows:
 * another owner's ID behaves exactly like a nonexistent ID (null / [] / RunStateError).
 * Obtain one with Store.forOwner(userId) using an ID from a verified session; never
 * from request input. Callers pass already-validated input; IDs are UUIDs.
 */
export interface OwnerScopedRepository {
  readonly ownerId: string;
  /** Throws RateLimitError when the owner created `maxPerHour` projects in the last hour. */
  createProject(input: CreateProjectInput, maxPerHour: number): Promise<Project>;
  listProjects(options: { includeArchived: boolean }): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  updateProject(id: string, patch: UpdateProjectInput): Promise<Project | null>;
  /**
   * null when the project does not exist for this owner. Throws ProjectArchivedError
   * for archived projects and RateLimitError when the hourly run limit is reached.
   */
  createRun(projectId: string, input: StartRunInput, maxPerHour: number): Promise<ThoughtRun | null>;
  getRun(id: string): Promise<ThoughtRun | null>;
  listRuns(projectId: string): Promise<ThoughtRun[]>;
  /** Assigns the next per-run sequence number. Assumes one writer per run (true until M3). */
  appendEvent(event: AppendEventInput): Promise<RunEvent>;
  /** Events in sequence order. */
  listEvents(runId: string): Promise<RunEvent[]>;
  /** running → succeeded. Throws RunStateError if the run is missing, not this owner's, or not running. */
  completeRun(runId: string, result: ReasoningResult): Promise<ThoughtRun>;
  /** running → failed with a stable error code. Same guards as completeRun. */
  failRun(runId: string, errorCode: string): Promise<ThoughtRun>;
}

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
  constructor(readonly runId: string, readonly expected: string) {
    super(`Run is missing or not in state "${expected}"`);
    this.name = "RunStateError";
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
