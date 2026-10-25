import { randomUUID } from "node:crypto";
import type {
  CreateProjectInput, Project, ReasoningResult, RunEvent, StartRunInput, ThoughtRun, UpdateProjectInput
} from "@/lib/domain/types";
import {
  assertOwnerId, ProjectArchivedError, RateLimitError, RunStateError,
  type AppendEventInput, type OwnerScopedRepository, type Store
} from "./repository";

/**
 * In-memory Store for unit tests ONLY. It is not wired into the running app (there is
 * no in-memory runtime mode since M2). Mirrors the Postgres semantics, including
 * owner scoping, so route tests can exercise cross-user denial without a database.
 */
type Owned<T> = T & { ownerId: string };

export class MemoryStore implements Store {
  readonly projects = new Map<string, Owned<Project>>();
  readonly runs = new Map<string, Owned<ThoughtRun>>();
  readonly events = new Map<string, RunEvent[]>();

  forOwner(ownerId: string): OwnerScopedRepository {
    assertOwnerId(ownerId);
    return new MemoryOwnerRepository(this, ownerId);
  }
  async ping(): Promise<void> {}
}

const HOUR_MS = 60 * 60 * 1000;
function strip<T extends object>(owned: Owned<T>): T {
  const copy: Partial<Owned<T>> = { ...owned };
  delete copy.ownerId;
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
  async createRun(projectId: string, input: StartRunInput, maxPerHour: number): Promise<ThoughtRun | null> {
    const project = this.ownProject(projectId);
    if (!project) return null;
    if (project.archivedAt) throw new ProjectArchivedError(projectId);
    if (this.recentCount(this.store.runs.values()) >= maxPerHour) throw new RateLimitError("runs", 3600);
    const run: Owned<ThoughtRun> = {
      id: randomUUID(), projectId, ...input, status: "running", result: null, errorCode: null,
      createdAt: new Date().toISOString(), completedAt: null, ownerId: this.ownerId
    };
    this.store.runs.set(run.id, run);
    this.store.events.set(run.id, []);
    return strip(run);
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
  async appendEvent(input: AppendEventInput): Promise<RunEvent> {
    if (!this.ownRun(input.runId)) throw new RunStateError(input.runId, "owned");
    const list = this.store.events.get(input.runId) ?? [];
    const event: RunEvent = { ...input, id: randomUUID(), sequence: list.length + 1, createdAt: new Date().toISOString() };
    list.push(event);
    this.store.events.set(input.runId, list);
    return event;
  }
  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.ownRun(runId) ? [...(this.store.events.get(runId) ?? [])] : [];
  }
  async completeRun(runId: string, result: ReasoningResult): Promise<ThoughtRun> {
    return this.transition(runId, { status: "succeeded", result: structuredClone(result) });
  }
  async failRun(runId: string, errorCode: string): Promise<ThoughtRun> {
    return this.transition(runId, { status: "failed", errorCode });
  }
  private transition(runId: string, patch: Partial<ThoughtRun>): ThoughtRun {
    const run = this.ownRun(runId);
    if (!run || run.status !== "running") throw new RunStateError(runId, "running");
    const updated: Owned<ThoughtRun> = { ...run, ...patch, completedAt: new Date().toISOString() };
    this.store.runs.set(runId, updated);
    return strip(updated);
  }
}
