import os
import re

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

from database import assert_test_connection, get_engine, get_test_database_url
from models import AuthRateLimitCounter


class BrowserClient(TestClient):
    """Browser-style requests with the app's explicit forgery protection."""
    outbox: list[tuple[str, str, str]] = []

    def __init__(self, *args, **kwargs):
        headers = {
            "Origin": "http://127.0.0.1:5173",
            "X-CSRF-Protection": "1",
            **kwargs.pop("headers", {}),
        }
        super().__init__(*args, headers=headers, **kwargs)


def signup_verified(client: BrowserClient, email: str, password: str) -> None:
    response = client.post("/signup", json={
        "email": email, "password": password,
    })
    assert response.status_code == 202
    body = next(body for to, _, body in reversed(client.outbox) if to == email)
    token = re.search(r"#token=([A-Za-z0-9_-]{43})", body).group(1)
    verified = client.post("/verification/confirm", json={
        "token": token, "password": password,
    })
    assert verified.status_code == 200


@pytest.fixture(autouse=True)
def mail_outbox(monkeypatch):
    messages = []
    monkeypatch.setenv("PUBLIC_FRONTEND_URL", "http://127.0.0.1:5173")
    monkeypatch.setenv("EMAIL_VERIFICATION_LIFETIME_SECONDS", "86400")
    monkeypatch.setattr(BrowserClient, "outbox", messages)
    monkeypatch.setattr("email_verification.send_email",
                        lambda to, subject, body: messages.append(
                            (to, subject, body)
                        ))
    return messages


def pytest_configure() -> None:
    try:
        test_url = get_test_database_url()
    except (RuntimeError, ValueError) as error:
        raise pytest.UsageError(str(error)) from error
    os.environ["DATABASE_URL"] = test_url
    os.environ["APP_ENV"] = "development"
    os.environ["SESSION_COOKIE_SECURE"] = "false"
    os.environ["AUTH_ALLOWED_ORIGINS"] = "http://127.0.0.1:5173"
    get_engine.cache_clear()


@pytest.fixture(scope="session", autouse=True)
def migrated_test_database() -> None:
    engine = get_engine()
    with engine.connect() as connection:
        assert_test_connection(connection)
    command.upgrade(Config("alembic.ini"), "head")


@pytest.fixture(autouse=True)
def clear_auth_rate_limits() -> None:
    with Session(get_engine()) as session:
        session.execute(delete(AuthRateLimitCounter))
        session.commit()
