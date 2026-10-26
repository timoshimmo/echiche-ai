"""Provider-neutral model client port, token usage, and spend accounting.

A `ModelClient` turns (trusted instructions, fenced data, output schema) into raw JSON
text plus usage. It never validates content against Pydantic: that happens in
`model_provider.py`, so an invalid output still reports the tokens it cost.

Prices are per 1M tokens in USD, taken from the provider's official pricing page and
recorded with the date they were checked. An unknown model is a configuration error:
the worker never guesses a price.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_UP, Decimal
from typing import Any, Protocol

from echiche_worker.provider import ProviderError

MILLION = Decimal(1_000_000)


@dataclass(frozen=True, slots=True)
class TokenUsage:
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0  # already included in output_tokens (billed as output)


@dataclass(frozen=True, slots=True)
class ModelRequest:
    instructions: str  # trusted, reviewed prompt text (system/developer role)
    data: str  # fenced untrusted data blocks (user role)
    schema_name: str  # e.g. "decision_frame_v1"; [A-Za-z0-9_-]{1,64}
    json_schema: dict[str, Any]  # strict JSON Schema for the output
    max_output_tokens: int
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ModelReply:
    """status: "completed" | "refused" | "truncated"."""

    status: str
    text: str
    usage: TokenUsage
    model: str
    latency_ms: int


class ModelCallError(Exception):
    """Raised by a ModelClient with the provider-neutral error to surface, plus the usage
    already incurred (for example a timeout after the provider started billing is unknown
    and reported as zero)."""

    def __init__(self, error: ProviderError, usage: TokenUsage | None = None, latency_ms: int = 0) -> None:
        super().__init__(str(error))
        self.error = error
        self.usage = usage or TokenUsage()
        self.latency_ms = latency_ms


class ModelClient(Protocol):
    provider: str
    model: str

    def generate(self, request: ModelRequest) -> ModelReply: ...


@dataclass(frozen=True, slots=True)
class ModelPrice:
    input: Decimal
    cached_input: Decimal
    output: Decimal


@dataclass(frozen=True, slots=True)
class PriceTable:
    provider: str
    checked_on: str
    source: str
    prices: dict[str, ModelPrice]
    regional_uplift: dict[str, Decimal]  # residency -> multiplier

    def price(self, model: str) -> ModelPrice:
        try:
            return self.prices[model]
        except KeyError:
            raise KeyError(f"no verified price for model {model!r}") from None

    def multiplier(self, residency: str) -> Decimal:
        return self.regional_uplift.get(residency, Decimal(1))

    def cost(self, model: str, usage: TokenUsage, residency: str) -> Decimal:
        p = self.price(model)
        cached = min(usage.cached_input_tokens, usage.input_tokens)
        raw = (
            Decimal(usage.input_tokens - cached) * p.input
            + Decimal(cached) * p.cached_input
            + Decimal(usage.output_tokens) * p.output
        ) / MILLION
        return (raw * self.multiplier(residency)).quantize(Decimal("0.000001"), rounding=ROUND_UP)

    def worst_case(self, model: str, request: ModelRequest, residency: str) -> Decimal:
        """Upper bound for one call: every input byte is a token (byte-level BPE never emits
        more tokens than bytes), nothing is cached, and output hits max_output_tokens."""
        import json

        input_bytes = (
            len(request.instructions.encode("utf-8"))
            + len(request.data.encode("utf-8"))
            + len(json.dumps(request.json_schema).encode("utf-8"))
            + 512  # message framing
        )
        usage = TokenUsage(input_tokens=input_bytes, output_tokens=request.max_output_tokens)
        return self.cost(model, usage, residency)


# Verified 2026-10-26 against https://openai.com/api/pricing/ (standard tier, per 1M tokens).
# The EU data-residency endpoint is billed at +10%.
OPENAI_PRICES = PriceTable(
    provider="openai",
    checked_on="2026-10-26",
    source="https://openai.com/api/pricing/",
    prices={
        "gpt-6-astra": ModelPrice(input=Decimal("10"), cached_input=Decimal("1"), output=Decimal("50")),
        "gpt-6.1-sol": ModelPrice(input=Decimal("2"), cached_input=Decimal("0.10"), output=Decimal("10")),
        "gpt-6-luna": ModelPrice(input=Decimal("0.10"), cached_input=Decimal("0.01"), output=Decimal("0.50")),
    },
    regional_uplift={"eu": Decimal("1.10")},
)
