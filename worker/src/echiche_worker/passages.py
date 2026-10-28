"""Deterministic passage selection and quote checking (no embeddings, no vector store).

A fetched page is split into passages of at most PASSAGE_CHARS characters on paragraph and
sentence boundaries, scored by overlap with the run's search queries and research questions,
and the best few are kept. Only those short passages are stored and shown to the model, so
excerpts stay small and every quote can be checked against exactly what the model saw.
"""

from __future__ import annotations

import math
import re
import unicodedata

PASSAGE_CHARS = 500
PASSAGES_PER_SOURCE = 3
_WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_STOP = frozenset(
    "a an and are as at be but by can could did do does for from had has have how if in into is it its "
    "may might more most no not of on or our should so than that the their them then there these they this "
    "to was we were what when where which who why will with would you your".split()
)


def terms(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if len(w) > 2 and w not in _STOP]


def split_passages(text: str, size: int = PASSAGE_CHARS) -> list[str]:
    passages: list[str] = []
    for paragraph in (p.strip() for p in text.split("\n")):
        if not paragraph:
            continue
        pieces = [paragraph] if len(paragraph) <= size else _SENTENCE.split(paragraph)
        current = ""
        for piece in pieces:
            while len(piece) > size:  # a single very long sentence: hard cut on a word boundary
                cut = piece.rfind(" ", 0, size)
                cut = cut if cut > size // 2 else size
                if current:
                    passages.append(current)
                    current = ""
                passages.append(piece[:cut].strip())
                piece = piece[cut:].strip()
            if not piece:
                continue
            if current and len(current) + 1 + len(piece) > size:
                passages.append(current)
                current = piece
            else:
                current = f"{current} {piece}".strip()
        if current:
            passages.append(current)
    return [p for p in passages if len(p) >= 40]


def select_passages(text: str, focus: str, limit: int = PASSAGES_PER_SOURCE) -> list[str]:
    """Top passages by query-term overlap (BM25-like saturation, length-normalised), in page order.
    Returns [] when nothing on the page overlaps the focus terms: the page is irrelevant."""
    wanted = set(terms(focus))
    if not wanted:
        return []
    scored: list[tuple[float, int, str]] = []
    for index, passage in enumerate(split_passages(text)):
        words = terms(passage)
        if not words:
            continue
        counts = {w: words.count(w) for w in wanted if w in words}
        if not counts:
            continue
        score = sum(c * 2.2 / (c + 1.2) for c in counts.values()) * len(counts) / math.sqrt(len(words))
        scored.append((score, index, passage))
    best = sorted(scored, key=lambda item: (-item[0], item[1]))[:limit]
    return [passage for _score, _index, passage in sorted(best, key=lambda item: item[1])]


def normalise(text: str) -> str:
    """For quote matching: NFKC, unified quotes and dashes, collapsed whitespace, case-folded."""
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(
        str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-"})
    )
    return " ".join(text.split()).casefold()


def quote_in(quote: str, passage: str) -> bool:
    q = normalise(quote).strip(" .\"'")
    return len(q) >= 12 and q in normalise(passage)
