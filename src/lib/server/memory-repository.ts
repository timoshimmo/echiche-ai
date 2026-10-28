import { randomUUID } from "node:crypto";
import { classify, tierBudget } from "@/lib/domain/routing";
import type {
  CreateProjectInput, Project, RunBudget, RunEvent, RunEvidence, StartRunInput, ThoughtRun, UpdateProjectInput
} from "@/lib/domain/types";
import {
  EXPORT_SCHEMA_VERSION,
  type ApproveMemoryInput, type CorrectMemoryInput, type CreateMemoryInput, type Decision, type DecisionOutcome, type Memory,
  type MemoryFilter, type OutcomeInput, type RememberedContext, type ReviseDecisionInput
} from "@/lib/domain/memory";
import {
  ACTIVE_STATUSES, assertOwnerId, DecisionStateError, IdempotencyConflictError, MemoryStateError, ProjectArchivedError,
  RateLimitError, RunStateError, SensitiveConfirmationError,
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
  readonly evidence = new Map<string, RunEvidence>();
  readonly memories = new Map<string, Owned<Memory> & { projectId: string }>();
  readonly decisions = new Map<string, Owned<Decision> & { projectId: string }>();
  readonly remembered = new Map<string, RememberedContext[]>();

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
        if (existing.projectId !== projectId || existing.prompt !== input.prompt || existing.route.requestedDepth !== (input.depth ?? "auto")) {
          throw new IdempotencyConflictError();
        }
        return { run: strip(existing), created: false };
      }
    }
    if (project.archivedAt) throw new ProjectArchivedError(projectId);
    if (this.recentCount(this.store.runs.values()) >= options.maxPerHour) throw new RateLimitError("runs", 3600);
    const now = new Date().toISOString();
    const remembered = [...this.store.memories.values()].some(m => m.projectId === projectId && m.status === "active")
      || [...this.store.decisions.values()].some(d => d.projectId === projectId && d.status === "active");
    const depth = input.depth ?? "auto";
    const decision = classify({ prompt: input.prompt, depth, hasMemory: remembered });
    const run: StoredRun = {
      id: randomUUID(), projectId, prompt: input.prompt, status: "queued", result: null, generation: DEMO_GENERATION, errorCode: null,
      route: { requestedDepth: depth, tier: decision.tier, reasons: decision.reasons, policyVersion: decision.policyVersion, escalation: null },
      cancelRequested: false, attempt: 0, budget: tierBudget(decision.tier, options.budget),
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
  async getEvidence(runId: string): Promise<RunEvidence> {
    const evidence = this.ownRun(runId) ? this.store.evidence.get(runId) : undefined;
    return evidence ?? { sources: [], claims: [] };
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
    const saved = this.save(run, { status: "completed" });
    if (run.result?.schemaVersion === "decision-brief.v1" && ![...this.store.decisions.values()].some(d => d.sourceRunId === runId)) {
      const b = run.result.data;
      this.newDecision(run.projectId, {
        origin: "accepted_brief", sourceRunId: runId, question: b.decision_question, choice: b.recommendation.summary,
        rationale: b.recommendation.rationale, alternatives: b.alternatives, assumptions: b.key_assumptions,
        confidence: b.confidence.level, reviewTriggers: b.what_would_change, nextActions: b.next_actions
      });
    }
    return saved;
  }

  // --- memory and decision journal (mirrors postgres-memory.ts for route tests) -----------
  private ownMemory(id: string) {
    const m = this.store.memories.get(id);
    return m && m.ownerId === this.ownerId ? m : undefined;
  }
  private plainMemory(m: Owned<Memory> & { projectId: string }): Memory {
    const copy: Partial<typeof m> = { ...m };
    delete copy.ownerId;
    delete copy.projectId;
    return copy as Memory;
  }
  private putMemory(projectId: string, m: Memory): Memory {
    this.store.memories.set(m.id, { ...m, ownerId: this.ownerId, projectId });
    return m;
  }
  async getRememberedContext(runId: string): Promise<RememberedContext[]> {
    return this.ownRun(runId) ? [...(this.store.remembered.get(runId) ?? [])] : [];
  }
  async listMemories(projectId: string, filter: MemoryFilter): Promise<Memory[] | null> {
    if (!this.ownProject(projectId)) return null;
    const status = filter.status ?? "active";
    return [...this.store.memories.values()]
      .filter(m => m.ownerId === this.ownerId && m.projectId === projectId && (status === "all" || m.status === status))
      .filter(m => !filter.kind || m.kind === filter.kind)
      .filter(m => !filter.q || m.content.toLowerCase().includes(filter.q.toLowerCase()))
      .map(m => this.plainMemory(m));
  }
  async createMemory(projectId: string, input: CreateMemoryInput): Promise<Memory | null> {
    if (!this.ownProject(projectId)) return null;
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.putMemory(projectId, {
      id, lineageId: id, version: 1, supersedesId: null, kind: input.kind, content: input.content, status: "active", origin: "user",
      edited: false, sensitivity: "normal", confidence: input.confidence ?? null, sourceRunId: null, observedAt: now, createdAt: now,
      reviewedAt: now, validFrom: now, validTo: null
    });
  }
  async approveMemory(memoryId: string, input: ApproveMemoryInput): Promise<Memory | null> {
    const m = this.ownMemory(memoryId);
    if (!m) return null;
    if (m.status === "active") return this.plainMemory(m);
    if (m.status !== "proposed") throw new MemoryStateError(memoryId, m.status);
    if (m.sensitivity === "sensitive" && input.confirmSensitive !== true) throw new SensitiveConfirmationError(memoryId);
    const content = input.content ?? m.content;
    const kind = input.kind ?? m.kind;
    const now = new Date().toISOString();
    return this.putMemory(m.projectId, {
      ...this.plainMemory(m), status: "active", content, kind, edited: content !== m.content || kind !== m.kind,
      reviewedAt: now, validFrom: now
    });
  }
  async rejectMemory(memoryId: string): Promise<Memory | null> {
    const m = this.ownMemory(memoryId);
    if (!m) return null;
    if (m.status === "rejected") return this.plainMemory(m);
    if (m.status !== "proposed") throw new MemoryStateError(memoryId, m.status);
    return this.putMemory(m.projectId, { ...this.plainMemory(m), status: "rejected", reviewedAt: new Date().toISOString() });
  }
  async correctMemory(memoryId: string, input: CorrectMemoryInput): Promise<Memory | null> {
    const m = this.ownMemory(memoryId);
    if (!m) return null;
    if (m.status !== "active") throw new MemoryStateError(memoryId, m.status);
    const now = new Date().toISOString();
    this.putMemory(m.projectId, { ...this.plainMemory(m), status: "superseded", validTo: now });
    return this.putMemory(m.projectId, {
      ...this.plainMemory(m), id: randomUUID(), version: m.version + 1, supersedesId: m.id, content: input.content,
      kind: input.kind ?? m.kind, confidence: input.confidence === undefined ? m.confidence : input.confidence, origin: "user",
      status: "active", sourceRunId: null, createdAt: now, observedAt: now, reviewedAt: now, validFrom: now, validTo: null
    });
  }
  async memoryHistory(memoryId: string): Promise<Memory[] | null> {
    const m = this.ownMemory(memoryId);
    if (!m) return null;
    return [...this.store.memories.values()]
      .filter(x => x.lineageId === m.lineageId)
      .sort((a, b) => a.version - b.version)
      .map(x => this.plainMemory(x));
  }
  async deleteMemory(memoryId: string): Promise<boolean> {
    const m = this.ownMemory(memoryId);
    if (!m) return false;
    for (const [id, x] of this.store.memories) if (x.lineageId === m.lineageId) this.store.memories.delete(id);
    return true;
  }
  private newDecision(
    projectId: string,
    v: Omit<Decision, "id" | "version" | "supersedesId" | "status" | "createdAt" | "supersededAt" | "outcomes">
  ): Decision {
    const mine = [...this.store.decisions.values()].filter(d => d.projectId === projectId && d.ownerId === this.ownerId);
    const active = mine.find(d => d.status === "active");
    const now = new Date().toISOString();
    if (active) this.store.decisions.set(active.id, { ...active, status: "superseded", supersededAt: now });
    const d: Decision = {
      ...v, id: randomUUID(), version: mine.length + 1, supersedesId: active?.id ?? null, status: "active", createdAt: now,
      supersededAt: null, outcomes: []
    };
    this.store.decisions.set(d.id, { ...d, ownerId: this.ownerId, projectId });
    return d;
  }
  private plainDecision(d: Owned<Decision> & { projectId: string }): Decision {
    const copy: Partial<typeof d> = { ...d };
    delete copy.ownerId;
    delete copy.projectId;
    return copy as Decision;
  }
  async listDecisions(projectId: string): Promise<Decision[] | null> {
    if (!this.ownProject(projectId)) return null;
    return [...this.store.decisions.values()]
      .filter(d => d.ownerId === this.ownerId && d.projectId === projectId)
      .sort((a, b) => b.version - a.version)
      .map(d => this.plainDecision(d));
  }
  async reviseDecision(decisionId: string, input: ReviseDecisionInput): Promise<Decision | null> {
    const d = this.store.decisions.get(decisionId);
    if (!d || d.ownerId !== this.ownerId) return null;
    if (d.status !== "active") throw new DecisionStateError(decisionId);
    return this.newDecision(d.projectId, {
      origin: "user_revision", sourceRunId: null, question: d.question, choice: input.choice, rationale: input.rationale,
      alternatives: d.alternatives, assumptions: d.assumptions,
      confidence: input.confidence === undefined ? d.confidence : input.confidence,
      reviewTriggers: d.reviewTriggers, nextActions: d.nextActions
    });
  }
  async addOutcome(decisionId: string, input: OutcomeInput): Promise<DecisionOutcome | null> {
    const d = this.store.decisions.get(decisionId);
    if (!d || d.ownerId !== this.ownerId) return null;
    const outcome: DecisionOutcome = {
      id: randomUUID(), result: input.result, observedOutcome: input.observedOutcome, observedOn: input.observedOn,
      notes: input.notes || null, createdAt: new Date().toISOString()
    };
    this.store.decisions.set(decisionId, { ...d, outcomes: [...d.outcomes, outcome] });
    return outcome;
  }
  async deleteProject(projectId: string): Promise<boolean> {
    if (!this.ownProject(projectId)) return false;
    this.store.projects.delete(projectId);
    for (const [id, r] of this.store.runs) {
      if (r.projectId !== projectId) continue;
      this.store.runs.delete(id);
      this.store.events.delete(id);
      this.store.evidence.delete(id);
    }
    for (const [id, m] of this.store.memories) if (m.projectId === projectId) this.store.memories.delete(id);
    for (const [id, d] of this.store.decisions) if (d.projectId === projectId) this.store.decisions.delete(id);
    return true;
  }
  async exportProject(projectId: string): Promise<Record<string, unknown> | null> {
    const project = this.ownProject(projectId);
    if (!project) return null;
    return {
      schema: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      project: strip(project),
      runs: [...this.store.runs.values()].filter(r => r.projectId === projectId && r.ownerId === this.ownerId).map(r => strip(r)),
      memories: await this.listMemories(projectId, { status: "all" }),
      decisions: ((await this.listDecisions(projectId)) ?? []).reverse()
    };
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
