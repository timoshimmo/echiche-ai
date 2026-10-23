import type { Project, RunEvent, ThoughtRun, CreateProjectInput, StartRunInput } from "@/lib/domain/types";

export interface EchicheRepository {
  createProject(input: CreateProjectInput): Promise<Project>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createRun(projectId: string, input: StartRunInput): Promise<ThoughtRun>;
  getRun(id: string): Promise<ThoughtRun | null>;
  listRuns(projectId: string): Promise<ThoughtRun[]>;
  appendEvent(event: Omit<RunEvent, "id" | "createdAt">): Promise<RunEvent>;
  listEvents(runId: string): Promise<RunEvent[]>;
  completeRun(runId: string, result: string): Promise<ThoughtRun>;
}
