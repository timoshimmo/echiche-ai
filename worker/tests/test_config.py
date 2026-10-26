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
    assert config.worker_id.startswith("worker-") and len(config.worker_id) <= 64
    assert config.lease_seconds == 60
    assert config.stage_timeout_seconds == 120


@pytest.mark.parametrize(("name", "value"), [("WORKER_LEASE_SECONDS", "5"), ("WORKER_STAGE_TIMEOUT_SECONDS", "0")])
def test_rejects_out_of_range_lease_and_timeout(name: str, value: str) -> None:
    assert any(name in i for i in issues_of({"DATABASE_URL": URL_OK, name: value}))


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
    log("info", "stage_started", stream, run_id="r1", stage="planning")
    record = json.loads(stream.getvalue())
    assert record["service"] == "worker"
    assert record["event"] == "stage_started"
    assert record["run_id"] == "r1"
    assert record["ts"].endswith("Z")


def test_main_exit_codes(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["--check-config"]) == 2
    assert json.loads(capsys.readouterr().err)["event"] == "config_invalid"

    monkeypatch.setenv("DATABASE_URL", URL_OK)
    assert main(["--check-config"]) == 0
    out = capsys.readouterr().out
    assert json.loads(out)["event"] == "config_valid"
    assert "placeholder" not in out


# --- reasoning provider (M4) ---------------------------------------------------------------

KEY = "sk-test-placeholder-not-real"


def test_provider_defaults_to_demo_mode_and_needs_no_key() -> None:
    config = parse_worker_config({"DATABASE_URL": URL_OK})
    assert config.reasoning_provider == "deterministic" and config.openai_api_key is None
    assert config.openai_model == "gpt-6.1-sol" and config.openai_max_output_tokens == 4000


def test_openai_provider_settings_are_validated() -> None:
    env = {"DATABASE_URL": URL_OK, "REASONING_PROVIDER": "openai"}
    assert any("OPENAI_API_KEY is required" in i for i in issues_of(env))
    bad = issues_of(
        env
        | {
            "OPENAI_API_KEY": KEY,
            "OPENAI_REASONING_EFFORT": "extreme",
            "OPENAI_DATA_RESIDENCY": "mars",
            "OPENAI_MAX_OUTPUT_TOKENS": "10",
            "OPENAI_MODEL": "bad model!",
        }
    )
    assert len(bad) == 4 and not any(KEY in i for i in bad)
    assert any("REASONING_PROVIDER" in i for i in issues_of({"DATABASE_URL": URL_OK, "REASONING_PROVIDER": "magic"}))
    extra = {"OPENAI_API_KEY": KEY, "OPENAI_DATA_RESIDENCY": "EU", "OPENAI_REASONING_EFFORT": "low"}
    ok = parse_worker_config(env | extra)
    assert ok.openai_data_residency == "eu" and ok.openai_reasoning_effort == "low"


def test_repr_hides_api_key() -> None:
    config = parse_worker_config({"DATABASE_URL": URL_OK, "REASONING_PROVIDER": "openai", "OPENAI_API_KEY": KEY})
    assert KEY not in repr(config) and KEY not in str(config) and "openai_api_key=***" in repr(config)


def test_unknown_model_fails_at_start_up_with_exit_code_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in {
        "DATABASE_URL": URL_OK,
        "REASONING_PROVIDER": "openai",
        "OPENAI_API_KEY": KEY,
        "OPENAI_MODEL": "gpt-unpriced",
    }.items():
        monkeypatch.setenv(name, value)
    assert main(["--check-config"]) == 2
    err = capsys.readouterr().err
    assert "no verified price" in err and KEY not in err
    monkeypatch.setenv("OPENAI_MODEL", "gpt-6-luna")
    assert main(["--check-config"]) == 0
    assert "openai:gpt-6-luna" in capsys.readouterr().out
