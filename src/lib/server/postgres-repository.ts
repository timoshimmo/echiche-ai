import postgres from "postgres";
import { REASONING_RESULT_SCHEMA_VERSION, reasoningResultSchema } from "@/lib/domain/reasoning";
import {
  RUN_EVENT_TYPES, RUN_STATUSES,
  type CreateProjectInput, type Project, type ReasoningResult, type RunEvent, type StartRunInput, type ThoughtRun
} from "@/lib/domain/types";
import { DataIntegrityError, RunStateError, type AppendEventInput, type EchicheRepository } from "./repository";

type Sql = ReturnType<typeof postgres>;

type ProjectRow = { id: string; title: string; problem_statement: string; created_at: Date };
type RunRow = {
  id: string; project_id: string; prompt: string; status: string; result: unknown;
  result_schema_version: string | null; error_code: string | null; created_at: Date; completed_at: Date | null;
};
type EventRow = { id: string; run_id: string; sequence: number; event_type: string; stage: string; message: string; created_at: Date };

const clients = new Map<string, Sql>();

/** One pooled client per connection string, reused across requests in this process. */
function clientFor(databaseUrl: string): Sql {
  let client = clients.get(databaseUrl);
  if (!client) {
    // prepare:false keeps transaction-mode poolers (e.g. Supabase/PgBouncer) working.
    client = postgres(databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 10, prepare: false, onnotice: () => {} });
    clients.set(databaseUrl, client);
  }
  return client;
}

function asProject(row: ProjectRow): Project {
  return { id: row.id, title: row.title, problemStatement: row.problem_statement, createdAt: row.created_at.toISOString() };
}

function asRun(row: RunRow): ThoughtRun {
  const status = RUN_STATUSES.find(s => s === row.status);
  if (!status) throw new DataIntegrityError("thought_run.status", row.id);

  let result: ReasoningResult | null = null;
  if (row.result != null) {
    if (row.result_schema_version !== REASONING_RESULT_SCHEMA_VERSION) throw new DataIntegrityError("thought_run.result_schema_version", row.id);
    const parsed = reasoningResultSchema.safeParse(row.result);
    if (!parsed.success) throw new DataIntegrityError("thought_run.result", row.id);
    result = parsed.data;
  }
  return {
    id: row.id, projectId: row.project_id, prompt: row.prompt, status, result, errorCode: row.error_code,
    createdAt: row.created_at.toISOString(), completedAt: row.completed_at ? row.completed_at.toISOString() : null
  };
}

function asEvent(row: EventRow): RunEvent {
  const type = RUN_EVENT_TYPES.find(t => t === row.event_type);
  if (!type) throw new DataIntegrityError("run_event.event_type", row.id);
  return { id: row.id, runId: row.run_id, sequence: row.sequence, type, stage: row.stage, message: row.message, createdAt: row.created_at.toISOString() };
}

export class PostgresRepository implements EchicheRepository {
  private readonly sql: Sql;
  constructor(databaseUrl: string) {
    this.sql = clientFor(databaseUrl);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const [row] = await this.sql<ProjectRow[]>`
      insert into projects (title, problem_statement) values (${input.title}, ${input.problemStatement})
      returning id, title, problem_statement, created_at`;
    return asProject(row);
  }
  async listProjects(): Promise<Project[]> {
    const rows = await this.sql<ProjectRow[]>`
      select id, title, problem_statement, created_at from projects order by created_at desc limit 100`;
    return rows.map(asProject);
  }
  async getProject(id: string): Promise<Project | null> {
    const [row] = await this.sql<ProjectRow[]>`select id, title, problem_statement, created_at from projects where id = ${id}`;
    return row ? asProject(row) : null;
  }
  async createRun(projectId: string, input: StartRunInput): Promise<ThoughtRun> {
    const [row] = await this.sql<RunRow[]>`
      insert into thought_runs (project_id, prompt, status) values (${projectId}, ${input.prompt}, 'running')
      returning *`;
    return asRun(row);
  }
  async getRun(id: string): Promise<ThoughtRun | null> {
    const [row] = await this.sql<RunRow[]>`select * from thought_runs where id = ${id}`;
    return row ? asRun(row) : null;
  }
  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    const rows = await this.sql<RunRow[]>`
      select * from thought_runs where project_id = ${projectId} order by created_at desc limit 50`;
    return rows.map(asRun);
  }
  async appendEvent(input: AppendEventInput): Promise<RunEvent> {
    // Single writer per run until M3; the (run_id, sequence) unique key rejects any concurrent collision.
    const [row] = await this.sql<EventRow[]>`
      insert into run_events (run_id, sequence, event_type, stage, message)
      values (
        ${input.runId},
        (select coalesce(max(sequence), 0) + 1 from run_events where run_id = ${input.runId}),
        ${input.type}, ${input.stage}, ${input.message}
      )
      returning *`;
    return asEvent(row);
  }
  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.sql<EventRow[]>`select * from run_events where run_id = ${runId} order by sequence asc`;
    return rows.map(asEvent);
  }
  async completeRun(runId: string, result: ReasoningResult): Promise<ThoughtRun> {
    const validated = reasoningResultSchema.parse(result);
    const [row] = await this.sql<RunRow[]>`
      update thought_runs
         set status = 'succeeded',
             result = ${this.sql.json(validated)},
             result_schema_version = ${REASONING_RESULT_SCHEMA_VERSION},
             completed_at = now()
       where id = ${runId} and status = 'running'
      returning *`;
    if (!row) throw new RunStateError(runId, "running");
    return asRun(row);
  }
  async failRun(runId: string, errorCode: string): Promise<ThoughtRun> {
    const [row] = await this.sql<RunRow[]>`
      update thought_runs set status = 'failed', error_code = ${errorCode}, completed_at = now()
       where id = ${runId} and status = 'running'
      returning *`;
    if (!row) throw new RunStateError(runId, "running");
    return asRun(row);
  }
  async ping(): Promise<void> {
    await this.sql`select 1`;
  }
}

/** Test helper: close pooled connections so test processes can exit. */
export async function closePostgresClients(): Promise<void> {
  await Promise.all([...clients.values()].map(client => client.end({ timeout: 5 })));
  clients.clear();
}
