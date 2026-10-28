"""Search provider port, the Brave Web Search adapter, and research telemetry (ADR-008).

Search results are used only to *discover* pages: nothing from a search response is stored
or shown to the model. Evidence comes exclusively from pages the worker fetched itself
(`fetch.py`), so every citation points at text the application actually read.

Brave Web Search (verified 2026-10-28, https://brave.com/search/api/ and Brave's docs):
GET https://api.search.brave.com/res/v1/web/search, header `X-Subscription-Token`,
`q` at most 400 characters / 50 words, `count` 1-20. Search plan: $5 per 1,000 requests.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, cast

from echiche_worker.provider import ProviderError, ResearchCallRecord, TransientProviderError

BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
# Verified 2026-10-28 at https://brave.com/search/api/ ("Search": $5 per 1,000 requests).
BRAVE_PRICE_PER_REQUEST = Decimal("0.005")
MAX_QUERY_CHARS = 400
MAX_QUERY_WORDS = 50


class ResearchError(ProviderError):
    code = "RESEARCH_ERROR"


class ResearchAuthError(ResearchError):
    """The search provider rejected the key: an operator problem, never retried."""

    code = "RESEARCH_AUTH"


class ResearchUnavailableError(TransientProviderError):
    code = "RESEARCH_UNAVAILABLE"


class ResearchRateLimitedError(ResearchUnavailableError):
    code = "RESEARCH_RATE_LIMITED"


@dataclass(frozen=True, slots=True)
class SearchHit:
    url: str


@dataclass(frozen=True, slots=True)
class SearchResult:
    hits: list[SearchHit]
    record: ResearchCallRecord


class SearchCallError(Exception):
    """Carries the provider-neutral error plus the call record (cost may already be incurred)."""

    def __init__(self, error: ProviderError, record: ResearchCallRecord) -> None:
        super().__init__(str(error))
        self.error = error
        self.record = record


class SearchClient(Protocol):
    provider: str
    price_per_request: Decimal

    def search(self, query: str, count: int, timeout_seconds: float) -> SearchResult: ...


def clean_query(query: str) -> str:
    words = query.split()[:MAX_QUERY_WORDS]
    return " ".join(words)[:MAX_QUERY_CHARS].strip()


def _retry_after(headers: object) -> float | None:
    get = getattr(headers, "get", None)
    raw = get("retry-after") if callable(get) else None
    try:
        value = float(cast(str, raw))
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= 3600 else None


class BraveSearchClient:
    provider = "brave"
    price_per_request = BRAVE_PRICE_PER_REQUEST

    def __init__(self, api_key: str, endpoint: str = BRAVE_ENDPOINT) -> None:
        # `endpoint` is overridable for tests (local mock server) only; not configurable from env.
        self._key = api_key
        self._endpoint = endpoint

    def search(self, query: str, count: int, timeout_seconds: float) -> SearchResult:
        params = urllib.parse.urlencode({"q": clean_query(query), "count": max(1, min(count, 20))})
        request = urllib.request.Request(  # noqa: S310 - fixed https endpoint (tests: local mock)
            f"{self._endpoint}?{params}",
            headers={"Accept": "application/json", "X-Subscription-Token": self._key},
            method="GET",
        )
        started = time.monotonic()

        def record(outcome: str, status: int | None, results: int = 0, size: int = 0) -> ResearchCallRecord:
            # Conservative: any request that got an HTTP response is counted as billed.
            cost = self.price_per_request if status is not None else Decimal(0)
            return ResearchCallRecord("search", self.provider, outcome, status, None, results, size, cost, _ms(started))

        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - fixed https endpoint
                body = response.read(5_000_000)
                status = int(response.status)
        except urllib.error.HTTPError as error:
            status = error.code
            if status == 429:
                raise SearchCallError(
                    ResearchRateLimitedError("search rate limited", retry_after=_retry_after(error.headers)),
                    record("rate_limited", status),
                ) from None
            if status in (401, 403):
                raise SearchCallError(ResearchAuthError("search key rejected"), record("auth_error", status)) from None
            if status >= 500 or status in (408, 409):
                raise SearchCallError(
                    ResearchUnavailableError(f"search status {status}"), record("http_error", status)
                ) from None
            raise SearchCallError(
                ResearchError(f"search rejected (status {status})"), record("http_error", status)
            ) from None
        except TimeoutError:
            raise SearchCallError(ResearchUnavailableError("search timed out"), record("timeout", None)) from None
        except urllib.error.URLError:
            raise SearchCallError(ResearchUnavailableError("search connection failed"), record("error", None)) from None

        try:
            payload = json.loads(body)
            web = cast(dict[str, object], cast(dict[str, object], payload).get("web") or {})
            results = cast(list[object], web.get("results") or [])
        except (ValueError, AttributeError, TypeError):
            raise SearchCallError(
                ResearchUnavailableError("search returned malformed JSON"), record("malformed", status, size=len(body))
            ) from None
        hits: list[SearchHit] = []
        for item in results:
            url = cast(dict[str, object], item).get("url") if isinstance(item, dict) else None
            if isinstance(url, str) and url.startswith(("https://", "http://")) and len(url) <= 2048:
                hits.append(SearchHit(url=url))
        outcome = "ok" if hits else "no_results"
        return SearchResult(hits=hits, record=record(outcome, status, len(hits), len(body)))


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
