"""Runs the decision benchmark through the real executor and pipeline (M7, ADR-010).

Everything that decides the outcome is production code: the executor (budgets, skipping,
checkpoints, composition), the model provider (prompt rendering, contracts, repair, citation
and confidence guards), research (passage selection, quote checks, verification report) and
memory selection. Only the edges are replaced: a scripted model, a scripted search, pages served
from memory, and an in-memory store with the same semantics as the Postgres one.

Variants:
  A  one-pass        framing + synthesis; no research, critique, verification or memory.
  B  research+synth  research, then synthesis over the *unverified* passages (no critique,
                     verification or memory). The citation-ID guard still applies.
  C  full            framing with memory, research, critique, verification, synthesis.
  R  routed          what the M7 router would run: the case's tier (benchmark field route_tier,
                     kept equal to the web router's output by a web test). No escalation model
                     exists in fake mode, so a justified escalation is recorded as not possible.
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from threading import Event
from typing import Any, cast

from pydantic import BaseModel

from echiche_worker.contracts import (
    DECISION_BRIEF_SCHEMA_VERSION,
    EVIDENCE_SET_SCHEMA_VERSION,
    VERIFICATION_REPORT_SCHEMA_VERSION,
    DecisionBriefV1,
    EvidenceSetV1,
    Stage,
    StageOutput,
    StageOutputV2,
    VerificationReportV1,
)
from echiche_worker.executor import ExecutorSettings, Outcome, execute
from echiche_worker.llm import OPENAI_PRICES, ModelClient
from echiche_worker.memory import ContextItem, DecisionItem, MemoryItem
from echiche_worker.model_provider import ModelReasoningProvider, ModelSettings, check_brief
from echiche_worker.prompts import PromptRegistry
from echiche_worker.provider import ModelCallRecord, ResearchCallRecord, StageContext, StageResult
from echiche_worker.research_pipeline import ResearchSettings, evidence_for_model
from echiche_worker.retry import RetryPolicy
from echiche_worker.routing import RoutingPolicy, load_policy
from echiche_worker.store import Budget, ClaimedRun, Usage, spend, to_v2

from .simulated import INJECTION_MARKER, MemoryFetcher, SimulatedModel, SimulatedSearch

ROOT = Path(__file__).resolve().parents[2]
BENCHMARK = ROOT / "evals" / "decision-benchmark.v1.json"
GATES = ROOT / "evals" / "gates.v1.json"
VARIANTS = ("A", "B", "C", "R")
# Scripted calls are priced as if they were the default model, to compare variants on one
# scale. They are NOT real costs: the token counts are made up.
PRICED_AS = "gpt-6.1-sol"
DEFAULT_BUDGET = Budget(max_steps=12, max_active_seconds=900, max_research_calls=6, max_cost_usd=Decimal("1.00"))
NOW = datetime(2026, 10, 1, tzinfo=UTC)


def variant_policy(variant: str, policy: RoutingPolicy, tier: str | None) -> tuple[RoutingPolicy | None, str | None]:
    """(policy, tier) for the executor. Baselines are expressed as edited copies of the policy,
    so the executor and provider take exactly their production code paths."""

    def edited(name: str, **pipeline: bool) -> RoutingPolicy:
        t = policy.tiers[name]  # type: ignore[index]
        tiers = {**policy.tiers, name: t.model_copy(update={"pipeline": t.pipeline.model_copy(update=pipeline)})}
        return policy.model_copy(update={"tiers": tiers})

    if variant == "A":
        return edited("low", research=False, critique=False, verify=False, memory=False, allow_escalation=False), "low"
    if variant == "B":
        return edited("medium", research=True, critique=False, verify=False, memory=False, allow_escalation=False), (
            "medium"
        )
    if variant == "C":
        return None, None  # no tier: the full pipeline, operator research limits, no escalation
    return policy, tier


class BaselineProvider(ModelReasoningProvider):
    """Variant B only: synthesis sees the fetched passages as if they were evidence, with no
    verification. Production never does this; it exists to measure what verification adds."""

    def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
        if stage != "synthesizing" or ctx.route.verify:
            return super().run_stage(stage, ctx)
        evidence = self._evidence(ctx)
        allowed = {s.source_id: s.domain for s in evidence.sources} if evidence else {}
        brief = self._generate(
            "decision-brief-synthesis",
            stage,
            ctx,
            DecisionBriefV1,
            {
                "decision_frame_json": json.dumps(self._frame(ctx).model_dump(mode="json")),
                "critique_json": json.dumps({"not_run": "No critique in this baseline."}),
                "evidence_json": evidence_for_model(evidence),
                "project_memory_json": "[]",
            },
            time.monotonic() + ctx.timeout_seconds,
            check=lambda b: check_brief(b, allowed),
        )
        return self._result(stage, "Decision brief", "Baseline B", brief, DECISION_BRIEF_SCHEMA_VERSION, [])


@dataclass
class MemoryStore:
    """In-memory RunStore with the Postgres store's semantics for everything the executor uses."""

    run: ClaimedRun
    memories: list[MemoryItem]
    decision: DecisionItem | None
    lease_seconds: int = 60
    outputs: dict[Stage, StageOutputV2] = field(default_factory=dict[Stage, StageOutputV2])
    usage: Usage = field(default_factory=lambda: Usage(0, Decimal(0), 0, Decimal(0)))
    calls: list[ModelCallRecord] = field(default_factory=list[ModelCallRecord])
    research_calls: list[ResearchCallRecord] = field(default_factory=list[ResearchCallRecord])
    run_memory: list[ContextItem] = field(default_factory=list[ContextItem])
    status: str = "queued"
    error_code: str | None = None
    result: BaseModel | None = None

    def load_checkpoints(self, _run_id: str) -> dict[Stage, StageOutputV2]:
        return dict(self.outputs)

    def load_project_memory(self, _run: ClaimedRun) -> tuple[list[MemoryItem], DecisionItem | None]:
        return list(self.memories), self.decision

    def load_run_memory(self, _run_id: str) -> list[ContextItem]:
        return list(self.run_memory)

    def cancel_requested(self, _run_id: str) -> bool:
        return False

    def begin_stage(self, _run: ClaimedRun, _stage: Stage, _title: str) -> None:
        self.status = "active"

    def _spend(self, calls: Sequence[ModelCallRecord], research: Sequence[ResearchCallRecord]) -> Decimal:
        return sum((c.cost_usd for c in calls), Decimal(0)) + sum((c.cost_usd for c in research), Decimal(0))

    def record_calls(
        self, _run: ClaimedRun, calls: Sequence[ModelCallRecord], research_calls: Sequence[ResearchCallRecord] = ()
    ) -> None:
        self.calls.extend(calls)
        self.research_calls.extend(research_calls)
        self.usage = dataclasses.replace(
            self.usage, cost_usd=self.usage.cost_usd + spend(self._spend(calls, research_calls))
        )

    def commit_stage(  # mirrors RunStore.commit_stage
        self,
        _run: ClaimedRun,
        output: StageOutput,
        duration_ms: int,
        research_calls: int,
        cost_usd: Decimal,
        calls: Sequence[ModelCallRecord] = (),
        research_records: Sequence[ResearchCallRecord] = (),
        memory_context: Sequence[ContextItem] = (),
        escalation: str | None = None,
    ) -> Usage:
        v2 = to_v2(output)
        self.outputs[v2.stage] = v2
        self.calls.extend(calls)
        self.research_calls.extend(research_records)
        if memory_context:
            self.run_memory = list(memory_context)
        self.usage = Usage(
            steps=self.usage.steps + 1,
            active_seconds=self.usage.active_seconds + Decimal(duration_ms) / 1000,
            research_calls=self.usage.research_calls + research_calls,
            cost_usd=self.usage.cost_usd + spend(cost_usd),
        )
        return self.usage

    def finish(self, _run: ClaimedRun, _schema: str, result: BaseModel) -> None:
        self.status, self.result = "awaiting_user_review", result

    def fail(self, _run: ClaimedRun, code: str) -> None:
        self.status, self.error_code = "failed", code

    def cancel(self, _run: ClaimedRun) -> None:
        self.status = "cancelled"

    def pause_for_budget(self, _run: ClaimedRun, code: str) -> None:
        self.status, self.error_code = "paused_for_budget", code

    def release_for_retry(self, _run: ClaimedRun, _delay: float, code: str, consume_attempt: bool = True) -> None:
        del consume_attempt
        self.status, self.error_code = "queued", code


def _memories(case: dict[str, Any]) -> tuple[list[MemoryItem], DecisionItem | None]:
    """What the SQL filter returns: active rows of this project only (statuses and other
    projects are filtered in Postgres; that filter is tested against a real database)."""
    items: list[MemoryItem] = []
    for i, m in enumerate(case["memories"]):
        if m["status"] != "active" or m.get("other_project"):
            continue
        items.append(MemoryItem(f"m{i}", m["kind"], m["content"], NOW.replace(day=1 + i), "user", False, 1))
    d = case.get("decision")
    decision = (
        DecisionItem("d1", 1, d["question"], d["choice"], d["rationale"], d.get("confidence"), NOW)
        if d is not None
        else None
    )
    return items, decision


def _budget(case: dict[str, Any]) -> Budget:
    b: dict[str, Any] = case.get("budget") or {}
    return Budget(
        max_steps=int(b.get("max_steps", DEFAULT_BUDGET.max_steps)),
        max_active_seconds=DEFAULT_BUDGET.max_active_seconds,
        max_research_calls=int(b.get("max_research_calls", DEFAULT_BUDGET.max_research_calls)),
        max_cost_usd=Decimal(b.get("max_cost_usd", str(DEFAULT_BUDGET.max_cost_usd))),
    )


@dataclass(frozen=True, slots=True)
class CaseRun:
    case: dict[str, Any]
    variant: str
    store: MemoryStore
    model: SimulatedModel
    outcome: Outcome


def run_case(
    case: dict[str, Any], variant: str, pages: dict[str, Any], policy: RoutingPolicy, registry: PromptRegistry
) -> CaseRun:
    model_spec = {**case["model"], "queries": case.get("queries"), "truth": case.get("truth", {})}
    model = SimulatedModel(behaviour=case["model"]["behaviour"], case_model=model_spec, model=PRICED_AS)
    research = ResearchSettings(
        search=cast(Any, SimulatedSearch(case.get("search") or [])),
        fetcher=cast(Any, MemoryFetcher(pages)),
        max_queries=3,
        results_per_query=5,
        max_pages=6,
        stale_days=730,
    )
    provider = BaselineProvider(
        cast(ModelClient, model),
        registry,
        OPENAI_PRICES,
        ModelSettings(residency="global", max_output_tokens=4000),
        research=research,
    )
    variant_routing, tier = variant_policy(variant, policy, case.get("route_tier"))
    memories, decision = _memories(case)
    run = ClaimedRun(
        id=f"{case['id']}-{variant}",
        owner_user_id="eval",
        prompt=case["prompt"],
        status="queued",
        attempt=1,
        max_attempts=3,
        budget=_budget(case),
        usage=Usage(0, Decimal(0), 0, Decimal(0)),
        project_context="Project title: Benchmark\n\nProblem statement:\nA synthetic decision for evaluation.",
        project_id="eval-project",
        route_tier=tier,
    )
    store = MemoryStore(run, memories, decision)
    settings = ExecutorSettings(
        stage_timeout_seconds=30,
        retry=RetryPolicy(max_tries=1, base_seconds=0.001, cap_seconds=0.002),
        routing=variant_routing,
    )
    outcome = execute(run, cast(Any, store), provider, settings, Event())
    return CaseRun(case, variant, store, model, outcome)


# --- scoring -----------------------------------------------------------------------------


def _data[M: BaseModel](store: MemoryStore, stage: Stage, schema: str, model: type[M]) -> M | None:
    out = store.outputs.get(stage)
    if out is None or out.data_schema != schema or out.data is None:
        return None
    return model.model_validate(out.data)


def score(r: CaseRun) -> dict[str, Any]:
    case, store = r.case, r.store
    expect: dict[str, Any] = case["expect"]
    truth: dict[str, str] = case.get("truth", {})
    evidence = _data(store, "researching", EVIDENCE_SET_SCHEMA_VERSION, EvidenceSetV1)
    report = _data(store, "verifying", VERIFICATION_REPORT_SCHEMA_VERSION, VerificationReportV1)
    domains = {s.source_id: s.domain for s in (evidence.sources if evidence else [])}
    brief = store.result if isinstance(store.result, DecisionBriefV1) else None
    m: dict[str, Any] = {"outcome": store.status, "error_code": store.error_code}

    if brief is not None:
        cited = {c.source_id for c in brief.citations} | {
            sid for p in [*brief.supporting_evidence, *brief.counterevidence] for sid in p.source_ids
        }
        supported = {sid for sid in cited if truth.get(domains.get(sid, "")) == "supports"}
        text = json.dumps(brief.model_dump(mode="json"), ensure_ascii=False)
        limits = " ".join(brief.limitations).lower()
        m |= {
            "schema_valid": True,
            "citations": len(cited),
            "invented_citations": len([s for s in cited if s not in domains]),
            "unsupported_citations": len([s for s in cited if s in domains and s not in supported]),
            "high_confidence_violation": brief.confidence.level == "high" and len({domains[s] for s in supported}) < 2,
            "injection_echoed": INJECTION_MARKER in text,
            "discloses_missing_evidence": bool(
                re.search(r"no verified|no sources|not researched|no external|no claim could be verified", limits)
            ),
            "conflict_surfaced": "disagree" in limits,
            "stale_flagged": "older than" in limits,
            "memory_conflict_surfaced": "may be outdated" in limits,
            "confidence": brief.confidence.level,
        }
    given = [i.content for i in store.run_memory] + [i.ref for i in store.run_memory if i.ref.startswith("D")]
    want: list[str] = expect.get("recall", [])
    forbid: list[str] = expect.get("forbid", [])
    if "recall" in expect:
        m["memory_recall"] = (sum(1 for w in want if w in given) / len(want)) if want else None
        m["memory_abstained"] = (not any(i.ref.startswith("M") for i in store.run_memory)) if not want else None
        m["memory_leaks"] = sum(1 for f in forbid if f in given)
    planning = store.outputs.get("planning")
    refs = {i.ref for i in store.run_memory}
    conflicts: list[dict[str, str]] = planning.data.get("memory_conflicts", []) if planning and planning.data else []
    m["invented_memory_refs"] = sum(1 for c in conflicts if c["ref"] not in refs)
    m["contradictions_found"] = len(report.contradictions) if report else 0
    m["model_calls"] = len(store.calls)
    m["repairs"] = sum(1 for c in store.calls if c.repair)
    m["searches"] = sum(1 for c in store.research_calls if c.kind == "search")
    m["scripted_cost_usd"] = str(store.usage.cost_usd)
    m["steps"] = store.usage.steps
    return m


def _rate(values: list[bool]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def aggregate(rows: list[dict[str, Any]], cases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    done = [r for r in rows if r["outcome"] == "awaiting_user_review"]
    budget_cases = [r for r in rows if cases[r["case"]]["expect"].get("outcome")]
    no_ev = [r for r in done if cases[r["case"]]["expect"].get("no_evidence")]
    grounded = [r for r in done if cases[r["case"]]["expect"].get("citations_min")]
    conflict = [r for r in done if cases[r["case"]]["expect"].get("conflict")]
    stale = [r for r in done if cases[r["case"]]["expect"].get("stale")]
    temporal = [r for r in done if cases[r["case"]]["expect"].get("memory_conflict")]
    injection = [r for r in done if cases[r["case"]]["expect"].get("injection")]
    recall = [r["memory_recall"] for r in rows if r.get("memory_recall") is not None]
    abstain = [r["memory_abstained"] for r in rows if r.get("memory_abstained") is not None]
    expected_done = [r for r in rows if not cases[r["case"]]["expect"].get("outcome")]
    return {
        "cases": len(rows),
        "completion_rate": _rate([r["outcome"] == "awaiting_user_review" for r in expected_done]),
        "schema_valid_rate": _rate([bool(r.get("schema_valid")) for r in done]),
        "invented_citations": sum(r.get("invented_citations", 0) for r in done),
        "unsupported_citations": sum(r.get("unsupported_citations", 0) for r in done),
        "high_confidence_violations": sum(1 for r in done if r.get("high_confidence_violation")),
        "grounded_answer_rate": _rate(
            [r.get("citations", 0) - r.get("unsupported_citations", 0) >= 1 for r in grounded]
        ),
        "abstention_rate": _rate(
            [
                r.get("citations", 0) == 0 and r.get("confidence") != "high" and r["discloses_missing_evidence"]
                for r in no_ev
            ]
        ),
        "conflict_surfaced_rate": _rate([r["conflict_surfaced"] for r in conflict]),
        "stale_flagged_rate": _rate([r["stale_flagged"] for r in stale]),
        "memory_recall": round(sum(recall) / len(recall), 3) if recall else None,
        "memory_abstention_rate": _rate(abstain),
        "memory_leaks": sum(r.get("memory_leaks", 0) for r in rows),
        "memory_conflict_surfaced_rate": _rate([r["memory_conflict_surfaced"] for r in temporal]),
        "invented_memory_refs": sum(r["invented_memory_refs"] for r in rows),
        "injection_echoed_rate": _rate([r["injection_echoed"] for r in injection]),
        "budget_honesty_rate": _rate(
            [
                r["outcome"] == cases[r["case"]]["expect"]["outcome"]
                and r["error_code"] == cases[r["case"]]["expect"]["error_code"]
                and "schema_valid" not in r
                for r in budget_cases
            ]
        ),
        "model_calls": sum(r["model_calls"] for r in rows),
        "repairs": sum(r["repairs"] for r in rows),
        "searches": sum(r["searches"] for r in rows),
        "scripted_cost_usd": str(sum((Decimal(r["scripted_cost_usd"]) for r in rows), Decimal(0))),
    }


def run_benchmark(path: Path = BENCHMARK, variants: tuple[str, ...] = VARIANTS) -> dict[str, Any]:
    bench = json.loads(path.read_text(encoding="utf-8"))
    policy = load_policy()
    registry = PromptRegistry.load()
    cases = {c["id"]: c for c in bench["cases"]}
    per_case: dict[str, list[dict[str, Any]]] = {v: [] for v in variants}
    with contextlib.redirect_stdout(io.StringIO()):  # the executor's per-stage logs are noise here
        for variant in variants:
            for case in bench["cases"]:
                result = run_case(case, variant, bench["pages"], policy, registry)
                per_case[variant].append({"case": case["id"], "category": case["category"], **score(result)})
    return {
        "schema_version": "eval-results.v1",
        "mode": "fake",
        "benchmark": bench["schema_version"],
        "cases": len(bench["cases"]),
        "routing_policy": policy.version,
        "prompts": {p: registry.get(p, allow_draft=True).meta.version for p in registry.ids()},
        "model": "simulated (scripted behaviours; not a model-quality measurement)",
        "cost_basis": f"scripted token usage priced as {PRICED_AS}; not real spend",
        "latency": "not measured in fake mode",
        "summary": {v: aggregate(per_case[v], cases) for v in variants},
        "per_case": per_case,
    }


def check_gates(results: dict[str, Any], gates_path: Path = GATES) -> list[str]:
    """Returns failures. Gates are invariants only; quality and cost targets are deferred
    until live baselines have been measured and reviewed by a person (ADR-010)."""
    gates = json.loads(gates_path.read_text(encoding="utf-8"))
    failures: list[str] = []
    for gate in gates["gates"]:
        for variant in gate["variants"]:
            if variant not in results["summary"]:
                continue  # variant not run
            value = results["summary"][variant].get(gate["metric"])
            if value is None:
                continue
            ok = value <= gate["max"] if "max" in gate else value >= gate["min"]
            if not ok:
                bound = f"<= {gate['max']}" if "max" in gate else f">= {gate['min']}"
                failures.append(f"{gate['id']}: {variant}.{gate['metric']} = {value}, required {bound}")
    return failures
