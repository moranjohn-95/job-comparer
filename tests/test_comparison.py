import json
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func
from sqlalchemy.orm import Session

from database import get_engine
from main import app
from ai_usage import (
    APP_DAILY_LIMIT,
    APP_MONTHLY_LIMIT,
    LOCK_KEY,
    UsageConfigurationError,
    get_app_limits,
)
from comparison import (
    MAX_CV_BYTES,
    MAX_CV_CHARS,
    MAX_JOB_BYTES,
    MAX_JOB_CHARS,
    MAX_OUTPUT_TOKENS,
    _post_once,
    source_excerpts,
)
from models import AIUsageCounter, ComparisonHistory, SavedCV, User

PASSWORD = "correct-horse-battery-123"
CV_TEXT = "Built Python APIs and maintained PostgreSQL databases."
JOB_DESCRIPTION = "Build Python APIs. Deploy services with Kubernetes."
JOB = {
    "title": "Backend Engineer",
    "company_name": "Example Co",
    "description": JOB_DESCRIPTION,
}
PROVIDER_RESULT = {
    "matched_requirements": [
        {
            "requirement": "Python APIs",
            "job_evidence": "Build Python APIs. ",
            "cv_evidence": CV_TEXT,
        }
    ],
    "possible_gaps": [
        {
            "requirement": "Kubernetes",
            "job_evidence": "Deploy services with Kubernetes.",
            "status": "not_found_in_cv",
        }
    ],
}
PROVIDER_REFERENCES = {
    "matched_requirements": [{
        "requirement": "Python APIs",
        "job_evidence_id": "job_0001",
        "cv_evidence_id": "cv_0001",
    }],
    "possible_gaps": [{
        "requirement": "Kubernetes",
        "job_evidence_id": "job_0002",
        "status": "not_found_in_cv",
    }],
}


@pytest.fixture(autouse=True)
def reset_ai_usage(
    monkeypatch: pytest.MonkeyPatch,
    migrated_test_database: None,
) -> Iterator[None]:
    monkeypatch.setenv("AI_COMPARISON_ENABLED", "true")
    monkeypatch.delenv("AI_APP_DAILY_LIMIT", raising=False)
    monkeypatch.delenv("AI_APP_MONTHLY_LIMIT", raising=False)
    with Session(get_engine()) as session:
        session.execute(
            delete(AIUsageCounter).where(
                AIUsageCounter.counter_key != LOCK_KEY
            )
        )
        session.commit()
    yield
    with Session(get_engine()) as session:
        session.execute(
            delete(AIUsageCounter).where(
                AIUsageCounter.counter_key != LOCK_KEY
            )
        )
        session.commit()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def create_user(client: TestClient) -> Iterator[Callable[[], dict[str, str]]]:
    emails: list[str] = []

    def create() -> dict[str, str]:
        email = f"comparison-test-{uuid4().hex}@example.com"
        emails.append(email)
        assert (
            client.post(
                "/signup", json={"email": email, "password": PASSWORD}
            ).status_code
            == 201
        )
        login = client.post(
            "/login", json={"email": email, "password": PASSWORD}
        )
        assert login.status_code == 200
        return {"Authorization": f"Bearer {login.json()['access_token']}"}

    yield create
    with Session(get_engine()) as session:
        session.execute(delete(User).where(User.email.in_(emails)))
        session.commit()


def prepare(
    client: TestClient, headers: dict[str, str], *, cv: bool = True,
    cv_text: str = CV_TEXT, job_description: str = JOB_DESCRIPTION,
) -> int:
    if cv:
        assert (
            client.put(
                "/cv", json={"text": cv_text}, headers=headers
            ).status_code
            == 200
        )
    response = client.post(
        "/jobs", json={**JOB, "description": job_description},
        headers=headers,
    )
    assert response.status_code == 201
    return response.json()["id"]


def provider_response(result: dict) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": json.dumps(result)}
                    ],
                }
            ],
        },
        request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
    )


def mock_success(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")

    def fake_post(*_: object, **kwargs: object) -> httpx.Response:
        calls.append(kwargs["json"])
        return provider_response(PROVIDER_REFERENCES)

    monkeypatch.setattr("comparison._post_once", fake_post)
    return calls


def seed_counter(key: str, count: int) -> None:
    with Session(get_engine()) as session:
        session.add(AIUsageCounter(counter_key=key, call_count=count))
        session.commit()


def current_periods() -> tuple[str, str]:
    with Session(get_engine()) as session:
        now = session.scalar(func.timezone("UTC", func.clock_timestamp()))
    return now.date().isoformat(), now.strftime("%Y-%m")


def test_comparison_returns_grounded_result_and_sends_only_owned_text(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    seen = []

    def fake_post(
        url: str, *, headers: dict, json: dict, timeout: float
    ) -> httpx.Response:
        seen.append((url, headers, json, timeout))
        return provider_response(PROVIDER_REFERENCES)

    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr("comparison._post_once", fake_post)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 200
    result = response.json()
    assert (
        result["matched_requirements"]
        == PROVIDER_RESULT["matched_requirements"]
    )
    assert result["possible_gaps"] == PROVIDER_RESULT["possible_gaps"]
    assert (
        "does not establish that the person lacks the skill"
        in result["interpretation"]
    )
    assert "score" not in result
    assert len(seen) == 1
    url, provider_headers, payload, timeout = seen[0]
    assert url == "https://api.openai.com/v1/responses"
    assert provider_headers == {"Authorization": "Bearer test-provider-key"}
    assert payload["model"] == "gpt-4o-mini"
    assert payload["store"] is False
    assert payload["max_output_tokens"] == MAX_OUTPUT_TOKENS
    assert payload["text"]["format"]["strict"] is True
    assert json.loads(payload["input"][1]["content"]) == {
        "cv_excerpts": source_excerpts(CV_TEXT, "cv"),
        "job_excerpts": source_excerpts(JOB_DESCRIPTION, "job"),
    }
    assert timeout == 30.0


def test_missing_cv_does_not_call_provider(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers, cv=False)
    monkeypatch.setattr(
        "main.compare", lambda *_: pytest.fail("provider called")
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 404
    assert response.json() == {"detail": "CV not found"}


def test_other_users_job_is_hidden_before_provider_call(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = create_user()
    other = create_user()
    job_id = prepare(client, owner)
    assert (
        client.put(
            "/cv", json={"text": "A different private CV"}, headers=other
        ).status_code
        == 200
    )
    monkeypatch.setattr(
        "main.compare", lambda *_: pytest.fail("provider called")
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=other)

    assert response.status_code == 404
    assert response.json() == {"detail": "Job not found"}


def test_unauthenticated_comparison_is_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: pytest.fail("provider called"),
    )
    response = client.post("/jobs/1/compare")
    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


@pytest.mark.parametrize(
    "bad_result",
    [
        {**PROVIDER_REFERENCES, "score": 95},
        PROVIDER_RESULT,
        {
            "matched_requirements": [
                {
                    **PROVIDER_REFERENCES["matched_requirements"][0],
                    "cv_evidence_id": "cv_9999",
                }
            ],
            "possible_gaps": [],
        },
        {
            "matched_requirements": [],
            "possible_gaps": [
                {
                    **PROVIDER_REFERENCES["possible_gaps"][0],
                    "status": "lacks_skill",
                }
            ],
        },
        {
            "matched_requirements": [],
            "possible_gaps": [
                {
                    **PROVIDER_REFERENCES["possible_gaps"][0],
                    "requirement": "  ",
                }
            ],
        },
    ],
)
def test_malformed_provider_output_has_generic_error(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    bad_result: dict,
    caplog: pytest.LogCaptureFixture,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison._post_once", lambda *_, **__: provider_response(bad_result)
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {
        "detail": "AI provider returned an invalid comparison"
    }
    assert CV_TEXT not in response.text
    assert "comparison_invalid_output" in caplog.text
    assert "category" not in response.json()
    assert "field" not in response.json()
    assert CV_TEXT not in caplog.text
    assert JOB_DESCRIPTION not in caplog.text


def test_provider_failure_does_not_expose_cv_or_provider_error(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")

    def failed_post(*_: object, **__: object) -> None:
        raise httpx.ConnectError(f"provider failed with {CV_TEXT}")

    monkeypatch.setattr("comparison._post_once", failed_post)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {"detail": "AI provider is unavailable"}
    assert CV_TEXT not in response.text
    assert "test-provider-key" not in response.text
    assert CV_TEXT not in caplog.text
    assert "test-provider-key" not in caplog.text


def test_incomplete_provider_response_is_rejected(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: httpx.Response(
            200,
            json={"status": "incomplete", "output": []},
            request=httpx.Request(
                "POST", "https://api.openai.com/v1/responses"
            ),
        ),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {
        "detail": "AI provider returned an invalid comparison"
    }


def test_non_json_provider_response_is_rejected(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: httpx.Response(
            200,
            content=b"not JSON",
            request=httpx.Request(
                "POST", "https://api.openai.com/v1/responses"
            ),
        ),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {
        "detail": "AI provider returned an invalid comparison"
    }


def test_unconfigured_provider_returns_clear_error_without_request(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "replace-with-your-api-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: pytest.fail("provider called"),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "AI provider is not configured"}


def test_comparisons_are_disabled_without_opt_in(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.delenv("AI_COMPARISON_ENABLED", raising=False)
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: pytest.fail("provider called"),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "AI comparisons are disabled"}
    with Session(get_engine()) as session:
        assert session.query(AIUsageCounter).count() == 1


def test_unapproved_model_is_rejected_before_reservation(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: pytest.fail("provider called"),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "AI provider is not configured"}
    with Session(get_engine()) as session:
        assert session.query(AIUsageCounter).count() == 1


@pytest.mark.parametrize("source", ["cv", "job"])
def test_oversized_input_is_rejected_before_reservation(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    source: str,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    if source == "cv":
        response = client.put(
            "/cv", json={"text": "x" * (MAX_CV_CHARS + 1)},
            headers=headers,
        )
        assert response.status_code == 200
    else:
        response = client.post(
            "/jobs",
            json={**JOB, "description": "x" * (MAX_JOB_CHARS + 1)},
            headers=headers,
        )
        assert response.status_code == 201
        job_id = response.json()["id"]
    mock_success(monkeypatch)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 422
    assert "AI comparison input limit" in response.json()["detail"]
    with Session(get_engine()) as session:
        assert session.query(AIUsageCounter).count() == 1


@pytest.mark.parametrize("source", ["cv", "job"])
def test_multibyte_input_respects_byte_limit(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    source: str,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    if source == "cv":
        text = "🎯" * (MAX_CV_BYTES // 4 + 1)
        assert len(text) < MAX_CV_CHARS
        response = client.put("/cv", json={"text": text}, headers=headers)
        assert response.status_code == 200
    else:
        text = "🎯" * (MAX_JOB_BYTES // 4 + 1)
        assert len(text) < MAX_JOB_CHARS
        response = client.post(
            "/jobs", json={**JOB, "description": text}, headers=headers
        )
        assert response.status_code == 201
        job_id = response.json()["id"]
    mock_success(monkeypatch)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 422
    with Session(get_engine()) as session:
        assert session.query(AIUsageCounter).count() == 1


def test_serialized_input_is_bounded_before_reservation(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    cv_response = client.put(
        "/cv", json={"text": '"' * MAX_CV_CHARS}, headers=headers
    )
    job_response = client.post(
        "/jobs",
        json={**JOB, "description": '"' * MAX_JOB_CHARS},
        headers=headers,
    )
    assert cv_response.status_code == 200
    assert job_response.status_code == 201
    calls = mock_success(monkeypatch)

    response = client.post(
        f"/jobs/{job_response.json()['id']}/compare", headers=headers
    )

    assert response.status_code == 422
    assert "Combined CV and job text" in response.json()["detail"]
    assert calls == []


def test_account_daily_limit_counts_attempts(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    calls = mock_success(monkeypatch)

    responses = [
        client.post(f"/jobs/{job_id}/compare", headers=headers)
        for _ in range(4)
    ]

    assert [response.status_code for response in responses] == [
        200, 200, 200, 429
    ]
    assert responses[-1].json() == {
        "detail": "Daily account comparison limit reached (3)"
    }
    assert len(calls) == 3
    assert len(
        client.get(
            f"/jobs/{job_id}/comparisons", headers=headers
        ).json()
    ) == 3


def test_app_limit_settings_default_and_local_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert get_app_limits() == (APP_DAILY_LIMIT, APP_MONTHLY_LIMIT)
    monkeypatch.setenv("AI_APP_DAILY_LIMIT", "50")
    monkeypatch.setenv("AI_APP_MONTHLY_LIMIT", "100")
    assert get_app_limits() == (50, 100)


@pytest.mark.parametrize(
    "name,value",
    [
        ("AI_APP_DAILY_LIMIT", "0"),
        ("AI_APP_DAILY_LIMIT", "-1"),
        ("AI_APP_DAILY_LIMIT", "not-a-number"),
        ("AI_APP_MONTHLY_LIMIT", "0"),
    ],
)
def test_invalid_limit_setting_is_rejected_without_reservation(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    calls = mock_success(monkeypatch)
    monkeypatch.setenv(name, value)

    with pytest.raises(UsageConfigurationError):
        get_app_limits()
    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "AI comparison limits are invalid"}
    assert calls == []
    with Session(get_engine()) as session:
        assert session.query(AIUsageCounter).count() == 1


@pytest.mark.parametrize(
    "period,env_name,limit,detail",
    [
        (
            "day", "AI_APP_DAILY_LIMIT", 50,
            "Daily app comparison limit reached (50)",
        ),
        (
            "month", "AI_APP_MONTHLY_LIMIT", 100,
            "Monthly app comparison limit reached (100)",
        ),
    ],
)
def test_app_limit_override_uses_existing_counters(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    period: str,
    env_name: str,
    limit: int,
    detail: str,
) -> None:
    day, month = current_periods()
    key = f"app:{period}:{day if period == 'day' else month}"
    seed_counter(key, limit - 1)
    first = create_user()
    second = create_user()
    first_job = prepare(client, first)
    second_job = prepare(client, second)
    calls = mock_success(monkeypatch)
    monkeypatch.setenv(env_name, str(limit))

    accepted = client.post(f"/jobs/{first_job}/compare", headers=first)
    rejected = client.post(f"/jobs/{second_job}/compare", headers=second)

    assert accepted.status_code == 200
    assert rejected.status_code == 429
    assert rejected.json() == {"detail": detail}
    assert len(calls) == 1
    with Session(get_engine()) as session:
        assert session.get(AIUsageCounter, key).call_count == limit


def test_app_daily_limit_applies_across_accounts(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    day, _ = current_periods()
    seed_counter(f"app:day:{day}", APP_DAILY_LIMIT - 1)
    first = create_user()
    second = create_user()
    first_job = prepare(client, first)
    second_job = prepare(client, second)
    calls = mock_success(monkeypatch)

    accepted = client.post(f"/jobs/{first_job}/compare", headers=first)
    rejected = client.post(f"/jobs/{second_job}/compare", headers=second)

    assert accepted.status_code == 200
    assert rejected.status_code == 429
    assert rejected.json() == {
        "detail": "Daily app comparison limit reached (10)"
    }
    assert len(calls) == 1


def test_app_monthly_limit_applies_across_accounts(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, month = current_periods()
    seed_counter(f"app:month:{month}", APP_MONTHLY_LIMIT - 1)
    first = create_user()
    second = create_user()
    first_job = prepare(client, first)
    second_job = prepare(client, second)
    calls = mock_success(monkeypatch)

    accepted = client.post(f"/jobs/{first_job}/compare", headers=first)
    rejected = client.post(f"/jobs/{second_job}/compare", headers=second)

    assert accepted.status_code == 200
    assert rejected.status_code == 429
    assert rejected.json() == {
        "detail": "Monthly app comparison limit reached (50)"
    }
    assert len(calls) == 1


def test_simultaneous_requests_cannot_exceed_shared_limit(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = [create_user() for _ in range(4)]
    jobs = [prepare(client, headers) for headers in users]
    calls = mock_success(monkeypatch)

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [
            pool.submit(
                client.post,
                f"/jobs/{jobs[index]}/compare",
                headers=users[index],
            )
            for index in range(4)
            for _ in range(3)
        ]
        responses = [future.result() for future in futures]

    assert sorted(response.status_code for response in responses) == (
        [200] * APP_DAILY_LIMIT + [429] * 2
    )
    assert len(calls) == APP_DAILY_LIMIT
    day, month = current_periods()
    with Session(get_engine()) as session:
        assert session.get(
            AIUsageCounter, f"app:day:{day}"
        ).call_count == APP_DAILY_LIMIT
        assert session.get(
            AIUsageCounter, f"app:month:{month}"
        ).call_count == APP_DAILY_LIMIT


def test_provider_failures_consume_attempts_without_retries(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    attempts = []

    def fail(*_: object, **__: object) -> None:
        attempts.append(1)
        raise httpx.ConnectError("provider failed with private data")

    monkeypatch.setattr("comparison._post_once", fail)
    codes = [
        client.post(f"/jobs/{job_id}/compare", headers=headers).status_code
        for _ in range(4)
    ]

    assert codes == [502, 502, 502, 429]
    assert len(attempts) == 3


def test_http_transport_explicitly_disables_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[object] = []

    def fake_transport(*, retries: int) -> object:
        seen.append(retries)
        return object()

    class FakeClient:
        def __init__(self, *, transport: object, timeout: float) -> None:
            seen.extend([transport, timeout])

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def post(self, url: str, *, headers: dict, json: dict) -> str:
            seen.extend([url, headers, json])
            return "sent once"

    monkeypatch.setattr("comparison.httpx.HTTPTransport", fake_transport)
    monkeypatch.setattr("comparison.httpx.Client", FakeClient)

    result = _post_once("https://example.invalid", headers={}, json={},
                        timeout=30.0)

    assert result == "sent once"
    assert seen[0] == 0
    assert len(seen) == 6


def test_successful_result_persists_as_private_history(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    calls = mock_success(monkeypatch)

    comparison = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert comparison.status_code == 200
    with TestClient(app) as fresh_client:
        history = fresh_client.get(
            f"/jobs/{job_id}/comparisons", headers=headers
        )
    assert history.status_code == 200
    assert len(history.json()) == 1
    saved = history.json()[0]
    assert saved["job_id"] == job_id
    assert saved["cv_outdated"] is False
    assert saved["result"] == comparison.json()
    assert datetime.fromisoformat(saved["created_at"]).tzinfo is not None
    assert len(calls) == 1
    assert client.get(
        f"/jobs/{job_id}/comparisons/{saved['id']}", headers=headers
    ).json() == saved
    with Session(get_engine()) as session:
        entry = session.get(ComparisonHistory, saved["id"])
        assert entry is not None
        assert entry.job_id == job_id
        assert entry.cv_revision == session.get(
            SavedCV, entry.user_id
        ).revision
        assert "cv_text" not in entry.result
        assert "job_description" not in entry.result
        assert entry.result == comparison.json()


def test_qualification_mismatch_returns_and_saves_incomplete_result(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(
        client, headers,
        cv_text="Built Python services. Diploma in engineering.",
        job_description=(
            "Python experience required. Engineering degree required."
        ),
    )
    references = {
        "matched_requirements": [
            {
                "requirement": label,
                "cv_evidence_id": f"cv_{index:04d}",
                "job_evidence_id": f"job_{index:04d}",
            }
            for index, label in enumerate(
                ("Python experience", "Engineering degree"), start=1
            )
        ],
        "possible_gaps": [],
    }
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison._post_once",
        lambda *_, **__: provider_response(references),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 200
    result = response.json()
    assert [
        item["requirement"] for item in result["matched_requirements"]
    ] == ["Python experience"]
    assert result["possible_gaps"] == []
    assert "comparison is incomplete" in result["interpretation"]
    assert "Engineering degree" in result["interpretation"]
    assert "Other CV evidence" in result["interpretation"]
    history = client.get(
        f"/jobs/{job_id}/comparisons", headers=headers,
    )
    assert history.json()[0]["result"] == result


def test_history_list_and_view_enforce_job_and_comparison_ownership(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = create_user()
    other = create_user()
    owned_job = prepare(client, owner)
    another_owned_job = prepare(client, owner)
    other_job = prepare(client, other)
    calls = mock_success(monkeypatch)
    assert client.post(
        f"/jobs/{owned_job}/compare", headers=owner
    ).status_code == 200
    history_id = client.get(
        f"/jobs/{owned_job}/comparisons", headers=owner
    ).json()[0]["id"]

    assert client.get(
        f"/jobs/{owned_job}/comparisons", headers=other
    ).status_code == 404
    assert client.get(
        f"/jobs/{owned_job}/comparisons/{history_id}",
        headers=other,
    ).status_code == 404
    assert client.get(
        f"/jobs/{other_job}/comparisons", headers=owner
    ).status_code == 404
    assert client.get(
        f"/jobs/{another_owned_job}/comparisons/{history_id}",
        headers=owner,
    ).status_code == 404
    assert client.get(f"/jobs/{owned_job}/comparisons").status_code == 401
    assert client.get(
        f"/jobs/{owned_job}/comparisons/{history_id}"
    ).status_code == 401
    assert len(calls) == 1


@pytest.mark.parametrize("failure", ["provider", "invalid"])
def test_failed_comparison_creates_no_history(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    if failure == "provider":
        def fake_post(*_: object, **__: object) -> None:
            raise httpx.ConnectError("provider unavailable")
    else:
        def fake_post(*_: object, **__: object) -> httpx.Response:
            return provider_response({"matched_requirements": []})
    monkeypatch.setattr("comparison._post_once", fake_post)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert client.get(
        f"/jobs/{job_id}/comparisons", headers=headers
    ).json() == []
    with Session(get_engine()) as session:
        assert session.query(ComparisonHistory).count() == 0


def test_history_marks_replaced_or_deleted_cv_as_outdated(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    mock_success(monkeypatch)
    assert client.post(
        f"/jobs/{job_id}/compare", headers=headers
    ).status_code == 200
    history_id = client.get(
        f"/jobs/{job_id}/comparisons", headers=headers
    ).json()[0]["id"]
    path = f"/jobs/{job_id}/comparisons/{history_id}"
    assert client.get(path, headers=headers).json()["cv_outdated"] is False

    assert client.put(
        "/cv", json={"text": "A different fictional CV"},
        headers=headers,
    ).status_code == 200
    assert client.get(path, headers=headers).json()["cv_outdated"] is True
    assert client.get(
        f"/jobs/{job_id}/comparisons", headers=headers
    ).json()[0]["cv_outdated"] is True

    assert client.delete("/cv", headers=headers).status_code == 204
    assert client.get(path, headers=headers).json()["cv_outdated"] is True
    assert client.put(
        "/cv", json={"text": CV_TEXT}, headers=headers
    ).status_code == 200
    assert client.get(path, headers=headers).json()["cv_outdated"] is True


def test_deleting_a_job_removes_its_history(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    mock_success(monkeypatch)
    assert client.post(
        f"/jobs/{job_id}/compare", headers=headers
    ).status_code == 200
    with Session(get_engine()) as session:
        entry_id = session.query(ComparisonHistory).one().id

    assert client.delete(f"/jobs/{job_id}", headers=headers).status_code == 204

    with Session(get_engine()) as session:
        assert session.get(ComparisonHistory, entry_id) is None


def test_history_lists_multiple_results_newest_first(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    calls = mock_success(monkeypatch)
    path = f"/jobs/{job_id}/compare"

    assert client.post(path, headers=headers).status_code == 200
    assert client.post(path, headers=headers).status_code == 200

    history = client.get(
        f"/jobs/{job_id}/comparisons", headers=headers
    ).json()
    assert len(history) == 2
    assert history[0]["id"] > history[1]["id"]
    assert all(entry["cv_outdated"] is False for entry in history)
    assert len(calls) == 2


def test_cv_replacement_during_provider_call_marks_result_outdated(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")

    def replace_cv(*_: object, **__: object) -> httpx.Response:
        with TestClient(app) as second_client:
            changed = second_client.put(
                "/cv",
                json={"text": "A revised fictional CV"},
                headers=headers,
            )
            assert changed.status_code == 200
        return provider_response(PROVIDER_REFERENCES)

    monkeypatch.setattr("comparison._post_once", replace_cv)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 200
    history = client.get(
        f"/jobs/{job_id}/comparisons", headers=headers
    ).json()
    assert len(history) == 1
    assert history[0]["cv_outdated"] is True
