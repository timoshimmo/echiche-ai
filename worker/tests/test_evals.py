"""The fake benchmark is a CI regression gate (M7, ADR-010): deterministic, invariants only."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from echiche_worker import model_provider
from evals.harness import BENCHMARK, check_gates, run_benchmark
from evals.run import main

pytestmark = pytest.mark.filterwarnings("ignore")


@pytest.fixture(scope="module")
def results() -> dict[str, Any]:
    return run_benchmark()


def test_benchmark_is_synthetic_and_versioned() -> None:
    bench = json.loads(BENCHMARK.read_text())
    assert bench["schema_version"] == "decision-benchmark.v1" and len(bench["cases"]) >= 30
    assert len({c["id"] for c in bench["cases"]}) == len(bench["cases"])
    # Only fictional .test domains: no real sites, no private data.
    assert all(url.split("/")[2].endswith(".test") for url in bench["pages"])
    categories = {c["category"] for c in bench["cases"]}
    assert {"grounding", "no_evidence", "conflict", "stale", "memory_recall", "temporal_conflict",
            "prior_decision", "injection", "budget", "lookup", "unsupported_source"} <= categories  # fmt: skip


def test_invariant_gates_pass(results: dict[str, Any]) -> None:
    assert check_gates(results) == []


def test_results_are_deterministic(results: dict[str, Any]) -> None:
    again = run_benchmark(variants=("C",))
    assert again["summary"]["C"] == results["summary"]["C"]
    assert again["per_case"]["C"] == results["per_case"]["C"]


def test_baselines_differ_where_the_design_says_they_should(results: dict[str, Any]) -> None:
    a, b, c = (results["summary"][v] for v in "ABC")
    assert a["searches"] == 0 and a["grounded_answer_rate"] == 0.0  # one-pass: no evidence at all
    assert b["unsupported_citations"] > 0  # without verification, unsupported sources get cited
    assert c["unsupported_citations"] == 0 and c["conflict_surfaced_rate"] == 1.0
    assert a["model_calls"] < b["model_calls"] < c["model_calls"]  # and the cost of doing more
    assert results["summary"]["R"]["model_calls"] <= c["model_calls"]  # routing never adds work here


def test_gates_catch_a_disabled_guardrail(monkeypatch: pytest.MonkeyPatch) -> None:
    # Mutation check: without the brief's citation/confidence guard the gates must fail.
    def no_guard(_brief: object, _allowed: object) -> None:
        return None

    monkeypatch.setattr(model_provider, "check_brief", no_guard)
    failures = check_gates(run_benchmark(variants=("C",)))
    assert any(f.startswith("no-unsupported-citations-verified") for f in failures)
    assert any(f.startswith("no-unearned-high-confidence-verified") for f in failures)


def test_cli_reports_and_refuses_live_mode(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    assert main(["--live"]) == 2
    assert "nothing was run" in capsys.readouterr().err
    assert main(["--variants", "C"]) == 0
    out = capsys.readouterr().out
    assert "Not a quality claim" in out and "all invariant gates pass" in out
