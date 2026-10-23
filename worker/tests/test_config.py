import io
import json

import pytest

from echiche_worker.__main__ import main
from echiche_worker.config import ConfigError, parse_worker_config
from echiche_worker.log import log

URL_OK = "postgresql://echiche_worker:placeholder@localhost:5432/echiche"


def issues_of(env: dict[str, str]) -> list[str]:
    with pytest.raises(ConfigError) as caught:
        parse_worker_config(env)
    return caught.value.issues


def test_valid_config_with_defaults() -> None:
    config = parse_worker_config({"DATABASE_URL": URL_OK})
    assert config.database_url == URL_OK
    assert config.poll_interval_seconds == 2.0
    assert config.worker_id == "worker-local"


def test_database_url_required_no_in_memory_mode() -> None:
    assert "DATABASE_URL is required" in issues_of({})[0]
    assert "DATABASE_URL is required" in issues_of({"DATABASE_URL": "   "})[0]


@pytest.mark.parametrize("url", ["mysql://root:SuperSecret@db/prod", "not a url", "postgresql:///no-host"])
def test_rejects_malformed_database_url_without_echoing_it(url: str) -> None:
    issues = issues_of({"DATABASE_URL": url})
    assert issues == ["DATABASE_URL must be a postgres:// or postgresql:// URL with a host"]
    assert "SuperSecret" not in " ".join(issues)


@pytest.mark.parametrize("value", ["abc", "0", "61", "nan", "inf", "-1"])
def test_rejects_out_of_range_poll_interval(value: str) -> None:
    assert any(
        "WORKER_POLL_INTERVAL_SECONDS" in i
        for i in issues_of({"DATABASE_URL": URL_OK, "WORKER_POLL_INTERVAL_SECONDS": value})
    )


def test_rejects_unsafe_worker_id() -> None:
    assert any("WORKER_ID" in i for i in issues_of({"DATABASE_URL": URL_OK, "WORKER_ID": "bad id; rm -rf"}))


def test_reports_all_issues_at_once() -> None:
    assert len(issues_of({"WORKER_POLL_INTERVAL_SECONDS": "x", "WORKER_ID": "x" * 65})) == 3


def test_repr_hides_connection_string() -> None:
    assert "placeholder" not in repr(parse_worker_config({"DATABASE_URL": URL_OK}))


def test_log_emits_one_json_line_with_shared_fields() -> None:
    stream = io.StringIO()
    log("info", "stage_started", stream=stream, run_id="r1", stage="planning")
    record = json.loads(stream.getvalue())
    assert record["service"] == "worker"
    assert record["event"] == "stage_started"
    assert record["run_id"] == "r1"
    assert record["ts"].endswith("Z")


def test_main_exit_codes(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main() == 2
    assert json.loads(capsys.readouterr().err)["event"] == "config_invalid"

    monkeypatch.setenv("DATABASE_URL", URL_OK)
    assert main() == 0
    out = capsys.readouterr().out
    assert json.loads(out)["event"] == "worker_skeleton_ready"
    assert "placeholder" not in out
