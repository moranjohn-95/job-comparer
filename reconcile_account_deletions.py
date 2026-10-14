"""Operator-only reconciliation of an isolated restored PostgreSQL database.

Dry-run unless --apply is supplied. Never imports the application or uses its
DATABASE_URL. Stopping writers and enforcing maintenance remain operator tasks.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import create_engine, delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from ai_usage import lock_usage
from deletion_ledger import (
    AccountDeletionLedger,
    LedgerError,
    parse_ledger_timestamp,
)
from models import (
    AIUsageCounter,
    AuthSession,
    ComparisonHistory,
    SavedCV,
    SavedJob,
    User,
    VerificationToken,
)


class RecoveryError(Exception):
    """Operator-safe error: no connection strings or personal data."""


class RecoveryParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise RecoveryError("Invalid recovery arguments; use --help")


def validate_metadata(ledger: AccountDeletionLedger,
                      args: argparse.Namespace, now: datetime) -> datetime:
    if (str(UUID(args.expected_dataset_id)) != args.expected_dataset_id
            or args.expected_dataset_id != ledger.settings.dataset_id):
        raise RecoveryError("Expected dataset does not match configuration")
    control, backup = ledger.get_recovery_metadata(args.backup_key)
    expected_control = {
        "schema_version", "dataset_id", "uuid_cutover_at",
        "earliest_backup_at",
    }
    expected_backup = {
        "schema_version", "dataset_id", "captured_at", "backup_key",
        "backup_version_id", "account_uuid_revision",
    }
    for record, fields in ((control, expected_control),
                           (backup, expected_backup)):
        if (set(record) != fields
                or type(record["schema_version"]) is not int
                or record["schema_version"] != 1
                or record["dataset_id"] != args.expected_dataset_id):
            raise RecoveryError("Recovery metadata schema/dataset mismatch")
    if (not args.backup_version_id or args.backup_version_id == "null"
            or backup["backup_key"] != args.backup_key
            or backup["backup_version_id"] != args.backup_version_id
            or backup["account_uuid_revision"] != "0010_account_uuid"):
        raise RecoveryError("Backup identity or UUID provenance mismatch")
    cutover = parse_ledger_timestamp(control["uuid_cutover_at"])
    earliest = parse_ledger_timestamp(control["earliest_backup_at"])
    captured = parse_ledger_timestamp(backup["captured_at"])
    if not cutover <= earliest <= captured <= now:
        raise RecoveryError("Backup predates cutover/floor or is future-dated")
    if now - captured > timedelta(days=31):
        raise RecoveryError("Backup exceeds the 31-day recovery limit")
    return cutover


def recovery_url(database_name: str):
    # Require a purpose-named restored database and an explicit URL variable.
    # Never fall back to DATABASE_URL, PGDATABASE or the app's engine factory.
    raw = os.getenv("RECOVERY_DATABASE_URL", "")
    if not raw or not re.fullmatch(
        r"job_comparer_recovery_[A-Za-z0-9_]+", database_name,
    ):
        raise RecoveryError(
            "Set RECOVERY_DATABASE_URL and explicitly select a database "
            "named job_comparer_recovery_<name>"
        )
    url = make_url(raw)
    if (url.get_backend_name() != "postgresql"
            or url.database != database_name or not url.host):
        raise RecoveryError("Recovery PostgreSQL target does not match")
    return url


def count_rows(session: Session, model, condition=None) -> int:
    statement = select(func.count()).select_from(model)
    if condition is not None:
        statement = statement.where(condition)
    return session.scalar(statement)


def reconcile(session: Session, intents: set[UUID], database_name: str,
              apply: bool) -> dict[str, int]:
    if not apply:
        session.execute(text("SET TRANSACTION READ ONLY"))
    session.execute(text("SET LOCAL lock_timeout = '5s'"))
    session.execute(text("SET LOCAL statement_timeout = '60s'"))
    if session.scalar(select(func.current_database())) != database_name:
        raise RecoveryError("Connected database does not match selection")
    # A pre-UUID restore fails this query; never migrate/backfill on recovery.
    total, nonnull, unique = session.execute(select(
        func.count(User.id), func.count(User.account_uuid),
        func.count(func.distinct(User.account_uuid)),
    )).one()
    if (total != nonnull or total != unique
            or count_rows(session, User, User.account_uuid == UUID(int=0))):
        raise RecoveryError("Restored account UUIDs are missing or invalid")
    if apply:
        lock_usage(session)
    statement = select(User.id).where(
        User.account_uuid.in_(intents),
    ).order_by(User.id)
    if apply:
        statement = statement.with_for_update()
    account_ids = list(session.scalars(statement))
    children = {
        "cvs": SavedCV, "jobs": SavedJob, "comparisons": ComparisonHistory,
    }
    counts = {"accounts": len(account_ids), "ai_counters": 0}
    for name, model in children.items():
        counts[name] = count_rows(
            session, model, model.user_id.in_(account_ids),
        )
    counts["sessions"] = count_rows(session, AuthSession)
    counts["verification_tokens"] = count_rows(session, VerificationToken)
    for account_id in account_ids:
        condition = AIUsageCounter.counter_key.startswith(
            f"user:{account_id}:"
        )
        counts["ai_counters"] += count_rows(session, AIUsageCounter, condition)
    if not apply:
        return counts
    session.execute(delete(User).where(User.id.in_(account_ids)))
    for account_id in account_ids:
        condition = AIUsageCounter.counter_key.startswith(
            f"user:{account_id}:"
        )
        session.execute(delete(AIUsageCounter).where(condition))
        if count_rows(session, AIUsageCounter, condition):
            raise RecoveryError("Account counter cleanup verification failed")
    # All restored authentication material is invalid, even for survivors.
    session.execute(delete(AuthSession))
    session.execute(delete(VerificationToken))
    session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    if (count_rows(session, User, User.account_uuid.in_(intents))
            or count_rows(session, User) != total - len(account_ids)
            or count_rows(session, AuthSession)
            or count_rows(session, VerificationToken)):
        raise RecoveryError("Account/session cleanup verification failed")
    for model in children.values():
        if count_rows(session, model, model.user_id.in_(account_ids)):
            raise RecoveryError("Cascading deletion verification failed")
    return counts


def main() -> int:
    parser = RecoveryParser(description=__doc__)
    parser.add_argument("--recovery-database", required=True)
    parser.add_argument("--expected-dataset-id", required=True)
    parser.add_argument("--backup-key", required=True)
    parser.add_argument("--backup-version-id", required=True)
    parser.add_argument("--apply", action="store_true")
    try:
        args = parser.parse_args()
        url = recovery_url(args.recovery_database)
        ledger = AccountDeletionLedger()
        now = datetime.now(timezone.utc)
        cutover = validate_metadata(ledger, args, now)
        intents = ledger.get_recovery_intents(cutover, now)
        # All external evidence is validated before opening the database.
        engine = create_engine(
            url, isolation_level="REPEATABLE READ", hide_parameters=True,
            connect_args={"connect_timeout": 5},
        )
        try:
            with Session(engine) as session:
                counts = reconcile(
                    session, intents, args.recovery_database, args.apply,
                )
                if args.apply:
                    session.commit()
                else:
                    session.rollback()
                # Session context rolls back automatically on any exception.
        finally:
            engine.dispose()
        print(json.dumps({
            "mode": "applied" if args.apply else "dry-run",
            "validated_intents": len(intents), "counts": counts,
        }, sort_keys=True))
        return 0
    except (RecoveryError, LedgerError) as error:
        print(f"Recovery refused: {error}. Keep maintenance mode enabled.",
              file=sys.stderr)
    except Exception:
        # Never render SDK/SQL exceptions: they can contain private details.
        # A lost commit acknowledgement is uncertain; keep traffic stopped
        # and rerun reconciliation, which safely handles already-gone rows.
        print("Recovery not confirmed. Keep maintenance mode enabled; "
              "check configuration, metadata, ledger access and DB schema. "
              "If apply reached commit, reconcile again before proceeding.",
              file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
