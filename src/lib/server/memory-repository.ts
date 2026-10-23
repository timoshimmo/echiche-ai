import { randomUUID } from "node:crypto";
import type { CreateProjectInput, Project, ReasoningResult, RunEvent, StartRunInput, ThoughtRun } from "@/lib/domain/types";
import { RunStateError, type AppendEventInput, type EchicheRepository } from "./repository";

/** Ephemeral, single-process demo storage. Never used when NODE_ENV=production (see config.ts). */
export class MemoryRepository implements EchicheRepository {
  private projects = new Map<string, Project>();
  private runs = new Map<string, ThoughtRun>();
  private events = new Map<string, RunEvent[]>();

  async createProject(input: CreateProjectInput): Promise<Project> {
    const project: Project = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
    this.projects.set(project.id, project);
    return project;
  }
  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
  async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }
  async createRun(projectId: string, input: StartRunInput): Promise<ThoughtRun> {
    const run: ThoughtRun = {
      id: randomUUID(), projectId, ...input, status: "running", result: null, errorCode: null,
      createdAt: new Date().toISOString(), completedAt: null
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    return run;
  }
  async getRun(id: string): Promise<ThoughtRun | null> {
    return this.runs.get(id) ?? null;
  }
  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    return [...this.runs.values()]
      .filter(r => r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
  }
  async appendEvent(input: AppendEventInput): Promise<RunEvent> {
    const list = this.events.get(input.runId) ?? [];
    const event: RunEvent = { ...input, id: randomUUID(), sequence: list.length + 1, createdAt: new Date().toISOString() };
    list.push(event);
    this.events.set(input.runId, list);
    return event;
  }
  async listEvents(runId: string): Promise<RunEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }
  async completeRun(runId: string, result: ReasoningResult): Promise<ThoughtRun> {
    return this.transition(runId, { status: "succeeded", result: structuredClone(result) });
  }
  async failRun(runId: string, errorCode: string): Promise<ThoughtRun> {
    return this.transition(runId, { status: "failed", errorCode });
  }
  async ping(): Promise<void> {}

  private transition(runId: string, patch: Partial<ThoughtRun>): ThoughtRun {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") throw new RunStateError(runId, "running");
    const updated: ThoughtRun = { ...run, ...patch, completedAt: new Date().toISOString() };
    this.runs.set(runId, updated);
    return updated;
  }
}
