"""ADR-012: files and links attached to a question (worker side)."""

import dataclasses
import json
from decimal import Decimal
from typing import Any

from echiche_worker.attachments import (
    TOTAL_TEXT_CHARS,
    Attachment,
    apply_reads,
    attachments_json,
    limitations,
    read_link,
)
from echiche_worker.contracts import STAGES, Stage, StageOutput
from echiche_worker.fetch import FetchedPage, FetchResult
from echiche_worker.llm import IMAGE_TOKEN_BOUND, OPENAI_PRICES, ModelRequest
from echiche_worker.model_provider import ModelReasoningProvider, ModelSettings
from echiche_worker.prompts import PromptRegistry
from echiche_worker.provider import DeterministicProvider, ProviderRefusedError, StageContext

from .model_fakes import FakeModelClient, reply

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4e00000000049454e44ae426082"
)


def doc(position: int, text: str | None = "Runway is 14 months.", **kw: Any) -> Attachment:
    base: dict[str, Any] = {
        "id": f"id{position}",
        "position": position,
        "kind": "pdf",
        "name": f"file{position}.pdf",
        "status": "ready",
        "text": text,
    }
    return Attachment(**(base | kw))


class FakeFetcher:
    def __init__(self, result: FetchResult) -> None:
        self.result = result
        self.urls: list[str] = []

    def fetch(self, url: str) -> FetchResult:
        self.urls.append(url)
        return self.result


def page(text: str) -> FetchResult:
    return FetchResult(
        status="ok",
        domain="example.org",
        page=FetchedPage(
            url="https://example.org/a",
            domain="example.org",
            title="Market notes",
            publisher=None,
            published_at=None,
            text=text,
            content_sha256="0" * 64,
        ),
    )


def provider(client: FakeModelClient, fetcher: FakeFetcher | None = None) -> ModelReasoningProvider:
    return ModelReasoningProvider(
        client,
        PromptRegistry.load(),
        OPENAI_PRICES,
        ModelSettings(residency="global", max_output_tokens=4000),
        link_fetcher=fetcher,  # type: ignore[arg-type]
    )


def ctx(attachments: tuple[Attachment, ...], previous: dict[Stage, StageOutput] | None = None) -> StageContext:
    return StageContext(
        run_id="r",
        prompt="Should we open a second office?",
        previous=previous or {},
        timeout_seconds=30,
        remaining_cost_usd=Decimal("1.00"),
        attachments=attachments,
    )


def block(data: str, name: str) -> str:
    return data.split(f'<untrusted name="{name}">\n', 1)[1].split("\n</untrusted>", 1)[0]


def test_prompt_input_lists_readable_attachments_within_the_total_budget_and_names_the_unread_ones() -> None:
    items = (
        doc(1, "a" * 20_000),
        doc(2, "b" * 20_000),
        doc(3, status="failed", text=None, note="No readable text found."),
    )
    data = json.loads(attachments_json(items))
    assert [d["ref"] for d in data] == ["A1", "A2", "A3"]
    assert len(data[0]["text"]) + len(data[1]["text"]) == TOTAL_TEXT_CHARS
    assert data[1]["truncated"] is True
    assert data[2] == {"ref": "A3", "name": "file3.pdf", "kind": "pdf", "unread": "No readable text found."}
    assert attachments_json(()) == "[]"
    assert limitations(items[2:]) == ["Attachment “file3.pdf” was not used: No readable text found."]


def test_links_are_read_with_the_safe_fetcher_and_failures_explained() -> None:
    link = Attachment(
        id="L", position=1, kind="link", name="example.org/a", status="pending", url="https://example.org/a"
    )
    fetcher = FakeFetcher(page("Demand for local support grew."))
    read, _ = read_link(fetcher, link)  # type: ignore[arg-type]
    assert fetcher.urls == ["https://example.org/a"]
    assert read.status == "ready" and read.text == "Market notes\n\nDemand for local support grew."
    blocked, _ = read_link(FakeFetcher(FetchResult(status="blocked_robots", domain="example.org")), link)  # type: ignore[arg-type]
    assert blocked.status == "failed" and blocked.note == "The site asks automated tools not to read this page."


def test_planning_reads_images_and_links_once_then_every_stage_sees_the_attachments() -> None:
    def read_image(request: ModelRequest):
        assert request.images and request.images[0].startswith("data:image/png;base64,")
        assert "SYSTEM" not in request.instructions
        return reply(json.dumps({"readable": True, "content": "Whiteboard: Option A | Option B. Cost 1,200 vs 900."}))

    client = FakeModelClient(script={"attachment_reading_v1": [read_image]})
    image = Attachment(
        id="I", position=2, kind="image", name="board.png", status="pending", media_type="image/png", image=PNG
    )
    link = Attachment(
        id="L", position=3, kind="link", name="example.org/a", status="pending", url="https://example.org/a"
    )
    attachments = (doc(1), image, link)
    p = provider(client, FakeFetcher(page("Local demand grew.")))

    outputs: dict[Stage, StageOutput] = {}
    for stage in STAGES:
        c = ctx(attachments, dict(outputs))
        result = p.run_stage(stage, c)
        outputs[stage] = result.output
        if stage == "planning":
            assert {r.id: r.status for r in result.attachment_reads} == {"I": "ready", "L": "ready"}
            assert [call.prompt_id for call in c.calls] == ["attachment-reader", "decision-framing"]
            attachments = apply_reads(attachments, result.attachment_reads)
            assert attachments[1].image is None  # bytes dropped once read

    schemas = [r.schema_name for r in client.requests]
    assert schemas == ["attachment_reading_v1", "decision_frame_v2", "critique_v1", "decision_brief_v1"]
    for request in client.requests[1:]:
        given = json.loads(block(request.data, "attachments_json"))
        assert [a["ref"] for a in given] == ["A1", "A2", "A3"]
        assert given[1]["text"].startswith("Whiteboard") and given[2]["text"].startswith("Market notes")
        assert "Runway is 14 months." not in request.instructions  # attachment text only ever in the data
    # The text of attachments never appears in what is stored for the stage.
    assert "Runway is 14 months." not in json.dumps(outputs["planning"].model_dump(mode="json"))


def test_an_unreadable_image_is_noted_without_failing_the_run() -> None:
    client = FakeModelClient(script={"attachment_reading_v1": [reply("", status="refused")]})
    image = Attachment(
        id="I", position=1, kind="image", name="x.png", status="pending", media_type="image/png", image=PNG
    )
    result = provider(client).run_stage("planning", ctx((image,)))
    assert result.attachment_reads[0].status == "failed"
    assert result.attachment_reads[0].note == "The image couldn't be read by the AI model."
    assert result.output.limitations[-1].startswith("Attachment “x.png” was not used")
    assert ProviderRefusedError.code == "PROVIDER_REFUSED"


def test_links_are_not_read_without_a_fetcher_and_demo_mode_reads_nothing() -> None:
    link = Attachment(id="L", position=1, kind="link", name="example.org", status="pending", url="https://example.org/")
    result = provider(FakeModelClient()).run_stage("planning", ctx((link,)))
    assert result.attachment_reads[0].status == "failed"
    demo = DeterministicProvider().run_stage("planning", ctx((doc(2), link)))
    assert [r.id for r in demo.attachment_reads] == ["L"] and demo.attachment_reads[0].status == "failed"
    assert any("Demo mode" in line for line in demo.output.limitations)


def test_worst_case_preflight_counts_images() -> None:
    base = ModelRequest(
        instructions="i", data="d", schema_name="s", json_schema={}, max_output_tokens=10, timeout_seconds=1
    )
    request = dataclasses.replace(base, images=("data:image/png;base64,AA==",))
    extra = OPENAI_PRICES.worst_case("gpt-6.1-sol", request, "global") - OPENAI_PRICES.worst_case(
        "gpt-6.1-sol", base, "global"
    )
    assert extra >= Decimal(IMAGE_TOKEN_BOUND) * Decimal(2) / Decimal(1_000_000)
