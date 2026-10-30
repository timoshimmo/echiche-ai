import type postgres from "postgres";
import {
  EXPORT_SCHEMA_VERSION,
  type ApproveMemoryInput, type CorrectMemoryInput, type CreateMemoryInput, type Decision, type DecisionOutcome, type Memory,
  type MemoryFilter, type OutcomeInput, type RememberedContext, type ReviseDecisionInput
} from "@/lib/domain/memory";
import type { DecisionBrief } from "@/lib/domain/types";
import { DecisionStateError, MemoryStateError, SensitiveConfirmationError } from "./repository";

/**
 * Memory and decision journal queries (M6, ADR-009). Every function runs inside the caller's
 * owner-scoped transaction (claims set, SET LOCAL ROLE echiche_end_user), so RLS applies, and
 * every query also filters by owner_user_id explicitly. The database triggers are the
 * authoritative state machine; the checks here give clean errors first.
 */
type Tx = postgres.TransactionSql;

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

const MEMORY_COLUMNS = `id, lineage_id as "lineageId", version, supersedes_id as "supersedesId", kind, content, status, origin,
  edited, sensitivity, confidence, source_run_id as "sourceRunId", observed_at as "observedAt", created_at as "createdAt",
  reviewed_at as "reviewedAt", valid_from as "validFrom", valid_to as "validTo"`;

type MemoryRow = Omit<Memory, "observedAt" | "createdAt" | "reviewedAt" | "validFrom" | "validTo"> & {
  observedAt: Date; createdAt: Date; reviewedAt: Date | null; validFrom: Date | null; validTo: Date | null;
};

function asMemory(r: MemoryRow): Memory {
  return {
    ...r, observedAt: iso(r.observedAt)!, createdAt: iso(r.createdAt)!, reviewedAt: iso(r.reviewedAt),
    validFrom: iso(r.validFrom), validTo: iso(r.validTo)
  };
}

const DECISION_COLUMNS = `d.id, d.version, d.supersedes_id as "supersedesId", d.status, d.origin, d.source_run_id as "sourceRunId",
  d.question, d.choice, d.rationale, d.alternatives, d.assumptions, d.confidence, d.review_triggers as "reviewTriggers",
  d.next_actions as "nextActions", d.created_at as "createdAt", d.superseded_at as "supersededAt",
  coalesce((select json_agg(json_build_object('id', o.id, 'result', o.result, 'observedOutcome', o.observed_outcome,
              'observedOn', o.observed_on, 'notes', o.notes, 'createdAt', o.created_at) order by o.created_at)
              from echiche.decision_outcomes o where o.decision_id = d.id and o.owner_user_id = d.owner_user_id), '[]') as outcomes`;

type DecisionRow = Omit<Decision, "createdAt" | "supersededAt"> & { createdAt: Date; supersededAt: Date | null };
const asDecision = (r: DecisionRow): Decision => ({ ...r, createdAt: iso(r.createdAt)!, supersededAt: iso(r.supersededAt) });

async function ownsProject(tx: Tx, ownerId: string, projectId: string): Promise<boolean> {
  const rows = await tx`select 1 from echiche.projects where id = ${projectId} and owner_user_id = ${ownerId}`;
  return rows.length > 0;
}

async function lockMemory(tx: Tx, ownerId: string, memoryId: string): Promise<MemoryRow | null> {
  const [row] = await tx<MemoryRow[]>`
    select ${tx.unsafe(MEMORY_COLUMNS)} from echiche.memories
     where id = ${memoryId} and owner_user_id = ${ownerId} for update`;
  return row ?? null;
}

export async function listMemories(tx: Tx, ownerId: string, projectId: string, filter: MemoryFilter): Promise<Memory[] | null> {
  if (!(await ownsProject(tx, ownerId, projectId))) return null;
  const status = filter.status ?? "active";
  const pattern = filter.q ? `%${filter.q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
  const rows = await tx<MemoryRow[]>`
    select ${tx.unsafe(MEMORY_COLUMNS)} from echiche.memories
     where project_id = ${projectId} and owner_user_id = ${ownerId}
       and (${status} = 'all' or status = ${status})
       and (${filter.kind ?? null}::text is null or kind = ${filter.kind ?? null})
       and (${pattern}::text is null or content ilike ${pattern})
     order by case status when 'proposed' then 0 when 'active' then 1 when 'superseded' then 2 else 3 end,
              observed_at desc, version desc
     limit 500`;
  return rows.map(asMemory);
}

export async function createMemory(tx: Tx, ownerId: string, projectId: string, input: CreateMemoryInput): Promise<Memory | null> {
  if (!(await ownsProject(tx, ownerId, projectId))) return null;
  const [row] = await tx<MemoryRow[]>`
    insert into echiche.memories (owner_user_id, project_id, kind, content, status, origin, confidence)
    values (${ownerId}, ${projectId}, ${input.kind}, ${input.content}, 'active', 'user', ${input.confidence ?? null})
    returning ${tx.unsafe(MEMORY_COLUMNS)}`;
  return asMemory(row);
}

export async function approveMemory(tx: Tx, ownerId: string, memoryId: string, input: ApproveMemoryInput): Promise<Memory | null> {
  const current = await lockMemory(tx, ownerId, memoryId);
  if (!current) return null;
  if (current.status === "active") return asMemory(current);
  if (current.status !== "proposed") throw new MemoryStateError(memoryId, current.status);
  if (current.sensitivity === "sensitive" && input.confirmSensitive !== true) throw new SensitiveConfirmationError(memoryId);
  const [row] = await tx<MemoryRow[]>`
    update echiche.memories set status = 'active', content = ${input.content ?? current.content}, kind = ${input.kind ?? current.kind}
     where id = ${memoryId} and owner_user_id = ${ownerId}
    returning ${tx.unsafe(MEMORY_COLUMNS)}`;
  return asMemory(row);
}

export async function rejectMemory(tx: Tx, ownerId: string, memoryId: string): Promise<Memory | null> {
  const current = await lockMemory(tx, ownerId, memoryId);
  if (!current) return null;
  if (current.status === "rejected") return asMemory(current);
  if (current.status !== "proposed") throw new MemoryStateError(memoryId, current.status);
  const [row] = await tx<MemoryRow[]>`
    update echiche.memories set status = 'rejected' where id = ${memoryId} and owner_user_id = ${ownerId}
    returning ${tx.unsafe(MEMORY_COLUMNS)}`;
  return asMemory(row);
}

export async function correctMemory(tx: Tx, ownerId: string, memoryId: string, input: CorrectMemoryInput): Promise<Memory | null> {
  const current = await lockMemory(tx, ownerId, memoryId);
  if (!current) return null;
  if (current.status !== "active") throw new MemoryStateError(memoryId, current.status);
  const [{ project_id: projectId }] = await tx<{ project_id: string }[]>`
    select project_id from echiche.memories where id = ${memoryId} and owner_user_id = ${ownerId}`;
  await tx`update echiche.memories set status = 'superseded' where id = ${memoryId} and owner_user_id = ${ownerId}`;
  const confidence = input.confidence === undefined ? current.confidence : input.confidence;
  const [row] = await tx<MemoryRow[]>`
    insert into echiche.memories (owner_user_id, project_id, lineage_id, version, supersedes_id, kind, content, status, origin,
                                  sensitivity, confidence)
    values (${ownerId}, ${projectId}, ${current.lineageId}, ${current.version + 1}, ${memoryId}, ${input.kind ?? current.kind},
            ${input.content}, 'active', 'user', ${current.sensitivity}, ${confidence})
    returning ${tx.unsafe(MEMORY_COLUMNS)}`;
  return asMemory(row);
}

export async function memoryHistory(tx: Tx, ownerId: string, memoryId: string): Promise<Memory[] | null> {
  const rows = await tx<MemoryRow[]>`
    select ${tx.unsafe(MEMORY_COLUMNS)} from echiche.memories
     where owner_user_id = ${ownerId}
       and lineage_id = (select lineage_id from echiche.memories where id = ${memoryId} and owner_user_id = ${ownerId})
     order by version`;
  return rows.length ? rows.map(asMemory) : null;
}

export async function deleteMemory(tx: Tx, ownerId: string, memoryId: string): Promise<boolean> {
  const rows = await tx`
    delete from echiche.memories
     where owner_user_id = ${ownerId}
       and lineage_id = (select lineage_id from echiche.memories where id = ${memoryId} and owner_user_id = ${ownerId})
    returning id`;
  return rows.length > 0;
}

export async function listDecisions(tx: Tx, ownerId: string, projectId: string): Promise<Decision[] | null> {
  if (!(await ownsProject(tx, ownerId, projectId))) return null;
  const rows = await tx<DecisionRow[]>`
    select ${tx.unsafe(DECISION_COLUMNS)} from echiche.decisions d
     where d.project_id = ${projectId} and d.owner_user_id = ${ownerId} order by d.version desc`;
  return rows.map(asDecision);
}

async function insertDecisionVersion(
  tx: Tx, ownerId: string, projectId: string,
  values: Omit<Decision, "id" | "version" | "supersedesId" | "status" | "createdAt" | "supersededAt" | "outcomes">
): Promise<Decision> {
  const [active] = await tx<{ id: string; version: number }[]>`
    select id, version from echiche.decisions
     where project_id = ${projectId} and owner_user_id = ${ownerId} and status = 'active' for update`;
  const [{ max }] = await tx<{ max: number }[]>`
    select coalesce(max(version), 0)::int as max from echiche.decisions where project_id = ${projectId} and owner_user_id = ${ownerId}`;
  if (active) {
    await tx`update echiche.decisions set status = 'superseded' where id = ${active.id} and owner_user_id = ${ownerId}`;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into echiche.decisions (owner_user_id, project_id, version, supersedes_id, status, origin, source_run_id, question,
                                   choice, rationale, alternatives, assumptions, confidence, review_triggers, next_actions)
    values (${ownerId}, ${projectId}, ${max + 1}, ${active?.id ?? null}, 'active', ${values.origin}, ${values.sourceRunId},
            ${values.question}, ${values.choice}, ${values.rationale}, ${tx.json(values.alternatives)},
            ${tx.json(values.assumptions)}, ${values.confidence}, ${tx.json(values.reviewTriggers)}, ${tx.json(values.nextActions)})
    returning id`;
  const [decision] = await tx<DecisionRow[]>`select ${tx.unsafe(DECISION_COLUMNS)} from echiche.decisions d where d.id = ${row.id}`;
  return asDecision(decision);
}

/** Accepting a brief records it as the project's current decision (the user's explicit approval). */
export async function recordAcceptedBrief(tx: Tx, ownerId: string, projectId: string, runId: string, brief: DecisionBrief): Promise<void> {
  const existing = await tx`select 1 from echiche.decisions where source_run_id = ${runId} and owner_user_id = ${ownerId}`;
  if (existing.length) return;
  await insertDecisionVersion(tx, ownerId, projectId, {
    origin: "accepted_brief",
    sourceRunId: runId,
    question: brief.decision_question,
    choice: brief.recommendation.summary,
    rationale: brief.recommendation.rationale,
    alternatives: brief.alternatives,
    assumptions: brief.key_assumptions,
    confidence: brief.confidence.level,
    reviewTriggers: brief.what_would_change,
    nextActions: brief.next_actions
  });
}

export async function reviseDecision(tx: Tx, ownerId: string, decisionId: string, input: ReviseDecisionInput): Promise<Decision | null> {
  const [current] = await tx<DecisionRow[]>`
    select ${tx.unsafe(DECISION_COLUMNS)}, d.project_id as "projectId" from echiche.decisions d
     where d.id = ${decisionId} and d.owner_user_id = ${ownerId} for update of d`;
  if (!current) return null;
  if (current.status !== "active") throw new DecisionStateError(decisionId);
  const projectId = (current as unknown as { projectId: string }).projectId;
  return insertDecisionVersion(tx, ownerId, projectId, {
    origin: "user_revision",
    sourceRunId: null,
    question: current.question,
    choice: input.choice,
    rationale: input.rationale,
    alternatives: current.alternatives,
    assumptions: current.assumptions,
    confidence: input.confidence === undefined ? current.confidence : input.confidence,
    reviewTriggers: current.reviewTriggers,
    nextActions: current.nextActions
  });
}

export async function addOutcome(tx: Tx, ownerId: string, decisionId: string, input: OutcomeInput): Promise<DecisionOutcome | null> {
  const found = await tx`select 1 from echiche.decisions where id = ${decisionId} and owner_user_id = ${ownerId}`;
  if (!found.length) return null;
  const [row] = await tx<(Omit<DecisionOutcome, "createdAt" | "observedOn"> & { createdAt: Date; observedOn: Date })[]>`
    insert into echiche.decision_outcomes (owner_user_id, decision_id, result, observed_outcome, observed_on, notes)
    values (${ownerId}, ${decisionId}, ${input.result}, ${input.observedOutcome}, ${input.observedOn}, ${input.notes || null})
    returning id, result, observed_outcome as "observedOutcome", observed_on::text as "observedOn", notes, created_at as "createdAt"`;
  return { ...row, observedOn: String(row.observedOn), createdAt: iso(row.createdAt)! };
}

export async function rememberedContext(tx: Tx, ownerId: string, runId: string): Promise<RememberedContext[]> {
  const rows = await tx<(Omit<RememberedContext, "observedAt"> & { observedAt: Date })[]>`
    select ref, kind, content, observed_at as "observedAt", memory_id as "memoryId", decision_id as "decisionId"
      from echiche.run_memory_context where run_id = ${runId} and owner_user_id = ${ownerId}
     order by (ref like 'D%') desc, length(ref), ref`;
  return rows.map(r => ({ ...r, observedAt: iso(r.observedAt)! }));
}

export async function deleteProject(tx: Tx, ownerId: string, projectId: string): Promise<boolean> {
  const rows = await tx`delete from echiche.projects where id = ${projectId} and owner_user_id = ${ownerId} returning id`;
  return rows.length > 0;
}

/** Everything stored for the project, as plain JSON (EXPORT-01). Telemetry is summarised per run. */
export async function exportProject(tx: Tx, ownerId: string, projectId: string): Promise<Record<string, unknown> | null> {
  const [project] = await tx`
    select id, title, problem_statement as "problemStatement", archived_at as "archivedAt", created_at as "createdAt",
           updated_at as "updatedAt"
      from echiche.projects where id = ${projectId} and owner_user_id = ${ownerId}`;
  if (!project) return null;
  const runs = await tx`
    select r.id, r.prompt, r.status, r.result_schema_version as "resultSchemaVersion", r.result, r.error_code as "errorCode",
           r.created_at as "createdAt", r.completed_at as "completedAt",
           json_build_object('steps', r.steps_used, 'activeSeconds', r.active_seconds_used, 'researchCalls', r.research_calls_used,
                             'costUsd', r.cost_usd_used) as usage,
           coalesce((select json_agg(json_build_object('sequence', e.sequence, 'type', e.event_type, 'stage', e.stage,
                       'message', e.message, 'createdAt', e.created_at) order by e.sequence)
                       from echiche.run_events e where e.run_id = r.id and e.owner_user_id = r.owner_user_id), '[]') as events,
           coalesce((select json_agg(json_build_object('ref', c.ref, 'kind', c.kind, 'content', c.content,
                       'observedAt', c.observed_at) order by c.ref)
                       from echiche.run_memory_context c where c.run_id = r.id and c.owner_user_id = r.owner_user_id), '[]')
             as "rememberedContext",
           coalesce((select json_agg(json_build_object('sourceId', s.source_key, 'url', s.url, 'title', s.title,
                       'publisher', s.publisher, 'publishedAt', s.published_at, 'retrievedAt', s.retrieved_at,
                       'contentSha256', s.content_sha256, 'passages', s.passages) order by s.source_key)
                       from echiche.sources s where s.run_id = r.id and s.owner_user_id = r.owner_user_id), '[]') as sources,
           coalesce((select json_agg(json_build_object('claimId', c.claim_key, 'text', c.text, 'label', c.label,
                       'status', c.status, 'freshness', c.freshness, 'contradicted', c.contradicted) order by c.claim_key)
                       from echiche.claims c where c.run_id = r.id and c.owner_user_id = r.owner_user_id), '[]') as claims,
           -- ADR-012: the text read from each attachment is the user's data, so it is exported (image bytes are not).
           coalesce((select json_agg(json_build_object('position', a.position, 'kind', a.kind, 'name', a.name, 'url', a.url,
                       'sizeBytes', a.size_bytes, 'status', a.status, 'note', a.note, 'truncated', a.truncated,
                       'extractedText', a.extracted_text, 'createdAt', a.created_at, 'readAt', a.read_at) order by a.position)
                       from echiche.run_attachments a where a.run_id = r.id and a.owner_user_id = r.owner_user_id), '[]') as attachments,
           (select json_build_object('calls', count(*), 'costUsd', coalesce(sum(m.cost_usd), 0),
                     'models', coalesce(array_agg(distinct m.model) filter (where m.model is not null), '{}'))
              from echiche.model_calls m where m.run_id = r.id and m.owner_user_id = r.owner_user_id) as "modelCalls"
      from echiche.thought_runs r
     where r.project_id = ${projectId} and r.owner_user_id = ${ownerId}
     order by r.created_at`;
  const memories = await tx<MemoryRow[]>`
    select ${tx.unsafe(MEMORY_COLUMNS)} from echiche.memories
     where project_id = ${projectId} and owner_user_id = ${ownerId} order by lineage_id, version`;
  const decisions = await listDecisions(tx, ownerId, projectId);
  return {
    schema: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    project,
    runs,
    memories: memories.map(asMemory),
    decisions: (decisions ?? []).reverse(),
    notes: [
      "Stage checkpoints and per-call telemetry rows are summarised, not exported verbatim.",
      "Sources include only the short passages Echiche stored, with links to the original pages."
    ]
  };
}
