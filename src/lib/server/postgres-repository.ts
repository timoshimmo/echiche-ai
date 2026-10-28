import postgres from "postgres";
import { evidenceClaimSchema, evidenceSourceSchema } from "@/lib/domain/evidence";
import type {
  ApproveMemoryInput, CorrectMemoryInput, CreateMemoryInput, Decision, DecisionOutcome, Memory, MemoryFilter, OutcomeInput,
  RememberedContext, ReviseDecisionInput
} from "@/lib/domain/memory";
import { parseRunResult } from "@/lib/domain/reasoning";
import * as journal from "./postgres-memory";
import {
  RUN_EVENT_TYPES, RUN_STAGES, RUN_STATUSES,
  type CreateProjectInput, type GenerationSummary, type Project, type RunBudget, type RunEvidence, type RunEvent, type StartRunInput,
  type ThoughtRun, type UpdateProjectInput
} from "@/lib/domain/types";
import {
  ACTIVE_STATUSES, assertOwnerId, DataIntegrityError, IdempotencyConflictError, ProjectArchivedError, RateLimitError,
  RunStateError, type CreateRunOptions, type OwnerScopedRepository, type Store
} from "./repository";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

type ProjectRow = {
  id: string; title: string; problem_statement: string; archived_at: Date | null; created_at: Date; updated_at: Date;
};
type RunRow = {
  id: string; project_id: string; prompt: string; status: string; result: unknown;
  result_schema_version: string | null; error_code: string | null; cancel_requested_at: Date | null; attempt: number;
  budget_max_steps: number; budget_max_active_seconds: number; budget_max_research_calls: number; budget_max_cost_usd: string;
  steps_used: number; active_seconds_used: string; research_calls_used: number; cost_usd_used: string;
  completed_stages: string[]; generation: GenerationRow; created_at: Date; started_at: Date | null; updated_at: Date; completed_at: Date | null;
};
type GenerationRow = {
  calls: number; repairs: number; input_tokens: number; output_tokens: number; cost_usd: string | number;
  providers: string[] | null; models: string[] | null; prompts: string[] | null;
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
const RUN_COLUMNS = `r.id, r.project_id, r.prompt, r.status, r.result, r.result_schema_version, r.error_code,
  r.cancel_requested_at, r.attempt, r.budget_max_steps, r.budget_max_active_seconds, r.budget_max_research_calls,
  r.budget_max_cost_usd, r.steps_used, r.active_seconds_used, r.research_calls_used, r.cost_usd_used,
  r.created_at, r.started_at, r.updated_at, r.completed_at,
  coalesce((select array_agg(o.stage) from echiche.run_stage_outputs o
             where o.run_id = r.id and o.owner_user_id = r.owner_user_id), '{}') as completed_stages,
  (select json_build_object(
            'calls', count(*), 'repairs', count(*) filter (where m.repair),
            'input_tokens', coalesce(sum(m.input_tokens), 0), 'output_tokens', coalesce(sum(m.output_tokens), 0),
            'cost_usd', coalesce(sum(m.cost_usd), 0),
            'providers', array_agg(distinct m.provider), 'models', array_agg(distinct m.model),
            'prompts', array_agg(distinct m.prompt_id || '@' || m.prompt_version))
     from echiche.model_calls m where m.run_id = r.id and m.owner_user_id = r.owner_user_id) as generation`;

function asProject(row: ProjectRow): Project {
  return {
    id: row.id, title: row.title, problemStatement: row.problem_statement,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function asRun(row: RunRow): ThoughtRun {
  const status = RUN_STATUSES.find(s => s === row.status);
  if (!status) throw new DataIntegrityError("thought_run.status", row.id);
  let result = null;
  if (row.result != null) {
    result = parseRunResult(row.result_schema_version, row.result);
    if (!result) throw new DataIntegrityError("thought_run.result", row.id);
  }
  const done = new Set(row.completed_stages);
  return {
    id: row.id, projectId: row.project_id, prompt: row.prompt, status, result, generation: asGeneration(row.generation),
    errorCode: row.error_code,
    cancelRequested: row.cancel_requested_at !== null, attempt: row.attempt,
    budget: {
      maxSteps: row.budget_max_steps, maxActiveSeconds: row.budget_max_active_seconds,
      maxResearchCalls: row.budget_max_research_calls, maxCostUsd: Number(row.budget_max_cost_usd)
    },
    usage: {
      steps: row.steps_used, activeSeconds: Number(row.active_seconds_used),
      researchCalls: row.research_calls_used, costUsd: Number(row.cost_usd_used)
    },
    completedStages: RUN_STAGES.filter(stage => done.has(stage)),
    createdAt: row.created_at.toISOString(), startedAt: iso(row.started_at), updatedAt: row.updated_at.toISOString(),
    completedAt: iso(row.completed_at)
  };
}

function asGeneration(row: GenerationRow): GenerationSummary {
  const calls = Number(row.calls);
  return {
    mode: calls > 0 ? "model" : "demo",
    providers: row.providers ?? [], models: row.models ?? [], prompts: row.prompts ?? [],
    calls, repairs: Number(row.repairs), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
    costUsd: Number(row.cost_usd)
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

  async createRun(projectId: string, input: StartRunInput, options: CreateRunOptions) {
    return this.tx(async tx => {
      if (options.idempotencyKey) {
        const replay = await this.findByIdempotencyKey(tx, options.idempotencyKey);
        if (replay) {
          if (replay.projectId !== projectId || replay.prompt !== input.prompt) throw new IdempotencyConflictError();
          return { run: replay, created: false };
        }
      }
      const [project] = await tx<{ archived_at: Date | null }[]>`
        select archived_at from echiche.projects where id = ${projectId} and owner_user_id = ${this.ownerId}`;
      if (!project) return null;
      if (project.archived_at) throw new ProjectArchivedError(projectId);
      // Takes the per-owner advisory lock, which also serialises same-key retries.
      await this.enforceHourlyLimit(tx, "runs", options.maxPerHour);
      if (options.idempotencyKey) {
        const raced = await this.findByIdempotencyKey(tx, options.idempotencyKey);
        if (raced) {
          if (raced.projectId !== projectId || raced.prompt !== input.prompt) throw new IdempotencyConflictError();
          return { run: raced, created: false };
        }
      }
      const b = options.budget;
      const [inserted] = await tx<{ id: string }[]>`
        insert into echiche.thought_runs
          (owner_user_id, project_id, prompt, idempotency_key,
           budget_max_steps, budget_max_active_seconds, budget_max_research_calls, budget_max_cost_usd)
        values (${this.ownerId}, ${projectId}, ${input.prompt}, ${options.idempotencyKey ?? null},
                ${b.maxSteps}, ${b.maxActiveSeconds}, ${b.maxResearchCalls}, ${b.maxCostUsd})
        returning id`;
      return { run: (await this.selectRun(tx, inserted.id))!, created: true };
    });
  }

  private async findByIdempotencyKey(tx: Tx, key: string): Promise<ThoughtRun | null> {
    const [row] = await tx<RunRow[]>`
      select ${tx.unsafe(RUN_COLUMNS)} from echiche.thought_runs r
       where r.owner_user_id = ${this.ownerId} and r.idempotency_key = ${key}`;
    return row ? asRun(row) : null;
  }

  private async selectRun(tx: Tx, id: string, lock = false): Promise<ThoughtRun | null> {
    const [row] = lock
      ? await tx<RunRow[]>`select ${tx.unsafe(RUN_COLUMNS)} from echiche.thought_runs r
                            where r.id = ${id} and r.owner_user_id = ${this.ownerId} for update of r`
      : await tx<RunRow[]>`select ${tx.unsafe(RUN_COLUMNS)} from echiche.thought_runs r
                            where r.id = ${id} and r.owner_user_id = ${this.ownerId}`;
    return row ? asRun(row) : null;
  }

  async getRun(id: string): Promise<ThoughtRun | null> {
    return this.tx(tx => this.selectRun(tx, id));
  }

  async listRuns(projectId: string): Promise<ThoughtRun[]> {
    return this.tx(async tx => {
      const rows = await tx<RunRow[]>`
        select ${tx.unsafe(RUN_COLUMNS)} from echiche.thought_runs r
         where r.project_id = ${projectId} and r.owner_user_id = ${this.ownerId}
         order by r.created_at desc limit 50`;
      return rows.map(asRun);
    });
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.tx(async tx => {
      const rows = await tx<EventRow[]>`
        select * from echiche.run_events where run_id = ${runId} and owner_user_id = ${this.ownerId} order by sequence asc`;
      return rows.map(asEvent);
    });
  }

  async getEvidence(runId: string): Promise<RunEvidence> {
    return this.tx(async tx => {
      const sources = await tx<Record<string, unknown>[]>`
        select source_key as "sourceId", url, domain, title, publisher, published_at as "publishedAt",
               to_char(retrieved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "retrievedAt", passages
          from echiche.sources where run_id = ${runId} and owner_user_id = ${this.ownerId}
         order by length(source_key), source_key`;
      const claims = await tx<Record<string, unknown>[]>`
        select c.claim_key as "claimId", c.text, c.label, c.status, c.freshness, c.contradicted,
               coalesce(json_agg(json_build_object(
                 'sourceId', s.source_key, 'passageId', cs.passage_key, 'relation', cs.relation,
                 'quote', cs.quote, 'verdict', cs.verdict, 'note', cs.note) order by cs.passage_key)
                 filter (where cs.claim_id is not null), '[]') as links
          from echiche.claims c
          left join echiche.claim_sources cs on cs.claim_id = c.id and cs.owner_user_id = c.owner_user_id
          left join echiche.sources s on s.id = cs.source_id and s.owner_user_id = c.owner_user_id
         where c.run_id = ${runId} and c.owner_user_id = ${this.ownerId}
         group by c.id order by length(c.claim_key), c.claim_key`;
      return {
        sources: sources.map(row => {
          const parsed = evidenceSourceSchema.safeParse(row);
          if (!parsed.success) throw new DataIntegrityError("source", String(row.sourceId));
          return parsed.data;
        }),
        claims: claims.map(row => {
          const parsed = evidenceClaimSchema.safeParse(row);
          if (!parsed.success) throw new DataIntegrityError("claim", String(row.claimId));
          return parsed.data;
        })
      };
    });
  }

  async getRememberedContext(runId: string): Promise<RememberedContext[]> {
    return this.tx(tx => journal.rememberedContext(tx, this.ownerId, runId));
  }
  async listMemories(projectId: string, filter: MemoryFilter): Promise<Memory[] | null> {
    return this.tx(tx => journal.listMemories(tx, this.ownerId, projectId, filter));
  }
  async createMemory(projectId: string, input: CreateMemoryInput): Promise<Memory | null> {
    return this.tx(tx => journal.createMemory(tx, this.ownerId, projectId, input));
  }
  async approveMemory(memoryId: string, input: ApproveMemoryInput): Promise<Memory | null> {
    return this.tx(tx => journal.approveMemory(tx, this.ownerId, memoryId, input));
  }
  async rejectMemory(memoryId: string): Promise<Memory | null> {
    return this.tx(tx => journal.rejectMemory(tx, this.ownerId, memoryId));
  }
  async correctMemory(memoryId: string, input: CorrectMemoryInput): Promise<Memory | null> {
    return this.tx(tx => journal.correctMemory(tx, this.ownerId, memoryId, input));
  }
  async memoryHistory(memoryId: string): Promise<Memory[] | null> {
    return this.tx(tx => journal.memoryHistory(tx, this.ownerId, memoryId));
  }
  async deleteMemory(memoryId: string): Promise<boolean> {
    return this.tx(tx => journal.deleteMemory(tx, this.ownerId, memoryId));
  }
  async listDecisions(projectId: string): Promise<Decision[] | null> {
    return this.tx(tx => journal.listDecisions(tx, this.ownerId, projectId));
  }
  async reviseDecision(decisionId: string, input: ReviseDecisionInput): Promise<Decision | null> {
    return this.tx(tx => journal.reviseDecision(tx, this.ownerId, decisionId, input));
  }
  async addOutcome(decisionId: string, input: OutcomeInput): Promise<DecisionOutcome | null> {
    return this.tx(tx => journal.addOutcome(tx, this.ownerId, decisionId, input));
  }
  async deleteProject(projectId: string): Promise<boolean> {
    return this.tx(tx => journal.deleteProject(tx, this.ownerId, projectId));
  }
  async exportProject(projectId: string): Promise<Record<string, unknown> | null> {
    return this.tx(tx => journal.exportProject(tx, this.ownerId, projectId));
  }

  async cancelRun(runId: string): Promise<ThoughtRun | null> {
    return this.tx(async tx => {
      const run = await this.selectRun(tx, runId, true);
      if (!run) return null;
      if (run.status === "cancelled") return run;
      if (run.status === "queued" || run.status === "paused_for_budget") {
        await tx`update echiche.thought_runs set status = 'cancelled' where id = ${runId} and owner_user_id = ${this.ownerId}`;
      } else if ((ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
        if (run.cancelRequested) return run;
        await tx`update echiche.thought_runs set cancel_requested_at = now() where id = ${runId} and owner_user_id = ${this.ownerId}`;
      } else {
        throw new RunStateError(runId, run.status);
      }
      return this.selectRun(tx, runId);
    });
  }

  async acceptRun(runId: string): Promise<ThoughtRun | null> {
    return this.tx(async tx => {
      const run = await this.selectRun(tx, runId, true);
      if (!run) return null;
      if (run.status === "completed") return run;
      if (run.status !== "awaiting_user_review") throw new RunStateError(runId, run.status);
      await tx`update echiche.thought_runs set status = 'completed' where id = ${runId} and owner_user_id = ${this.ownerId}`;
      if (run.result?.schemaVersion === "decision-brief.v1") {
        // The user's explicit acceptance makes this brief the project's current decision (ADR-009).
        await journal.recordAcceptedBrief(tx, this.ownerId, run.projectId, runId, run.result.data);
      }
      return this.selectRun(tx, runId);
    });
  }

  async resumeRun(runId: string, increment: RunBudget): Promise<ThoughtRun | null> {
    return this.tx(async tx => {
      const run = await this.selectRun(tx, runId, true);
      if (!run) return null;
      if (run.status === "queued" || (ACTIVE_STATUSES as readonly string[]).includes(run.status)) return run;
      if (run.status !== "paused_for_budget") throw new RunStateError(runId, run.status);
      await tx`
        update echiche.thought_runs
           set status = 'queued',
               budget_max_steps = budget_max_steps + ${increment.maxSteps},
               budget_max_active_seconds = budget_max_active_seconds + ${increment.maxActiveSeconds},
               budget_max_research_calls = budget_max_research_calls + ${increment.maxResearchCalls},
               budget_max_cost_usd = budget_max_cost_usd + ${increment.maxCostUsd}
         where id = ${runId} and owner_user_id = ${this.ownerId}`;
      return this.selectRun(tx, runId);
    });
  }
}

/** Test helper: close pooled connections so test processes can exit. */
export async function closePostgresClients(): Promise<void> {
  await Promise.all([...clients.values()].map(client => client.end({ timeout: 5 })));
  clients.clear();
}
