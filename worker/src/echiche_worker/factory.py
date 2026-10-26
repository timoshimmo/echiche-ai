"""Builds the configured reasoning provider; every problem surfaces at start-up as a ConfigError."""

from __future__ import annotations

from echiche_worker.config import ConfigError, WorkerConfig
from echiche_worker.llm import OPENAI_PRICES
from echiche_worker.model_provider import ModelReasoningProvider, ModelSettings
from echiche_worker.prompts import PromptRegistry, PromptRegistryError
from echiche_worker.provider import DeterministicProvider, ReasoningProvider


def build_provider(config: WorkerConfig) -> ReasoningProvider:
    if config.reasoning_provider == "deterministic":
        return DeterministicProvider()
    from echiche_worker.openai_adapter import OpenAIModelClient

    issues: list[str] = []
    if config.openai_model not in OPENAI_PRICES.prices:
        issues.append(
            f"OPENAI_MODEL has no verified price (known: {', '.join(sorted(OPENAI_PRICES.prices))}); "
            "add it to llm.OPENAI_PRICES from the official pricing page first"
        )
    try:
        registry = PromptRegistry.load()
    except PromptRegistryError as error:
        issues.append(f"prompt registry: {error}")
        registry = None
    if issues or registry is None or config.openai_api_key is None:
        raise ConfigError(issues or ["OPENAI_API_KEY is required"])
    client = OpenAIModelClient(
        api_key=config.openai_api_key,
        model=config.openai_model,
        data_residency=config.openai_data_residency,
        reasoning_effort=config.openai_reasoning_effort,
    )
    try:
        return ModelReasoningProvider(
            client,
            registry,
            OPENAI_PRICES,
            ModelSettings(residency=config.openai_data_residency, max_output_tokens=config.openai_max_output_tokens),
        )
    except (PromptRegistryError, ValueError, KeyError) as error:
        raise ConfigError([f"reasoning provider: {error}"]) from error
