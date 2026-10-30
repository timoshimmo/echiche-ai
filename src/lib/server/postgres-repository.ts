import postgres from "postgres";
import { evidenceClaimSchema, evidenceSourceSchema } from "@/lib/domain/evidence";
import type {
  ApproveMemoryInput, CorrectMemoryInput, CreateMemoryInput, Decision, DecisionOutcome, Memory, MemoryFilter, OutcomeInput,
  RememberedContext, ReviseDecisionInput
} from "@/lib/domain/memory";
import { parseRunResult } from "@/lib/domain/reasoning";
import { classify, tierBudget, withAttachmentFloor } from "@/lib/domain/routing";
import { attachmentFingerprint } from "./attachment-fingerprint";
import * as journal from "./postgres-memory";
import {
  ATTACHMENT_KINDS, RUN_EVENT_TYPES, RUN_STAGES, RUN_STATUSES,
  type AttachmentSummary, type CreateProjectInput, type GenerationSummary, type Project, type RunBudget, type RunEvidence, type RunEvent, type StartRunInput,
  type ThoughtRun, type UpdateProjectInput
} from "@/lib/domain/types";
import {
  ACTIVE_STATUSES, assertOwnerId, DataIntegrityError, IdempotencyConflictError, ProjectArchivedError, RateLimitError,
  SpendLimitError, type SpendLimits, type UsageKind,
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
  completed_stages: string[]; generation: GenerationRow; created_at: Date;
  requested_depth: "auto" | "quick" | "standard" | "deep"; route_tier: "low" | "medium" | "high" | null;
  route_reasons: { signal: string; points: number; detail: string }[]; route_policy_version: string | null; route_escalation: string | null; started_at: Date | null; updated_at: Date; completed_at: Date | null;
  attachments: AttachmentRow[] | null;
};
type AttachmentRow = {
  id: string; position: number; kind: string; name: string; url: string | null; size_bytes: number;
  status: string; truncated: boolean; note: string | null; content_sha256: string;
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
  r.requested_depth, r.route_tier, r.route_reasons, r.route_policy_version, r.route_escalation,
  coalesce((select array_agg(o.stage) from echiche.run_stage_outputs o
             where o.run_id = r.id and o.owner_user_id = r.owner_user_id), '{}') as completed_stages,
  (select json_build_object(
            'calls', count(*), 'repairs', count(*) filter (where m.repair),
            'input_tokens', coalesce(sum(m.input_tokens), 0), 'output_tokens', coalesce(sum(m.output_tokens), 0),
            'cost_usd', coalesce(sum(m.cost_usd), 0),
            'providers', array_agg(distinct m.provider), 'models', array_agg(distinct m.model),
            'prompts', array_agg(distinct m.prompt_id || '@' || m.prompt_version))
     from echiche.model_calls m where m.run_id = r.id and m.owner_user_id = r.owner_user_id) as generation,
  (select json_agg(json_build_object(
            'id', a.id, 'position', a.position, 'kind', a.kind, 'name', a.name, 'url', a.url, 'size_bytes', a.size_bytes,
            'status', a.status, 'truncated', a.truncated, 'note', a.note, 'content_sha256', a.content_sha256) order by a.position)
     from echiche.run_attachments a where a.run_id = r.id and a.owner_user_id = r.owner_user_id) as attachments`;

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
    route: { requestedDepth: row.requested_depth, tier: row.route_tier, reasons: row.route_reasons, policyVersion: row.route_policy_version,
      escalation: row.route_escalation },
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
    completedAt: iso(row.completed_at),
    attachments: (row.attachments ?? []).map(asAttachment)
  };
}

/** Names and reading status only: extracted text and image bytes never leave the database this way. */
function asAttachment(row: AttachmentRow): AttachmentSummary {
  const kind = ATTACHMENT_KINDS.find(k => k === row.kind);
  const status = (["ready", "pending", "failed"] as const).find(s => s === row.status);
  if (!kind || !status) throw new DataIntegrityError("run_attachment.kind/status", row.id);
  return { id: row.id, position: row.position, kind, name: row.name, url: row.url, sizeBytes: row.size_bytes, status,
    truncated: row.truncated, note: row.note };
}

const fingerprintOf = (rows: AttachmentRow[] | null) =>
  attachmentFingerprint((rows ?? []).map(a => ({ kind: a.kind, contentSha256: a.content_sha256 })));

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
type LedgerKind = "project" | "run" | UsageKind;
const LEDGER_RESOURCE = { project: "projects", run: "runs", export: "exports", journal_write: "journal changes" } as const;

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

  /**
   * Hourly limit from the usage ledger (migration 0009), which deleting a project does not erase.
   * Serialised per owner and kind with an advisory lock, so concurrent requests cannot exceed it.
   * The caller appends the ledger row in the same transaction (`ledger`).
   */
  private async enforceHourlyLimit(tx: Tx, kind: LedgerKind, maxPerHour: number): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`echiche:rate:${kind}:${this.ownerId}`}, 0))`;
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from echiche.usage_ledger
       where owner_user_id = ${this.ownerId} and kind = ${kind} and created_at > now() - interval '1 hour'`;
    if (row.n >= maxPerHour) throw new RateLimitError(LEDGER_RESOURCE[kind], 3600);
  }

  /** Reserves `amount` of spend against the per-user and global rolling-24-hour ceilings. */
  private async reserveSpend(tx: Tx, amount: number, limits: SpendLimits): Promise<void> {
    if (amount <= 0) return;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`echiche:spend:${this.ownerId}`}, 0))`;
    const [own] = await tx<{ total: string }[]>`
      select coalesce(sum(reserved_cost_usd), 0)::text as total from echiche.usage_ledger
       where owner_user_id = ${this.ownerId} and created_at > now() - interval '24 hours'`;
    if (Number(own.total) + amount > limits.userDailyUsd + 1e-9) throw new SpendLimitError("user");
    // One lock for everyone: brief, and only around this check, so the global ceiling is exact.
    await tx`select pg_advisory_xact_lock(hashtextextended('echiche:spend:global', 0))`;
    const [all] = await tx<{ total: string }[]>`select echiche.global_reserved_spend(interval '24 hours')::text as total`;
    if (Number(all.total) + amount > limits.globalDailyUsd + 1e-9) throw new SpendLimitError("global");
  }

  private async ledger(tx: Tx, kind: LedgerKind | "resume", reservedUsd = 0): Promise<void> {
    await tx`insert into echiche.usage_ledger (owner_user_id, kind, reserved_cost_usd)
             values (${this.ownerId}, ${kind}, ${reservedUsd})`;
  }

  async recordUsage(kind: UsageKind, maxPerHour: number): Promise<void> {
    await this.tx(async tx => {
      await this.enforceHourlyLimit(tx, kind, maxPerHour);
      await this.ledger(tx, kind);
    });
  }

  async createProject(input: CreateProjectInput, maxPerHour: number): Promise<Project> {
    return this.tx(async tx => {
      await this.enforceHourlyLimit(tx, "project", maxPerHour);
      await this.ledger(tx, "project");
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
      const attachments = input.attachments ?? [];
      const fingerprint = attachmentFingerprint(attachments);
      const sameRequest = (r: { run: ThoughtRun; fingerprint: string }) =>
        r.run.projectId === projectId && r.run.prompt === input.prompt && r.run.route.requestedDepth === (input.depth ?? "auto")
        && r.fingerprint === fingerprint;
      if (options.idempotencyKey) {
        const replay = await this.findByIdempotencyKey(tx, options.idempotencyKey);
        if (replay) {
          if (!sameRequest(replay)) throw new IdempotencyConflictError();
          return { run: replay.run, created: false };
        }
      }
      const [project] = await tx<{ archived_at: Date | null }[]>`
        select archived_at from echiche.projects where id = ${projectId} and owner_user_id = ${this.ownerId}`;
      if (!project) return null;
      if (project.archived_at) throw new ProjectArchivedError(projectId);
      // Takes the per-owner advisory lock, which also serialises same-key retries.
      await this.enforceHourlyLimit(tx, "run", options.maxPerHour);
      if (options.idempotencyKey) {
        const raced = await this.findByIdempotencyKey(tx, options.idempotencyKey);
        if (raced) {
          if (!sameRequest(raced)) throw new IdempotencyConflictError();
          return { run: raced.run, created: false };
        }
      }
      const [{ remembered }] = await tx<{ remembered: boolean }[]>`
        select exists (select 1 from echiche.decisions where project_id = ${projectId} and owner_user_id = ${this.ownerId} and status = 'active')
            or exists (select 1 from echiche.memories where project_id = ${projectId} and owner_user_id = ${this.ownerId} and status = 'active')
           as remembered`;
      const depth = input.depth ?? "auto";
      const route = withAttachmentFloor(classify({ prompt: input.prompt, depth, hasMemory: remembered }), attachments.length);
      const b = tierBudget(route.tier, options.budget);
      await this.reserveSpend(tx, b.maxCostUsd, options.spend);
      await this.ledger(tx, "run", b.maxCostUsd);
      const [inserted] = await tx<{ id: string }[]>`
        insert into echiche.thought_runs
          (owner_user_id, project_id, prompt, idempotency_key,
           budget_max_steps, budget_max_active_seconds, budget_max_research_calls, budget_max_cost_usd,
           requested_depth, route_tier, route_reasons, route_policy_version)
        values (${this.ownerId}, ${projectId}, ${input.prompt}, ${options.idempotencyKey ?? null},
                ${b.maxSteps}, ${b.maxActiveSeconds}, ${b.maxResearchCalls}, ${b.maxCostUsd},
                ${depth}, ${route.tier}, ${tx.json(route.reasons)}, ${route.policyVersion})
        returning id`;
      for (const a of attachments) {
        await tx`
          insert into echiche.run_attachments
            (owner_user_id, run_id, position, kind, name, media_type, size_bytes, url, content_sha256, status,
             extracted_text, truncated, image_data, note)
          values (${this.ownerId}, ${inserted.id}, ${a.position}, ${a.kind}, ${a.name}, ${a.mediaType}, ${a.sizeBytes}, ${a.url},
                  ${a.contentSha256}, ${a.status}, ${a.text}, ${a.truncated}, ${a.imageData}, ${a.note})`;
      }
      return { run: (await this.selectRun(tx, inserted.id))!, created: true };
    });
  }

  private async findByIdempotencyKey(tx: Tx, key: string): Promise<{ run: ThoughtRun; fingerprint: string } | null> {
    const [row] = await tx<RunRow[]>`
      select ${tx.unsafe(RUN_COLUMNS)} from echiche.thought_runs r
       where r.owner_user_id = ${this.ownerId} and r.idempotency_key = ${key}`;
    return row ? { run: asRun(row), fingerprint: fingerprintOf(row.attachments) } : null;
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

  async resumeRun(runId: string, increment: RunBudget, spend: SpendLimits): Promise<ThoughtRun | null> {
    return this.tx(async tx => {
      const run = await this.selectRun(tx, runId, true);
      if (!run) return null;
      if (run.status === "queued" || (ACTIVE_STATUSES as readonly string[]).includes(run.status)) return run;
      if (run.status !== "paused_for_budget") throw new RunStateError(runId, run.status);
      await this.reserveSpend(tx, increment.maxCostUsd, spend);
      await this.ledger(tx, "resume", increment.maxCostUsd);
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
