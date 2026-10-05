"""Reserve one provider attempt under shared PostgreSQL limits."""

import os
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import AIUsageCounter

ACCOUNT_DAILY_LIMIT = 3
APP_DAILY_LIMIT = 10
APP_MONTHLY_LIMIT = 50
LOCK_KEY = "__lock__"


class UsageConfigurationError(Exception):
    pass


class UsageLimitReached(Exception):
    pass


def _configured_limit(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise UsageConfigurationError from None
    if value < 1:
        raise UsageConfigurationError
    return value


def get_app_limits() -> tuple[int, int]:
    return (
        _configured_limit("AI_APP_DAILY_LIMIT", APP_DAILY_LIMIT),
        _configured_limit("AI_APP_MONTHLY_LIMIT", APP_MONTHLY_LIMIT),
    )


def reserve_attempt(session: Session, user_id: int) -> None:
    account_daily_limit = _configured_limit(
        "AI_ACCOUNT_DAILY_LIMIT", ACCOUNT_DAILY_LIMIT,
    )
    app_daily_limit, app_monthly_limit = get_app_limits()
    # Every worker locks this same row before reading or writing counters.
    # The commit occurs before the provider call, so uncertain failures count.
    lock = session.scalar(
        select(AIUsageCounter)
        .where(AIUsageCounter.counter_key == LOCK_KEY)
        .with_for_update()
    )
    if lock is None:
        session.rollback()
        raise RuntimeError("AI usage lock row is missing")

    now: datetime = session.scalar(
        func.timezone("UTC", func.clock_timestamp())
    )
    day = now.date().isoformat()
    month = now.strftime("%Y-%m")
    checks = (
        (
            f"user:{user_id}:{day}",
            account_daily_limit,
            f"Daily account comparison limit reached ({account_daily_limit})",
        ),
        (
            f"app:day:{day}",
            app_daily_limit,
            f"Daily app comparison limit reached ({app_daily_limit})",
        ),
        (
            f"app:month:{month}",
            app_monthly_limit,
            f"Monthly app comparison limit reached ({app_monthly_limit})",
        ),
    )
    counters = {}
    for key, limit, message in checks:
        counter = session.get(AIUsageCounter, key)
        if counter is not None and counter.call_count >= limit:
            session.rollback()
            raise UsageLimitReached(message)
        counters[key] = counter
    for key, _, _ in checks:
        counter = counters[key]
        if counter is None:
            session.add(AIUsageCounter(counter_key=key, call_count=1))
        else:
            counter.call_count += 1
    session.commit()
