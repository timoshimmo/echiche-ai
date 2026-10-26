"""OpenAI Responses API adapter (ADR-007).

- `store=False`: no application state is kept by OpenAI for these calls.
- SDK retries are disabled (`max_retries=0`): the worker's own retry/requeue policy
  is the only one, so attempts, backoff and spend stay bounded and observable.
- Strict structured outputs: the JSON Schema is derived from the Pydantic contract.
- Errors are mapped to the worker's provider-neutral error classes. Raw provider error
  messages are never logged or stored (they can echo request content).
"""

from __future__ import annotations

import time
from typing import Any, cast, get_args

import openai
from openai import Omit, OpenAI, omit
from openai.lib._pydantic import to_strict_json_schema  # pyright: ignore[reportPrivateUsage]
from openai.types.shared.reasoning_effort import ReasoningEffort
from openai.types.shared_params.reasoning import Reasoning
from pydantic import BaseModel

from echiche_worker.llm import ModelCallError, ModelReply, ModelRequest, TokenUsage
from echiche_worker.provider import (
    ProviderAuthError,
    ProviderError,
    ProviderRateLimitedError,
    ProviderRequestError,
    ProviderTimeoutError,
    TransientProviderError,
)

REASONING_EFFORTS: frozenset[str] = frozenset(a for a in get_args(get_args(ReasoningEffort)[0]) if isinstance(a, str))


def strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """The schema the SDK itself would send for `text_format=model` (pinned SDK version)."""
    return to_strict_json_schema(model)


def _retry_after(error: openai.APIStatusError) -> float | None:
    raw = error.response.headers.get("retry-after")
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if 0 <= value <= 3600 else None


def map_error(error: Exception) -> ProviderError:
    if isinstance(error, openai.APITimeoutError):
        return ProviderTimeoutError("provider request timed out")
    if isinstance(error, openai.APIConnectionError):
        return TransientProviderError("provider connection failed")
    if isinstance(error, openai.RateLimitError):
        return ProviderRateLimitedError("provider rate limited", retry_after=_retry_after(error))
    if isinstance(error, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return ProviderAuthError("provider rejected the credentials")
    if isinstance(error, openai.InternalServerError):
        return TransientProviderError("provider server error", retry_after=_retry_after(error))
    if isinstance(error, openai.APIStatusError):
        if error.status_code in (408, 409) or error.status_code >= 500:
            return TransientProviderError(f"provider status {error.status_code}")
        return ProviderRequestError(f"provider rejected the request (status {error.status_code})")
    return ProviderError(f"provider call failed ({type(error).__name__})")


def _usage(response: Any) -> TokenUsage:  # noqa: ANN401 - SDK response object
    usage = getattr(response, "usage", None)
    if usage is None:
        return TokenUsage()
    input_details = getattr(usage, "input_tokens_details", None)
    output_details = getattr(usage, "output_tokens_details", None)
    return TokenUsage(
        input_tokens=int(usage.input_tokens or 0),
        cached_input_tokens=int(getattr(input_details, "cached_tokens", 0) or 0),
        output_tokens=int(usage.output_tokens or 0),
        reasoning_tokens=int(getattr(output_details, "reasoning_tokens", 0) or 0),
    )


class OpenAIModelClient:
    provider = "openai"

    def __init__(
        self,
        api_key: str,
        model: str,
        data_residency: str = "global",
        reasoning_effort: str | None = None,
        base_url: str | None = None,  # tests only (local mock server); not configurable from env
    ) -> None:
        if reasoning_effort is not None and reasoning_effort not in REASONING_EFFORTS:
            raise ValueError("unsupported reasoning effort")
        self.model = model
        self._reasoning_effort = reasoning_effort
        if base_url is not None:
            self._client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)
        else:
            residency = cast(Any, data_residency)
            self._client = OpenAI(api_key=api_key, data_residency=residency, max_retries=0)

    def generate(self, request: ModelRequest) -> ModelReply:
        started = time.monotonic()
        reasoning: Reasoning | Omit = (
            omit if self._reasoning_effort is None else {"effort": cast(ReasoningEffort, self._reasoning_effort)}
        )
        try:
            response = self._client.responses.create(
                model=self.model,
                instructions=request.instructions,
                input=[{"role": "user", "content": request.data}],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": request.schema_name,
                        "schema": request.json_schema,
                        "strict": True,
                    }
                },
                max_output_tokens=request.max_output_tokens,
                store=False,
                timeout=request.timeout_seconds,
                reasoning=reasoning,
            )
        except openai.OpenAIError as error:
            raise ModelCallError(map_error(error), latency_ms=_ms(started)) from error

        latency = _ms(started)
        usage = _usage(response)
        model = str(getattr(response, "model", None) or self.model)
        refusal = False
        for item in response.output or []:
            parts = cast(list[object], getattr(item, "content", None) or [])
            refusal = refusal or any(getattr(part, "type", None) == "refusal" for part in parts)
        if refusal:
            return ModelReply(status="refused", text="", usage=usage, model=model, latency_ms=latency)
        if response.status == "incomplete":
            reason = getattr(response.incomplete_details, "reason", None)
            status = "refused" if reason == "content_filter" else "truncated"
            return ModelReply(status=status, text="", usage=usage, model=model, latency_ms=latency)
        if response.status != "completed":
            raise ModelCallError(TransientProviderError(f"provider returned status {response.status}"), usage, latency)
        return ModelReply(status="completed", text=response.output_text, usage=usage, model=model, latency_ms=latency)


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
