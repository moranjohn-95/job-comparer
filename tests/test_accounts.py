from collections.abc import Iterator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from auth import verify_password
from database import get_engine
from main import app
from models import User

PASSWORD = "correct-horse-battery-123"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def email() -> Iterator[str]:
    address = f"account-test-{uuid4().hex}@example.com"
    yield address
    with Session(get_engine()) as session:
        session.execute(delete(User).where(User.email == address))
        session.commit()


def signup(client: TestClient, email: str) -> None:
    response = client.post("/signup", json={"email": email, "password": PASSWORD})
    assert response.status_code == 201


def test_signup_hashes_password_and_returns_public_user(client: TestClient, email: str) -> None:
    response = client.post("/signup", json={"email": email.upper(), "password": PASSWORD})

    assert response.status_code == 201
    assert response.json() == {"id": response.json()["id"], "email": email}
    assert PASSWORD not in response.text
    with Session(get_engine()) as session:
        user = session.scalar(select(User).where(User.email == email))
        assert user is not None
        assert user.password_hash != PASSWORD
        assert verify_password(PASSWORD, user.password_hash)


def test_login_returns_bearer_token(client: TestClient, email: str) -> None:
    signup(client, email)

    response = client.post("/login", json={"email": email, "password": PASSWORD})

    assert response.status_code == 200
    assert response.json()["token_type"] == "bearer"
    assert isinstance(response.json()["access_token"], str)
    assert PASSWORD not in response.text


def test_duplicate_email_is_rejected(client: TestClient, email: str) -> None:
    signup(client, email)

    response = client.post("/signup", json={"email": email.upper(), "password": PASSWORD})

    assert response.status_code == 409
    assert response.json() == {"detail": "Email is already registered"}


@pytest.mark.parametrize("wrong_field", ["email", "password"])
def test_invalid_login_is_rejected(client: TestClient, email: str, wrong_field: str) -> None:
    signup(client, email)
    credentials = {"email": email, "password": PASSWORD}
    credentials[wrong_field] = "someone-else@example.com" if wrong_field == "email" else "wrong-password"

    response = client.post("/login", json=credentials)

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid email or password"}


def test_me_requires_authentication(client: TestClient) -> None:
    response = client.get("/me")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_me_returns_authenticated_user(client: TestClient, email: str) -> None:
    signup(client, email)
    token = client.post("/login", json={"email": email, "password": PASSWORD}).json()["access_token"]

    response = client.get("/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json() == {"id": response.json()["id"], "email": email}
    assert PASSWORD not in response.text


def test_me_rejects_invalid_token(client: TestClient) -> None:
    response = client.get("/me", headers={"Authorization": "Bearer invalid-token"})

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired token"}


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": PASSWORD},
        {"email": "valid@example.com", "password": "short"},
    ],
)
def test_signup_validates_inputs(client: TestClient, payload: dict[str, str]) -> None:
    response = client.post("/signup", json=payload)

    assert response.status_code == 422
