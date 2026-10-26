"""Model-backed reasoning provider (M4, ADR-007).

Stage plan:
  planning      -> model: decision-framing          -> decision-frame.v1
  researching   -> deterministic skip (no research provider until M5)
  critiquing    -> model: decision-critic           -> critique.v1
  verifying     -> deterministic: re-validates frame and critique, checks citations
  synthesizing  -> model: decision-brief-synthesis  -> decision-brief.v1

Every model call:
  1. renders a reviewed prompt from the registry; user content only in fenced data blocks;
  2. checks the worst-case cost against the run's remaining spend cap (else BUDGET_COST);
  3. validates the output against the Pydantic contract plus the citation guard;
  4. on an invalid output, makes exactly one repair attempt, then fails;
  5. appends a ModelCallRecord (tokens, cost, latency, prompt id/version/hash; no content).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, cast

from pydantic import BaseModel, ValidationError

from echiche_worker.contracts import (
    CRITIQUE_SCHEMA_VERSION,
    DECISION_BRIEF_SCHEMA_VERSION,
    DECISION_FRAME_SCHEMA_VERSION,
    MODEL_OUTPUTS,
    CritiqueV1,
    DecisionBriefV1,
    DecisionFrameV1,
    Stage,
    StageOutputV2,
)
from echiche_worker.llm import ModelCallError, ModelClient, ModelReply, ModelRequest, PriceTable, TokenUsage
from echiche_worker.openai_adapter import strict_schema
from echiche_worker.prompts import Prompt, PromptRegistry, render
from echiche_worker.provider import (
    NO_RESEARCH,
    BudgetPreflightError,
    CallOutcome,
    InvalidProviderOutputError,
    ModelCallRecord,
    ProviderError,
    ProviderOutputTruncatedError,
    ProviderRefusedError,
    StageContext,
    StageResult,
)

MAX_REPAIR_ATTEMPTS = 1
_STAGE_PROMPTS: dict[Stage, str] = {
    "planning": "decision-framing",
    "critiquing": "decision-critic",
    "synthesizing": "decision-brief-synthesis",
}


class ReasoningModeMismatchError(ProviderError):
    """A checkpoint from an earlier stage was not produced by the model pipeline
    (e.g. the worker was switched from demo mode mid-run)."""

    code = "REASONING_MODE_MISMATCH"


class CitationError(ValueError):
    pass


def check_citations(payload: BaseModel, allowed: frozenset[str]) -> None:
    """Deterministic guard: every cited source ID must be one the application supplied."""
    bad: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in cast(dict[str, object], node).items():
                if key == "source_id" and isinstance(value, str) and value not in allowed:
                    bad.add(value)
                elif key == "source_ids" and isinstance(value, list):
                    bad.update(v for v in cast(list[object], value) if isinstance(v, str) and v not in allowed)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in cast(list[object], node):
                walk(item)

    walk(payload.model_dump(mode="json"))
    if bad:
        raise CitationError(f"{len(bad)} cited source ID(s) were not supplied")


def repair_note(error: ValidationError | CitationError) -> str:
    """Names failing JSON paths and rule messages only; never echoes the model's content."""
    lines = [
        "Your previous output did not satisfy the required contract. Fix these problems and return the full output:"
    ]
    if isinstance(error, CitationError):
        lines.append(
            "- citations/source_ids: only source IDs present in the evidence data may be cited; "
            "if the evidence list is empty, these lists must be empty."
        )
    else:
        for item in error.errors(include_input=False, include_url=False)[:20]:
            path = ".".join(str(p) for p in item["loc"]) or "(root)"
            lines.append(f"- {path}: {item['msg']}")
    return "\n".join(lines)


def _json(payload: BaseModel) -> str:
    return json.dumps(payload.model_dump(mode="json"), ensure_ascii=False, indent=1)


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items) if items else "- (none stated)"


@dataclass(frozen=True, slots=True)
class ModelSettings:
    residency: str
    max_output_tokens: int


class ModelReasoningProvider:
    name = "model"

    def __init__(
        self, client: ModelClient, registry: PromptRegistry, prices: PriceTable, settings: ModelSettings
    ) -> None:
        self.client = client
        self.prices = prices
        self.settings = settings
        prices.price(client.model)  # unknown model -> KeyError at start-up, never at run time
        self.prompts: dict[Stage, Prompt] = {}
        for stage, prompt_id in _STAGE_PROMPTS.items():
            prompt = registry.get(prompt_id)
            if prompt.meta.output_schema not in MODEL_OUTPUTS:
                raise ValueError(f"{prompt.ref}: output schema has no contract")
            self.prompts[stage] = prompt
        self._schemas = {name: strict_schema(model) for name, model in MODEL_OUTPUTS.items()}

    @property
    def label(self) -> str:
        return f"{self.client.provider}:{self.client.model}"

    # --- stages ---------------------------------------------------------------------

    def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
        if stage == "planning":
            frame = self._generate(
                stage, ctx, DecisionFrameV1, {"project_context": ctx.project_context, "question": ctx.prompt}
            )
            limitations = (
                [f"Clarification would help: {frame.clarifying_question}"]
                if frame.clarification_needed and frame.clarifying_question
                else []
            )
            content = (
                f"Decision: {frame.decision_statement}\n\nGoal: {frame.goal}\n\n"
                f"Options:\n{_bullets(frame.options)}\n\nCriteria:\n{_bullets(frame.criteria)}\n\n"
                f"Unknowns:\n{_bullets(frame.unknowns)}"
            )
            return self._result(stage, "Decision frame", content, frame, DECISION_FRAME_SCHEMA_VERSION, limitations)

        if stage == "researching":
            return StageResult(
                output=StageOutputV2(
                    stage=stage, title="Research skipped", content=NO_RESEARCH, limitations=[NO_RESEARCH]
                )
            )

        frame = self._previous(ctx, "planning", DecisionFrameV1, DECISION_FRAME_SCHEMA_VERSION)
        if stage == "critiquing":
            critique = self._generate(
                stage, ctx, CritiqueV1, {"decision_frame_json": _json(frame), "evidence_json": "[]"}
            )
            content = (
                f"Strongest objection: {critique.strongest_objection}\n\n"
                f"Missing evidence:\n{_bullets(critique.missing_evidence)}"
            )
            return self._result(stage, "Critique", content, critique, CRITIQUE_SCHEMA_VERSION, [])

        critique = self._previous(ctx, "critiquing", CritiqueV1, CRITIQUE_SCHEMA_VERSION)
        if stage == "verifying":
            # Deterministic: both contracts were re-validated by _previous. There is no evidence
            # to check yet; the brief's citations are guarded when it is generated.
            return StageResult(
                output=StageOutputV2(
                    stage=stage,
                    title="Check structure",
                    content=(
                        "The decision frame and critique passed their contracts. No factual claims were verified "
                        "because no research was performed; the brief may not cite any sources."
                    ),
                    limitations=["Structural check only; no claims or citations to verify."],
                )
            )

        brief = self._generate(
            stage,
            ctx,
            DecisionBriefV1,
            {"decision_frame_json": _json(frame), "critique_json": _json(critique), "evidence_json": "[]"},
        )
        content = (
            f"Recommendation: {brief.recommendation.summary}\n\n"
            f"Confidence: {brief.confidence.level}. {brief.confidence.explanation}"
        )
        return self._result(stage, "Decision brief", content, brief, DECISION_BRIEF_SCHEMA_VERSION, [])

    # --- helpers --------------------------------------------------------------------

    def _result(
        self, stage: Stage, title: str, content: str, data: BaseModel, schema: str, limitations: list[str]
    ) -> StageResult:
        output = StageOutputV2(
            stage=stage,
            title=title,
            content=content[:20_000],
            limitations=limitations,
            data_schema=schema,
            data=data.model_dump(mode="json"),
        )
        return StageResult(output=output)

    @staticmethod
    def _previous[M: BaseModel](ctx: StageContext, stage: Stage, model: type[M], schema: str) -> M:
        output = ctx.previous.get(stage)
        if not isinstance(output, StageOutputV2) or output.data_schema != schema or output.data is None:
            raise ReasoningModeMismatchError(f"{stage} checkpoint has no {schema} data")
        try:
            return model.model_validate(output.data)
        except ValidationError as error:
            raise ReasoningModeMismatchError(f"{stage} checkpoint data is invalid") from error

    def _generate[M: BaseModel](self, stage: Stage, ctx: StageContext, model: type[M], inputs: dict[str, str]) -> M:
        prompt = self.prompts[stage]
        schema_name = prompt.meta.output_schema
        deadline = time.monotonic() + ctx.timeout_seconds
        note: str | None = None
        for attempt in range(MAX_REPAIR_ATTEMPTS + 1):
            repair = attempt > 0
            rendered = render(prompt, inputs, repair_note=note)
            request = ModelRequest(
                instructions=rendered.instructions,
                data=rendered.data,
                schema_name=schema_name.replace(".", "_").replace("-", "_"),
                json_schema=self._schemas[schema_name],
                max_output_tokens=self.settings.max_output_tokens,
                timeout_seconds=max(1.0, deadline - time.monotonic()),
            )
            self._preflight(ctx, request)
            try:
                reply = self.client.generate(request)
            except ModelCallError as failure:
                self._record(ctx, stage, prompt, repair, "error", failure.error.code, failure.usage, failure.latency_ms)
                raise failure.error from failure

            if reply.status == "refused":
                self._record_reply(ctx, stage, prompt, repair, "refused", ProviderRefusedError.code, reply)
                raise ProviderRefusedError("model refused")
            if reply.status == "truncated":
                self._record_reply(ctx, stage, prompt, repair, "truncated", ProviderOutputTruncatedError.code, reply)
                raise ProviderOutputTruncatedError("model output hit max_output_tokens")
            try:
                parsed = model.model_validate_json(reply.text)
                check_citations(parsed, frozenset())  # M4: no evidence is ever supplied
            except (ValidationError, CitationError) as error:
                last = attempt == MAX_REPAIR_ATTEMPTS
                code = InvalidProviderOutputError.code
                self._record_reply(ctx, stage, prompt, repair, "invalid_output", code, reply)
                if last:
                    raise InvalidProviderOutputError("output failed its contract after repair") from None
                note = repair_note(error)
                continue
            self._record_reply(ctx, stage, prompt, repair, "ok", None, reply)
            return parsed
        raise AssertionError("unreachable")

    def _preflight(self, ctx: StageContext, request: ModelRequest) -> None:
        remaining = ctx.remaining_cost_usd - ctx.spent_usd()
        worst = self.prices.worst_case(self.client.model, request, self.settings.residency)
        if ctx.remaining_cost_usd <= 0 or worst > remaining:
            raise BudgetPreflightError("worst-case call cost exceeds the remaining spend cap")

    def _record_reply(
        self,
        ctx: StageContext,
        stage: Stage,
        prompt: Prompt,
        repair: bool,
        outcome: CallOutcome,
        code: str | None,
        reply: ModelReply,
    ) -> None:
        self._record(ctx, stage, prompt, repair, outcome, code, reply.usage, reply.latency_ms, reply.model)

    def _record(
        self,
        ctx: StageContext,
        stage: Stage,
        prompt: Prompt,
        repair: bool,
        outcome: CallOutcome,
        code: str | None,
        usage: TokenUsage,
        latency_ms: int,
        model: str | None = None,
    ) -> None:
        ctx.calls.append(
            ModelCallRecord(
                stage=stage,
                provider=self.client.provider,
                model=(model or self.client.model)[:100],
                prompt_id=prompt.meta.id,
                prompt_version=prompt.meta.version,
                prompt_sha256=prompt.sha256,
                output_schema=prompt.meta.output_schema,
                repair=repair,
                outcome=outcome,
                error_code=code,
                input_tokens=usage.input_tokens,
                cached_input_tokens=usage.cached_input_tokens,
                output_tokens=usage.output_tokens,
                reasoning_tokens=usage.reasoning_tokens,
                # Priced by the configured model: the response may name a dated snapshot.
                cost_usd=self.prices.cost(self.client.model, usage, self.settings.residency),
                latency_ms=latency_ms,
            )
        )


def describe(provider: Any) -> str:  # noqa: ANN401 - any ReasoningProvider
    return str(getattr(provider, "label", None) or getattr(provider, "name", "unknown"))
