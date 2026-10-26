import { randomUUID } from "node:crypto";
import type {
  CreateProjectInput, Project, RunBudget, RunEvent, StartRunInput, ThoughtRun, UpdateProjectInput
} from "@/lib/domain/types";
import {
  ACTIVE_STATUSES, assertOwnerId, IdempotencyConflictError, ProjectArchivedError, RateLimitError, RunStateError,
  type CreateRunOptions, type OwnerScopedRepository, type Store
} from "./repository";

/**
 * In-memory Store for unit tests ONLY (no in-memory runtime mode exists). Mirrors the
 * Postgres semantics, including owner scoping and the user-decision rules of the DB
 * trigger, so route tests can exercise them without a database. `simulateWorker`
 * stands in for the Python worker.
 */
type Owned<T> = T & { ownerId: string };
type StoredRun = Owned<ThoughtRun> & { idempotencyKey?: string };

export class MemoryStore implements Store {
  readonly projects = new Map<string, Owned<Project>>();
  readonly runs = new Map<string, StoredRun>();
  readonly events = new Map<string, RunEvent[]>();

  forOwner(ownerId: string): OwnerScopedRepository {
    assertOwnerId(ownerId);
    return new MemoryOwnerRepository(this, ownerId);
  }
  async ping(): Promise<void> {}

  /** Test helper: apply what the worker would write. */
  simulateWorker(runId: string, patch: Partial<ThoughtRun>, event?: Pick<RunEvent, "type" | "stage" | "message">): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error("no such run");
    this.runs.set(runId, { ...run, ...patch, updatedAt: new Date().toISOString() });
    if (event) {
      const list = this.events.get(runId) ?? [];
      list.push({ ...event, id: randomUUID(), runId, sequence: list.length + 1, createdAt: new Date().toISOString() });
      this.events.set(runId, list);
    }
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DEMO_GENERATION: ThoughtRun["generation"] = {
  mode: "demo", providers: [], models: [], prompts: [], calls: 0, repairs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0
};
function strip<T extends object>(owned: Owned<T>): T {
  const copy: Partial<Owned<T> & { idempotencyKey?: string }> = { ...owned };
  delete copy.ownerId;
  delete copy.idempotencyKey;
  return copy as T;
}

class MemoryOwnerRepository implements OwnerScopedRepository {
  constructor(private readonly store: MemoryStore, readonly ownerId: string) {}

  private ownProject(id: string) {
    const p = this.store.projects.get(id);
    return p && p.ownerId === this.ownerId ? p : undefined;
  }
  private ownRun(id: string) {
    const r = this.store.runs.get(id);
    return r && r.ownerId === this.ownerId ? r : undefined;
  }
  private recentCount(items: Iterable<{ ownerId: string; createdAt: string }>): number {
    const since = Date.now() - HOUR_MS;
    return [...items].filter(i => i.ownerId === this.ownerId && Date.parse(i.createdAt) > since).length;
  }
  private save(run: StoredRun, patch: Partial<ThoughtRun>): ThoughtRun {
    const now = new Date().toISOString();
    const terminal = patch.status && ["completed", "failed", "cancelled"].includes(patch.status) && patch.status !== run.status;
    const updated: StoredRun = { ...run, ...patch, updatedAt: now, ...(terminal && { completedAt: now }) };
    this.store.runs.set(run.id, updated);
    return strip(updated);
  }

  async createProject(input: CreateProjectInput, maxPerHour: number): Promise<Project> {
    if (this.recentCount(this.store.projects.values()) >= maxPerHour) throw new RateLimitError("projects", 3600);
    const now = new Date().toISOString();
    const project: Owned<Project> = { id: randomUUID(), ...input, archivedAt: null, createdAt: now, updatedAt: now, ownerId: this.ownerId };
    this.store.projects.set(project.id, project);
    return strip(project);
  }
  async listProjects({ includeArchived }: { includeArchived: boolean }): Promise<Project[]> {
    return [...this.store.projects.values()]
      .filter(p => p.ownerId === this.ownerId && (includeArchived || p.archivedAt === null))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map(strip);
  }
  async getProject(id: string): Promise<Project | null> {
    const p = this.ownProject(id);
    return p ? strip(p) : null;
  }
  async updateProject(id: string, patch: UpdateProjectInput): Promise<Project | null> {
    const p = this.ownProject(id);
    if (!p) return null;
    const now = new Date().toISOString();
    const updated: Owned<Project> = {
      ...p,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.problemStatement !== undefined && { problemStatement: patch.problemStatement }),
      ...(patch.archived !== undefined && { archivedAt: patch.archived ? (p.archivedAt ?? now) : null }),
      updatedAt: now
    };
    this.store.projects.set(id, updated);
    return strip(updated);
  }

  async createRun(projectId: string, input: StartRunInput, options: CreateRunOptions) {
    const project = this.ownProject(projectId);
    if (!project) return null;
    if (options.idempotencyKey) {
      const existing = [...this.store.runs.values()].find(r => r.ownerId === this.ownerId && r.idempotencyKey === options.idempotencyKey);
      if (existing) {
        if (existing.projectId !== projectId || existing.prompt !== input.prompt) throw new IdempotencyConflictError();
        return { run: strip(existing), created: false };
      }
    }
    if (project.archivedAt) throw new ProjectArchivedError(projectId);
    if (this.recentCount(this.store.runs.values()) >= options.maxPerHour) throw new RateLimitError("runs", 3600);
    const now = new Date().toISOString();
    const run: StoredRun = {
      id: randomUUID(), projectId, prompt: input.prompt, status: "queued", result: null, generation: DEMO_GENERATION, errorCode: null,
      cancelRequested: false, attempt: 0, budget: { ...options.budget },
      usage: { steps: 0, activeSeconds: 0, researchCalls: 0, costUsd: 0 }, completedStages: [],
      createdAt: now, startedAt: null, updatedAt: now, completedAt: null,
      ownerId: this.ownerId, idempotencyKey: options.idempotencyKey
    };
    this.store.runs.set(run.id, run);
    this.store.events.set(run.id, []);
    return { run: strip(run), created: true };
  }
  async getRun(id: string): Promise<ThoughtRun | null> {
    const r = this.ownRun(id);
    return r ? strip(r) : null;
  }
  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    return [...this.store.runs.values()]
      .filter(r => r.ownerId === this.ownerId && r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map(strip);
  }
  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.ownRun(runId) ? [...(this.store.events.get(runId) ?? [])] : [];
  }
  async cancelRun(runId: string): Promise<ThoughtRun | null> {
    const run = this.ownRun(runId);
    if (!run) return null;
    if (run.status === "cancelled") return strip(run);
    if (run.status === "queued" || run.status === "paused_for_budget") return this.save(run, { status: "cancelled" });
    if ((ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
      return run.cancelRequested ? strip(run) : this.save(run, { cancelRequested: true });
    }
    throw new RunStateError(runId, run.status);
  }
  async acceptRun(runId: string): Promise<ThoughtRun | null> {
    const run = this.ownRun(runId);
    if (!run) return null;
    if (run.status === "completed") return strip(run);
    if (run.status !== "awaiting_user_review") throw new RunStateError(runId, run.status);
    return this.save(run, { status: "completed" });
  }
  async resumeRun(runId: string, increment: RunBudget): Promise<ThoughtRun | null> {
    const run = this.ownRun(runId);
    if (!run) return null;
    if (run.status === "queued" || (ACTIVE_STATUSES as readonly string[]).includes(run.status)) return strip(run);
    if (run.status !== "paused_for_budget") throw new RunStateError(runId, run.status);
    const b = run.budget;
    return this.save(run, {
      status: "queued", errorCode: null,
      budget: {
        maxSteps: b.maxSteps + increment.maxSteps, maxActiveSeconds: b.maxActiveSeconds + increment.maxActiveSeconds,
        maxResearchCalls: b.maxResearchCalls + increment.maxResearchCalls, maxCostUsd: b.maxCostUsd + increment.maxCostUsd
      }
    });
  }
}
