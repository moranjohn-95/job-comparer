from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from starlette.requests import Request

from auth import verify_password
from auth_rate_limit import (
    LOGIN_EMAIL_ATTEMPT_LIMIT,
    LOGIN_IP_ATTEMPT_LIMIT,
    LOGIN_WINDOW,
    SIGNUP_ATTEMPT_LIMIT,
    login_email_scope,
)
from database import get_engine
from main import app, client_ip
from models import AuthRateLimitCounter, User

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
    response = client.post(
        "/signup", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 201


def test_signup_hashes_password_and_returns_public_user(
    client: TestClient, email: str
) -> None:
    response = client.post(
        "/signup", json={"email": email.upper(), "password": PASSWORD}
    )

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

    response = client.post(
        "/login", json={"email": email, "password": PASSWORD}
    )

    assert response.status_code == 200
    assert response.json()["token_type"] == "bearer"
    assert isinstance(response.json()["access_token"], str)
    assert PASSWORD not in response.text


def test_duplicate_email_is_rejected(client: TestClient, email: str) -> None:
    signup(client, email)

    response = client.post(
        "/signup", json={"email": email.upper(), "password": PASSWORD}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Email is already registered"}


@pytest.mark.parametrize("wrong_field", ["email", "password"])
def test_invalid_login_is_rejected(
    client: TestClient, email: str, wrong_field: str
) -> None:
    signup(client, email)
    credentials = {"email": email, "password": PASSWORD}
    credentials[wrong_field] = (
        "someone-else@example.com"
        if wrong_field == "email"
        else "wrong-password"
    )

    response = client.post("/login", json=credentials)

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid email or password"}


def test_login_email_limit_uses_normalized_email_and_returns_generic_429(
    client: TestClient, email: str
) -> None:
    for _ in range(LOGIN_EMAIL_ATTEMPT_LIMIT):
        response = client.post(
            "/login",
            json={"email": email.upper(), "password": "wrong-password"},
        )
        assert response.status_code == 401

    response = client.post(
        "/login", json={"email": email, "password": "wrong-password"}
    )

    assert response.status_code == 429
    assert response.json() == {
        "detail": "Too many authentication attempts. Please try again later."
    }


def test_login_limit_resets_in_a_new_window(
    client: TestClient, email: str
) -> None:
    old_window = datetime.now(timezone.utc) - LOGIN_WINDOW - timedelta(minutes=1)
    with Session(get_engine()) as session:
        session.add(
            AuthRateLimitCounter(
                counter_key=f"{login_email_scope(email)}:{old_window.isoformat()}",
                attempt_count=LOGIN_EMAIL_ATTEMPT_LIMIT,
            )
        )
        session.commit()

    response = client.post(
        "/login", json={"email": email, "password": "wrong-password"}
    )

    assert response.status_code == 401


def test_changing_email_does_not_bypass_login_ip_limit() -> None:
    with TestClient(app, client=("198.51.100.10", 50000)) as client:
        for _ in range(LOGIN_IP_ATTEMPT_LIMIT):
            response = client.post(
                "/login",
                json={
                    "email": f"ip-limit-{uuid4().hex}@example.com",
                    "password": "wrong-password",
                },
            )
            assert response.status_code == 401

        response = client.post(
            "/login",
            json={
                "email": f"ip-limit-{uuid4().hex}@example.com",
                "password": "wrong-password",
            },
        )

    assert response.status_code == 429


def test_changing_ip_does_not_bypass_login_email_limit() -> None:
    email = f"email-limit-{uuid4().hex}@example.com"
    for index in range(LOGIN_EMAIL_ATTEMPT_LIMIT):
        with TestClient(app, client=(f"198.51.100.{index + 20}", 50000)) as client:
            response = client.post(
                "/login", json={"email": email, "password": "wrong-password"}
            )
            assert response.status_code == 401

    with TestClient(app, client=("198.51.100.30", 50000)) as client:
        response = client.post(
            "/login", json={"email": email, "password": "wrong-password"}
        )

    assert response.status_code == 429


def test_signup_limit_is_per_ip(client: TestClient) -> None:
    for _ in range(SIGNUP_ATTEMPT_LIMIT):
        response = client.post(
            "/signup",
            json={
                "email": f"signup-limit-{uuid4().hex}@example.com",
                "password": PASSWORD,
            },
        )
        assert response.status_code == 201

    response = client.post(
        "/signup",
        json={
            "email": f"signup-limit-{uuid4().hex}@example.com",
            "password": PASSWORD,
        },
    )

    assert response.status_code == 429
    assert response.json() == {
        "detail": "Too many authentication attempts. Please try again later."
    }


def test_forwarded_ip_is_used_only_for_a_trusted_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1")
    scope = {
        "type": "http",
        "client": ("10.0.0.1", 443),
        "headers": [(b"x-forwarded-for", b"198.51.100.8, 10.0.0.2")],
    }
    assert client_ip(Request(scope)) == "198.51.100.8"

    scope["client"] = ("198.51.100.9", 443)
    assert client_ip(Request(scope)) == "198.51.100.9"


def test_me_requires_authentication(client: TestClient) -> None:
    response = client.get("/me")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_me_returns_authenticated_user(client: TestClient, email: str) -> None:
    signup(client, email)
    token = client.post(
        "/login", json={"email": email, "password": PASSWORD}
    ).json()["access_token"]

    response = client.get("/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json() == {"id": response.json()["id"], "email": email}
    assert PASSWORD not in response.text


def test_me_rejects_invalid_token(client: TestClient) -> None:
    response = client.get(
        "/me", headers={"Authorization": "Bearer invalid-token"}
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired token"}


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": PASSWORD},
        {"email": "valid@example.com", "password": "short"},
    ],
)
def test_signup_validates_inputs(
    client: TestClient, payload: dict[str, str]
) -> None:
    response = client.post("/signup", json=payload)

    assert response.status_code == 422
