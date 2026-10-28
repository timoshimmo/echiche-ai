"""Run the evaluation: `uv run python -m evals.run` (from worker/).

(default)          fake mode: deterministic, no network, no cost. Prints a summary, checks the
                   invariant gates (exit 1 on failure). --write saves the versioned results JSON
                   and the Markdown report under evals/results/.
--live             NOT IMPLEMENTED BY DESIGN in this milestone: a live baseline needs an API key,
                   a spend cap and a reviewer. See docs/runbooks/evaluation.md for the procedure.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any

from .harness import ROOT, VARIANTS, check_gates, run_benchmark

RESULTS = ROOT / "evals" / "results"
ROWS = [
    ("completion_rate", "Completed (excl. budget cases)"),
    ("schema_valid_rate", "Valid decision brief"),
    ("invented_citations", "Invented citations"),
    ("unsupported_citations", "Citations to sources that do not support the claim"),
    ("high_confidence_violations", "'High' confidence without two supporting domains"),
    ("grounded_answer_rate", "Grounding cases with ≥1 supporting citation"),
    ("abstention_rate", "No-evidence cases: no citations, not 'high', gap disclosed"),
    ("conflict_surfaced_rate", "Conflicting sources surfaced"),
    ("stale_flagged_rate", "Stale evidence flagged"),
    ("memory_recall", "Expected memory recalled"),
    ("memory_abstention_rate", "Irrelevant memory left out"),
    ("memory_leaks", "Forbidden memory items given to the run"),
    ("memory_conflict_surfaced_rate", "Memory conflicts surfaced"),
    ("invented_memory_refs", "Invented memory refs"),
    ("injection_echoed_rate", "Injected text echoed in the brief"),
    ("budget_honesty_rate", "Budget cases stopped honestly"),
    ("model_calls", "Model calls (total)"),
    ("repairs", "Repair attempts"),
    ("searches", "Searches"),
    ("scripted_cost_usd", "Scripted cost, USD (not real spend)"),
]


def git_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
            cwd=ROOT, capture_output=True, text=True, check=True,
        )  # fmt: skip
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],  # noqa: S607
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.strip()  # fmt: skip
        return out.stdout.strip() + ("+uncommitted" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def markdown(results: dict[str, Any], failures: list[str]) -> str:
    variants = list(results["summary"])
    lines = [
        f"# Evaluation report: {results['benchmark']} ({results['mode']} mode)",
        "",
        "> **Not a quality claim.** Fake mode runs the real pipeline with a *scripted* model, search and pages.",
        "> It shows what Echiche's deterministic guardrails do under cooperative, naive and adversarial model",
        "> behaviours. It says nothing about how good a real model's analysis is. Costs are scripted token",
        "> counts priced at list price, not real spend; latency is not measured. Do not quote these numbers",
        "> as product performance.",
        "",
        f"- Commit: `{results['git_commit']}` · routing policy `{results['routing_policy']}` · "
        f"{results['cases']} cases",
        "- Prompts: " + ", ".join(f"`{k}@{v}`" for k, v in sorted(results["prompts"].items())),
        "- Variants: **A** one-pass · **B** research + synthesis (unverified) · **C** full pipeline · "
        "**R** routed by the M7 policy",
        "",
        "| Metric | " + " | ".join(variants) + " |",
        "|---|" + "---|" * len(variants),
    ]
    for key, label in ROWS:
        cells: list[str] = []
        for v in variants:
            value = results["summary"][v].get(key)
            cells.append("n/a" if value is None else str(value))
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    lines += ["", "## Gates (invariants only)", ""]
    lines += [f"- ❌ {f}" for f in failures] or ["- ✅ all invariant gates pass"]
    lines += [
        "",
        "Quality and cost thresholds are deliberately not set: they need live baselines reviewed by a person",
        "(docs/runbooks/evaluation.md).",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Echiche evaluation harness")
    parser.add_argument("--variants", default=",".join(VARIANTS))
    parser.add_argument("--write", action="store_true", help="write evals/results/*.json and .md")
    parser.add_argument("--live", action="store_true", help="live baseline (see the runbook; not run here)")
    args = parser.parse_args(argv)
    if args.live:
        print(
            "Live evaluation is a manual, approved procedure (real model and search calls are billed). "
            "Follow docs/runbooks/evaluation.md; nothing was run.",
            file=sys.stderr,
        )
        return 2
    variants = tuple(v for v in args.variants.split(",") if v)
    results = run_benchmark(variants=variants)
    results["git_commit"] = git_commit()
    failures = check_gates(results)
    results["gates"] = {"version": "gates.v1", "failures": failures}
    report = markdown(results, failures)
    print(report)
    if args.write:
        RESULTS.mkdir(parents=True, exist_ok=True)
        name = f"{results['benchmark']}.{results['mode']}"
        (RESULTS / f"{name}.json").write_text(
            json.dumps(results, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        (RESULTS / f"{name}.md").write_text(report, encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
