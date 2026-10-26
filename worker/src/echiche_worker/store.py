"""Postgres access for the worker (connects as echiche_worker; ADR-004 roles).

Every write after a claim is guarded by `claimed_by = me AND lease_expires_at > now()`.
If that guard matches nothing, the lease was lost (expired and reclaimed by another
worker) and LeaseLostError is raised, so a slow or partitioned worker can never
overwrite a run someone else now owns. Stage checkpoints, the status change, usage
counters and the stage event are committed in one transaction.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import LiteralString, cast

import psycopg
from psycopg.rows import DictRow, dict_row
from pydantic import ValidationError

from echiche_worker.contracts import (
    RESULT_SCHEMA_VERSION,
    STAGE_OUTPUT_SCHEMA_VERSION,
    STAGES,
    ReasoningScaffoldResultV1,
    Stage,
    StageOutputV1,
)

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


def connect(database_url: str) -> psycopg.Connection[Row]:
    # autocommit + explicit transaction blocks; prepare_threshold=None keeps transaction-mode
    # poolers (Supabase Supavisor / PgBouncer) working.
    return psycopg.Connection[DictRow].connect(
        database_url, autocommit=True, row_factory=dict_row, prepare_threshold=None, connect_timeout=10
    )


def _claimed(row: Row) -> ClaimedRun:
    return ClaimedRun(
        id=str(row["id"]),
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
        return _claimed(row) if row else None

    def renew_lease(self, run_id: str) -> bool:
        cur = self.conn.execute(
            """update echiche.thought_runs set lease_expires_at = now() + make_interval(secs => %s)
                where id = %s and claimed_by = %s and lease_expires_at > now()""",
            (self.lease_seconds, run_id, self.worker_id),
        )
        return cur.rowcount == 1

    # --- reads -------------------------------------------------------------------------

    def load_checkpoints(self, run_id: str) -> dict[Stage, StageOutputV1]:
        rows = self.conn.execute(
            "select stage, output, output_schema_version from echiche.run_stage_outputs where run_id = %s",
            (run_id,),
        ).fetchall()
        result: dict[Stage, StageOutputV1] = {}
        for row in rows:
            if row["output_schema_version"] != STAGE_OUTPUT_SCHEMA_VERSION:
                raise CorruptCheckpointError(f"unknown checkpoint version for {row['stage']}")
            try:
                output = StageOutputV1.model_validate(row["output"])
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

    def commit_stage(
        self, run: ClaimedRun, output: StageOutputV1, duration_ms: int, research_calls: int, cost_usd: Decimal
    ) -> Usage:
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
                    STAGE_OUTPUT_SCHEMA_VERSION,
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
                    (Decimal(duration_ms) / 1000, research_calls, cost_usd, self.lease_seconds),
                )
                self._event(run, "stage", output.stage, f"{output.title}: completed")
        return _claimed(row).usage

    def finish(self, run: ClaimedRun, result: ReasoningScaffoldResultV1) -> None:
        with self.conn.transaction():
            self._guarded_update(
                run.id,
                """status = 'awaiting_user_review', result = %s::jsonb, result_schema_version = %s,
                   error_code = null, claimed_by = null, lease_expires_at = null""",
                (json.dumps(result.model_dump(mode="json")), RESULT_SCHEMA_VERSION),
            )
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
