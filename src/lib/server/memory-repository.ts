import { randomUUID } from "node:crypto";
import type { CreateProjectInput, Project, RunEvent, StartRunInput, ThoughtRun } from "@/lib/domain/types";
import type { EchicheRepository } from "./repository";

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
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getProject(id: string): Promise<Project | null> { return this.projects.get(id) ?? null; }
  async createRun(projectId: string, input: StartRunInput): Promise<ThoughtRun> {
    const run: ThoughtRun = { id: randomUUID(), projectId, ...input, status: "running", result: null, createdAt: new Date().toISOString(), completedAt: null };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    return run;
  }
  async getRun(id: string): Promise<ThoughtRun | null> { return this.runs.get(id) ?? null; }
  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    return [...this.runs.values()].filter(r => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async appendEvent(input: Omit<RunEvent, "id" | "createdAt">): Promise<RunEvent> {
    const event: RunEvent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    const list = this.events.get(input.runId) ?? [];
    list.push(event);
    this.events.set(input.runId, list);
    return event;
  }
  async listEvents(runId: string): Promise<RunEvent[]> { return this.events.get(runId) ?? []; }
  async completeRun(runId: string, result: string): Promise<ThoughtRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    const updated: ThoughtRun = { ...run, status: "succeeded", result, completedAt: new Date().toISOString() };
    this.runs.set(runId, updated);
    return updated;
  }
}
