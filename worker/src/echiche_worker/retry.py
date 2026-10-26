"""Bounded retries with exponential backoff and full jitter, for transient errors only."""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass
from threading import Event

from echiche_worker.provider import TransientProviderError


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_tries: int = 3
    base_seconds: float = 0.5
    cap_seconds: float = 8.0

    def delay(self, retry_number: int, rand: Callable[[], float] = random.random) -> float:
        """Full-jitter delay before retry `retry_number` (1-based)."""
        ceiling = min(self.cap_seconds, self.base_seconds * (2 ** (retry_number - 1)))
        return ceiling * rand()


def run_with_retries[T](
    fn: Callable[[], T],
    policy: RetryPolicy,
    shutdown: Event,
    on_retry: Callable[[int, TransientProviderError], None] = lambda _n, _e: None,
) -> T:
    """Calls fn; retries only TransientProviderError, up to policy.max_tries total.

    Permanent errors propagate immediately. Waiting is interruptible by shutdown, in
    which case the last transient error propagates (the run is released, not failed).
    """
    for attempt in range(1, policy.max_tries + 1):
        try:
            return fn()
        except TransientProviderError as error:
            if attempt == policy.max_tries:
                raise
            on_retry(attempt, error)
            wait = policy.delay(attempt)
            if error.retry_after is not None:
                # Honour the provider's Retry-After, bounded so one stage cannot stall for long.
                wait = max(wait, min(error.retry_after, policy.cap_seconds * 4))
            if shutdown.wait(wait):
                raise
    raise AssertionError("unreachable")
