"""M6 memory against real Postgres as echiche_worker: the seeded retrieval benchmark,
run memory context, proposals, and the database rules that keep memory user-controlled."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from threading import Event
from typing import Any

import psycopg
import pytest
from psycopg.rows import DictRow

from echiche_worker.executor import ExecutorSettings, Outcome, execute
from echiche_worker.memory import select_context
from echiche_worker.retry import RetryPolicy
from echiche_worker.store import RunStore

from .conftest import as_end_user, create_run, run_row
from .model_fakes import VALID, FakeModelClient, model_provider

pytestmark = [pytest.mark.integration, pytest.mark.usefixtures("clean")]
FAST = ExecutorSettings(stage_timeout_seconds=10, retry=RetryPolicy(max_tries=1, base_seconds=0.001, cap_seconds=0.002))
Admin = psycopg.Connection[DictRow]
CORPUS = json.loads((Path(__file__).parent / "fixtures" / "memory_benchmark.json").read_text())


def seed(admin: Admin) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """Creates users, projects, memories (all statuses) and P1's decision. Returns key -> id maps."""
    users = {u: str(uuid.uuid4()) for u in ("U1", "U2")}
    for uid in users.values():
        admin.execute("insert into auth.users (id, email) values (%s, %s)", (uid, f"worker-test-{uid}@example.test"))
    projects: dict[str, str] = {}
    for key, p in CORPUS["projects"].items():
        row = admin.execute(
            """insert into echiche.projects (owner_user_id, title, problem_statement)
               values (%s, %s, 'Synthetic memory benchmark project.') returning id""",
            (users[p["owner"]], p["title"]),
        ).fetchone()
        assert row is not None
        projects[key] = str(row["id"])
    ids: dict[str, str] = {}
    for i, m in enumerate(CORPUS["memories"]):
        owner = users[CORPUS["projects"][m["project"]]["owner"]]
        mid = str(uuid.uuid4())
        lineage = ids[m["supersedes"]] if "supersedes" in m else mid
        version = 2 if "supersedes" in m else 1
        admin.execute(
            """insert into echiche.memories (id, owner_user_id, project_id, lineage_id, version, supersedes_id, kind,
                                             content, status, origin, observed_at)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'user', now() - make_interval(days => %s))""",
            (mid, owner, projects[m["project"]], lineage, version, ids.get(m.get("supersedes", "")), m["kind"],
             m["content"], m["status"], 60 - i),
        )  # fmt: skip
        ids[m["key"]] = mid
    d = CORPUS["decision"]
    admin.execute(
        """insert into echiche.decisions
             (owner_user_id, project_id, version, status, origin, question, choice, rationale)
           values (%s, %s, 1, 'active', 'user_revision', %s, %s, %s)""",
        (users["U1"], projects[d["project"]], d["question"], d["choice"], d["rationale"]),
    )
    return users, projects, ids


def claimed_for(admin: Admin, store: RunStore, owner: str, project: str, prompt: str) -> Any:
    create_run(admin, owner_user_id=owner, project_id=project, prompt=prompt)
    run = store.claim()
    assert run is not None
    return run


def test_seeded_retrieval_benchmark(admin: Admin, store_factory: Any) -> None:
    """Recall, precision, abstention, temporal correctness and isolation on a known corpus."""
    users, projects, ids = seed(admin)
    by_id = {v: k for k, v in ids.items()}
    store: RunStore = store_factory()
    always = {"goal", "team"}
    hits = expected_total = returned_relevant = correct_abstentions = abstention_queries = 0
    leaks: list[str] = []
    for case in CORPUS["queries"]:
        run = claimed_for(admin, store, users["U1"], projects["P1"], f"{case['q']} (benchmark)")
        memories, decision = store.load_project_memory(run)
        chosen = select_context(memories, decision, case["q"])
        keys = [by_id[c.memory_id] for c in chosen if c.memory_id]
        assert chosen[0].ref == "D1" and "paid pilot" in chosen[0].content  # canonical decision first
        assert always <= set(keys)  # goals and current constraints always included
        recalled = [k for k in keys if k not in always]
        leaks += [k for k in keys if k in {"team_old", "unapproved", "rejected"} or k.startswith(("p2_", "p3_"))]
        expected = set(case["expect"])
        hits += len(expected & set(recalled))
        expected_total += len(expected)
        returned_relevant += len(recalled)
        if not expected:
            abstention_queries += 1
            correct_abstentions += int(not recalled)
        admin.execute("update echiche.thought_runs set status = 'failed', claimed_by = null, lease_expires_at = null")
    recall = hits / expected_total
    precision = hits / returned_relevant if returned_relevant else 1.0
    abstention = correct_abstentions / abstention_queries
    print(
        f"\nmemory benchmark: recall={recall:.2f} precision={precision:.2f} abstention={abstention:.2f} leaks={leaks}"
    )
    assert leaks == []  # superseded, unapproved, rejected and other projects' items never surface
    assert recall == 1.0 and precision == 1.0 and abstention == 1.0


def test_runs_record_the_memory_they_were_given_and_flag_conflicts(admin: Admin, store_factory: Any) -> None:
    users, projects, ids = seed(admin)
    frame = json.loads(VALID["decision_frame_v2"])
    frame["memory_conflicts"] = [{"ref": "M1", "conflict": "The question now targets 40 clinics, not 20."}]
    invented = frame | {"memory_conflicts": [{"ref": "M9", "conflict": "I remember you said otherwise."}]}
    client = FakeModelClient(script={"decision_frame_v2": [json.dumps(invented), json.dumps(frame)]})
    store: RunStore = store_factory()
    run = claimed_for(admin, store, users["U1"], projects["P1"], "Should we aim for 40 paying clinics by June?")
    assert execute(run, store, model_provider(client), FAST, Event()) is Outcome.AWAITING_REVIEW

    context = admin.execute(
        "select ref, memory_id, decision_id, content from echiche.run_memory_context where run_id = %s order by ref",
        (run.id,),
    ).fetchall()
    refs = [c["ref"] for c in context]
    given = {str(c["memory_id"]) for c in context if c["memory_id"]}
    assert refs[0] == "D1" and given >= {ids["goal"], ids["team"]}
    framing = client.requests[0]
    assert "Reach 20 paying clinics" in framing.data and "Reach 20 paying clinics" not in framing.instructions
    assert "Only one engineer" not in framing.data and "Clinics hate" not in framing.data  # superseded / unapproved
    assert "M9" in client.requests[1].instructions  # invented recall was rejected and repaired
    synthesis = next(r for r in client.requests if r.schema_name == "decision_brief_v1")
    assert "Reach 20 paying clinics" in synthesis.data  # the brief sees the same remembered items
    brief = run_row(admin, run.id)["result"]
    assert "Remembered item M1 may be outdated: The question now targets 40 clinics, not 20." in brief["limitations"]


def test_completed_runs_create_proposals_not_memories(admin: Admin, store_factory: Any) -> None:
    brief = json.loads(VALID["decision_brief_v1"])
    brief["proposed_memory_updates"] = [
        {"kind": "decision", "statement": "Testing willingness to pay before a full launch."},
        {"kind": "constraint", "statement": "The founder's salary must be covered by June."},
    ]
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    client = FakeModelClient(script={"decision_brief_v1": [json.dumps(brief)]})
    assert execute(run, store, model_provider(client), FAST, Event()) is Outcome.AWAITING_REVIEW
    rows = admin.execute(
        "select status, origin, sensitivity, proposal_index from echiche.memories where source_run_id = %s "
        "order by proposal_index",
        (run_id,),
    ).fetchall()
    assert [(r["status"], r["origin"], r["sensitivity"]) for r in rows] == [
        ("proposed", "model_proposal", "normal"),
        ("proposed", "model_proposal", "sensitive"),  # salary: flagged for explicit confirmation
    ]
    # Proposals are never given to later runs until approved.
    later = create_run(admin, owner_user_id=run_row(admin, run_id)["owner_user_id"], project_id=run.project_id)
    claimed = store.claim()
    assert claimed is not None and claimed.id == later
    memories, _ = store.load_project_memory(claimed)
    assert memories == []


def test_database_keeps_memory_user_controlled(admin: Admin, store_factory: Any, worker_url: str) -> None:
    users, projects, ids = seed(admin)
    run_id = create_run(admin, owner_user_id=users["U1"], project_id=projects["P1"])
    with psycopg.connect(worker_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.RaiseException, match="only insert memory proposals"):
            conn.execute(
                """insert into echiche.memories (owner_user_id, project_id, kind, content, status, origin)
                   values (%s, %s, 'goal', 'Sneaky durable memory', 'active', 'model_proposal')""",
                (users["U1"], projects["P1"]),
            )
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update echiche.memories set content = 'x' where id = %s", (ids["goal"],))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("delete from echiche.memories where id = %s", (ids["goal"],))
    # End users: active content is immutable (corrections are new versions); superseded is frozen.
    with pytest.raises(psycopg.errors.RaiseException, match="cannot change"):
        as_end_user(admin, run_id, "update echiche.memories set content = 'rewritten' where id = %s", (ids["goal"],))
    with pytest.raises(psycopg.errors.RaiseException, match="cannot change"):
        as_end_user(admin, run_id, "update echiche.memories set status = 'active' where id = %s", (ids["team_old"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):  # provenance columns are not even updatable
        sql = "update echiche.memories set origin = 'model_proposal' where id = %s"
        as_end_user(admin, run_id, sql, (ids["goal"],))
    # Another user's memories are invisible to the owner of P1 and vice versa (RLS).
    other_run = create_run(admin, owner_user_id=users["U2"], project_id=projects["P3"])
    with admin.transaction():
        admin.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": users["U2"]}),))
        admin.execute("set local role echiche_end_user")
        visible = admin.execute("select count(*)::int as n from echiche.memories").fetchone()
    assert visible == {"n": 2} and other_run
