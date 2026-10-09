from collections.abc import Callable, Iterator
from uuid import uuid4

import pytest
from conftest import BrowserClient as TestClient, signup_verified
from sqlalchemy import delete
from sqlalchemy.orm import Session

from database import get_engine
from main import (
    MAX_JOB_COMPANY_LENGTH,
    MAX_JOB_DESCRIPTION_LENGTH,
    MAX_JOB_TITLE_LENGTH,
    MAX_JOB_URL_LENGTH,
    app,
)
from models import SavedJob, User

PASSWORD = "correct-horse-battery-123"
JOB = {
    "title": "Backend Engineer",
    "company_name": "Example Co",
    "description": "Build reliable APIs with Python and PostgreSQL.",
    "source_url": "https://example.invalid/jobs/123",
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def create_user(
    client: TestClient,
) -> Iterator[Callable[[], tuple[int, dict[str, str]]]]:
    emails: list[str] = []

    def create() -> tuple[int, dict[str, str]]:
        email = f"job-test-{uuid4().hex}@example.com"
        emails.append(email)
        signup_verified(client, email, PASSWORD)
        login = client.post(
            "/login", json={"email": email, "password": PASSWORD}
        )
        assert login.status_code == 200
        client.cookies.clear()
        return login.json()["id"], {
            "Cookie": (
                f"job_comparer_session={login.cookies['job_comparer_session']}"
            )
        }

    yield create
    with Session(get_engine()) as session:
        session.execute(delete(User).where(User.email.in_(emails)))
        session.commit()


def test_create_persists_job_and_views_it(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    user_id, headers = create_user()

    created = client.post("/jobs", json=JOB, headers=headers)

    assert created.status_code == 201
    job_id = created.json()["id"]
    assert created.json() == {"id": job_id, **JOB}
    assert (
        client.get(f"/jobs/{job_id}", headers=headers).json() == created.json()
    )
    with Session(get_engine()) as session:
        saved = session.get(SavedJob, job_id)
        assert saved is not None
        assert saved.user_id == user_id
        assert saved.description == JOB["description"]
        assert saved.source_url == JOB["source_url"]


def test_list_returns_only_own_jobs_newest_first_and_allows_no_url(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    _, headers = create_user()
    first = client.post("/jobs", json=JOB, headers=headers).json()
    second_payload = {
        "title": "Data Engineer",
        "company_name": "Other Co",
        "description": "Build pipelines.",
    }
    second_response = client.post(
        "/jobs", json=second_payload, headers=headers
    )

    assert second_response.status_code == 201
    second = second_response.json()
    assert second["source_url"] is None
    assert client.get("/jobs", headers=headers).json() == [second, first]


def test_delete_removes_only_the_owned_job(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    _, headers = create_user()
    job_id = client.post("/jobs", json=JOB, headers=headers).json()["id"]

    deleted = client.delete(f"/jobs/{job_id}", headers=headers)

    assert deleted.status_code == 204
    assert client.get(f"/jobs/{job_id}", headers=headers).status_code == 404
    assert client.get("/jobs", headers=headers).json() == []
    with Session(get_engine()) as session:
        assert session.get(SavedJob, job_id) is None


@pytest.mark.parametrize(
    "payload",
    [
        {
            "company_name": JOB["company_name"],
            "description": JOB["description"],
        },
        {"title": JOB["title"], "description": JOB["description"]},
        {"title": JOB["title"], "company_name": JOB["company_name"]},
        {**JOB, "title": " \t "},
        {**JOB, "company_name": " \n "},
        {**JOB, "description": " \n "},
        {**JOB, "title": "x" * (MAX_JOB_TITLE_LENGTH + 1)},
        {**JOB, "company_name": "x" * (MAX_JOB_COMPANY_LENGTH + 1)},
        {**JOB, "description": "x" * (MAX_JOB_DESCRIPTION_LENGTH + 1)},
        {**JOB, "source_url": "x" * (MAX_JOB_URL_LENGTH + 1)},
        {**JOB, "source_url": "file:///private/path"},
        {**JOB, "source_url": "https://"},
        {**JOB, "source_url": "https://example.com/bad path"},
    ],
    ids=[
        "missing-title",
        "missing-company",
        "missing-description",
        "blank-title",
        "blank-company",
        "blank-description",
        "long-title",
        "long-company",
        "long-description",
        "long-url",
        "unsupported-url-scheme",
        "url-without-host",
        "url-with-space",
    ],
)
def test_invalid_jobs_are_rejected_without_saving(
    client: TestClient,
    create_user: Callable[[], tuple[int, dict[str, str]]],
    payload: dict[str, str],
) -> None:
    _, headers = create_user()

    response = client.post("/jobs", json=payload, headers=headers)

    assert response.status_code == 422
    assert response.json()["detail"]
    assert client.get("/jobs", headers=headers).json() == []


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/jobs"),
        ("GET", "/jobs"),
        ("GET", "/jobs/1"),
        ("DELETE", "/jobs/1"),
    ],
)
def test_job_endpoints_require_authentication(
    client: TestClient, method: str, path: str
) -> None:
    response = client.request(
        method, path, json=JOB if method == "POST" else None
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_two_users_cannot_list_view_or_delete_each_others_jobs(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    _, first_headers = create_user()
    _, second_headers = create_user()
    first_job = client.post("/jobs", json=JOB, headers=first_headers).json()
    first_id = first_job["id"]

    assert client.get("/jobs", headers=second_headers).json() == []
    assert (
        client.get(f"/jobs/{first_id}", headers=second_headers).status_code
        == 404
    )
    assert (
        client.delete(f"/jobs/{first_id}", headers=second_headers).status_code
        == 404
    )
    assert (
        client.get(f"/jobs/{first_id}", headers=first_headers).json()
        == first_job
    )

    second_job = client.post(
        "/jobs", json={**JOB, "title": "Private role"}, headers=second_headers
    ).json()
    assert client.get("/jobs", headers=first_headers).json() == [first_job]
    assert client.get("/jobs", headers=second_headers).json() == [second_job]
    assert (
        client.get(
            f"/jobs/{second_job['id']}", headers=first_headers
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/jobs/{second_job['id']}", headers=first_headers
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/jobs/{second_job['id']}", headers=second_headers
        ).status_code
        == 204
    )
    assert (
        client.get(f"/jobs/{first_id}", headers=first_headers).json()
        == first_job
    )
