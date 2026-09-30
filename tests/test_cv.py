from collections.abc import Callable, Iterator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from database import get_engine
from main import MAX_CV_LENGTH, app
from models import SavedCV, User

PASSWORD = "correct-horse-battery-123"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def create_user(client: TestClient) -> Iterator[Callable[[], tuple[int, dict[str, str]]]]:
    emails: list[str] = []

    def create() -> tuple[int, dict[str, str]]:
        email = f"cv-test-{uuid4().hex}@example.com"
        emails.append(email)
        signup = client.post("/signup", json={"email": email, "password": PASSWORD})
        assert signup.status_code == 201
        login = client.post("/login", json={"email": email, "password": PASSWORD})
        assert login.status_code == 200
        return signup.json()["id"], {"Authorization": f"Bearer {login.json()['access_token']}"}

    yield create
    with Session(get_engine()) as session:
        session.execute(delete(User).where(User.email.in_(emails)))
        session.commit()


def test_cv_persists_across_requests_and_in_database(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    user_id, headers = create_user()
    cv_text = "Software engineer\nPython and PostgreSQL experience"

    saved = client.put("/cv", json={"text": cv_text}, headers=headers)
    retrieved = client.get("/cv", headers=headers)

    assert saved.status_code == 200
    assert saved.json() == {"text": cv_text}
    assert retrieved.status_code == 200
    assert retrieved.json() == {"text": cv_text}
    with Session(get_engine()) as session:
        assert session.get(SavedCV, user_id).text == cv_text


def test_saving_again_replaces_the_only_cv(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    user_id, headers = create_user()
    assert client.put("/cv", json={"text": "First version"}, headers=headers).status_code == 200

    replaced = client.put("/cv", json={"text": "Updated version"}, headers=headers)

    assert replaced.status_code == 200
    assert client.get("/cv", headers=headers).json() == {"text": "Updated version"}
    with Session(get_engine()) as session:
        count = session.scalar(select(func.count()).select_from(SavedCV).where(SavedCV.user_id == user_id))
        assert count == 1


def test_delete_removes_the_saved_cv(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    user_id, headers = create_user()
    assert client.put("/cv", json={"text": "To delete"}, headers=headers).status_code == 200

    deleted = client.delete("/cv", headers=headers)
    missing = client.get("/cv", headers=headers)

    assert deleted.status_code == 204
    assert missing.status_code == 404
    assert missing.json() == {"detail": "CV not found"}
    with Session(get_engine()) as session:
        assert session.get(SavedCV, user_id) is None


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
def test_cv_endpoints_require_authentication(client: TestClient, method: str) -> None:
    body = {"text": "A valid CV"} if method == "PUT" else None

    response = client.request(method, "/cv", json=body)

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_users_cannot_read_or_change_each_others_cv(
    client: TestClient, create_user: Callable[[], tuple[int, dict[str, str]]]
) -> None:
    first_id, first_headers = create_user()
    _, second_headers = create_user()
    assert client.put("/cv", json={"text": "First user's private CV"}, headers=first_headers).status_code == 200

    assert client.get("/cv", headers=second_headers).status_code == 404
    spoofed = client.put(
        "/cv", json={"text": "Attempted overwrite", "user_id": first_id}, headers=second_headers
    )
    assert spoofed.status_code == 422
    assert client.get("/cv", headers=second_headers).status_code == 404

    assert client.put("/cv", json={"text": "Second user's CV"}, headers=second_headers).status_code == 200
    assert client.get("/cv", headers=first_headers).json() == {"text": "First user's private CV"}
    assert client.get("/cv", headers=second_headers).json() == {"text": "Second user's CV"}
    assert client.delete("/cv", headers=second_headers).status_code == 204
    assert client.get("/cv", headers=first_headers).json() == {"text": "First user's private CV"}


@pytest.mark.parametrize(
    "invalid_text,detail",
    [
        ("", "CV text must not be blank"),
        (" \t\n ", "CV text must not be blank"),
        ("x" * (MAX_CV_LENGTH + 1), f"CV text exceeds {MAX_CV_LENGTH} characters"),
    ],
    ids=["empty", "whitespace", "too-long"],
)
def test_invalid_cv_does_not_replace_existing_text(
    client: TestClient,
    create_user: Callable[[], tuple[int, dict[str, str]]],
    invalid_text: str,
    detail: str,
) -> None:
    _, headers = create_user()
    assert client.put("/cv", json={"text": "Valid CV"}, headers=headers).status_code == 200

    response = client.put("/cv", json={"text": invalid_text}, headers=headers)

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert client.get("/cv", headers=headers).json() == {"text": "Valid CV"}
