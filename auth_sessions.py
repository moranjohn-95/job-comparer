"""Database-backed sessions, not yet wired to the HTTP authentication layer.

Callers own the SQLAlchemy transaction: helpers may flush, but never commit
or roll back. Commit issuance before delivering its raw token. Password
updates and user-session revocation can share one caller-owned transaction.
No token is cached, logged, or stored in plaintext.
"""

import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from hashlib import sha256

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from models import AuthSession, User

_LIFETIME_ERROR = (
    "SESSION_LIFETIME_SECONDS must be a positive whole number of seconds "
    "that produces a representable expiry timestamp."
)


def get_session_lifetime() -> timedelta:
    """Read and validate the absolute lifetime for newly issued sessions."""
    value = os.getenv("SESSION_LIFETIME_SECONDS", "3600")
    if re.fullmatch(r"[0-9]+", value) is None:
        raise RuntimeError(_LIFETIME_ERROR)
    try:
        seconds = int(value)
        if seconds <= 0:
            raise ValueError
        return timedelta(seconds=seconds)
    except (ValueError, OverflowError):
        raise RuntimeError(_LIFETIME_ERROR) from None


def _token_hash(token: str | None) -> str | None:
    # token_urlsafe(32) produces exactly 43 unpadded URL-safe characters.
    if not isinstance(token, str) or len(token) != 43:
        return None
    if re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
        return None
    return sha256(token.encode("ascii")).hexdigest()


def create_session(db: Session, user_id: int) -> str:
    """Flush a new session and return its raw token once; caller commits."""
    lifetime = get_session_lifetime()
    now: datetime = db.scalar(select(func.clock_timestamp()))
    now = now.astimezone(timezone.utc)
    try:
        expires_at = now + lifetime
    except OverflowError:
        raise RuntimeError(_LIFETIME_ERROR) from None
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(
        user_id=user_id,
        token_hash=sha256(token.encode("ascii")).hexdigest(),
        created_at=now,
        expires_at=expires_at,
    ))
    db.flush()
    return token


def resolve_session(
    db: Session, token: str | None
) -> tuple[AuthSession, User] | None:
    """Resolve a live session and its current user without extending expiry."""
    digest = _token_hash(token)
    if digest is None:
        return None
    row = db.execute(
        select(AuthSession, User)
        .join(User, AuthSession.user_id == User.id)
        .where(
            AuthSession.token_hash == digest,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > func.clock_timestamp(),
        )
        .execution_options(populate_existing=True)
    ).one_or_none()
    if row is None:
        return None
    session, user = row
    return session, user


def revoke_session(db: Session, token: str | None) -> None:
    """Revoke one token idempotently; invalid/unknown tokens are a no-op."""
    digest = _token_hash(token)
    if digest is None:
        return
    db.execute(
        update(AuthSession)
        .where(
            AuthSession.token_hash == digest,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=func.clock_timestamp())
    )


def revoke_user_sessions(db: Session, user_id: int) -> None:
    """Revoke this user's sessions; caller commits with related changes."""
    db.execute(
        update(AuthSession)
        .where(
            AuthSession.user_id == user_id,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=func.clock_timestamp())
    )
