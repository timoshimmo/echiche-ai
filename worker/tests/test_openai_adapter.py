"""OpenAI adapter against a local mock HTTP server (no network, no API key)."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from echiche_worker.contracts import DecisionFrameV2
from echiche_worker.llm import ModelCallError, ModelRequest
from echiche_worker.openai_adapter import OpenAIModelClient, strict_schema
from echiche_worker.provider import (
    ProviderAuthError,
    ProviderRateLimitedError,
    ProviderRequestError,
    ProviderTimeoutError,
    TransientProviderError,
)

from .model_fakes import VALID

Plan = tuple[int, dict[str, Any], dict[str, str], float]  # status, body, headers, delay


def response_body(
    text: str = VALID["decision_frame_v2"], status: str = "completed", refusal: bool = False, reason: str | None = None
) -> dict[str, Any]:
    content: list[dict[str, Any]] = (
        [{"type": "refusal", "refusal": "I can't help with that."}]
        if refusal
        else [{"type": "output_text", "text": text, "annotations": []}]
    )
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 1_790_000_000,
        "model": "gpt-6.1-sol-2026-09-01",
        "status": status,
        "incomplete_details": {"reason": reason} if reason else None,
        "output": [{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": content}],
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 900,
            "input_tokens_details": {"cached_tokens": 100, "cache_write_tokens": 0},
            "output_tokens": 300,
            "output_tokens_details": {"reasoning_tokens": 50},
            "total_tokens": 1200,
        },
    }


class Server:
    def __init__(self) -> None:
        self.plans: list[Plan] = []
        self.requests: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("content-length", "0"))
                outer.requests.append({"path": self.path, "body": json.loads(self.rfile.read(length))})
                outer.headers.append({k.lower(): v for k, v in self.headers.items()})
                status, body, headers, delay = outer.plans.pop(0) if outer.plans else (200, response_body(), {}, 0.0)
                time.sleep(delay)
                payload = json.dumps(body).encode()
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(payload)))
                    for k, v in headers.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()


@pytest.fixture
def server() -> Iterator[Server]:
    s = Server()
    yield s
    s.httpd.shutdown()
    s.httpd.server_close()


def request(timeout: float = 5) -> ModelRequest:
    return ModelRequest(
        instructions="Trusted instructions.",
        data='<untrusted name="question">\nq\n</untrusted>',
        schema_name="decision_frame_v2",
        json_schema=strict_schema(DecisionFrameV2),
        max_output_tokens=1234,
        timeout_seconds=timeout,
    )


def client(server: Server, effort: str | None = None) -> OpenAIModelClient:
    return OpenAIModelClient(
        api_key="sk-test-not-real", model="gpt-6.1-sol", reasoning_effort=effort, base_url=server.url
    )


def test_request_shape_store_false_and_strict_schema(server: Server) -> None:
    out = client(server, effort="low").generate(request())
    assert out.status == "completed" and DecisionFrameV2.model_validate_json(out.text)
    assert (out.usage.input_tokens, out.usage.cached_input_tokens, out.usage.output_tokens) == (900, 100, 300)
    assert out.usage.reasoning_tokens == 50 and out.model == "gpt-6.1-sol-2026-09-01"
    sent = server.requests[0]
    assert sent["path"] == "/v1/responses"
    body = sent["body"]
    assert body["store"] is False and body["model"] == "gpt-6.1-sol" and body["max_output_tokens"] == 1234
    assert body["instructions"] == "Trusted instructions."
    assert body["input"] == [{"role": "user", "content": request().data}]
    assert body["text"]["format"]["strict"] is True and body["text"]["format"]["type"] == "json_schema"
    assert body["reasoning"] == {"effort": "low"}
    assert server.headers[0]["authorization"] == "Bearer sk-test-not-real"


def test_reasoning_is_omitted_unless_configured(server: Server) -> None:
    client(server).generate(request())
    assert "reasoning" not in server.requests[0]["body"]
    with pytest.raises(ValueError, match="effort"):
        OpenAIModelClient(api_key="k", model="m", reasoning_effort="extreme", base_url=server.url)


@pytest.mark.parametrize(
    ("status", "headers", "error", "retry_after"),
    [
        (429, {"retry-after": "3"}, ProviderRateLimitedError, 3.0),
        (500, {}, TransientProviderError, None),
        (503, {}, TransientProviderError, None),
        (401, {}, ProviderAuthError, None),
        (403, {}, ProviderAuthError, None),
        (400, {}, ProviderRequestError, None),
    ],
)
def test_http_errors_map_to_worker_errors_without_sdk_retries(
    server: Server, status: int, headers: dict[str, str], error: type[Exception], retry_after: float | None
) -> None:
    server.plans.append((status, {"error": {"message": "secret echo of user text", "type": "x"}}, headers, 0.0))
    with pytest.raises(ModelCallError) as caught:
        client(server).generate(request())
    assert type(caught.value.error) is error
    assert getattr(caught.value.error, "retry_after", None) == retry_after
    assert "secret echo" not in str(caught.value.error)  # provider messages never propagate
    assert len(server.requests) == 1  # max_retries=0: the worker owns retries


def test_timeouts_map_to_provider_timeout(server: Server) -> None:
    server.plans.append((200, response_body(), {}, 2.0))
    with pytest.raises(ModelCallError) as caught:
        client(server).generate(request(timeout=0.3))
    assert isinstance(caught.value.error, ProviderTimeoutError)


def test_connection_failures_are_transient() -> None:
    dead = OpenAIModelClient(api_key="k", model="gpt-6.1-sol", base_url="http://127.0.0.1:9/v1")
    with pytest.raises(ModelCallError) as caught:
        dead.generate(request(timeout=2))
    assert isinstance(caught.value.error, TransientProviderError)


def test_refusal_incomplete_and_invalid_json_are_reported_not_parsed(server: Server) -> None:
    server.plans.append((200, response_body(refusal=True), {}, 0.0))
    server.plans.append((200, response_body(status="incomplete", reason="max_output_tokens"), {}, 0.0))
    server.plans.append((200, response_body(status="incomplete", reason="content_filter"), {}, 0.0))
    server.plans.append((200, response_body(text="{not json"), {}, 0.0))
    c = client(server)
    assert c.generate(request()).status == "refused"
    truncated = c.generate(request())
    assert truncated.status == "truncated" and truncated.usage.output_tokens == 300  # still billed
    assert c.generate(request()).status == "refused"
    raw = c.generate(request())
    assert raw.status == "completed" and raw.text == "{not json"  # validation is the provider layer's job
