"""Research and verification building blocks (M5, ADR-008). No model calls happen here;
the model-backed steps are passed in by `model_provider.py`.

Evidence path:
  frame.research_questions --(model: research-planner)--> queries (bounded by budget + config)
  queries --(Brave)--> candidate URLs (discovery only, never stored)
  URLs --(PageFetcher)--> pages the application read itself --(passages)--> S1..Sn with S<n>.p<m>
  passages --(model: claim-extractor)--> claims C1..Cn, each with exact quotes
  quotes --(deterministic)--> found in the passage text, or "quote_not_found"
  found quotes --(model: decision-verifier, independent)--> supported / partial / not supported
  --> verification-report.v1: status, freshness, contradictions, unverifiable items
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from echiche_worker.contracts import (
    ClaimSetV1,
    ClaimVerificationV1,
    DecisionFrameV1,
    EvidenceSetV1,
    PassageV1,
    SearchSummaryV1,
    SkippedSourceV1,
    SourceRecordV1,
    VerificationReportV1,
    VerifiedClaimV1,
    VerifiedEvidenceV1,
)
from echiche_worker.fetch import FetchResult, PageFetcher, normalise_url
from echiche_worker.passages import quote_in, select_passages
from echiche_worker.provider import BudgetPreflightError, StageContext
from echiche_worker.research import ResearchAuthError, SearchCallError, SearchClient, clean_query

FETCH_CONCURRENCY = 4
MAX_PER_DOMAIN = 2
NO_SOURCES = "Research was insufficient: no readable, relevant source was found, so no external evidence is cited."


@dataclass(frozen=True, slots=True)
class ResearchSettings:
    search: SearchClient
    fetcher: PageFetcher
    max_queries: int = 3
    results_per_query: int = 5
    max_pages: int = 6
    stale_days: int = 730


# --- researching ------------------------------------------------------------------------


def gather_evidence(
    settings: ResearchSettings,
    ctx: StageContext,
    frame: DecisionFrameV1,
    plan_queries: Callable[[int], list[str]],
    deadline: float,
) -> tuple[EvidenceSetV1, int]:
    """Returns the evidence set and the number of searches made (counted against the budget)."""
    limitations: list[str] = []
    allowed = min(settings.max_queries, ctx.remaining_research_calls)
    provider = settings.search.provider
    if allowed <= 0:
        return _empty(provider, ["The research budget for this run allows no searches.", NO_SOURCES]), 0
    if not frame.research_questions:
        return _empty(provider, ["Framing identified no research questions.", NO_SOURCES]), 0

    queries = list(dict.fromkeys(q for q in (clean_query(q) for q in plan_queries(allowed)) if q))[:allowed]
    if not queries:
        return _empty(provider, ["The research plan produced no usable queries.", NO_SOURCES]), 0

    searches: list[SearchSummaryV1] = []
    per_query_urls: list[tuple[str, list[str]]] = []
    made = 0
    provider_failed = False
    for query in queries:
        if ctx.remaining_cost_usd - ctx.spent_usd() < settings.search.price_per_request:
            raise BudgetPreflightError("search cost exceeds the remaining spend cap")
        timeout = max(1.0, min(10.0, deadline - time.monotonic() - 5))
        made += 1
        try:
            result = settings.search.search(query, settings.results_per_query, timeout)
        except SearchCallError as failure:
            ctx.research_calls.append(failure.record)
            if isinstance(failure.error, ResearchAuthError) or not ctx.final_attempt:
                raise failure.error from failure
            # Last attempt: degrade to "no evidence from this query" with an explicit limitation.
            provider_failed = True
            searches.append(SearchSummaryV1(query=query, status="failed", result_count=0))
            continue
        ctx.research_calls.append(result.record)
        urls = [h.url for h in result.hits]
        searches.append(SearchSummaryV1(query=query, status="ok" if urls else "no_results", result_count=len(urls)))
        per_query_urls.append((query, urls))
    if provider_failed:
        limitations.append("The search provider was unavailable for part of this run; research is incomplete.")

    candidates = _interleave(per_query_urls)
    focus = " ".join([*queries, *frame.research_questions])
    sources: list[SourceRecordV1] = []
    skipped: list[SkippedSourceV1] = []
    hashes: set[str] = set()
    attempts = candidates[: settings.max_pages * 2]
    fetched_pairs: list[tuple[str, str, FetchResult | None]] = []
    for start in range(0, len(attempts), FETCH_CONCURRENCY):
        # Fetch in small parallel batches and stop as soon as enough sources are usable,
        # so publishers are not asked for pages we will not use.
        if _usable_count(fetched_pairs, sources) >= settings.max_pages:
            break
        batch = attempts[start : start + FETCH_CONCURRENCY]
        results = _fetch_all(settings.fetcher, [url for _q, url in batch], deadline)
        fetched_pairs.extend((q, u, r) for (q, u), r in zip(batch, results, strict=True))
    for query, url, fetched in fetched_pairs:
        if fetched is None:
            skipped.append(SkippedSourceV1(domain=_domain(url), status="not_attempted"))
            continue
        ctx.research_calls.extend(fetched.records)
        if len(sources) >= settings.max_pages:
            continue
        page = fetched.page
        if page is None:
            skipped.append(SkippedSourceV1(domain=fetched.domain[:253], status=fetched.status))  # pyright: ignore[reportArgumentType]
            continue
        if page.content_sha256 in hashes:
            skipped.append(SkippedSourceV1(domain=page.domain, status="duplicate"))
            continue
        passages = select_passages(page.text, f"{query} {focus}")
        if not passages:
            skipped.append(SkippedSourceV1(domain=page.domain, status="irrelevant"))
            continue
        hashes.add(page.content_sha256)
        sid = f"S{len(sources) + 1}"
        sources.append(
            SourceRecordV1(
                source_id=sid,
                url=page.url,
                domain=page.domain,
                title=page.title,
                publisher=page.publisher,
                published_at=page.published_at,
                retrieved_at=datetime.now(UTC).isoformat(timespec="seconds"),
                content_sha256=page.content_sha256,
                search_query=query,
                passages=[PassageV1(passage_id=f"{sid}.p{i + 1}", text=p) for i, p in enumerate(passages)],
            )
        )
    if not sources:
        limitations.append(NO_SOURCES)
    return EvidenceSetV1(
        provider=provider, searches=searches, sources=sources, skipped=skipped[:100], limitations=limitations
    ), made


def _usable_count(pairs: list[tuple[str, str, FetchResult | None]], _sources: list[SourceRecordV1]) -> int:
    """Upper bound on usable sources so far (fetched pages; relevance is decided afterwards)."""
    return sum(1 for _q, _u, r in pairs if r is not None and r.page is not None)


def _empty(provider: str, limitations: list[str]) -> EvidenceSetV1:
    return EvidenceSetV1(provider=provider, searches=[], sources=[], skipped=[], limitations=limitations)


def _domain(url: str) -> str:
    from urllib.parse import urlsplit

    return (urlsplit(url).hostname or "unknown")[:253]


def _interleave(per_query: list[tuple[str, list[str]]]) -> list[tuple[str, str]]:
    """Round-robin across queries for diversity; dedupe URLs; at most MAX_PER_DOMAIN per domain."""
    seen: set[str] = set()
    per_domain: dict[str, int] = {}
    out: list[tuple[str, str]] = []
    longest = max((len(urls) for _q, urls in per_query), default=0)
    for i in range(longest):
        for query, urls in per_query:
            if i >= len(urls):
                continue
            url = urls[i]
            key = normalise_url(url)
            domain = _domain(url)
            if key in seen or per_domain.get(domain, 0) >= MAX_PER_DOMAIN:
                continue
            seen.add(key)
            per_domain[domain] = per_domain.get(domain, 0) + 1
            out.append((query, url))
    return out


def _fetch_all(fetcher: PageFetcher, urls: list[str], deadline: float) -> list[FetchResult | None]:
    """Fetches in parallel; URLs not started before the stage deadline are left as None."""

    def one(url: str) -> FetchResult | None:
        if deadline - time.monotonic() < fetcher.timeout + 2:
            return None
        return fetcher.fetch(url)

    with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY, thread_name_prefix="fetch") as pool:
        return list(pool.map(one, urls))


def evidence_for_model(evidence: EvidenceSetV1 | None) -> str:
    """Compact JSON of what the model may use: source metadata and passage text only."""
    if evidence is None or not evidence.sources:
        return "[]"
    return json.dumps(
        [
            {
                "source_id": s.source_id,
                "title": s.title,
                "domain": s.domain,
                "publisher": s.publisher,
                "published_at": s.published_at,
                "passages": [{"passage_id": p.passage_id, "text": p.text} for p in s.passages],
            }
            for s in evidence.sources
        ],
        ensure_ascii=False,
        indent=1,
    )


# --- verifying -----------------------------------------------------------------------------


class GuardError(ValueError):
    """A deterministic check on model output failed. `note` is application-written text that
    names IDs and rules only (IDs are pattern-constrained), so it is safe in a repair note."""

    def __init__(self, note: str) -> None:
        super().__init__(note)
        self.note = note


def passage_index(evidence: EvidenceSetV1) -> dict[str, tuple[SourceRecordV1, PassageV1]]:
    return {p.passage_id: (s, p) for s in evidence.sources for p in s.passages}


def check_claim_set(claims: ClaimSetV1, evidence: EvidenceSetV1) -> None:
    index = passage_index(evidence)
    ids = [c.claim_id for c in claims.claims]
    problems: list[str] = []
    if len(ids) != len(set(ids)):
        problems.append("claim_id values must be unique (C1, C2, ...)")
    unknown = sorted({e.passage_id for c in claims.claims for e in c.evidence if e.passage_id not in index})
    if unknown:
        problems.append(f"unknown passage_id values {', '.join(unknown[:10])}: use only the passage IDs supplied")
    if problems:
        raise GuardError("; ".join(problems))


def quote_checked(claims: ClaimSetV1, evidence: EvidenceSetV1) -> list[tuple[str, str, bool]]:
    """(claim_id, passage_id, quote found) for every evidence item."""
    index = passage_index(evidence)
    return [
        (c.claim_id, e.passage_id, quote_in(e.quote, index[e.passage_id][1].text))
        for c in claims.claims
        for e in c.evidence
        if e.passage_id in index
    ]


def claims_for_verifier(claims: ClaimSetV1, evidence: EvidenceSetV1, found: set[tuple[str, str]]) -> str:
    index = passage_index(evidence)
    payload: list[dict[str, object]] = []
    for c in claims.claims:
        items = [
            {
                "passage_id": e.passage_id,
                "relation": e.relation,
                "quote": e.quote,
                "passage_text": index[e.passage_id][1].text,
            }
            for e in c.evidence
            if (c.claim_id, e.passage_id) in found
        ]
        if items:
            payload.append({"claim_id": c.claim_id, "claim": c.text, "evidence": items})
    return json.dumps(payload, ensure_ascii=False, indent=1)


def check_judgments(judgments: ClaimVerificationV1, expected: set[tuple[str, str]]) -> None:
    extra = sorted(
        f"{j.claim_id}/{j.passage_id}" for j in judgments.judgments if (j.claim_id, j.passage_id) not in expected
    )
    if extra:
        raise GuardError(f"judgments for pairs that were not supplied: {', '.join(extra[:10])}")


Freshness = Literal["fresh", "stale", "unknown"]


def _freshness(dates: list[str | None], stale_days: int, today: date) -> Freshness:
    parsed: list[date] = []
    for raw in dates:
        if raw is None:
            continue
        try:
            parsed.append(date.fromisoformat(raw[:10]))
        except ValueError:
            continue
    if not parsed:
        return "unknown"
    return "fresh" if max(parsed) >= today - timedelta(days=stale_days) else "stale"


def build_report(
    claims: ClaimSetV1,
    evidence: EvidenceSetV1,
    found: set[tuple[str, str]],
    judgments: ClaimVerificationV1 | None,
    stale_days: int,
    today: date | None = None,
) -> VerificationReportV1:
    index = passage_index(evidence)
    verdicts = {(j.claim_id, j.passage_id): (j.verdict, j.note) for j in (judgments.judgments if judgments else [])}
    today = today or datetime.now(UTC).date()
    out: list[VerifiedClaimV1] = []
    contradictions: list[str] = []
    discarded = 0
    stale_claims = 0
    for c in claims.claims:
        items: list[VerifiedEvidenceV1] = []
        for e in c.evidence:
            if e.passage_id not in index:
                continue
            source = index[e.passage_id][0]
            if (c.claim_id, e.passage_id) not in found:
                verdict, note = "quote_not_found", "The quote does not appear in the passage that was read."
            else:
                verdict, note = verdicts.get(
                    (c.claim_id, e.passage_id), ("not_supported", "The verifier gave no judgment for this pair.")
                )
            items.append(
                VerifiedEvidenceV1(
                    source_id=source.source_id,
                    passage_id=e.passage_id,
                    relation=e.relation,
                    quote=e.quote,
                    verdict=verdict,  # pyright: ignore[reportArgumentType]
                    note=note[:500],
                )
            )
        backing = [i for i in items if i.relation == "supports" and i.verdict in ("supported", "partially_supported")]
        against = [
            i for i in items if i.relation == "contradicts" and i.verdict in ("supported", "partially_supported")
        ]
        if all(i.verdict == "quote_not_found" for i in items):
            status = "invalid"
            discarded += 1
        elif any(i.verdict == "supported" for i in backing):
            status = "verified"
        elif backing:
            status = "partial"
        else:
            status = "unsupported"
        if backing and against:
            contradictions.append(c.claim_id)
        label = c.label
        if label == "fact" and status != "verified":
            label = "inference"  # not established by the sources that were read
        dates = [index[i.passage_id][0].published_at for i in backing]
        freshness: Freshness = _freshness(dates, stale_days, today) if backing else "unknown"
        if freshness == "stale":
            stale_claims += 1
        out.append(
            VerifiedClaimV1(
                claim_id=c.claim_id,
                text=c.text,
                label=label,
                status=status,
                freshness=freshness,
                evidence=items,  # pyright: ignore[reportArgumentType]
            )
        )
    limitations: list[str] = []
    usable = [c for c in out if c.status in ("verified", "partial")]
    if not usable:
        limitations.append("No claim could be verified against the source text that was read.")
    if discarded:
        limitations.append(f"{discarded} extracted claim(s) were discarded: their quotes did not match the sources.")
    if stale_claims:
        limitations.append(f"{stale_claims} claim(s) rest on sources older than {stale_days} days.")
    if contradictions:
        limitations.append(f"Sources disagree on {len(contradictions)} claim(s): {', '.join(contradictions)}.")
    unverifiable = [*claims.gaps, *(f"{c.claim_id}: {c.text}" for c in out if c.status in ("unsupported", "invalid"))]
    return VerificationReportV1(
        claims=out,
        contradictions=contradictions,
        unverifiable=[u[:500] for u in unverifiable][:20],
        limitations=limitations,
    )


def usable_evidence(report: VerificationReportV1 | None, evidence: EvidenceSetV1 | None) -> tuple[str, dict[str, str]]:
    """JSON of verified/partial claims for synthesis, and allowed source IDs -> domain."""
    if report is None or evidence is None:
        return "[]", {}
    sources = {s.source_id: s for s in evidence.sources}
    allowed: dict[str, str] = {}
    payload: list[dict[str, object]] = []
    for c in report.claims:
        if c.status not in ("verified", "partial"):
            continue
        items = [i for i in c.evidence if i.verdict in ("supported", "partially_supported")]
        for i in items:
            allowed[i.source_id] = sources[i.source_id].domain
        payload.append(
            {
                "claim_id": c.claim_id,
                "claim": c.text,
                "label": c.label,
                "status": c.status,
                "freshness": c.freshness,
                "contradicted": c.claim_id in report.contradictions,
                "evidence": [
                    {
                        "source_id": i.source_id,
                        "relation": i.relation,
                        "verdict": i.verdict,
                        "quote": i.quote,
                        "source_title": sources[i.source_id].title,
                        "source_domain": sources[i.source_id].domain,
                        "published_at": sources[i.source_id].published_at,
                    }
                    for i in items
                ],
            }
        )
    return json.dumps(payload, ensure_ascii=False, indent=1) if payload else "[]", allowed
