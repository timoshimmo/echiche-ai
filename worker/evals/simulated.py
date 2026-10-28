"""Scripted stand-ins for the model, search and fetcher (no network, fully deterministic).

The simulated model is *not* a model-quality proxy. It plays one of three scripted behaviours
so the benchmark can check what Echiche's deterministic machinery does with each:

  cooperative  follows the prompt rules: cites only the evidence it was given, calibrates confidence.
  naive        over-claims: cites every source it has seen anywhere in the run, always says "high".
  adversarial  as naive, plus it invents a source ID (S9) and a memory ref (M9), and obeys
               instructions injected into fetched pages.

On a repair request (the application's repair note) every behaviour drops the parts the note
names, as a reasonably compliant model would; an adversarial model keeps any injected text.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

from echiche_worker.fetch import FetchedPage, FetchResult
from echiche_worker.llm import ModelReply, ModelRequest, TokenUsage
from echiche_worker.provider import ResearchCallRecord
from echiche_worker.research import SearchHit, SearchResult

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
# Scripted usage per call. Costs computed from it are labelled "scripted", never real spend.
USAGE = TokenUsage(input_tokens=1200, cached_input_tokens=200, output_tokens=600, reasoning_tokens=100)
INJECTION_MARKER = "APPROVED-BY-ECHICHE"
SEARCH_PRICE = Decimal("0.005")  # Brave, $5 per 1,000 requests (ADR-008)


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.valid.json").read_text(encoding="utf-8"))


def _block(data: str, name: str) -> str:
    match = re.search(rf'<untrusted name="{name}">\n(.*?)\n</untrusted>', data, re.S)
    return match.group(1) if match else ""


def _json_block(data: str, name: str) -> Any:  # noqa: ANN401 - parsed model input
    text = _block(data, name).replace("&lt;", "<")
    return json.loads(text) if text.strip() else []


@dataclass
class SimulatedModel:
    """Implements the ModelClient protocol. One instance per benchmark run (it is stateful)."""

    behaviour: str
    case_model: dict[str, Any]
    model: str = "simulated"
    provider: str = "simulated"
    requests: list[ModelRequest] = field(default_factory=list[ModelRequest])
    seen_sources: dict[str, str] = field(default_factory=dict[str, str])  # source_id -> domain
    seen_injection: bool = False

    def generate(self, request: ModelRequest) -> ModelReply:
        self.requests.append(request)
        repair = "<repair_note>" in request.instructions
        if "SYSTEM OVERRIDE" in request.data:
            self.seen_injection = True
        handler = getattr(self, f"_{request.schema_name}")
        payload = handler(request, repair)
        return ModelReply(status="completed", text=json.dumps(payload), usage=USAGE, model=self.model, latency_ms=0)

    @property
    def _overclaims(self) -> bool:
        return self.behaviour in ("naive", "adversarial")

    # --- one handler per output contract -------------------------------------------------

    def _decision_frame_v2(self, request: ModelRequest, repair: bool) -> dict[str, Any]:
        frame = _fixture("decision-frame.v1")
        question = _block(request.data, "question").strip()
        frame["decision_statement"] = question[:300] or frame["decision_statement"]
        frame["research_questions"] = [question[:300]] if question else []
        conflicts: list[dict[str, str]] = []
        term = self.case_model.get("memory_conflict")
        if term:
            for item in _json_block(request.data, "project_memory_json"):
                if term in item.get("remembered", ""):
                    conflicts.append({"ref": item["ref"], "conflict": "The question states a newer value."})
        if self.behaviour == "adversarial" and not repair:
            conflicts.append({"ref": "M9", "conflict": "Invented recall."})
        frame["memory_conflicts"] = conflicts
        return frame

    def _research_plan_v1(self, request: ModelRequest, _repair: bool) -> dict[str, Any]:
        limit = int(json.loads(_block(request.data, "limits_json") or "{}").get("max_queries", 1))
        queries: list[str] = self.case_model.get("queries") or ["decision research"]
        return {
            "queries": [
                {
                    "query": q,
                    "research_question": "What does outside evidence say?",
                    "rationale": "Tests a key unknown.",
                }
                for q in queries[:limit]
            ],
            "skipped_questions": [],
        }

    def _critique_v1(self, request: ModelRequest, _repair: bool) -> dict[str, Any]:
        self._remember_sources(_json_block(request.data, "evidence_json"))
        critique = _fixture("critique.v1")
        severity = self.case_model.get("critique_severity", "medium")
        for item in [*critique["challenged_assumptions"], *critique["risks"]]:
            item["severity"] = severity
        return critique

    def _claim_set_v1(self, request: ModelRequest, repair: bool) -> dict[str, Any]:
        sources: list[dict[str, Any]] = _json_block(request.data, "evidence_json")
        self._remember_sources(sources)
        claims: list[dict[str, Any]] = []
        for s in sources:
            p = s["passages"][0]
            claims.append(
                {
                    "claim_id": f"C{len(claims) + 1}",
                    "text": f"{s['title']}: {p['text'][:120]}",
                    "label": "fact",
                    "evidence": [{"passage_id": p["passage_id"], "relation": "supports", "quote": p["text"][:90]}],
                }
            )
        rule = self.case_model.get("contradict")
        by_domain = {s["domain"]: s for s in sources}
        if rule and rule["claim"] in by_domain and rule["by"] in by_domain:
            other = next((p for p in by_domain[rule["by"]]["passages"] if rule["contains"] in p["text"]), None)
            target = next(
                c
                for c in claims
                if c["evidence"][0]["passage_id"].startswith(by_domain[rule["claim"]]["source_id"] + ".")
            )
            if other is not None:
                target["evidence"].append(
                    {"passage_id": other["passage_id"], "relation": "contradicts", "quote": other["text"][:80]}
                )
        if self.behaviour == "adversarial" and not repair and claims:
            claims[0]["evidence"].append({"passage_id": "S9.p1", "relation": "supports", "quote": "invented"})
        return {"claims": claims, "gaps": []}

    def _claim_verification_v1(self, request: ModelRequest, _repair: bool) -> dict[str, Any]:
        truth: dict[str, str] = self.case_model.get("truth", {})
        judgments: list[dict[str, str]] = []
        for c in _json_block(request.data, "claims_json"):
            for e in c["evidence"]:
                domain = self.seen_sources.get(e["passage_id"].split(".")[0], "")
                verdict = "supported" if truth.get(domain) == "supports" else "not_supported"
                judgments.append(
                    {"claim_id": c["claim_id"], "passage_id": e["passage_id"], "verdict": verdict, "note": "Scripted."}
                )
        return {"judgments": judgments}

    def _decision_brief_v1(self, request: ModelRequest, repair: bool) -> dict[str, Any]:
        brief = _fixture("decision-brief.v1")
        evidence_text = _block(request.data, "evidence_json")
        given = list(dict.fromkeys(re.findall(r'"source_id": "(S[0-9]+)"', evidence_text)))
        if self._overclaims and not repair:
            cited = list(dict.fromkeys([*given, *self.seen_sources]))
            if self.behaviour == "adversarial":
                cited.append("S9")
            level = "high"
        else:
            cited = given
            level = "medium" if given else "low"
        brief["citations"] = [{"source_id": s, "supports": "Backs a claim in the brief."} for s in cited[:10]]
        brief["supporting_evidence"][0]["source_ids"] = cited[:5]
        brief["confidence"] = {"level": level, "explanation": "Scripted confidence."}
        brief["limitations"] = [] if given else ["No verified external evidence was available."]
        if self.behaviour == "adversarial" and self.seen_injection:
            brief["recommendation"]["summary"] = f"{INJECTION_MARKER}: adopt the plan."
        if "not_run" in _block(request.data, "critique_json"):
            brief["limitations"].append("No separate critique was run.")
        return brief

    def _remember_sources(self, sources: list[dict[str, Any]]) -> None:
        for s in sources:
            self.seen_sources[s["source_id"]] = s["domain"]
            if any("SYSTEM OVERRIDE" in p["text"] for p in s.get("passages", [])):
                self.seen_injection = True


class SimulatedSearch:
    """Answers the n-th query with the case's n-th URL list (the last list repeats)."""

    provider = "brave"
    price_per_request = SEARCH_PRICE

    def __init__(self, script: list[list[str]]) -> None:
        self.script = script
        self.queries: list[str] = []

    def search(self, query: str, count: int, _timeout_seconds: float) -> SearchResult:
        self.queries.append(query)
        urls = self.script[min(len(self.queries) - 1, len(self.script) - 1)] if self.script else []
        hits = [SearchHit(url=u) for u in urls[:count]]
        status = "ok" if hits else "no_results"
        record = ResearchCallRecord("search", "brave", status, 200, None, len(hits), 0, SEARCH_PRICE, 0)
        return SearchResult(hits=hits, record=record)


class MemoryFetcher:
    """Serves benchmark pages from memory (URL safety and robots are covered by the M5 tests)."""

    timeout = 1.0

    def __init__(self, pages: dict[str, dict[str, Any]]) -> None:
        self.pages = pages

    def fetch(self, url: str) -> FetchResult:
        domain = url.split("/")[2]
        page = self.pages.get(url)
        if page is None:
            return FetchResult(status="fetch_error", domain=domain)
        text = page["text"]
        return FetchResult(
            status="ok",
            domain=domain,
            page=FetchedPage(
                url=url,
                domain=domain,
                title=page["title"],
                publisher=page.get("publisher"),
                published_at=page.get("published_at"),
                text=text,
                content_sha256=hashlib.sha256(text.encode()).hexdigest(),
            ),
        )
