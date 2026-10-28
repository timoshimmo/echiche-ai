"""Worker entry point: claim → execute → repeat, until SIGTERM/SIGINT.

    echiche-worker                 run until stopped (production; Render Background Worker)
    echiche-worker --once          process every runnable job, then exit (tests, one-off drains)
    echiche-worker --check-config  validate configuration and exit

Exit codes: 0 = clean stop, 2 = invalid configuration.
On SIGTERM it stops claiming; the current run finishes its stage or is released back to
the queue without consuming an attempt, well within Render's maxShutdownDelaySeconds.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time
from collections.abc import Callable
from threading import Event

import psycopg

from echiche_worker import __version__
from echiche_worker.config import ConfigError, WorkerConfig, parse_worker_config
from echiche_worker.executor import ExecutorSettings, execute
from echiche_worker.factory import build_provider
from echiche_worker.log import log
from echiche_worker.model_provider import describe
from echiche_worker.provider import ReasoningProvider
from echiche_worker.routing import RoutingPolicy, RoutingPolicyError, load_policy
from echiche_worker.store import RunStore, connect


class Session:
    """Two connections: one for claiming/executing, one for the lease keeper thread
    (psycopg connections must not be shared across threads)."""

    def __init__(self, config: WorkerConfig) -> None:
        self.main = connect(config.database_url)
        try:
            self.lease = connect(config.database_url)
        except Exception:
            self.main.close()
            raise
        self.store = RunStore(self.main, config.worker_id, config.lease_seconds)
        self.lease_store = RunStore(self.lease, config.worker_id, config.lease_seconds)

    @property
    def healthy(self) -> bool:
        return not self.main.closed and not self.lease.closed

    def close(self, remove_heartbeat: bool) -> None:
        if remove_heartbeat and not self.main.closed:
            try:
                self.store.remove_heartbeat()
            except psycopg.Error:
                pass
        self.main.close()
        self.lease.close()


def _lease_renewer(lease_store: RunStore, run_id: str) -> Callable[[], bool]:
    return lambda: lease_store.renew_lease(run_id)


def run_loop(
    config: WorkerConfig,
    shutdown: Event,
    provider: ReasoningProvider,
    once: bool = False,
    routing: RoutingPolicy | None = None,
) -> int:
    settings = ExecutorSettings(stage_timeout_seconds=config.stage_timeout_seconds, routing=routing)
    heartbeat_every = max(1.0, config.lease_seconds / 3)
    backoff = 1.0
    processed = 0
    session: Session | None = None
    last_beat = 0.0
    while not shutdown.is_set():
        try:
            if session is None or not session.healthy:
                session = Session(config)
                session.store.heartbeat(__version__, None)
                last_beat = time.monotonic()
                log("info", "worker_connected", worker_id=config.worker_id)
            if time.monotonic() - last_beat >= heartbeat_every:
                session.store.heartbeat(__version__, None)
                last_beat = time.monotonic()
            run = session.store.claim()
            backoff = 1.0
            if run is None:
                if once:
                    break
                shutdown.wait(config.poll_interval_seconds)
                continue
            session.store.heartbeat(__version__, run.id)
            log("info", "run_claimed", run_id=run.id, attempt=run.attempt)
            outcome = execute(
                run,
                session.store,
                provider,
                settings,
                shutdown,
                renew_lease=_lease_renewer(session.lease_store, run.id),
            )
            processed += 1
            log("info", "run_outcome", run_id=run.id, outcome=outcome.value)
            session.store.heartbeat(__version__, None)
            last_beat = time.monotonic()
        except psycopg.OperationalError as error:
            log("error", "database_unavailable", error_name=type(error).__name__, retry_in_seconds=backoff)
            if session is not None:
                session.close(remove_heartbeat=False)
                session = None
            if shutdown.wait(backoff):
                break
            backoff = min(backoff * 2, 30.0)
    if session is not None:
        session.close(remove_heartbeat=True)
    log("info", "worker_stopped", processed=processed)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Echiche run worker")
    parser.add_argument("--once", action="store_true", help="process all runnable jobs, then exit")
    parser.add_argument("--check-config", action="store_true", help="validate configuration and exit")
    args = parser.parse_args(argv)
    try:
        config = parse_worker_config(os.environ)
        provider = build_provider(config)
        routing = load_policy()
    except ConfigError as error:
        log("error", "config_invalid", issues=error.issues)
        return 2
    except RoutingPolicyError as error:
        log("error", "config_invalid", issues=[str(error)])
        return 2
    if args.check_config:
        log(
            "info",
            "config_valid",
            version=__version__,
            worker_id=config.worker_id,
            provider=describe(provider),
            routing=routing.version,
        )
        return 0

    shutdown = Event()

    def stop(signum: int, _frame: object) -> None:
        log("info", "shutdown_requested", signal=signal.Signals(signum).name)
        shutdown.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log("info", "worker_starting", version=__version__, provider=describe(provider), routing=routing.version)
    return run_loop(config, shutdown, provider, once=args.once, routing=routing)


if __name__ == "__main__":
    sys.exit(main())
