import json
from collections.abc import Callable, Iterator
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

from database import get_engine
from main import app
from models import User


PASSWORD = "correct-horse-battery-123"
CV_TEXT = "Built Python APIs and maintained PostgreSQL databases."
JOB_DESCRIPTION = "Build Python APIs. Deploy services with Kubernetes."
JOB = {"title": "Backend Engineer", "company_name": "Example Co", "description": JOB_DESCRIPTION}
PROVIDER_RESULT = {
    "matched_requirements": [
        {"requirement": "Python APIs", "job_evidence": "Build Python APIs", "cv_evidence": "Built Python APIs"}
    ],
    "possible_gaps": [
        {
            "requirement": "Kubernetes",
            "job_evidence": "Deploy services with Kubernetes",
            "status": "not_found_in_cv",
        }
    ],
}


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
        assert client.post("/signup", json={"email": email, "password": PASSWORD}).status_code == 201
        login = client.post("/login", json={"email": email, "password": PASSWORD})
        assert login.status_code == 200
        return {"Authorization": f"Bearer {login.json()['access_token']}"}

    yield create
    with Session(get_engine()) as session:
        session.execute(delete(User).where(User.email.in_(emails)))
        session.commit()


def prepare(client: TestClient, headers: dict[str, str], *, cv: bool = True) -> int:
    if cv:
        assert client.put("/cv", json={"text": CV_TEXT}, headers=headers).status_code == 200
    response = client.post("/jobs", json=JOB, headers=headers)
    assert response.status_code == 201
    return response.json()["id"]


def provider_response(result: dict) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}],
        },
        request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
    )


def test_comparison_returns_grounded_result_and_sends_only_owned_text(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    seen = []

    def fake_post(url: str, *, headers: dict, json: dict, timeout: float) -> httpx.Response:
        seen.append((url, headers, json, timeout))
        return provider_response(PROVIDER_RESULT)

    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr("comparison.httpx.post", fake_post)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 200
    result = response.json()
    assert result["matched_requirements"] == PROVIDER_RESULT["matched_requirements"]
    assert result["possible_gaps"] == PROVIDER_RESULT["possible_gaps"]
    assert "does not establish that the person lacks the skill" in result["interpretation"]
    assert "score" not in result
    assert len(seen) == 1
    url, provider_headers, payload, timeout = seen[0]
    assert url == "https://api.openai.com/v1/responses"
    assert provider_headers == {"Authorization": "Bearer test-provider-key"}
    assert payload["model"] == "gpt-4o-mini"
    assert payload["store"] is False
    assert payload["text"]["format"]["strict"] is True
    assert json.loads(payload["input"][1]["content"]) == {
        "cv_text": CV_TEXT,
        "job_description": JOB_DESCRIPTION,
    }
    assert timeout == 30.0


def test_missing_cv_does_not_call_provider(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = create_user()
    job_id = prepare(client, headers, cv=False)
    monkeypatch.setattr("main.compare", lambda *_: pytest.fail("provider called"))

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 404
    assert response.json() == {"detail": "CV not found"}


def test_other_users_job_is_hidden_before_provider_call(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = create_user()
    other = create_user()
    job_id = prepare(client, owner)
    assert client.put("/cv", json={"text": "A different private CV"}, headers=other).status_code == 200
    monkeypatch.setattr("main.compare", lambda *_: pytest.fail("provider called"))

    response = client.post(f"/jobs/{job_id}/compare", headers=other)

    assert response.status_code == 404
    assert response.json() == {"detail": "Job not found"}


def test_unauthenticated_comparison_is_rejected(client: TestClient) -> None:
    response = client.post("/jobs/1/compare")
    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


@pytest.mark.parametrize(
    "bad_result",
    [
        {**PROVIDER_RESULT, "score": 95},
        {"matched_requirements": [{**PROVIDER_RESULT["matched_requirements"][0], "cv_evidence": "Invented experience"}], "possible_gaps": []},
        {"matched_requirements": [], "possible_gaps": [{**PROVIDER_RESULT["possible_gaps"][0], "status": "lacks_skill"}]},
        {"matched_requirements": [], "possible_gaps": [{**PROVIDER_RESULT["possible_gaps"][0], "requirement": "  "}]},
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
    monkeypatch.setattr("comparison.httpx.post", lambda *_, **__: provider_response(bad_result))

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {"detail": "AI provider returned an invalid comparison"}
    assert CV_TEXT not in response.text


def test_provider_failure_does_not_expose_cv_or_provider_error(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")

    def failed_post(*_: object, **__: object) -> None:
        raise httpx.ConnectError(f"provider failed with {CV_TEXT}")

    monkeypatch.setattr("comparison.httpx.post", failed_post)

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {"detail": "AI provider is unavailable"}
    assert CV_TEXT not in response.text


def test_incomplete_provider_response_is_rejected(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison.httpx.post",
        lambda *_, **__: httpx.Response(
            200,
            json={"status": "incomplete", "output": []},
            request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
        ),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {"detail": "AI provider returned an invalid comparison"}


def test_non_json_provider_response_is_rejected(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "test-provider-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr(
        "comparison.httpx.post",
        lambda *_, **__: httpx.Response(
            200,
            content=b"not JSON",
            request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
        ),
    )

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 502
    assert response.json() == {"detail": "AI provider returned an invalid comparison"}


def test_unconfigured_provider_returns_clear_error_without_request(
    client: TestClient, create_user: Callable[[], dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = create_user()
    job_id = prepare(client, headers)
    monkeypatch.setenv("OPENAI_API_KEY", "replace-with-your-api-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setattr("comparison.httpx.post", lambda *_, **__: pytest.fail("provider called"))

    response = client.post(f"/jobs/{job_id}/compare", headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "AI provider is not configured"}
