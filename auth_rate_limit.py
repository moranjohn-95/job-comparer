"""PostgreSQL-backed fixed-window limits for public authentication routes."""

from datetime import datetime, timedelta
from hashlib import sha256

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from models import AuthRateLimitCounter

LOGIN_EMAIL_ATTEMPT_LIMIT = 5
LOGIN_IP_ATTEMPT_LIMIT = 20
LOGIN_WINDOW = timedelta(minutes=15)
SIGNUP_ATTEMPT_LIMIT = 10
SIGNUP_WINDOW = timedelta(hours=1)


class AuthRateLimitReached(Exception):
    pass


def _window_start(now: datetime, window: timedelta) -> datetime:
    seconds = int(window.total_seconds())
    timestamp = int(now.timestamp())
    return datetime.fromtimestamp(
        timestamp - timestamp % seconds, tz=now.tzinfo
    )


def _counter_key(scope: str, window_start: datetime) -> str:
    return f"{scope}:{window_start.isoformat()}"


def login_email_scope(email: str) -> str:
    email_digest = sha256(email.encode("utf-8")).hexdigest()
    return f"login:email:{email_digest}"


def login_ip_scope(client_ip: str) -> str:
    return f"login:ip:{client_ip}"


def signup_scope(client_ip: str) -> str:
    return f"signup:{client_ip}"


def reserve_auth_attempt(
    session: Session, scope: str, limit: int, window: timedelta
) -> None:
    reserve_auth_attempts(session, ((scope, limit, window),))


def reserve_auth_attempts(
    session: Session, attempts: tuple[tuple[str, int, timedelta], ...]
) -> None:
    now: datetime = session.scalar(
        select(func.timezone("UTC", func.clock_timestamp()))
    )
    for scope, limit, window in attempts:
        counter_key = _counter_key(scope, _window_start(now, window))
        statement = insert(AuthRateLimitCounter).values(
            counter_key=counter_key, attempt_count=1
        )
        statement = statement.on_conflict_do_update(
            index_elements=[AuthRateLimitCounter.counter_key],
            set_={"attempt_count": AuthRateLimitCounter.attempt_count + 1},
            where=AuthRateLimitCounter.attempt_count < limit,
        ).returning(AuthRateLimitCounter.attempt_count)
        count = session.scalar(statement)
        if count is None:
            session.rollback()
            raise AuthRateLimitReached()
    session.commit()


def reserve_auth_cooldown(
    session: Session, scope: str, seconds: int
) -> None:
    """Reserve an actual minimum interval, including across window edges."""
    statement = insert(AuthRateLimitCounter).values(
        counter_key=scope, attempt_count=0,
        last_attempt_at=func.clock_timestamp(),
    )
    statement = statement.on_conflict_do_update(
        index_elements=[AuthRateLimitCounter.counter_key],
        set_={"last_attempt_at": func.clock_timestamp()},
        where=(AuthRateLimitCounter.last_attempt_at.is_(None)) | (
            AuthRateLimitCounter.last_attempt_at
            <= func.clock_timestamp() - timedelta(seconds=seconds)
        ),
    ).returning(AuthRateLimitCounter.counter_key)
    if session.scalar(statement) is None:
        session.rollback()
        raise AuthRateLimitReached()
    session.commit()
