from alembic import context
from sqlalchemy import create_engine

from database import Base, assert_test_connection, get_database_url, get_test_database_url
import models  # noqa: F401 - registers models with Base.metadata

target_metadata = Base.metadata


def migration_database() -> tuple[str, bool]:
    selection = context.get_x_argument(as_dictionary=True).get("database")
    if selection == "test":
        return get_test_database_url(), True
    if selection is not None:
        raise RuntimeError("Use -x database=test to select the test database.")
    return get_database_url(), False


def run_migrations_offline() -> None:
    url, _ = migration_database()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url, is_test = migration_database()
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with engine.connect() as connection:
            if is_test:
                assert_test_connection(connection)
            context.configure(connection=connection, target_metadata=target_metadata)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
