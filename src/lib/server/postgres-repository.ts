import postgres from "postgres";
import type { CreateProjectInput, Project, RunEvent, StartRunInput, ThoughtRun } from "@/lib/domain/types";
import type { EchicheRepository } from "./repository";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;
function sql(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  client ??= postgres(process.env.DATABASE_URL, { max: 5, idle_timeout: 20, connect_timeout: 10, prepare: false });
  return client;
}
function asProject(row: any): Project {
  return { id: row.id, title: row.title, problemStatement: row.problem_statement, createdAt: new Date(row.created_at).toISOString() };
}
function asRun(row: any): ThoughtRun {
  return { id: row.id, projectId: row.project_id, prompt: row.prompt, status: row.status, result: row.result == null ? null : (typeof row.result === "string" ? row.result : JSON.stringify(row.result)), createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null };
}
function asEvent(row: any): RunEvent {
  return { id: row.id, runId: row.run_id, type: row.event_type, stage: row.stage, message: row.message, createdAt: new Date(row.created_at).toISOString() };
}

export class PostgresRepository implements EchicheRepository {
  async createProject(input: CreateProjectInput): Promise<Project> {
    const [row] = await sql()`insert into projects (title, problem_statement) values (${input.title}, ${input.problemStatement}) returning *`;
    return asProject(row);
  }
  async listProjects(): Promise<Project[]> {
    const rows = await sql()`select * from projects order by created_at desc limit 100`;
    return rows.map(asProject);
  }
  async getProject(id: string): Promise<Project | null> {
    const [row] = await sql()`select * from projects where id = ${id}`;
    return row ? asProject(row) : null;
  }
  async createRun(projectId: string, input: StartRunInput): Promise<ThoughtRun> {
    const [row] = await sql()`insert into thought_runs (project_id, prompt, status) values (${projectId}, ${input.prompt}, 'running') returning *`;
    return asRun(row);
  }
  async getRun(id: string): Promise<ThoughtRun | null> {
    const [row] = await sql()`select * from thought_runs where id = ${id}`;
    return row ? asRun(row) : null;
  }
  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    const rows = await sql()`select * from thought_runs where project_id = ${projectId} order by created_at desc limit 50`;
    return rows.map(asRun);
  }
  async appendEvent(input: Omit<RunEvent, "id" | "createdAt">): Promise<RunEvent> {
    const [row] = await sql()`insert into run_events (run_id, event_type, stage, message) values (${input.runId}, ${input.type}, ${input.stage}, ${input.message}) returning *`;
    return asEvent(row);
  }
  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = await sql()`select * from run_events where run_id = ${runId} order by created_at asc`;
    return rows.map(asEvent);
  }
  async completeRun(runId: string, result: string): Promise<ThoughtRun> {
    const [row] = await sql()`update thought_runs set status = 'succeeded', result = ${result}, completed_at = now() where id = ${runId} returning *`;
    if (!row) throw new Error("RUN_NOT_FOUND");
    return asRun(row);
  }
}
