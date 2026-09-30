import os

from sqlalchemy import text

from database import get_engine


def test_development_database_connection() -> None:
    expected_database = os.environ["POSTGRES_DB"]
    engine = get_engine()
    try:
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT 1")) == 1
            assert connection.scalar(text("SELECT current_database()")) == expected_database
    finally:
        engine.dispose()
