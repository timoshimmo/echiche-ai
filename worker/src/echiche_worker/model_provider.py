"""Model-backed reasoning provider (M4 ADR-007; research and verification M5 ADR-008).

Stage plan:
  planning      -> model: decision-framing -> decision-frame.v1
  researching   -> model: research-planner -> queries; Brave discovery; the worker fetches pages
                   itself -> evidence-set.v1 (sources S1..Sn with passages). Without a research
                   provider: skipped, with an explicit limitation.
  critiquing    -> model: decision-critic (sees the evidence passages) -> critique.v1
  verifying     -> model: claim-extractor -> claims with exact quotes; deterministic quote check;
                   model: decision-verifier (independent) -> verification-report.v1
  synthesizing  -> model: decision-brief-synthesis (sees verified claims only) -> decision-brief.v1,
                   guarded: citations only to sources backing verified claims; "high" confidence
                   only with verified support from two or more domains.

Every model call:
  1. renders a reviewed prompt from the registry; user and web content only in fenced data blocks;
  2. checks the worst-case cost against the run's remaining spend cap (else BUDGET_COST);
  3. validates the output against its Pydantic contract plus deterministic guards;
  4. on an invalid output, makes exactly one repair attempt, then fails;
  5. appends a ModelCallRecord (tokens, cost, latency, prompt id/version/hash; no content).
"""

from __future__ import annotations

import dataclasses
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

from pydantic import BaseModel, ValidationError

from echiche_worker.contracts import (
    CRITIQUE_SCHEMA_VERSION,
    DECISION_BRIEF_SCHEMA_VERSION,
    DECISION_FRAME_SCHEMA_VERSION,
    DECISION_FRAME_V2_SCHEMA_VERSION,
    EVIDENCE_SET_SCHEMA_VERSION,
    MODEL_OUTPUTS,
    VERIFICATION_REPORT_SCHEMA_VERSION,
    ClaimSetV1,
    ClaimVerificationV1,
    CritiqueV1,
    DecisionBriefV1,
    DecisionFrameV1,
    DecisionFrameV2,
    EvidenceSetV1,
    ResearchPlanV1,
    Stage,
    StageOutputV2,
    VerificationReportV1,
)
from echiche_worker.llm import ModelCallError, ModelClient, ModelReply, ModelRequest, PriceTable, TokenUsage
from echiche_worker.memory import context_json, select_context
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
from echiche_worker.research_pipeline import (
    GuardError,
    ResearchSettings,
    build_report,
    check_claim_set,
    check_judgments,
    claims_for_verifier,
    evidence_for_model,
    gather_evidence,
    quote_checked,
    usable_evidence,
)
from echiche_worker.routing import RouteSettings, escalation_reasons

MAX_REPAIR_ATTEMPTS = 1
NOT_RUN_CRITIQUE = json.dumps(
    {
        "not_run": "This run's route did not include a separate critique. Name the strongest objection yourself and "
        "say in limitations that no independent critique was run."
    }
)
PROMPT_IDS = (
    "decision-framing",
    "research-planner",
    "decision-critic",
    "claim-extractor",
    "decision-verifier",
    "decision-brief-synthesis",
)


class ReasoningModeMismatchError(ProviderError):
    """A checkpoint from an earlier stage was not produced by the model pipeline
    (e.g. the worker was switched from demo mode mid-run)."""

    code = "REASONING_MODE_MISMATCH"


CitationError = GuardError


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
        raise GuardError(
            f"{len(bad)} cited source ID(s) were not supplied: only source IDs present in the evidence data "
            "may be cited; if the evidence is empty, citations and every source_ids list must be empty"
        )


def check_memory_refs(frame: DecisionFrameV2, refs: frozenset[str]) -> None:
    """The model may only point at remembered items it was given (no invented recall)."""
    unknown = sorted({c.ref for c in frame.memory_conflicts if c.ref not in refs})
    if unknown:
        listed = ", ".join(unknown[:8])
        raise GuardError(
            f"memory_conflicts refers to {listed}, which were not supplied: use only refs from the remembered "
            "items; if none were supplied, memory_conflicts must be empty"
        )


def check_brief(brief: DecisionBriefV1, allowed: dict[str, str]) -> None:
    """Citation guard plus the confidence rule (ADR-008): 'high' needs verified support
    from at least two independent domains among the sources the brief cites."""
    check_citations(brief, frozenset(allowed))
    if brief.confidence.level == "high":
        cited = {c.source_id for c in brief.citations} | {
            sid for point in brief.supporting_evidence for sid in point.source_ids
        }
        domains = {allowed[sid] for sid in cited if sid in allowed}
        if len(domains) < 2:
            raise GuardError(
                "confidence.level: high requires cited, verified support from at least two independent "
                "sources (different domains); lower the confidence or explain the limitation"
            )


def repair_note(error: ValidationError | GuardError) -> str:
    """Names failing JSON paths, IDs and rule messages only; never echoes the model's content."""
    lines = [
        "Your previous output did not satisfy the required contract. Fix these problems and return the full output:"
    ]
    if isinstance(error, GuardError):
        lines.append(f"- {error.note}")
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


def research_for(research: ResearchSettings, route: RouteSettings) -> ResearchSettings:
    """The operator's research settings, tightened (never loosened) by the run's tier."""
    return dataclasses.replace(
        research,
        max_queries=min(research.max_queries, route.max_queries if route.max_queries is not None else 99),
        max_pages=min(research.max_pages, route.max_pages if route.max_pages is not None else 99),
    )


class ModelReasoningProvider:
    name = "model"

    def __init__(
        self,
        client: ModelClient,
        registry: PromptRegistry,
        prices: PriceTable,
        settings: ModelSettings,
        research: ResearchSettings | None = None,
        escalation: ModelClient | None = None,
    ) -> None:
        self.client = client
        self.escalation = escalation
        self.prices = prices
        self.settings = settings
        self.research = research
        prices.price(client.model)  # unknown model -> KeyError at start-up, never at run time
        if escalation is not None:
            prices.price(escalation.model)
        self.prompts: dict[str, Prompt] = {}
        for prompt_id in PROMPT_IDS:
            prompt = registry.get(prompt_id)
            if prompt.meta.output_schema not in MODEL_OUTPUTS:
                raise ValueError(f"{prompt.ref}: output schema has no contract")
            self.prompts[prompt_id] = prompt
        self._schemas = {name: strict_schema(model) for name, model in MODEL_OUTPUTS.items()}

    @property
    def label(self) -> str:
        research = f"+{self.research.search.provider}" if self.research else ""
        return f"{self.client.provider}:{self.client.model}{research}"

    # --- stages ---------------------------------------------------------------------

    def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
        deadline = time.monotonic() + ctx.timeout_seconds
        if stage == "planning":
            return self._planning(ctx, deadline)
        frame = self._frame(ctx)
        if stage == "researching":
            return self._researching(ctx, frame, deadline)
        evidence = self._evidence(ctx)
        if stage == "critiquing":
            critique = self._generate(
                "decision-critic",
                stage,
                ctx,
                CritiqueV1,
                {"decision_frame_json": _json(frame), "evidence_json": evidence_for_model(evidence)},
                deadline,
            )
            content = (
                f"Strongest objection: {critique.strongest_objection}\n\n"
                f"Missing evidence:\n{_bullets(critique.missing_evidence)}"
            )
            return self._result(stage, "Critique", content, critique, CRITIQUE_SCHEMA_VERSION, [])
        critique = self._optional(ctx, "critiquing", CritiqueV1, CRITIQUE_SCHEMA_VERSION)
        if stage == "verifying":
            return self._verifying(ctx, frame, evidence, deadline)
        report = self._report(ctx)
        evidence_json, allowed = usable_evidence(report, evidence)
        client, escalation = self._synthesis_client(ctx, critique, report)
        brief = self._generate(
            "decision-brief-synthesis",
            stage,
            ctx,
            DecisionBriefV1,
            {
                "decision_frame_json": _json(frame),
                "critique_json": _json(critique) if critique is not None else NOT_RUN_CRITIQUE,
                "evidence_json": evidence_json,
                "project_memory_json": context_json(ctx.run_memory),
            },
            deadline,
            check=lambda b: check_brief(b, allowed),
            client=client,
        )
        content = (
            f"Recommendation: {brief.recommendation.summary}\n\n"
            f"Confidence: {brief.confidence.level}. {brief.confidence.explanation}"
        )
        result = self._result(stage, "Decision brief", content, brief, DECISION_BRIEF_SCHEMA_VERSION, [])
        return dataclasses.replace(result, escalation=escalation)

    def _synthesis_client(
        self, ctx: StageContext, critique: CritiqueV1 | None, report: VerificationReportV1 | None
    ) -> tuple[ModelClient, str | None]:
        """High tier only: a stronger model for synthesis when a configured trigger fired (ADR-010).
        The outcome is always recorded, including when escalation was justified but not possible."""
        fired = escalation_reasons(ctx.route, critique, report)
        if not fired:
            return self.client, None
        why = ", ".join(fired)
        if self.escalation is None:
            return self.client, f"escalation triggered ({why}) but no escalation model is configured"
        worst = self.prices.worst_case(self.escalation.model, self._probe_request(), self.settings.residency)
        if worst > ctx.remaining_cost_usd - ctx.spent_usd():
            return self.client, f"escalation triggered ({why}) but skipped: it would exceed the remaining spend cap"
        return self.escalation, f"synthesis escalated to {self.escalation.model} ({why})"

    def _probe_request(self) -> ModelRequest:
        """A size estimate for the escalation preflight; the real call is preflighted again."""
        prompt = self.prompts["decision-brief-synthesis"]
        return ModelRequest(
            instructions=prompt.instructions,
            data="x" * 60_000,
            schema_name="probe",
            json_schema={},
            max_output_tokens=self.settings.max_output_tokens,
            timeout_seconds=1.0,
        )

    def _planning(self, ctx: StageContext, deadline: float) -> StageResult:
        memory = ctx.run_memory or select_context(ctx.project_memories, ctx.project_decision, ctx.prompt)
        refs = frozenset(i.ref for i in memory)
        frame = self._generate(
            "decision-framing",
            "planning",
            ctx,
            DecisionFrameV2,
            {
                "project_context": ctx.project_context,
                "question": ctx.prompt,
                "project_memory_json": context_json(memory),
            },
            deadline,
            check=lambda f: check_memory_refs(f, refs),
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
        result = self._result(
            "planning", "Decision frame", content, frame, DECISION_FRAME_V2_SCHEMA_VERSION, limitations
        )
        return StageResult(output=result.output, memory_context=memory)

    def _frame(self, ctx: StageContext) -> DecisionFrameV2:
        """decision-frame.v2, or a v1 checkpoint from before M6 (read as having no conflicts)."""
        output = ctx.previous.get("planning")
        if getattr(output, "data_schema", None) == DECISION_FRAME_SCHEMA_VERSION:
            v1 = self._previous(ctx, "planning", DecisionFrameV1, DECISION_FRAME_SCHEMA_VERSION)
            return DecisionFrameV2.model_validate({**v1.model_dump(), "memory_conflicts": []})
        return self._previous(ctx, "planning", DecisionFrameV2, DECISION_FRAME_V2_SCHEMA_VERSION)

    def _researching(self, ctx: StageContext, frame: DecisionFrameV2, deadline: float) -> StageResult:
        if self.research is None:
            return StageResult(
                output=StageOutputV2(
                    stage="researching", title="Research skipped", content=NO_RESEARCH, limitations=[NO_RESEARCH]
                )
            )

        def plan(limit: int) -> list[str]:
            limits = json.dumps({"max_queries": limit})
            result = self._generate(
                "research-planner",
                "researching",
                ctx,
                ResearchPlanV1,
                {"decision_frame_json": _json(frame), "limits_json": limits},
                deadline,
            )
            return [q.query for q in result.queries][:limit]

        evidence, searches = gather_evidence(research_for(self.research, ctx.route), ctx, frame, plan, deadline)
        reads = "\n".join(f"- {s.source_id}: {s.title} ({s.domain})" for s in evidence.sources) or "- none"
        content = (
            f"Searches: {len(evidence.searches)} · sources read and kept: {len(evidence.sources)} · "
            f"skipped: {len(evidence.skipped)}\n\nSources:\n{reads}"
        )
        result = self._result(
            "researching", "Research", content, evidence, EVIDENCE_SET_SCHEMA_VERSION, list(evidence.limitations)
        )
        return StageResult(output=result.output, research_calls=searches)

    def _verifying(
        self, ctx: StageContext, frame: DecisionFrameV2, evidence: EvidenceSetV1 | None, deadline: float
    ) -> StageResult:
        if evidence is None or not evidence.sources:
            note = "No sources were read, so there were no claims to verify."
            return StageResult(
                output=StageOutputV2(stage="verifying", title="Verification", content=note, limitations=[note])
            )
        claims = self._generate(
            "claim-extractor",
            "verifying",
            ctx,
            ClaimSetV1,
            {"decision_frame_json": _json(frame), "evidence_json": evidence_for_model(evidence)},
            deadline,
            check=lambda c: check_claim_set(c, evidence),
        )
        found = {(cid, pid) for cid, pid, ok in quote_checked(claims, evidence) if ok}
        judgments: ClaimVerificationV1 | None = None
        if found:
            judgments = self._generate(
                "decision-verifier",
                "verifying",
                ctx,
                ClaimVerificationV1,
                {"claims_json": claims_for_verifier(claims, evidence, found)},
                deadline,
                check=lambda j: check_judgments(j, found),
            )
        stale_days = self.research.stale_days if self.research else 730
        report = build_report(claims, evidence, found, judgments, stale_days)
        counts = {
            s: sum(1 for c in report.claims if c.status == s) for s in ("verified", "partial", "unsupported", "invalid")
        }
        content = (
            f"Claims checked: {len(report.claims)} · verified {counts['verified']} · partial {counts['partial']} · "
            f"unsupported {counts['unsupported']} · discarded (quote not found) {counts['invalid']}"
        )
        return self._result(
            "verifying", "Verification", content, report, VERIFICATION_REPORT_SCHEMA_VERSION, list(report.limitations)
        )

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

    @staticmethod
    def _optional[M: BaseModel](ctx: StageContext, stage: Stage, model: type[M], schema: str) -> M | None:
        output = ctx.previous.get(stage)
        data = getattr(output, "data", None)
        if getattr(output, "data_schema", None) != schema or data is None:
            return None
        try:
            return model.model_validate(data)
        except ValidationError as error:
            raise ReasoningModeMismatchError(f"{stage} checkpoint data is invalid") from error

    def _evidence(self, ctx: StageContext) -> EvidenceSetV1 | None:
        return self._optional(ctx, "researching", EvidenceSetV1, EVIDENCE_SET_SCHEMA_VERSION)

    def _report(self, ctx: StageContext) -> VerificationReportV1 | None:
        return self._optional(ctx, "verifying", VerificationReportV1, VERIFICATION_REPORT_SCHEMA_VERSION)

    def _generate[M: BaseModel](
        self,
        prompt_id: str,
        stage: Stage,
        ctx: StageContext,
        model: type[M],
        inputs: dict[str, str],
        deadline: float,
        check: Callable[[M], None] | None = None,
        client: ModelClient | None = None,
    ) -> M:
        client = client or self.client
        prompt = self.prompts[prompt_id]
        schema_name = prompt.meta.output_schema
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
            self._preflight(ctx, request, client)
            try:
                reply = client.generate(request)
            except ModelCallError as failure:
                self._record(
                    ctx,
                    stage,
                    prompt,
                    repair,
                    "error",
                    failure.error.code,
                    failure.usage,
                    failure.latency_ms,
                    client=client,
                )
                raise failure.error from failure

            if reply.status == "refused":
                self._record_reply(ctx, stage, prompt, repair, "refused", ProviderRefusedError.code, reply, client)
                raise ProviderRefusedError("model refused")
            if reply.status == "truncated":
                self._record_reply(
                    ctx, stage, prompt, repair, "truncated", ProviderOutputTruncatedError.code, reply, client
                )
                raise ProviderOutputTruncatedError("model output hit max_output_tokens")
            try:
                parsed = model.model_validate_json(reply.text)
                if check is not None:
                    check(parsed)
                else:
                    check_citations(parsed, frozenset())  # nothing citable was supplied to this prompt
            except (ValidationError, GuardError) as error:
                last = attempt == MAX_REPAIR_ATTEMPTS
                code = InvalidProviderOutputError.code
                self._record_reply(ctx, stage, prompt, repair, "invalid_output", code, reply, client)
                if last:
                    raise InvalidProviderOutputError("output failed its contract after repair") from None
                note = repair_note(error)
                continue
            self._record_reply(ctx, stage, prompt, repair, "ok", None, reply, client)
            return parsed
        raise AssertionError("unreachable")

    def _preflight(self, ctx: StageContext, request: ModelRequest, client: ModelClient) -> None:
        remaining = ctx.remaining_cost_usd - ctx.spent_usd()
        worst = self.prices.worst_case(client.model, request, self.settings.residency)
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
        client: ModelClient,
    ) -> None:
        self._record(ctx, stage, prompt, repair, outcome, code, reply.usage, reply.latency_ms, reply.model, client)

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
        client: ModelClient | None = None,
    ) -> None:
        client = client or self.client
        ctx.calls.append(
            ModelCallRecord(
                stage=stage,
                provider=client.provider,
                model=(model or client.model)[:100],
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
                cost_usd=self.prices.cost(client.model, usage, self.settings.residency),
                latency_ms=latency_ms,
            )
        )


def describe(provider: Any) -> str:  # noqa: ANN401 - any ReasoningProvider
    return str(getattr(provider, "label", None) or getattr(provider, "name", "unknown"))
