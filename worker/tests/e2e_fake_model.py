"""Cross-language E2E helper (used by the web integration suite, never in production):
drains the queue with the real executor and store, as echiche_worker, but with the
scripted model client instead of a live provider. No network, no API key.

    DATABASE_URL=postgresql://echiche_worker:...@.../db uv run --no-sync python -m tests.e2e_fake_model [--research]

With --research, a local TLS fixture website and a scripted search provider stand in for
Brave and the web, so sources, claims and research telemetry are written as in production.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from threading import Event

from echiche_worker.executor import ExecutorSettings, execute
from echiche_worker.research_pipeline import ResearchSettings
from echiche_worker.store import RunStore, connect

from .model_fakes import FakeModelClient, model_provider
from .research_fakes import (
    FakeSearch,
    FixtureSite,
    brief_citing,
    claims_reply,
    make_tls,
    plan_reply,
    site_fetcher,
    verifier_reply,
)


def main(argv: list[str]) -> int:
    site: FixtureSite | None = None
    if "--research" in argv:
        site = FixtureSite(make_tls(Path(tempfile.mkdtemp())))
        search = FakeSearch([[site.url("survey.test"), site.url("pilots.test")], [site.url("forum.test")]])
        client = FakeModelClient(
            script={
                "research_plan_v1": [plan_reply(["clinic scheduling pricing", "paid pilot conversion"])],
                "claim_set_v1": [claims_reply()],
                "claim_verification_v1": [verifier_reply()],
                "decision_brief_v1": [brief_citing(["S1", "S2"])],
            }
        )
        provider = model_provider(client, research=ResearchSettings(search=search, fetcher=site_fetcher(site)))
    else:
        provider = model_provider()
    try:
        with connect(os.environ["DATABASE_URL"]) as conn:
            store = RunStore(conn, "worker-e2e-model", 30)
            while (run := store.claim()) is not None:
                execute(run, store, provider, ExecutorSettings(stage_timeout_seconds=30), Event())
    finally:
        if site is not None:
            site.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
