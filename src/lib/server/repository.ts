import type {
  ApproveMemoryInput, CorrectMemoryInput, CreateMemoryInput, Decision, DecisionOutcome, Memory, MemoryFilter, OutcomeInput,
  RememberedContext, ReviseDecisionInput
} from "@/lib/domain/memory";
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
  /** Remembered items the run was given (empty when none). */
  getRememberedContext(runId: string): Promise<RememberedContext[]>;

  // --- memory and decision journal (M6, ADR-009). null = project/memory/decision not found for this owner.
  listMemories(projectId: string, filter: MemoryFilter): Promise<Memory[] | null>;
  createMemory(projectId: string, input: CreateMemoryInput): Promise<Memory | null>;
  /** proposed → active (optionally edited first). Throws MemoryStateError / SensitiveConfirmationError. */
  approveMemory(memoryId: string, input: ApproveMemoryInput): Promise<Memory | null>;
  /** proposed → rejected. Idempotent for rejected. */
  rejectMemory(memoryId: string): Promise<Memory | null>;
  /** active → superseded, plus a new active version with the corrected content. Returns the new version. */
  correctMemory(memoryId: string, input: CorrectMemoryInput): Promise<Memory | null>;
  /** All versions of the memory's lineage, oldest first. */
  memoryHistory(memoryId: string): Promise<Memory[] | null>;
  /** Hard-deletes the whole lineage (all versions). false when not found. */
  deleteMemory(memoryId: string): Promise<boolean>;
  /** All decision versions for the project, newest first, each with its outcomes. */
  listDecisions(projectId: string): Promise<Decision[] | null>;
  /** Appends a new version superseding the active one (the earlier rationale is kept). Throws DecisionStateError. */
  reviseDecision(decisionId: string, input: ReviseDecisionInput): Promise<Decision | null>;
  /** Appends an outcome observation; never edits the decision. */
  addOutcome(decisionId: string, input: OutcomeInput): Promise<DecisionOutcome | null>;
  /** Hard-deletes the project and everything under it. false when not found. */
  deleteProject(projectId: string): Promise<boolean>;
  /** Machine-readable export of everything stored for the project (EXPORT-01). */
  exportProject(projectId: string): Promise<Record<string, unknown> | null>;
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

/** budget = the operator's configured caps; the router may tighten them per tier (ADR-010). */
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

export class MemoryStateError extends Error {
  readonly code = "MEMORY_STATE_CONFLICT";
  constructor(readonly memoryId: string, readonly status: string) {
    super(`Memory is in state "${status}"`);
    this.name = "MemoryStateError";
  }
}

export class DecisionStateError extends Error {
  readonly code = "DECISION_STATE_CONFLICT";
  constructor(readonly decisionId: string) {
    super("Only the active decision version can be revised");
    this.name = "DecisionStateError";
  }
}

export class SensitiveConfirmationError extends Error {
  readonly code = "SENSITIVE_CONFIRMATION_REQUIRED";
  constructor(readonly memoryId: string) {
    super("Sensitive memory proposals need explicit confirmation");
    this.name = "SensitiveConfirmationError";
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
