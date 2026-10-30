"""Files and links a user attached to a question (ADR-012).

The web app has already turned documents into text. The worker finishes the job for the two kinds the
web app cannot read safely: images (read by the model, which needs the API key only the worker holds)
and links (fetched with the SSRF-safe, robots-respecting PageFetcher). Then every readable attachment
is given to the framing, critique and synthesis prompts as untrusted, user-supplied data.

Attachment text is model input only. It is never written to logs, events or stage outputs.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from echiche_worker.fetch import PageFetcher
    from echiche_worker.provider import ResearchCallRecord

MAX_TEXT_CHARS = 15_000  # per attachment (matches the database check)
TOTAL_TEXT_CHARS = 30_000  # across one run's attachments, so every model call stays within budget
NOTE_CHARS = 300

LINK_NOTES: dict[str, str] = {
    "blocked_robots": "The site asks automated tools not to read this page.",
    "blocked_publisher": "The site asks AI tools not to use or archive this page.",
    "blocked_address": "That address isn't a public website.",
    "unsupported_url": "That link can't be read (only public https web pages).",
    "unsupported_type": (
        "Only web pages (HTML or plain text) can be read from a link. Attach PDFs and documents as files."
    ),
    "too_large": "The page is too large to read.",
    "http_error": "The page returned an error or could not be found.",
    "timeout": "The site took too long to respond.",
    "fetch_error": "The site couldn't be reached.",
    "no_text": "The page had no readable text.",
}
DEMO_NOTE = "Not read: demo mode has no AI model, so images and links can't be read."


@dataclass(frozen=True, slots=True)
class Attachment:
    id: str
    position: int
    kind: str  # text | pdf | word | spreadsheet | image | link
    name: str
    status: str  # ready | pending | failed
    text: str | None = None
    truncated: bool = False
    note: str | None = None
    url: str | None = None
    media_type: str | None = None
    image: bytes | None = None

    @property
    def ref(self) -> str:
        return f"A{self.position}"


@dataclass(frozen=True, slots=True)
class AttachmentRead:
    """The worker's result for one pending attachment, persisted with the planning checkpoint."""

    id: str
    status: Literal["ready", "failed"]
    text: str | None
    truncated: bool
    note: str | None


def tidy(raw: str, limit: int = MAX_TEXT_CHARS) -> tuple[str, bool]:
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return (text[:limit], True) if len(text) > limit else (text, False)


def failed(attachment: Attachment, note: str) -> AttachmentRead:
    return AttachmentRead(id=attachment.id, status="failed", text=None, truncated=False, note=note[:NOTE_CHARS])


def read_link(fetcher: PageFetcher, attachment: Attachment) -> tuple[AttachmentRead, list[ResearchCallRecord]]:
    """Fetches a link the user supplied. The fetcher re-validates it (https, public address, robots)."""
    if attachment.url is None:
        return failed(attachment, LINK_NOTES["fetch_error"]), []
    result = fetcher.fetch(attachment.url)
    if result.status != "ok" or result.page is None:
        return failed(attachment, LINK_NOTES.get(result.status, LINK_NOTES["fetch_error"])), result.records
    title = result.page.title.strip()
    text, truncated = tidy(f"{title}\n\n{result.page.text}" if title else result.page.text)
    if not text:
        return failed(attachment, LINK_NOTES["no_text"]), result.records
    note = "Only the first part of the page was used (it is long)." if truncated else None
    return AttachmentRead(id=attachment.id, status="ready", text=text, truncated=truncated, note=note), result.records


def image_data_url(attachment: Attachment) -> str:
    if attachment.image is None or attachment.media_type is None:
        raise ValueError("not an unread image attachment")
    return f"data:{attachment.media_type};base64,{base64.b64encode(attachment.image).decode('ascii')}"


def apply_reads(attachments: tuple[Attachment, ...], reads: list[AttachmentRead]) -> tuple[Attachment, ...]:
    by_id = {r.id: r for r in reads}
    out: list[Attachment] = []
    for a in attachments:
        r = by_id.get(a.id)
        if r is None:
            out.append(a)
        else:
            out.append(replace(a, status=r.status, text=r.text, truncated=r.truncated, note=r.note, image=None))
    return tuple(out)


def attachments_json(attachments: tuple[Attachment, ...]) -> str:
    """The prompt input: readable attachments in order, within the run's total text budget, plus a
    line for each one that could not be read (so the model can say what it did not see)."""
    items: list[dict[str, object]] = []
    budget = TOTAL_TEXT_CHARS
    for a in sorted(attachments, key=lambda x: x.position):
        entry: dict[str, object] = {"ref": a.ref, "name": a.name, "kind": a.kind}
        if a.status == "ready" and a.text:
            text = a.text[: max(0, budget)]
            budget -= len(text)
            entry["text"] = text
            entry["truncated"] = a.truncated or len(text) < len(a.text)
            if not text:
                entry = {**entry, "text": "", "unread": "Left out: the attachments together exceed the reading limit."}
        else:
            entry["unread"] = a.note or "This attachment could not be read."
        items.append(entry)
    return json.dumps(items, ensure_ascii=False, indent=1) if items else "[]"


def limitations(attachments: tuple[Attachment, ...]) -> list[str]:
    """User-facing lines for the brief's limitations: which attachments were not (fully) used."""
    lines: list[str] = []
    for a in sorted(attachments, key=lambda x: x.position):
        if a.status != "ready":
            lines.append(f"Attachment “{a.name}” was not used: {a.note or 'it could not be read.'}")
        elif a.truncated:
            lines.append(f"Only the first part of attachment “{a.name}” was used.")
    return lines
