import json
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func
from sqlalchemy.orm import Session

from database import get_engine
from main import app
from ai_usage import APP_DAILY_LIMIT, APP_MONTHLY_LIMIT, LOCK_KEY
from comparison import (
    MAX_CV_BYTES,
    MAX_CV_CHARS,
    MAX_JOB_BYTES,
    MAX_JOB_CHARS,
    MAX_OUTPUT_TOKENS,
    _post_once,
)
from models import AIUsageCounter, User

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
            "job_evidence": "Build Python APIs",
            "cv_evidence": "Built Python APIs",
        }
    ],
    "possible_gaps": [
        {
            "requirement": "Kubernetes",
            "job_evidence": "Deploy services with Kubernetes",
            "status": "not_found_in_cv",
        }
    ],
}


@pytest.fixture(autouse=True)
def reset_ai_usage(
    monkeypatch: pytest.MonkeyPatch,
    migrated_test_database: None,
) -> Iterator[None]:
    monkeypatch.setenv("AI_COMPARISON_ENABLED", "true")
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
    client: TestClient, headers: dict[str, str], *, cv: bool = True
) -> int:
    if cv:
        assert (
            client.put(
                "/cv", json={"text": CV_TEXT}, headers=headers
            ).status_code
            == 200
        )
    response = client.post("/jobs", json=JOB, headers=headers)
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
        return provider_response(PROVIDER_RESULT)

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
        return provider_response(PROVIDER_RESULT)

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
        "cv_text": CV_TEXT,
        "job_description": JOB_DESCRIPTION,
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
        {**PROVIDER_RESULT, "score": 95},
        {
            "matched_requirements": [
                {
                    **PROVIDER_RESULT["matched_requirements"][0],
                    "cv_evidence": "Invented experience",
                }
            ],
            "possible_gaps": [],
        },
        {
            "matched_requirements": [],
            "possible_gaps": [
                {
                    **PROVIDER_RESULT["possible_gaps"][0],
                    "status": "lacks_skill",
                }
            ],
        },
        {
            "matched_requirements": [],
            "possible_gaps": [
                {**PROVIDER_RESULT["possible_gaps"][0], "requirement": "  "}
            ],
        },
    ],
)
def test_malformed_provider_output_has_generic_error(
    client: TestClient,
    create_user: Callable[[], dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    bad_result: dict,
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
