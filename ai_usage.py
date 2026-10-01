"""Reserve one provider attempt under shared PostgreSQL limits."""

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import AIUsageCounter

ACCOUNT_DAILY_LIMIT = 3
APP_DAILY_LIMIT = 10
APP_MONTHLY_LIMIT = 50
LOCK_KEY = "__lock__"


class UsageLimitReached(Exception):
    pass


def reserve_attempt(session: Session, user_id: int) -> None:
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
            ACCOUNT_DAILY_LIMIT,
            "Daily account comparison limit reached (3)",
        ),
        (
            f"app:day:{day}",
            APP_DAILY_LIMIT,
            "Daily app comparison limit reached (10)",
        ),
        (
            f"app:month:{month}",
            APP_MONTHLY_LIMIT,
            "Monthly app comparison limit reached (50)",
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
