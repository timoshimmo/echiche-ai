"""Project memory for runs (M6, ADR-009). Deterministic, no embeddings.

Retrieval policy:
  1. Hard filters first, in SQL: this owner, this project, status 'active' only (proposals,
     rejected and superseded versions are never used), plus the project's active decision.
  2. Canonical records before anything else: the active decision (D1), then goals and
     constraints (always included, newest first: they frame every decision).
  3. Assumptions, open questions, facts and decision notes only when they share a
     *distinctive* term with the question (IDF-weighted overlap within the project, above a
     threshold); otherwise they are left out (abstention: nothing irrelevant is "recalled").
  4. Hard caps on count and characters.

Everything selected is shown to the model as *remembered* (dated, with its origin), inside a
fenced untrusted-data block. The model may refer to it only by its ref, and is asked to flag
items the new question contradicts. It is never treated as verified evidence.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime

from echiche_worker.passages import terms

ALWAYS = ("goal", "constraint")
WHEN_RELEVANT = ("assumption", "open_question", "fact", "decision")
MAX_ITEMS = 20
MAX_CHARS = 6000


@dataclass(frozen=True, slots=True)
class MemoryItem:
    id: str
    kind: str
    content: str
    observed_at: datetime
    origin: str  # model_proposal (approved by the user) | user
    edited: bool
    version: int


@dataclass(frozen=True, slots=True)
class DecisionItem:
    id: str
    version: int
    question: str
    choice: str
    rationale: str
    confidence: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ContextItem:
    """One remembered item given to a run (persisted in echiche.run_memory_context)."""

    ref: str
    kind: str
    content: str
    observed_at: datetime
    memory_id: str | None = None
    decision_id: str | None = None


def _decision_text(d: DecisionItem) -> str:
    confidence = f" Confidence: {d.confidence}." if d.confidence else ""
    text = f"Decided (version {d.version}): {d.choice} Question: {d.question} Rationale: {d.rationale}{confidence}"
    return text if len(text) <= 2000 else text[:1997] + "..."


MIN_RELEVANCE = 1.0


def _scores(question: str, candidates: list[MemoryItem]) -> list[float]:
    """IDF-weighted term overlap within the project's own candidates: a word that appears in
    many remembered items (e.g. the project's subject) counts for little, so an item is only
    recalled when it shares a distinctive term with the question."""
    wanted = set(terms(question))
    bags = [set(terms(m.content)) for m in candidates]
    n = len(bags)
    df: dict[str, int] = {}
    for bag in bags:
        for word in bag:
            df[word] = df.get(word, 0) + 1

    # A word found in exactly one remembered item is distinctive by definition, so it is worth at
    # least the threshold. Without this floor a project with one or two items could never recall
    # them: every word is in "all" of its items (found by the M7 benchmark, case M05).
    def weight(word: str) -> float:
        idf = math.log((n + 1) / (df[word] + 0.5))
        return max(idf, MIN_RELEVANCE) if df[word] == 1 else idf

    return [sum(weight(w) for w in wanted & bag) for bag in bags]


def select_context(
    memories: list[MemoryItem],
    decision: DecisionItem | None,
    question: str,
    max_items: int = MAX_ITEMS,
    max_chars: int = MAX_CHARS,
) -> list[ContextItem]:
    """Deterministic selection; `memories` must already be filtered to active rows of one project."""
    chosen: list[ContextItem] = []
    used = 0

    def add(item: ContextItem) -> bool:
        nonlocal used
        if len(chosen) >= max_items or used + len(item.content) > max_chars:
            return False
        chosen.append(item)
        used += len(item.content)
        return True

    if decision is not None:
        text = _decision_text(decision)
        add(ContextItem("D1", "decision_record", text, decision.created_at, decision_id=decision.id))
    by_recency = sorted(memories, key=lambda m: m.observed_at, reverse=True)
    always = [m for m in by_recency if m.kind in ALWAYS]
    candidates = [m for m in by_recency if m.kind in WHEN_RELEVANT]
    scored = list(zip(candidates, _scores(question, candidates), strict=True))
    ranked = sorted(scored, key=lambda p: (-p[1], -p[0].observed_at.timestamp()))
    relevant = [m for m, score in ranked if score >= MIN_RELEVANCE]
    for m in [*always, *relevant]:
        if not add(ContextItem(f"M{len([c for c in chosen if c.ref.startswith('M')]) + 1}", m.kind, m.content,
                               m.observed_at, memory_id=m.id)):  # fmt: skip
            break
    return chosen


def context_json(items: list[ContextItem]) -> str:
    """What the model sees: remembered, dated items with refs. Empty list when nothing applies."""
    return json.dumps(
        [
            {
                "ref": i.ref,
                "kind": i.kind,
                "remembered": i.content,
                "recorded_on": i.observed_at.date().isoformat(),
            }
            for i in items
        ],
        ensure_ascii=False,
        indent=1,
    )


# Conservative screen for proposals that touch sensitive personal categories. A match does
# not block the proposal; it is flagged so the user must confirm it explicitly (ADR-009).
_SENSITIVE = re.compile(
    r"\b(diagnos\w*|illness|disease|medical|medication|therapy|therapist|pregnan\w*|disabilit\w*|mental health|"
    r"religio\w*|church|mosque|political|politics|union member\w*|ethnic\w*|race|sexual\w*|gender identity|"
    r"salary|salaries|income|debt|loan|bankrupt\w*|credit score|immigration|visa status|criminal|arrest\w*|"
    r"divorce|password|passport|social security|national insurance number)\b",
    re.I,
)


def sensitivity(text: str) -> str:
    return "sensitive" if _SENSITIVE.search(text) else "normal"
