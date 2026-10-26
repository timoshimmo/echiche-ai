"""Cross-language E2E helper (used by the web integration suite, never in production):
drains the queue with the real executor and store, as echiche_worker, but with the
scripted model client instead of a live provider. No network, no API key.

    DATABASE_URL=postgresql://echiche_worker:...@.../db uv run --no-sync python -m tests.e2e_fake_model
"""

from __future__ import annotations

import os
import sys
from threading import Event

from echiche_worker.executor import ExecutorSettings, execute
from echiche_worker.store import RunStore, connect

from .model_fakes import model_provider


def main() -> int:
    provider = model_provider()
    with connect(os.environ["DATABASE_URL"]) as conn:
        store = RunStore(conn, "worker-e2e-model", 30)
        while (run := store.claim()) is not None:
            execute(run, store, provider, ExecutorSettings(stage_timeout_seconds=10), Event())
    return 0


if __name__ == "__main__":
    sys.exit(main())
