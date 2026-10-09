import os

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

    def __init__(self, *args, **kwargs):
        headers = {
            "Origin": "http://127.0.0.1:5173",
            "X-CSRF-Protection": "1",
            **kwargs.pop("headers", {}),
        }
        super().__init__(*args, headers=headers, **kwargs)


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
