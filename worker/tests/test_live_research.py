"""Opt-in live smoke test: ONE real Brave search (billed, $0.005 at the verified price) and
real page fetches through the production fetcher guards. Never runs in CI or by default.

    ECHICHE_LIVE_BRAVE=1 BRAVE_SEARCH_API_KEY=... uv run pytest -m live -s -k research
"""

from __future__ import annotations

import os

import pytest

from echiche_worker.factory import USER_AGENT
from echiche_worker.fetch import PageFetcher
from echiche_worker.passages import select_passages
from echiche_worker.research import BraveSearchClient

pytestmark = pytest.mark.live


@pytest.mark.skipif(os.environ.get("ECHICHE_LIVE_BRAVE") != "1", reason="set ECHICHE_LIVE_BRAVE=1 to opt in")
def test_live_research_search_and_fetch() -> None:
    key = os.environ.get("BRAVE_SEARCH_API_KEY", "").strip()
    assert key, "BRAVE_SEARCH_API_KEY is required for the live test"
    query = "small clinic appointment scheduling software pricing"
    result = BraveSearchClient(key).search(query, 5, 10)
    assert result.record.http_status == 200
    print(f"\nlive search ok: {len(result.hits)} hits, outcome={result.record.outcome}")
    fetcher = PageFetcher(USER_AGENT, 8, 2_000_000)
    for hit in result.hits[:3]:
        fetched = fetcher.fetch(hit.url)
        passages = select_passages(fetched.page.text, query) if fetched.page else []
        print(f"  {fetched.domain}: {fetched.status}, {len(passages)} passage(s)")
