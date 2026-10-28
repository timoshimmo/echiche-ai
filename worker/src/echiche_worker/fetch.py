"""Safe page fetcher for research evidence (ADR-008). Standard library only.

Guards, in order:
  * https only, no credentials in URLs, default ports only;
  * the hostname is resolved once, **every** address must be public (no private, loopback,
    link-local, reserved, multicast or unspecified ranges, incl. IPv4-mapped IPv6), and the
    connection is pinned to the validated address (no DNS-rebinding window);
  * robots.txt is honoured per RFC 9309 for our user agent (4xx = allowed; 5xx/unreachable =
    disallowed), on every host in a redirect chain;
  * at most 3 redirects, each re-validated; only 200 responses with an HTML or plain-text
    content type; a byte cap enforced while reading; an overall deadline per page;
  * `X-Robots-Tag` / `<meta name="robots">` with noarchive, noai or none is respected: the
    page is not stored or used.

Fetched text is untrusted data. It is reduced to plain text and a few metadata fields here;
nothing in it can change what the application does.
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import re
import socket
import ssl
import time
import urllib.parse
import urllib.robotparser
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from html.parser import HTMLParser
from typing import Any

from echiche_worker.provider import ResearchCallRecord

Resolver = Callable[[str, int], list[str]]
MAX_REDIRECTS = 3
ROBOTS_MAX_BYTES = 512_000
_TEXT_TYPES = ("text/html", "application/xhtml+xml", "text/plain")
_BLOCK_DIRECTIVES = re.compile(r"\b(noarchive|noai|none)\b", re.I)
_TRACKING = re.compile(r"^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid)$", re.I)


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(ip.is_global and not ip.is_multicast and not ip.is_unspecified and not ip.is_reserved)


def normalise_url(url: str) -> str:
    """Drops the fragment and common tracking parameters; lower-cases scheme and host."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.urlencode(
        [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True) if not _TRACKING.match(k)]
    )
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", query, ""))


@dataclass(frozen=True, slots=True)
class FetchedPage:
    url: str
    domain: str
    title: str
    publisher: str | None
    published_at: str | None
    text: str
    content_sha256: str


@dataclass(slots=True)
class FetchResult:
    status: str  # "ok" or a SkippedSourceV1 status
    domain: str
    page: FetchedPage | None = None
    records: list[ResearchCallRecord] = field(default_factory=list[ResearchCallRecord])


class _Blocked(Exception):
    def __init__(self, status: str, http_status: int | None = None) -> None:
        super().__init__(status)
        self.status = status
        self.http_status = http_status


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, ip: str, timeout: float, context: ssl.SSLContext) -> None:
        super().__init__(host, port, timeout=timeout, context=context)
        self._ip = ip
        self._ctx = context

    def connect(self) -> None:
        # Certificate and hostname are verified against `host` (SNI); the TCP peer is the validated IP.
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._ctx.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, ip: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _Extractor(HTMLParser):
    SKIP = frozenset(
        {"script", "style", "noscript", "template", "svg", "nav", "footer", "header", "aside", "form", "iframe",
         "button", "select", "head"}
    )  # fmt: skip
    BLOCK = frozenset(
        {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "blockquote",
         "pre", "dd", "dt", "table", "ul", "ol", "main"}
    )  # fmt: skip
    DATE_KEYS = frozenset(
        {"article:published_time", "og:published_time", "datepublished", "date", "citation_publication_date",
         "dc.date", "dc.date.issued", "pubdate", "publish-date"}
    )  # fmt: skip

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self.publisher: str | None = None
        self.published_at: str | None = None
        self.robots = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("name") or a.get("property") or a.get("itemprop") or "").lower()
            content = a.get("content", "").strip()
            if key == "robots" or key == "echichebot":
                self.robots += " " + content
            elif key in ("og:site_name", "application-name") and content and not self.publisher:
                self.publisher = content[:200]
            elif key in self.DATE_KEYS and content and not self.published_at:
                self.published_at = content[:40]
            return
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP and tag != "head":
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and tag != "head" and self._skip:
            self._skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)

    def text(self) -> str:
        lines = (" ".join(line.split()) for line in "".join(self.parts).split("\n"))
        return "\n".join(line for line in lines if line)


def extract(html: str) -> _Extractor:
    parser = _Extractor()
    parser.feed(html)
    parser.close()
    return parser


class PageFetcher:
    provider = "fetcher"

    def __init__(
        self,
        user_agent: str,
        timeout_seconds: float = 8.0,
        max_bytes: int = 2_000_000,
        resolver: Resolver = system_resolver,
        *,
        # Test hooks only (local servers); production uses the defaults and never sets these from env.
        address_allowed: Callable[[str], bool] = is_public_address,
        allowed_ports: frozenset[int] = frozenset({443}),
        allow_http: bool = False,
        ssl_context: ssl.SSLContext | None = None,
    ) -> None:
        self.user_agent = user_agent
        self.robots_token = user_agent.split("/")[0]
        self.timeout = timeout_seconds
        self.max_bytes = max_bytes
        self.resolver = resolver
        self.address_allowed = address_allowed
        self.allowed_ports = allowed_ports
        self.allow_http = allow_http
        self._context = ssl_context or ssl.create_default_context()
        self._robots: dict[str, urllib.robotparser.RobotFileParser | bool] = {}

    # --- public -------------------------------------------------------------------------

    def fetch(self, url: str) -> FetchResult:
        records: list[ResearchCallRecord] = []
        domain = (urllib.parse.urlsplit(url).hostname or "")[:253]
        deadline = time.monotonic() + self.timeout
        current = url
        try:
            for _ in range(MAX_REDIRECTS + 1):
                parts = self._validate(current)
                domain = parts.hostname or domain
                if not self._robots_allowed(parts, records, deadline):
                    raise _Blocked("blocked_robots")
                status, headers, body = self._get(current, records, deadline, kind="fetch")
                if status in (301, 302, 303, 307, 308):
                    location = headers.get("location")
                    if not location:
                        raise _Blocked("http_error", status)
                    current = urllib.parse.urljoin(current, location)
                    continue
                if status != 200:
                    raise _Blocked("http_error", status)
                return self._page(current, headers, body, records)
            raise _Blocked("http_error")
        except _Blocked as blocked:
            status = "fetch_error" if blocked.status == "dns" else blocked.status
            return FetchResult(status=status, domain=domain, records=records)

    # --- internals ----------------------------------------------------------------------

    def _validate(self, url: str) -> urllib.parse.SplitResult:
        parts = urllib.parse.urlsplit(url)
        allowed = ("https", "http") if self.allow_http else ("https",)
        if parts.scheme not in allowed or not parts.hostname or parts.username or parts.password:
            raise _Blocked("unsupported_url")
        if parts.port is not None and parts.port not in self.allowed_ports:
            raise _Blocked("unsupported_url")
        return parts

    def _address(self, host: str, port: int) -> str:
        try:
            addresses = self.resolver(host, port)
        except OSError:
            raise _Blocked("dns") from None
        if not addresses:
            raise _Blocked("dns")
        if not all(self.address_allowed(a) for a in addresses):
            raise _Blocked("blocked_address")
        return addresses[0]

    def _get(
        self, url: str, records: list[ResearchCallRecord], deadline: float, kind: str, limit: int | None = None
    ) -> tuple[int, http.client.HTTPMessage, bytes]:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "https" else 80)
        started = time.monotonic()
        cap = limit or self.max_bytes
        remaining = deadline - started
        if remaining <= 0:
            raise _Blocked("timeout")
        ip = self._address(host, port)
        conn: http.client.HTTPConnection
        if parts.scheme == "https":
            conn = _PinnedHTTPSConnection(host, port, ip, remaining, self._context)
        else:
            conn = _PinnedHTTPConnection(host, port, ip, remaining)
        path = urllib.parse.urlunsplit(("", "", parts.path or "/", parts.query, ""))
        outcome, status, size = "error", None, 0
        try:
            conn.request(
                "GET",
                path,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
                    "Accept-Encoding": "identity",
                },
            )
            response = conn.getresponse()
            status = response.status
            declared = response.getheader("content-length")
            if declared and declared.isdigit() and int(declared) > cap:
                outcome = "too_large"
                raise _Blocked("too_large", status)
            chunks: list[bytes] = []
            while True:
                if time.monotonic() > deadline:
                    outcome = "timeout"
                    raise _Blocked("timeout", status)
                chunk = response.read(65_536)
                if not chunk:
                    break
                size += len(chunk)
                if size > cap:
                    outcome = "too_large"
                    raise _Blocked("too_large", status)
                chunks.append(chunk)
            outcome = "ok" if status == 200 else "redirect" if 300 <= status < 400 else "http_error"
            return status, response.headers, b"".join(chunks)
        except TimeoutError:
            outcome = "timeout"
            raise _Blocked("timeout", status) from None
        except (OSError, http.client.HTTPException, ssl.SSLError):
            outcome = "error"
            raise _Blocked("fetch_error", status) from None
        finally:
            conn.close()
            records.append(
                ResearchCallRecord(
                    kind="robots" if kind == "robots" else "fetch",
                    provider=self.provider,
                    outcome=outcome,
                    http_status=status,
                    domain=host[:253],
                    result_count=0,
                    bytes=size,
                    cost_usd=Decimal(0),
                    latency_ms=int((time.monotonic() - started) * 1000),
                )
            )

    def _robots_allowed(
        self, parts: urllib.parse.SplitResult, records: list[ResearchCallRecord], deadline: float
    ) -> bool:
        origin = f"{parts.scheme}://{parts.netloc}"
        cached = self._robots.get(origin)
        if cached is None:
            try:
                status, _headers, body = self._get(
                    f"{origin}/robots.txt", records, deadline, kind="robots", limit=ROBOTS_MAX_BYTES
                )
            except _Blocked as blocked:
                if blocked.status in ("blocked_address", "unsupported_url", "dns"):
                    raise  # the page itself is unreachable or refused, not just robots.txt
                cached = False  # unreachable or too large: RFC 9309 says assume disallowed
            else:
                if 200 <= status < 300:
                    parser = urllib.robotparser.RobotFileParser()
                    parser.parse(body.decode("utf-8", "replace").splitlines())
                    cached = parser
                elif 400 <= status < 500 or 300 <= status < 400:
                    cached = True  # unavailable: allowed (redirected robots.txt treated as unavailable)
                else:
                    cached = False
            self._robots[origin] = cached
        if isinstance(cached, bool):
            return cached
        target = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))
        return cached.can_fetch(self.robots_token, target)

    def _page(
        self, url: str, headers: http.client.HTTPMessage, body: bytes, records: list[ResearchCallRecord]
    ) -> FetchResult:
        domain = urllib.parse.urlsplit(url).hostname or ""
        content_type = (headers.get("content-type") or "").lower()
        if not content_type.startswith(_TEXT_TYPES):
            return FetchResult(status="unsupported_type", domain=domain, records=records)
        if _BLOCK_DIRECTIVES.search(" ".join(headers.get_all("x-robots-tag") or [])):
            return FetchResult(status="blocked_publisher", domain=domain, records=records)
        charset = headers.get_content_charset() or "utf-8"
        try:
            html = body.decode(charset, "replace")
        except LookupError:
            html = body.decode("utf-8", "replace")
        if content_type.startswith("text/plain"):
            text, title, publisher, published = (
                "\n".join(line.strip() for line in html.splitlines() if line.strip()),
                "",
                None,
                None,
            )
        else:
            parsed = extract(html)
            if _BLOCK_DIRECTIVES.search(parsed.robots):
                return FetchResult(status="blocked_publisher", domain=domain, records=records)
            text, title, publisher, published = (
                parsed.text(),
                " ".join(parsed.title.split()),
                parsed.publisher,
                parsed.published_at,
            )
        if len(text) < 200:
            return FetchResult(status="no_text", domain=domain, records=records)
        page = FetchedPage(
            url=normalise_url(url),
            domain=domain[:253],
            title=(title or domain)[:300],
            publisher=publisher,
            published_at=_iso_date(published),
            text=text,
            content_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        )
        return FetchResult(status="ok", domain=domain, page=page, records=records)


_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$")


def _iso_date(value: Any) -> str | None:  # noqa: ANN401 - raw page metadata
    """Keeps only ISO-8601 dates; anything else is 'unknown' rather than guessed."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:40] if _ISO.match(text) else None
