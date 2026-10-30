"""Postgres access for the worker (connects as echiche_worker; ADR-004 roles).

Every write after a claim is guarded by `claimed_by = me AND lease_expires_at > now()`.
If that guard matches nothing, the lease was lost (expired and reclaimed by another
worker) and LeaseLostError is raised, so a slow or partitioned worker can never
overwrite a run someone else now owns. Stage checkpoints, the status change, usage
counters and the stage event are committed in one transaction.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from decimal import ROUND_UP, Decimal
from typing import LiteralString, cast

import psycopg
from psycopg.rows import DictRow, dict_row
from pydantic import BaseModel, ValidationError

from echiche_worker.attachments import Attachment, AttachmentRead
from echiche_worker.contracts import (
    EVIDENCE_SET_SCHEMA_VERSION,
    STAGE_DATA,
    STAGE_OUTPUT_SCHEMA_VERSION,
    STAGE_OUTPUT_V2_SCHEMA_VERSION,
    STAGES,
    VERIFICATION_REPORT_SCHEMA_VERSION,
    DecisionBriefV1,
    EvidenceSetV1,
    Stage,
    StageOutput,
    StageOutputV1,
    StageOutputV2,
    VerificationReportV1,
)
from echiche_worker.memory import ContextItem, DecisionItem, MemoryItem, sensitivity
from echiche_worker.provider import ModelCallRecord, ResearchCallRecord

ACTIVE = ("planning", "researching", "critiquing", "verifying", "synthesizing")
Row = DictRow


class LeaseLostError(Exception):
    """This worker no longer owns the run; stop without writing anything else."""


class CorruptCheckpointError(Exception):
    code = "CHECKPOINT_INVALID"


@dataclass(frozen=True, slots=True)
class Budget:
    max_steps: int
    max_active_seconds: int
    max_research_calls: int
    max_cost_usd: Decimal


@dataclass(frozen=True, slots=True)
class Usage:
    steps: int
    active_seconds: Decimal
    research_calls: int
    cost_usd: Decimal


@dataclass(frozen=True, slots=True)
class ClaimedRun:
    id: str
    owner_user_id: str
    prompt: str
    status: str
    attempt: int
    max_attempts: int
    budget: Budget
    usage: Usage
    project_context: str = ""
    project_id: str = ""
    route_tier: str | None = None  # M7; None for runs queued before routing existed


def to_v2(output: StageOutput) -> StageOutputV2:
    if isinstance(output, StageOutputV2):
        return output
    return StageOutputV2(stage=output.stage, title=output.title, content=output.content, limitations=output.limitations)


def spend(amount: Decimal) -> Decimal:
    """cost_usd_used is numeric(10,4): round each increment up so spend is never under-counted."""
    return amount.quantize(Decimal("0.0001"), rounding=ROUND_UP)


def project_context(title: str, problem_statement: str) -> str:
    return f"Project title: {title.strip()}\n\nProblem statement:\n{problem_statement.strip()}"


def connect(database_url: str) -> psycopg.Connection[Row]:
    # autocommit + explicit transaction blocks; prepare_threshold=None keeps transaction-mode
    # poolers (Supabase Supavisor / PgBouncer) working.
    return psycopg.Connection[DictRow].connect(
        database_url, autocommit=True, row_factory=dict_row, prepare_threshold=None, connect_timeout=10
    )


def _claimed(row: Row) -> ClaimedRun:
    return ClaimedRun(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        owner_user_id=str(row["owner_user_id"]),
        prompt=cast(str, row["prompt"]),
        status=cast(str, row["status"]),
        attempt=cast(int, row["attempt"]),
        max_attempts=cast(int, row["max_attempts"]),
        budget=Budget(
            max_steps=cast(int, row["budget_max_steps"]),
            max_active_seconds=cast(int, row["budget_max_active_seconds"]),
            max_research_calls=cast(int, row["budget_max_research_calls"]),
            max_cost_usd=cast(Decimal, row["budget_max_cost_usd"]),
        ),
        usage=Usage(
            steps=cast(int, row["steps_used"]),
            active_seconds=cast(Decimal, row["active_seconds_used"]),
            research_calls=cast(int, row["research_calls_used"]),
            cost_usd=cast(Decimal, row["cost_usd_used"]),
        ),
        route_tier=cast(str | None, row.get("route_tier")),
    )


class RunStore:
    def __init__(self, conn: psycopg.Connection[Row], worker_id: str, lease_seconds: int) -> None:
        self.conn = conn
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds

    # --- liveness -------------------------------------------------------------------

    def heartbeat(self, version: str, current_run_id: str | None) -> None:
        self.conn.execute(
            """insert into echiche.worker_heartbeats (worker_id, version, current_run_id)
               values (%s, %s, %s)
               on conflict (worker_id) do update
                 set last_seen_at = now(), version = excluded.version, current_run_id = excluded.current_run_id""",
            (self.worker_id, version, current_run_id),
        )

    def remove_heartbeat(self) -> None:
        self.conn.execute("delete from echiche.worker_heartbeats where worker_id = %s", (self.worker_id,))

    # --- claiming ----------------------------------------------------------------------

    def claim(self) -> ClaimedRun | None:
        """Claims one runnable job: queued and due, or active with an expired lease.

        SKIP LOCKED makes concurrent workers pick different rows; the lease makes a
        crashed worker's run reclaimable once it expires.
        """
        with self.conn.transaction():
            row = self.conn.execute(
                """with candidate as (
                     select id from echiche.thought_runs
                      -- A live lease always excludes a run, whatever its status: a claimed run stays
                      -- 'queued' until its first stage starts, and FOR UPDATE re-checks this predicate
                      -- against the committed row, so without it two workers could both claim it.
                      where (lease_expires_at is null or lease_expires_at < now())
                        and ((status = 'queued' and available_at <= now()) or status = any(%s))
                      order by available_at, created_at
                      for update skip locked
                      limit 1)
                   update echiche.thought_runs r
                      set claimed_by = %s,
                          lease_expires_at = now() + make_interval(secs => %s),
                          attempt = r.attempt + 1,
                          started_at = coalesce(r.started_at, now())
                     from candidate
                    where r.id = candidate.id
                   returning r.*""",
                (list(ACTIVE), self.worker_id, self.lease_seconds),
            ).fetchone()
            if row is None:
                return None
            project = self.conn.execute(
                "select title, problem_statement from echiche.projects where id = %s", (row["project_id"],)
            ).fetchone()
        claimed = _claimed(row)
        if project is None:
            return claimed
        context = project_context(cast(str, project["title"]), cast(str, project["problem_statement"]))
        return replace(claimed, project_context=context)

    def renew_lease(self, run_id: str) -> bool:
        cur = self.conn.execute(
            """update echiche.thought_runs set lease_expires_at = now() + make_interval(secs => %s)
                where id = %s and claimed_by = %s and lease_expires_at > now()""",
            (self.lease_seconds, run_id, self.worker_id),
        )
        return cur.rowcount == 1

    # --- reads -------------------------------------------------------------------------

    def load_checkpoints(self, run_id: str) -> dict[Stage, StageOutputV2]:
        """Accepts stage-output.v1 (M3) and v2 checkpoints, so runs paused before an upgrade
        resume cleanly. Any model payload is re-validated against its contract."""
        rows = self.conn.execute(
            "select stage, output, output_schema_version from echiche.run_stage_outputs where run_id = %s",
            (run_id,),
        ).fetchall()
        result: dict[Stage, StageOutputV2] = {}
        for row in rows:
            version = row["output_schema_version"]
            try:
                if version == STAGE_OUTPUT_SCHEMA_VERSION:
                    output = to_v2(StageOutputV1.model_validate(row["output"]))
                elif version == STAGE_OUTPUT_V2_SCHEMA_VERSION:
                    output = StageOutputV2.model_validate(row["output"])
                    if output.data_schema is not None or output.data is not None:
                        contract = STAGE_DATA.get(output.data_schema or "")
                        if contract is None or output.data is None:
                            raise CorruptCheckpointError(f"unknown data contract for {row['stage']}")
                        contract.model_validate(output.data)
                else:
                    raise CorruptCheckpointError(f"unknown checkpoint version for {row['stage']}")
            except ValidationError as exc:
                raise CorruptCheckpointError(f"invalid checkpoint for {row['stage']}") from exc
            result[output.stage] = output
        return {stage: result[stage] for stage in STAGES if stage in result}

    def cancel_requested(self, run_id: str) -> bool:
        row = self.conn.execute(
            "select cancel_requested_at is not null as requested from echiche.thought_runs where id = %s",
            (run_id,),
        ).fetchone()
        return bool(row and row["requested"])

    # --- guarded writes ----------------------------------------------------------------

    def _guarded_update(self, run_id: str, assignments: LiteralString, params: tuple[object, ...]) -> Row:
        row = self.conn.execute(
            f"""update echiche.thought_runs set {assignments}
                 where id = %s and claimed_by = %s and lease_expires_at > now()
                returning *""",  # noqa: S608 - assignments are LiteralString constants from this module
            (*params, run_id, self.worker_id),
        ).fetchone()
        if row is None:
            raise LeaseLostError(run_id)
        return row

    def _event(self, run: ClaimedRun, event_type: str, stage: str, message: str) -> None:
        # The guarded UPDATE in the same transaction holds the run row lock, so
        # sequence numbers cannot race with another writer.
        self.conn.execute(
            """insert into echiche.run_events (owner_user_id, run_id, sequence, event_type, stage, message)
               values (%s, %s,
                       (select coalesce(max(sequence), 0) + 1 from echiche.run_events where run_id = %s),
                       %s, %s, %s)""",
            (run.owner_user_id, run.id, run.id, event_type, stage, message),
        )

    def begin_stage(self, run: ClaimedRun, stage: Stage, title: str) -> None:
        with self.conn.transaction():
            self._guarded_update(
                run.id,
                "status = %s, lease_expires_at = now() + make_interval(secs => %s)",
                (stage, self.lease_seconds),
            )
            self._event(run, "stage", stage, f"{title}: started")

    def _insert_calls(self, run: ClaimedRun, calls: Sequence[ModelCallRecord]) -> None:
        for c in calls:
            self.conn.execute(
                """insert into echiche.model_calls
                     (owner_user_id, run_id, stage, attempt, provider, model, prompt_id, prompt_version, prompt_sha256,
                      output_schema, repair, outcome, error_code, input_tokens, cached_input_tokens, output_tokens,
                      reasoning_tokens, cost_usd, latency_ms)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    run.owner_user_id, run.id, c.stage, run.attempt, c.provider, c.model, c.prompt_id,
                    c.prompt_version, c.prompt_sha256, c.output_schema, c.repair, c.outcome, c.error_code,
                    c.input_tokens, c.cached_input_tokens, c.output_tokens, c.reasoning_tokens, c.cost_usd,
                    c.latency_ms,
                ),
            )  # fmt: skip

    def _insert_research_calls(self, run: ClaimedRun, calls: Sequence[ResearchCallRecord]) -> None:
        for c in calls:
            self.conn.execute(
                """insert into echiche.research_calls
                     (owner_user_id, run_id, attempt, kind, provider, outcome, http_status, domain, result_count, bytes,
                      cost_usd, latency_ms)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    run.owner_user_id, run.id, run.attempt, c.kind, c.provider, c.outcome[:32], c.http_status,
                    c.domain, c.result_count, c.bytes, c.cost_usd, c.latency_ms,
                ),
            )  # fmt: skip

    def _insert_sources(self, run: ClaimedRun, evidence: EvidenceSetV1) -> None:
        for s in evidence.sources:
            self.conn.execute(
                """insert into echiche.sources
                     (owner_user_id, run_id, source_key, url, domain, title, publisher, published_at, retrieved_at,
                      content_sha256, search_query, passages)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
                (
                    run.owner_user_id, run.id, s.source_id, s.url, s.domain, s.title, s.publisher, s.published_at,
                    s.retrieved_at, s.content_sha256, s.search_query,
                    json.dumps([p.model_dump(mode="json") for p in s.passages]),
                ),
            )  # fmt: skip

    def _insert_claims(self, run: ClaimedRun, report: VerificationReportV1) -> None:
        for c in report.claims:
            row = self.conn.execute(
                """insert into echiche.claims (owner_user_id, run_id, claim_key, text, label, status, freshness,
                                               contradicted)
                   values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
                (run.owner_user_id, run.id, c.claim_id, c.text, c.label, c.status, c.freshness,
                 c.claim_id in report.contradictions),
            ).fetchone()  # fmt: skip
            if row is None:  # pragma: no cover - INSERT ... RETURNING always returns the row
                raise LeaseLostError(run.id)
            for e in c.evidence:
                self.conn.execute(
                    """insert into echiche.claim_sources
                         (claim_id, source_id, owner_user_id, passage_key, relation, quote, verdict, note)
                       select %s, s.id, %s, %s, %s, %s, %s, %s
                         from echiche.sources s where s.run_id = %s and s.source_key = %s
                       on conflict (claim_id, passage_key) do nothing""",
                    (row["id"], run.owner_user_id, e.passage_id, e.relation, e.quote[:500], e.verdict, e.note[:500],
                     run.id, e.source_id),
                )  # fmt: skip

    # --- project memory (M6) -------------------------------------------------------------

    def load_project_memory(self, run: ClaimedRun) -> tuple[list[MemoryItem], DecisionItem | None]:
        """Active memories and the active decision of this run's project and owner only."""
        rows = self.conn.execute(
            """select id, kind, content, observed_at, origin, edited, version from echiche.memories
                where project_id = %s and owner_user_id = %s and status = 'active'
                order by observed_at desc limit 200""",
            (run.project_id, run.owner_user_id),
        ).fetchall()
        memories = [
            MemoryItem(str(r["id"]), r["kind"], r["content"], r["observed_at"], r["origin"], r["edited"], r["version"])
            for r in rows
        ]
        d = self.conn.execute(
            """select id, version, question, choice, rationale, confidence, created_at from echiche.decisions
                where project_id = %s and owner_user_id = %s and status = 'active'""",
            (run.project_id, run.owner_user_id),
        ).fetchone()
        if d is None:
            return memories, None
        decision = DecisionItem(
            str(d["id"]), d["version"], d["question"], d["choice"], d["rationale"], d["confidence"], d["created_at"]
        )
        return memories, decision

    def load_run_memory(self, run_id: str) -> list[ContextItem]:
        rows = self.conn.execute(
            """select ref, kind, content, observed_at, memory_id, decision_id from echiche.run_memory_context
                where run_id = %s order by (ref like 'D%%') desc, length(ref), ref""",
            (run_id,),
        ).fetchall()
        return [
            ContextItem(
                r["ref"],
                r["kind"],
                r["content"],
                r["observed_at"],
                str(r["memory_id"]) if r["memory_id"] else None,
                str(r["decision_id"]) if r["decision_id"] else None,
            )
            for r in rows
        ]

    def load_attachments(self, run_id: str) -> tuple[Attachment, ...]:
        """ADR-012: the run's attachments in order. Image bytes are loaded only while still unread."""
        rows = self.conn.execute(
            """select id, position, kind, name, status, extracted_text, truncated, note, url, media_type,
                      case when status = 'pending' then image_data end as image_data
                 from echiche.run_attachments where run_id = %s order by position""",
            (run_id,),
        ).fetchall()
        return tuple(
            Attachment(
                id=str(r["id"]),
                position=int(r["position"]),
                kind=str(r["kind"]),
                name=str(r["name"]),
                status=str(r["status"]),
                text=cast(str | None, r["extracted_text"]),
                truncated=bool(r["truncated"]),
                note=cast(str | None, r["note"]),
                url=cast(str | None, r["url"]),
                media_type=cast(str | None, r["media_type"]),
                image=bytes(r["image_data"]) if r["image_data"] is not None else None,
            )
            for r in rows
        )

    def _record_attachment_reads(self, run: ClaimedRun, reads: Sequence[AttachmentRead]) -> None:
        """Keeps what was read (text or a reason it wasn't) and drops the image bytes: no longer needed."""
        for r in reads:
            self.conn.execute(
                """update echiche.run_attachments
                      set status = %s, extracted_text = %s, truncated = %s, note = %s,
                          image_data = null, read_at = now()
                    where id = %s and run_id = %s and status = 'pending'""",
                (r.status, r.text, r.truncated, r.note, r.id, run.id),
            )

    def _insert_memory_context(self, run: ClaimedRun, items: Sequence[ContextItem]) -> None:
        for i in items:
            self.conn.execute(
                """insert into echiche.run_memory_context
                     (run_id, owner_user_id, ref, memory_id, decision_id, kind, content, observed_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (run_id, ref) do nothing""",
                (run.id, run.owner_user_id, i.ref, i.memory_id, i.decision_id, i.kind, i.content, i.observed_at),
            )

    def _insert_proposals(self, run: ClaimedRun, brief: DecisionBriefV1) -> None:
        """Proposals only: nothing here is durable memory until the owner approves it (MEM-01).
        Idempotent per (run, proposal index)."""
        for index, update in enumerate(brief.proposed_memory_updates):
            self.conn.execute(
                """insert into echiche.memories
                     (owner_user_id, project_id, kind, content, status, origin, sensitivity, source_run_id,
                      proposal_index, observed_at)
                   values (%s, %s, %s, %s, 'proposed', 'model_proposal', %s, %s, %s, now())
                   on conflict (source_run_id, proposal_index) do nothing""",
                (
                    run.owner_user_id,
                    run.project_id,
                    update.kind,
                    update.statement,
                    sensitivity(update.statement),
                    run.id,
                    index,
                ),
            )

    def record_calls(
        self, run: ClaimedRun, calls: Sequence[ModelCallRecord], research_calls: Sequence[ResearchCallRecord] = ()
    ) -> None:
        """Persists telemetry and counts the spend of calls whose stage did not complete
        (failure, retry, pause), so a failing run still consumes its cost budget."""
        if not calls and not research_calls:
            return
        total = sum((c.cost_usd for c in calls), Decimal(0)) + sum((c.cost_usd for c in research_calls), Decimal(0))
        with self.conn.transaction():
            self._guarded_update(run.id, "cost_usd_used = cost_usd_used + %s", (spend(total),))
            self._insert_calls(run, calls)
            self._insert_research_calls(run, research_calls)

    def commit_stage(
        self,
        run: ClaimedRun,
        output: StageOutput,
        duration_ms: int,
        research_calls: int,
        cost_usd: Decimal,
        calls: Sequence[ModelCallRecord] = (),
        research_records: Sequence[ResearchCallRecord] = (),
        memory_context: Sequence[ContextItem] = (),
        escalation: str | None = None,
        attachment_reads: Sequence[AttachmentRead] = (),
    ) -> Usage:
        """cost_usd must include the cost of `calls` and `research_records`. The checkpoint,
        usage, telemetry, and any sources or claims it carries are written in one transaction."""
        output = to_v2(output)
        with self.conn.transaction():
            inserted = self.conn.execute(
                """insert into echiche.run_stage_outputs
                     (run_id, owner_user_id, stage, output, output_schema_version, attempt, duration_ms)
                   values (%s, %s, %s, %s::jsonb, %s, %s, %s)
                   on conflict (run_id, stage) do nothing""",
                (
                    run.id,
                    run.owner_user_id,
                    output.stage,
                    json.dumps(output.model_dump(mode="json")),
                    STAGE_OUTPUT_V2_SCHEMA_VERSION,
                    run.attempt,
                    duration_ms,
                ),
            ).rowcount
            if inserted == 0:
                # Already checkpointed (should not happen under a valid lease): count nothing twice.
                row = self._guarded_update(run.id, "lease_expires_at = lease_expires_at", ())
            else:
                row = self._guarded_update(
                    run.id,
                    """steps_used = steps_used + 1,
                       active_seconds_used = active_seconds_used + %s,
                       research_calls_used = research_calls_used + %s,
                       cost_usd_used = cost_usd_used + %s,
                       lease_expires_at = now() + make_interval(secs => %s)""",
                    (Decimal(duration_ms) / 1000, research_calls, spend(cost_usd), self.lease_seconds),
                )
                self._insert_calls(run, calls)
                self._insert_research_calls(run, research_records)
                self._insert_memory_context(run, memory_context)
                self._record_attachment_reads(run, attachment_reads)
                if output.data_schema == EVIDENCE_SET_SCHEMA_VERSION and output.data is not None:
                    self._insert_sources(run, EvidenceSetV1.model_validate(output.data))
                elif output.data_schema == VERIFICATION_REPORT_SCHEMA_VERSION and output.data is not None:
                    self._insert_claims(run, VerificationReportV1.model_validate(output.data))
                if escalation:
                    self._guarded_update(run.id, "route_escalation = %s", (escalation[:300],))
                    self._event(run, "status", output.stage, f"Route: {escalation}"[:500])
                self._event(run, "stage", output.stage, f"{output.title}: completed")
        return _claimed(row).usage

    def finish(self, run: ClaimedRun, schema_version: str, result: BaseModel) -> None:
        with self.conn.transaction():
            self._guarded_update(
                run.id,
                """status = 'awaiting_user_review', result = %s::jsonb, result_schema_version = %s,
                   error_code = null, claimed_by = null, lease_expires_at = null""",
                (json.dumps(result.model_dump(mode="json")), schema_version),
            )
            if isinstance(result, DecisionBriefV1):
                self._insert_proposals(run, result)
            self._event(run, "result", "complete", "Decision brief ready for your review.")

    def _terminal(self, run: ClaimedRun, status: str, code: str | None, event_type: str, message: str) -> None:
        with self.conn.transaction():
            self._guarded_update(
                run.id,
                "status = %s, error_code = %s, claimed_by = null, lease_expires_at = null",
                (status, code),
            )
            self._event(run, event_type, status, message)

    def fail(self, run: ClaimedRun, code: str) -> None:
        self._terminal(run, "failed", code, "error", "Run failed.")

    def cancel(self, run: ClaimedRun) -> None:
        self._terminal(run, "cancelled", None, "status", "Run cancelled at your request.")

    def pause_for_budget(self, run: ClaimedRun, code: str) -> None:
        self._terminal(
            run,
            "paused_for_budget",
            code,
            "budget",
            "Paused: budget limit reached. Approve more to continue.",
        )

    def release_for_retry(self, run: ClaimedRun, delay_seconds: float, code: str, consume_attempt: bool = True) -> None:
        """Back to the queue, keeping checkpoints. Graceful shutdown does not consume an attempt."""
        with self.conn.transaction():
            self._guarded_update(
                run.id,
                """status = 'queued', error_code = %s, claimed_by = null, lease_expires_at = null,
                   available_at = now() + make_interval(secs => %s),
                   attempt = attempt - %s""",
                (code, delay_seconds, 0 if consume_attempt else 1),
            )
            self._event(run, "status", "queued", "Temporary problem; the run will retry automatically.")
