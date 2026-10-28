"""Test doubles for research: a local multi-host fixture website, a scripted search client,
and model replies that react to the evidence actually supplied in the request."""

from __future__ import annotations

import json
import re
import shutil
import ssl
import subprocess
import threading
import time
from collections.abc import Callable
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from echiche_worker.fetch import PageFetcher
from echiche_worker.llm import ModelReply, ModelRequest
from echiche_worker.provider import ResearchCallRecord
from echiche_worker.research import SearchCallError, SearchHit, SearchResult

from .model_fakes import VALID, reply

PAGES = Path(__file__).resolve().parent / "fixtures" / "research"
HOSTS = {
    "survey.test": "/clinic-survey.html",
    "pilots.test": "/pilot-study.html",
    "forum.test": "/contrarian.html",
    "archive.test": "/stale.html",
    "pricing.test": "/injection.html",
    "members.test": "/noarchive.html",
}


TEST_HOSTS = [*HOSTS, "norobots.test", "brokenrobots.test", "internal.test", "rebind.test"]


OPENSSL = shutil.which("openssl") or "/usr/bin/openssl"


def make_tls(directory: Path) -> tuple[ssl.SSLContext, ssl.SSLContext]:
    """A throwaway self-signed certificate for the *.test hosts: (server context, client context)."""
    cert, key = directory / "cert.pem", directory / "key.pem"
    sans = ",".join(f"DNS:{h}" for h in TEST_HOSTS)
    subprocess.run(  # noqa: S603 - fixed arguments, test only
        [OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=echiche-test",
         "-keyout", str(key), "-out", str(cert), "-addext", f"subjectAltName={sans}",
         "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=digitalSignature,keyCertSign"],
        check=True, capture_output=True,
    )  # fmt: skip
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(cert, key)
    client = ssl.create_default_context(cafile=str(cert))
    return server, client


class FixtureSite:
    """One local HTTPS server answering for many *.test hostnames (resolved to 127.0.0.1)."""

    def __init__(self, tls: tuple[ssl.SSLContext, ssl.SSLContext]) -> None:
        self.client_context = tls[1]
        self.requests: list[tuple[str, str, str]] = []  # (host, path, user agent)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                host = (self.headers.get("host") or "").split(":")[0]
                outer.requests.append((host, self.path, self.headers.get("user-agent") or ""))
                status, ctype, body, extra = outer.route(host, self.path)
                try:
                    self.send_response(status)
                    self.send_header("content-type", ctype)
                    self.send_header("content-length", str(len(body)))
                    for k, v in extra.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.socket = tls[0].wrap_socket(self.httpd.socket, server_side=True)
        self.port = int(self.httpd.server_address[1])
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, host: str, path: str | None = None) -> str:
        return f"https://{host}:{self.port}{path or HOSTS[host]}"

    def route(self, host: str, path: str) -> tuple[int, str, bytes, dict[str, str]]:
        html = "text/html; charset=utf-8"
        path = path.split("?")[0]
        if path == "/robots.txt":
            if host == "norobots.test":
                return 404, "text/plain", b"", {}
            if host == "brokenrobots.test":
                return 503, "text/plain", b"", {}
            return 200, "text/plain", (PAGES / "robots.txt").read_bytes(), {}
        if path in ("/private/page", "/blocked-for-echiche"):
            return 200, html, (PAGES / "clinic-survey.html").read_bytes(), {}
        if path == "/big":
            return 200, html, b"<p>" + b"clinic scheduling " * 120_000 + b"</p>", {}
        if path == "/pdf":
            return 200, "application/pdf", b"%PDF-1.4 clinic scheduling", {}
        if path == "/header-noai":
            return 200, html, (PAGES / "clinic-survey.html").read_bytes(), {"x-robots-tag": "noai"}
        if path == "/redirect-internal":
            return 302, html, b"", {"location": f"https://internal.test:{self.port}/clinic-survey.html"}
        if path == "/redirect-http":
            return 302, html, b"", {"location": f"http://survey.test:{self.port}/clinic-survey.html"}
        if path == "/redirect-loop":
            return 302, html, b"", {"location": "/redirect-loop"}
        if path == "/slow":
            time.sleep(3)
            return 200, html, (PAGES / "clinic-survey.html").read_bytes(), {}
        if path == "/thin":
            return 200, html, b"<p>Too short.</p>", {}
        file = PAGES / path.lstrip("/")
        if path.endswith(".html") and file.is_file():
            return 200, html, file.read_bytes(), {}
        return 404, html, b"not found", {}

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def resolver(host: str, port: int) -> list[str]:
    if host == "internal.test":
        return ["10.0.0.7"]
    if host == "rebind.test":
        return ["127.0.0.1", "169.254.169.254"]
    if host.endswith(".test"):
        return ["127.0.0.1"]
    raise OSError("unknown host")


def site_fetcher(site: FixtureSite, timeout: float = 2.0, max_bytes: int = 1_000_000) -> PageFetcher:
    return PageFetcher(
        "EchicheResearchBot/test",
        timeout,
        max_bytes,
        resolver,
        address_allowed=lambda ip: ip == "127.0.0.1",
        allowed_ports=frozenset({site.port}),
        ssl_context=site.client_context,
    )


Script = list[str] | SearchCallError


class FakeSearch:
    """Answers each query with the next scripted URL list (or error); default: no results."""

    provider = "brave"
    price_per_request = Decimal("0.005")

    def __init__(self, script: list[Script] | None = None) -> None:
        self.script = list(script or [])
        self.queries: list[str] = []

    def search(self, query: str, count: int, timeout_seconds: float) -> SearchResult:
        self.queries.append(query)
        step: Script = self.script.pop(0) if self.script else []
        if isinstance(step, SearchCallError):
            raise step
        hits = [SearchHit(url=u) for u in step[:count]]
        record = ResearchCallRecord(
            "search", "brave", "ok" if hits else "no_results", 200, None, len(hits), 100, Decimal("0.005"), 3
        )
        return SearchResult(hits=hits, record=record)


# --- model replies that read the supplied evidence -----------------------------------------


def block(data: str, name: str) -> str:
    match = re.search(rf'<untrusted name="{name}">\n(.*?)\n</untrusted>', data, re.S)
    assert match is not None, f"no {name} block"
    return match.group(1)


def plan_reply(queries: list[str]) -> Callable[[ModelRequest], ModelReply]:
    def answer(request: ModelRequest) -> ModelReply:
        limit = json.loads(block(request.data, "limits_json"))["max_queries"]
        return reply(
            json.dumps(
                {
                    "queries": [
                        {"query": q, "research_question": "Will clinics pay?", "rationale": "Tests the key assumption."}
                        for q in queries[:limit]
                    ],
                    "skipped_questions": [],
                }
            )
        )

    return answer


def claims_reply(
    mutate: Callable[[list[dict[str, Any]], list[dict[str, Any]]], None] | None = None,
) -> Callable[[ModelRequest], ModelReply]:
    """One claim per source, quoting the first 90 characters of its first passage exactly.
    If both the pilot study and the forum poll were read, C1 cites both (supports + contradicts)."""

    def answer(request: ModelRequest) -> ModelReply:
        sources: list[dict[str, Any]] = json.loads(block(request.data, "evidence_json"))
        claims: list[dict[str, Any]] = []
        for s in sources:
            p = s["passages"][0]
            claims.append(
                {
                    "claim_id": f"C{len(claims) + 1}",
                    "text": f"{s['title']}: {p['text'][:120]}",
                    "label": "fact",
                    "evidence": [{"passage_id": p["passage_id"], "relation": "supports", "quote": p["text"][:90]}],
                }
            )
        by_domain = {s["domain"]: s for s in sources}
        if "pilots.test" in by_domain and "forum.test" in by_domain:
            forum = next(p for p in by_domain["forum.test"]["passages"] if "22 percent" in p["text"])
            target = next(
                c for c in claims if c["evidence"][0]["passage_id"].startswith(by_domain["pilots.test"]["source_id"])
            )
            target["evidence"].append(
                {"passage_id": forum["passage_id"], "relation": "contradicts", "quote": forum["text"][:80]}
            )
        if mutate:
            mutate(claims, sources)
        return reply(json.dumps({"claims": claims, "gaps": ["Willingness to pay at the proposed price."]}))

    return answer


def verifier_reply(verdicts: dict[str, str] | None = None) -> Callable[[ModelRequest], ModelReply]:
    """Supported for every supplied pair unless overridden by claim_id."""

    def answer(request: ModelRequest) -> ModelReply:
        claims: list[dict[str, Any]] = json.loads(block(request.data, "claims_json"))
        judgments = [
            {
                "claim_id": c["claim_id"],
                "passage_id": e["passage_id"],
                "verdict": (verdicts or {}).get(c["claim_id"], "supported"),
                "note": "Checked against the passage text.",
            }
            for c in claims
            for e in c["evidence"]
        ]
        return reply(json.dumps({"judgments": judgments}))

    return answer


def brief_citing(source_ids: list[str], confidence: str = "medium") -> str:
    brief = json.loads(VALID["decision_brief_v1"])
    brief["citations"] = [{"source_id": s, "supports": "Backs a verified claim."} for s in source_ids]
    brief["supporting_evidence"][0]["source_ids"] = source_ids[:5]
    brief["confidence"]["level"] = confidence
    return json.dumps(brief)
