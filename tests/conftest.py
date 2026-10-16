import os
import re
import smtplib

import boto3
import botocore.client
import botocore.httpsession
import dotenv
import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

_isolation = pytest.MonkeyPatch()
_unexpected_external_calls: list[str] = []


def block_external_call(*args, **kwargs):
    # Never retain request arguments: they may include private content.
    _unexpected_external_calls.append("Unexpected external-service call")
    raise RuntimeError("External services must be mocked in backend tests")


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
    # Install before application imports/collection, not just fixture setup.
    # Database configuration must be explicitly supplied to the test process.
    _isolation.setattr(dotenv, "load_dotenv", lambda *a, **kw: False)
    for name in tuple(os.environ):
        if name.startswith(("AWS_", "BOTO_", "DELETION_LEDGER_",
                            "OPENAI_", "SMTP_", "AI_")):
            _isolation.delenv(name)
    for name, value in {
        "AWS_ACCESS_KEY_ID": "test-only",
        "AWS_SECRET_ACCESS_KEY": "test-only",
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_CONFIG_FILE": os.devnull,
        "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
        "BOTO_CONFIG": os.devnull,
        "AWS_DEFAULT_REGION": "eu-west-1",
        "DELETION_LEDGER_BUCKET": "test-only-deletion-ledger",
        "DELETION_LEDGER_REGION": "eu-west-1",
        "DELETION_LEDGER_PREFIX": "test/account-deletions/v1/",
        "DELETION_LEDGER_DATASET_ID":
            "a49de592-fabd-4ca6-93d3-227fa652ab9b",
        "OPENAI_API_KEY": "test-provider-key",
        "OPENAI_MODEL": "gpt-6.1-sol",
        "AI_COMPARISON_ENABLED": "false",
    }.items():
        _isolation.setenv(name, value)
    _isolation.setattr(boto3, "DEFAULT_SESSION", None)
    _isolation.setattr(botocore.client.BaseClient, "_make_api_call",
                       block_external_call)
    # Also blocks metadata/credential HTTP even if no AWS API call is made.
    _isolation.setattr(botocore.httpsession.URLLib3Session, "send",
                       block_external_call)
    _isolation.setattr(httpx.HTTPTransport, "handle_request",
                       block_external_call)
    _isolation.setattr(httpx.AsyncHTTPTransport, "handle_async_request",
                       block_external_call)
    _isolation.setattr(smtplib.SMTP, "connect", block_external_call)

    from database import get_engine, get_test_database_url

    try:
        test_url = get_test_database_url()
    except (RuntimeError, ValueError) as error:
        raise pytest.UsageError(str(error)) from error
    os.environ["DATABASE_URL"] = test_url
    os.environ["APP_ENV"] = "development"
    os.environ["SESSION_COOKIE_SECURE"] = "false"
    os.environ["AUTH_ALLOWED_ORIGINS"] = "http://127.0.0.1:5173"
    get_engine.cache_clear()


def pytest_collection_finish() -> None:
    if _unexpected_external_calls:
        raise pytest.UsageError("External-service call during collection")


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_teardown():
    try:
        yield
    finally:
        if _unexpected_external_calls:
            _unexpected_external_calls.clear()
            pytest.fail("Unexpected external-service call (even if caught)")


def pytest_unconfigure() -> None:
    _isolation.undo()


@pytest.fixture(scope="session", autouse=True)
def migrated_test_database() -> None:
    from database import assert_test_connection, get_engine

    engine = get_engine()
    with engine.connect() as connection:
        assert_test_connection(connection)
    command.upgrade(Config("alembic.ini"), "head")


@pytest.fixture(autouse=True)
def clear_auth_rate_limits(migrated_test_database) -> None:
    from database import get_engine
    from models import AuthRateLimitCounter

    with Session(get_engine()) as session:
        session.execute(delete(AuthRateLimitCounter))
        session.commit()
