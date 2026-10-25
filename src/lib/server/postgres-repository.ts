import postgres from "postgres";
import { REASONING_RESULT_SCHEMA_VERSION, reasoningResultSchema } from "@/lib/domain/reasoning";
import {
  RUN_EVENT_TYPES, RUN_STATUSES,
  type CreateProjectInput, type Project, type ReasoningResult, type RunEvent, type StartRunInput, type ThoughtRun,
  type UpdateProjectInput
} from "@/lib/domain/types";
import {
  assertOwnerId, DataIntegrityError, ProjectArchivedError, RateLimitError, RunStateError,
  type AppendEventInput, type OwnerScopedRepository, type Store
} from "./repository";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

type ProjectRow = {
  id: string; title: string; problem_statement: string; archived_at: Date | null; created_at: Date; updated_at: Date;
};
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
    // prepare:false keeps transaction-mode poolers (Supabase Supavisor / PgBouncer) working.
    client = postgres(databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 10, prepare: false, onnotice: () => {} });
    clients.set(databaseUrl, client);
  }
  return client;
}

const PROJECT_COLUMNS = "id, title, problem_statement, archived_at, created_at, updated_at";

function asProject(row: ProjectRow): Project {
  return {
    id: row.id, title: row.title, problemStatement: row.problem_statement,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()
  };
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

/**
 * Connects as the web role (echiche_web, NOINHERIT: no table privileges of its own).
 * Every operation runs in a transaction that first sets the owner's claims and then
 * SET LOCAL ROLE echiche_end_user, so RLS policies apply (database layer), in addition
 * to the explicit owner_user_id filter in every query (application layer).
 */
export class PostgresStore implements Store {
  private readonly sql: Sql;
  constructor(databaseUrl: string) {
    this.sql = clientFor(databaseUrl);
  }
  forOwner(ownerId: string): OwnerScopedRepository {
    assertOwnerId(ownerId);
    return new PostgresOwnerRepository(this.sql, ownerId);
  }
  async ping(): Promise<void> {
    await this.sql`select 1`;
  }
}

class PostgresOwnerRepository implements OwnerScopedRepository {
  constructor(private readonly sql: Sql, readonly ownerId: string) {}

  private async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const claims = JSON.stringify({ sub: this.ownerId, role: "authenticated" });
    return (await this.sql.begin(async tx => {
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx.unsafe("set local role echiche_end_user");
      return fn(tx);
    })) as T;
  }

  /** Serialises create-per-owner in this transaction so concurrent requests cannot exceed the limit. */
  private async enforceHourlyLimit(tx: Tx, resource: "projects" | "runs", maxPerHour: number): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`echiche:rate:${resource}:${this.ownerId}`}, 0))`;
    const [row] = resource === "projects"
      ? await tx<{ n: number }[]>`select count(*)::int as n from echiche.projects where owner_user_id = ${this.ownerId} and created_at > now() - interval '1 hour'`
      : await tx<{ n: number }[]>`select count(*)::int as n from echiche.thought_runs where owner_user_id = ${this.ownerId} and created_at > now() - interval '1 hour'`;
    if (row.n >= maxPerHour) throw new RateLimitError(resource, 3600);
  }

  async createProject(input: CreateProjectInput, maxPerHour: number): Promise<Project> {
    return this.tx(async tx => {
      await this.enforceHourlyLimit(tx, "projects", maxPerHour);
      const [row] = await tx<ProjectRow[]>`
        insert into echiche.projects (owner_user_id, title, problem_statement)
        values (${this.ownerId}, ${input.title}, ${input.problemStatement})
        returning ${tx.unsafe(PROJECT_COLUMNS)}`;
      return asProject(row);
    });
  }

  async listProjects({ includeArchived }: { includeArchived: boolean }): Promise<Project[]> {
    return this.tx(async tx => {
      const rows = await tx<ProjectRow[]>`
        select ${tx.unsafe(PROJECT_COLUMNS)} from echiche.projects
         where owner_user_id = ${this.ownerId} and (${includeArchived} or archived_at is null)
         order by created_at desc limit 100`;
      return rows.map(asProject);
    });
  }

  async getProject(id: string): Promise<Project | null> {
    return this.tx(async tx => {
      const [row] = await tx<ProjectRow[]>`
        select ${tx.unsafe(PROJECT_COLUMNS)} from echiche.projects where id = ${id} and owner_user_id = ${this.ownerId}`;
      return row ? asProject(row) : null;
    });
  }

  async updateProject(id: string, patch: UpdateProjectInput): Promise<Project | null> {
    const archived = patch.archived ?? null;
    return this.tx(async tx => {
      const [row] = await tx<ProjectRow[]>`
        update echiche.projects
           set title = coalesce(${patch.title ?? null}::text, title),
               problem_statement = coalesce(${patch.problemStatement ?? null}::text, problem_statement),
               archived_at = case
                 when ${archived}::boolean is null then archived_at
                 when ${archived}::boolean then coalesce(archived_at, now())
                 else null end,
               updated_at = now()
         where id = ${id} and owner_user_id = ${this.ownerId}
        returning ${tx.unsafe(PROJECT_COLUMNS)}`;
      return row ? asProject(row) : null;
    });
  }

  async createRun(projectId: string, input: StartRunInput, maxPerHour: number): Promise<ThoughtRun | null> {
    return this.tx(async tx => {
      const [project] = await tx<{ archived_at: Date | null }[]>`
        select archived_at from echiche.projects where id = ${projectId} and owner_user_id = ${this.ownerId}`;
      if (!project) return null;
      if (project.archived_at) throw new ProjectArchivedError(projectId);
      await this.enforceHourlyLimit(tx, "runs", maxPerHour);
      const [row] = await tx<RunRow[]>`
        insert into echiche.thought_runs (owner_user_id, project_id, prompt, status)
        values (${this.ownerId}, ${projectId}, ${input.prompt}, 'running')
        returning *`;
      return asRun(row);
    });
  }

  async getRun(id: string): Promise<ThoughtRun | null> {
    return this.tx(async tx => {
      const [row] = await tx<RunRow[]>`select * from echiche.thought_runs where id = ${id} and owner_user_id = ${this.ownerId}`;
      return row ? asRun(row) : null;
    });
  }

  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    return this.tx(async tx => {
      const rows = await tx<RunRow[]>`
        select * from echiche.thought_runs where project_id = ${projectId} and owner_user_id = ${this.ownerId}
         order by created_at desc limit 50`;
      return rows.map(asRun);
    });
  }

  async appendEvent(input: AppendEventInput): Promise<RunEvent> {
    return this.tx(async tx => {
      // The insert's composite FK (run_id, owner_user_id) rejects runs owned by anyone else;
      // check first so callers get a domain error rather than a constraint violation.
      const [owned] = await tx`select 1 from echiche.thought_runs where id = ${input.runId} and owner_user_id = ${this.ownerId}`;
      if (!owned) throw new RunStateError(input.runId, "owned");
      const [row] = await tx<EventRow[]>`
        insert into echiche.run_events (owner_user_id, run_id, sequence, event_type, stage, message)
        values (
          ${this.ownerId}, ${input.runId},
          (select coalesce(max(sequence), 0) + 1 from echiche.run_events where run_id = ${input.runId} and owner_user_id = ${this.ownerId}),
          ${input.type}, ${input.stage}, ${input.message}
        )
        returning *`;
      return asEvent(row);
    });
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.tx(async tx => {
      const rows = await tx<EventRow[]>`
        select * from echiche.run_events where run_id = ${runId} and owner_user_id = ${this.ownerId} order by sequence asc`;
      return rows.map(asEvent);
    });
  }

  async completeRun(runId: string, result: ReasoningResult): Promise<ThoughtRun> {
    const validated = reasoningResultSchema.parse(result);
    return this.tx(async tx => {
      const [row] = await tx<RunRow[]>`
        update echiche.thought_runs
           set status = 'succeeded', result = ${tx.json(validated)},
               result_schema_version = ${REASONING_RESULT_SCHEMA_VERSION}, completed_at = now()
         where id = ${runId} and owner_user_id = ${this.ownerId} and status = 'running'
        returning *`;
      if (!row) throw new RunStateError(runId, "running");
      return asRun(row);
    });
  }

  async failRun(runId: string, errorCode: string): Promise<ThoughtRun> {
    return this.tx(async tx => {
      const [row] = await tx<RunRow[]>`
        update echiche.thought_runs set status = 'failed', error_code = ${errorCode}, completed_at = now()
         where id = ${runId} and owner_user_id = ${this.ownerId} and status = 'running'
        returning *`;
      if (!row) throw new RunStateError(runId, "running");
      return asRun(row);
    });
  }
}

/** Test helper: close pooled connections so test processes can exit. */
export async function closePostgresClients(): Promise<void> {
  await Promise.all([...clients.values()].map(client => client.end({ timeout: 5 })));
  clients.clear();
}
