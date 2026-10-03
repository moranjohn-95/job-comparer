import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete
from sqlalchemy.orm import Session

from database import assert_test_connection, get_engine, get_test_database_url
from models import AuthRateLimitCounter


def pytest_configure() -> None:
    try:
        test_url = get_test_database_url()
    except (RuntimeError, ValueError) as error:
        raise pytest.UsageError(str(error)) from error
    os.environ["DATABASE_URL"] = test_url
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
