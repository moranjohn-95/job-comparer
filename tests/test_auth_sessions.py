from collections.abc import Iterator
from datetime import timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, func, inspect, select, update
from sqlalchemy.orm import Session

from auth_sessions import (
    create_session,
    get_session_lifetime,
    resolve_session,
    revoke_session,
    revoke_user_sessions,
)
from database import assert_test_connection, get_database_url, get_engine
from models import AuthSession, User


@pytest.fixture(autouse=True)
def session_lifetime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SESSION_LIFETIME_SECONDS", "3600")


@pytest.fixture
def users() -> Iterator[tuple[int, int]]:
    with Session(get_engine()) as db:
        accounts = [
            User(
                email=f"session-test-{uuid4().hex}@example.com",
                password_hash="unused-session-test-hash",
            )
            for _ in range(2)
        ]
        db.add_all(accounts)
        db.flush()
        ids = (accounts[0].id, accounts[1].id)
        db.commit()
    try:
        yield ids
    finally:
        with Session(get_engine()) as db:
            db.execute(delete(User).where(User.id.in_(ids)))
            db.commit()


def test_migrated_session_schema() -> None:
    schema = inspect(get_engine())
    columns = {c["name"]: c for c in schema.get_columns("auth_sessions")}
    assert set(columns) == {
        "id", "user_id", "token_hash", "created_at", "expires_at",
        "revoked_at",
    }
    for name in ("created_at", "expires_at", "revoked_at"):
        assert columns[name]["type"].timezone
    assert columns["revoked_at"]["nullable"]
    assert not columns["token_hash"]["nullable"]
    assert any(
        constraint["column_names"] == ["token_hash"]
        for constraint in schema.get_unique_constraints("auth_sessions")
    )
    foreign_key, = schema.get_foreign_keys("auth_sessions")
    assert foreign_key["referred_table"] == "users"
    assert foreign_key["options"]["ondelete"] == "CASCADE"
    indexes = schema.get_indexes("auth_sessions")
    assert {"ix_auth_sessions_user_id", "ix_auth_sessions_expires_at"} <= {
        index["name"] for index in indexes
    }


def test_sessions_persist_hash_only_across_connections(users) -> None:
    with Session(get_engine()) as db:
        token = create_session(db, users[0])
        other_token = create_session(db, users[0])
        db.commit()
    assert token != other_token
    assert len(token) == 43

    # A fresh engine/session cannot rely on process-local session storage.
    engine = create_engine(get_database_url())
    try:
        with engine.connect() as connection:
            assert_test_connection(connection)
        with Session(engine) as db:
            saved, user = resolve_session(db, token)
            assert user.id == users[0]
            assert saved.token_hash == sha256(token.encode()).hexdigest()
            assert token not in vars(saved).values()
            assert saved.created_at.utcoffset() == timedelta(0)
            assert saved.expires_at.utcoffset() == timedelta(0)
            assert saved.expires_at - saved.created_at == timedelta(hours=1)
            assert saved.revoked_at is None
            expiry = saved.expires_at
            assert resolve_session(db, token)[0].expires_at == expiry
            assert resolve_session(db, saved.token_hash) is None
    finally:
        engine.dispose()


@pytest.mark.parametrize("token", [
    None, "", "short", "a" * 42, "a" * 44, "!" * 43, "é" * 43,
    "a" * 42 + "\n", "a" * 43,
])
def test_invalid_or_unknown_tokens_are_rejected(token) -> None:
    with Session(get_engine()) as db:
        assert resolve_session(db, token) is None
        revoke_session(db, token)
        db.commit()


@pytest.mark.parametrize("seconds_ago", [0, 60])
def test_expired_tokens_are_rejected(users, seconds_ago) -> None:
    with Session(get_engine()) as db:
        token = create_session(db, users[0])
        db.execute(
            update(AuthSession)
            .where(AuthSession.user_id == users[0])
            .values(
                expires_at=func.clock_timestamp()
                - timedelta(seconds=seconds_ago)
            )
        )
        db.commit()
        assert resolve_session(db, token) is None


def test_revocation_is_idempotent_and_isolated_between_users(users) -> None:
    with Session(get_engine()) as db:
        first = create_session(db, users[0])
        second = create_session(db, users[0])
        other = create_session(db, users[1])
        db.commit()

    with Session(get_engine()) as reader, Session(get_engine()) as writer:
        saved, _ = resolve_session(reader, first)
        saved_id = saved.id
        revoke_session(writer, first)
        writer.commit()
        assert resolve_session(reader, first) is None
        assert resolve_session(reader, second) is not None
        assert resolve_session(reader, other) is not None
        reader.refresh(saved)
        first_revoked_at = saved.revoked_at
        assert first_revoked_at is not None
        assert first_revoked_at.utcoffset() == timedelta(0)

        revoke_session(writer, first)
        revoke_user_sessions(writer, users[0])
        writer.commit()
        assert resolve_session(reader, first) is None
        assert resolve_session(reader, second) is None
        assert resolve_session(reader, other) is not None
        reader.refresh(saved)
        assert saved.revoked_at == first_revoked_at
        revoked_times = dict(reader.execute(
            select(AuthSession.id, AuthSession.revoked_at)
            .where(AuthSession.user_id == users[0])
        ).all())
        assert revoked_times[saved_id] == first_revoked_at

        revoke_user_sessions(writer, users[0])
        writer.commit()
        assert dict(reader.execute(
            select(AuthSession.id, AuthSession.revoked_at)
            .where(AuthSession.user_id == users[0])
        ).all()) == revoked_times
        assert resolve_session(reader, other) is not None


def test_deleted_users_cannot_authenticate(users) -> None:
    with Session(get_engine()) as db:
        token = create_session(db, users[0])
        db.commit()
        db.execute(delete(User).where(User.id == users[0]))
        db.commit()
        assert resolve_session(db, token) is None
        assert db.scalar(select(AuthSession.id).where(
            AuthSession.user_id == users[0]
        )) is None


def test_caller_controls_creation_and_atomic_revocation(users) -> None:
    with Session(get_engine()) as db:
        discarded = create_session(db, users[0])
        db.rollback()
        assert resolve_session(db, discarded) is None
        token = create_session(db, users[0])
        db.commit()

        original_hash = db.get(User, users[0]).password_hash
        db.get(User, users[0]).password_hash = "replacement-test-hash"
        revoke_user_sessions(db, users[0])
        db.rollback()
        assert db.get(User, users[0]).password_hash == original_hash
        assert resolve_session(db, token) is not None

        revoke_session(db, token)
        db.rollback()
        assert resolve_session(db, token) is not None

        db.get(User, users[0]).password_hash = "replacement-test-hash"
        revoke_user_sessions(db, users[0])
        db.commit()

    with Session(get_engine()) as db:
        assert db.get(User, users[0]).password_hash == "replacement-test-hash"
        assert resolve_session(db, token) is None


def test_default_and_configured_lifetime(users, monkeypatch) -> None:
    monkeypatch.delenv("SESSION_LIFETIME_SECONDS")
    assert get_session_lifetime() == timedelta(hours=1)
    monkeypatch.setenv("SESSION_LIFETIME_SECONDS", "120")
    with Session(get_engine()) as db:
        token = create_session(db, users[0])
        saved, _ = resolve_session(db, token)
        assert saved.expires_at - saved.created_at == timedelta(seconds=120)


@pytest.mark.parametrize("value", [
    "", "0", "-1", "1.5", "true", "abc", "1e3", "9" * 30,
])
def test_invalid_lifetime_is_rejected(monkeypatch, value) -> None:
    monkeypatch.setenv("SESSION_LIFETIME_SECONDS", value)
    with pytest.raises(RuntimeError, match="SESSION_LIFETIME_SECONDS"):
        get_session_lifetime()


def test_unrepresentable_expiry_is_rejected(users, monkeypatch) -> None:
    monkeypatch.setenv("SESSION_LIFETIME_SECONDS", str(999999999 * 86400))
    with Session(get_engine()) as db:
        with pytest.raises(RuntimeError, match="SESSION_LIFETIME_SECONDS"):
            create_session(db, users[0])
        assert db.scalar(select(AuthSession.id).where(
            AuthSession.user_id == users[0]
        )) is None
