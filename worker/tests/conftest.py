"""Fixtures for integration tests against a DISPOSABLE, migrated database.

    WORKER_TEST_DATABASE_URL  connects as echiche_worker (the production role)
    TEST_ADMIN_DATABASE_URL   superuser / Supabase postgres, for setup and assertions only

Prepare with `npm run test:db:prepare` at the repo root. Integration tests fail (never
skip) when these are missing.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from typing import Any, LiteralString

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import DictRow, dict_row

from echiche_worker.store import RunStore, connect


def _url(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        pytest.fail(f"{name} is required for integration tests (run `npm run test:db:prepare`).")
    return value


@pytest.fixture(scope="session")
def admin() -> Iterator[psycopg.Connection[DictRow]]:
    conn = psycopg.Connection[DictRow].connect(
        _url("TEST_ADMIN_DATABASE_URL"), autocommit=True, row_factory=dict_row, prepare_threshold=None
    )
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def worker_url() -> str:
    url = _url("WORKER_TEST_DATABASE_URL")
    with connect(url) as conn:
        row = conn.execute("select current_user as u").fetchone()
        assert row is not None and row["u"] == "echiche_worker", (
            "WORKER_TEST_DATABASE_URL must connect as echiche_worker"
        )
    return url


@pytest.fixture
def clean(admin: psycopg.Connection[DictRow]) -> Iterator[None]:
    admin.execute(
        "truncate echiche.projects, echiche.thought_runs, echiche.run_events, echiche.run_stage_outputs cascade"
    )
    admin.execute("delete from echiche.worker_heartbeats")
    admin.execute("delete from auth.users where email like 'worker-test-%@example.test'")
    yield


@pytest.fixture
def store_factory(worker_url: str) -> Iterator[Any]:
    opened: list[psycopg.Connection[DictRow]] = []

    def make(worker_id: str = "worker-a", lease_seconds: int = 30) -> RunStore:
        conn = connect(worker_url)
        opened.append(conn)
        return RunStore(conn, worker_id, lease_seconds)

    yield make
    for conn in opened:
        conn.close()


def create_run(admin: psycopg.Connection[DictRow], **overrides: object) -> str:
    """A queued run owned by a fresh synthetic user, inserted like the web app would."""
    user = str(uuid.uuid4())
    admin.execute("insert into auth.users (id, email) values (%s, %s)", (user, f"worker-test-{user}@example.test"))
    project = admin.execute(
        """insert into echiche.projects (owner_user_id, title, problem_statement)
           values (%s, 'Worker test', 'A synthetic decision for worker tests.') returning id""",
        (user,),
    ).fetchone()
    assert project is not None
    columns = {"owner_user_id": user, "project_id": project["id"], "prompt": "Should we enter market X next year?"}
    columns.update(overrides)
    query = sql.SQL("insert into echiche.thought_runs ({}) values ({}) returning id").format(
        sql.SQL(", ").join(sql.Identifier(name) for name in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )
    row = admin.execute(query, tuple(columns.values())).fetchone()
    assert row is not None
    return str(row["id"])


def run_row(admin: psycopg.Connection[DictRow], run_id: str) -> DictRow:
    row = admin.execute("select * from echiche.thought_runs where id = %s", (run_id,)).fetchone()
    assert row is not None
    return row


def events(admin: psycopg.Connection[DictRow], run_id: str) -> list[tuple[int, str, str]]:
    rows = admin.execute(
        "select sequence, event_type, stage from echiche.run_events where run_id = %s order by sequence", (run_id,)
    ).fetchall()
    return [(r["sequence"], r["event_type"], r["stage"]) for r in rows]


def checkpoints(admin: psycopg.Connection[DictRow], run_id: str) -> list[str]:
    rows = admin.execute(
        "select stage from echiche.run_stage_outputs where run_id = %s order by created_at", (run_id,)
    ).fetchall()
    return [r["stage"] for r in rows]


def as_end_user(
    admin: psycopg.Connection[DictRow], run_id: str, sql: LiteralString, params: tuple[object, ...] = ()
) -> None:
    """Executes sql exactly as the web app would for the run's owner (role + claims)."""
    owner = run_row(admin, run_id)["owner_user_id"]
    with admin.transaction():
        admin.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": str(owner)}),))
        admin.execute("set local role echiche_end_user")
        admin.execute(sql, params)
