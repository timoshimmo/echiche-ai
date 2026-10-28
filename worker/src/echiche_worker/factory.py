"""Builds the configured reasoning provider; every problem surfaces at start-up as a ConfigError."""

from __future__ import annotations

from echiche_worker import __version__
from echiche_worker.config import ConfigError, WorkerConfig
from echiche_worker.llm import OPENAI_PRICES
from echiche_worker.model_provider import ModelReasoningProvider, ModelSettings
from echiche_worker.prompts import PromptRegistry, PromptRegistryError
from echiche_worker.provider import DeterministicProvider, ReasoningProvider
from echiche_worker.research_pipeline import ResearchSettings


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
            research=build_research(config),
        )
    except (PromptRegistryError, ValueError, KeyError) as error:
        raise ConfigError([f"reasoning provider: {error}"]) from error


USER_AGENT = f"EchicheResearchBot/{__version__}"


def build_research(config: WorkerConfig) -> ResearchSettings | None:
    if config.research_provider != "brave" or config.brave_api_key is None:
        return None
    from echiche_worker.fetch import PageFetcher
    from echiche_worker.research import BraveSearchClient

    return ResearchSettings(
        search=BraveSearchClient(config.brave_api_key),
        fetcher=PageFetcher(USER_AGENT, config.fetch_timeout_seconds, config.fetch_max_bytes),
        max_queries=config.research_max_queries,
        results_per_query=config.research_results_per_query,
        max_pages=config.research_max_pages,
        stale_days=config.research_stale_days,
    )
