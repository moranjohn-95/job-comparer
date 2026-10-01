import os
from functools import lru_cache
from typing import Iterator

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.orm import DeclarativeBase, Session

load_dotenv()


class Base(DeclarativeBase):
    pass


def get_database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and "
            "configure it."
        )
    return url


def get_test_database_url() -> str:
    test_url = os.getenv("TEST_DATABASE_URL")
    development_name = os.getenv("POSTGRES_DB")
    test_name = os.getenv("POSTGRES_TEST_DB")
    if not test_url or not development_name or not test_name:
        raise RuntimeError(
            "Set TEST_DATABASE_URL, POSTGRES_TEST_DB, and POSTGRES_DB in .env."
        )
    if test_name == development_name:
        raise RuntimeError(
            "The test database name must differ from the development "
            "database name."
        )
    if make_url(get_database_url()).database != development_name:
        raise RuntimeError(
            "DATABASE_URL must point to POSTGRES_DB before running tests."
        )
    if make_url(test_url).database != test_name:
        raise RuntimeError("TEST_DATABASE_URL must point to POSTGRES_TEST_DB.")
    return test_url


def assert_test_connection(connection: Connection) -> None:
    actual_name = connection.scalar(text("SELECT current_database()"))
    test_name = os.getenv("POSTGRES_TEST_DB")
    development_name = os.getenv("POSTGRES_DB")
    if actual_name != test_name or actual_name == development_name:
        raise RuntimeError(
            "Refusing database tests or migrations: connected to "
            f"{actual_name!r}, expected test database {test_name!r} "
            f"(development database: {development_name!r})."
        )


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_database_url(), pool_pre_ping=True)


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session
