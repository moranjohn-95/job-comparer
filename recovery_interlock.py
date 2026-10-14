"""Operator-controlled startup clearance, outside database snapshots.

Linux only. The startup check reads local files and configuration only.
Root operators must stop writers/traffic before changing recovery state.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from uuid import UUID, uuid4

from sqlalchemy.engine import make_url


STATE_DIR = Path("/var/lib/job-comparer-recovery")
STATE_FILE = STATE_DIR / "clearance.json"
BACKUP_MARKER = Path("/var/lib/job-comparer-backup/last-success")


class InterlockError(Exception):
    """Safe error containing no credentials or database URLs."""


def timestamp():
    return datetime.now(timezone.utc).isoformat(
        timespec="microseconds",
    ).replace("+00:00", "Z")


def uuid_value(value):
    if str(UUID(value)) != value or not UUID(value).int:
        raise InterlockError("A canonical nonzero UUID is required")
    return value


def database_target(url):
    # Disallow alternate routing through libpq query/environment overrides.
    allowed = {"sslmode", "sslcert", "sslkey", "sslrootcert"}
    port = 5432 if url.port is None else url.port
    if (url.get_backend_name() != "postgresql" or not url.host
            or not url.database or set(url.query) - allowed
            or not 1 <= port <= 65535
            or any(os.getenv(name) for name in (
                "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS",
            ))):
        raise InterlockError("An unambiguous PostgreSQL target is required")
    return {"host": url.host.lower(), "port": port,
            "database": url.database}


def protected(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (info.st_uid != 0 or info.st_mode & 0o022
            or not kind(info.st_mode)):
        raise InterlockError("Interlock files must be root-owned/protected")


def check_parents(path):
    for parent in reversed(path.parents):
        protected(parent, directory=True)


def read_protected(path):
    check_parents(path)
    protected(path)
    with path.open(encoding="utf-8") as stream:
        data = stream.read(8193)
    if len(data) > 8192:
        raise InterlockError("Oversized interlock record")
    return data


def read_state():
    # These records are generated locally by root, never accepted from a dump.
    from deletion_ledger import _unique_fields, parse_ledger_timestamp

    state = json.loads(read_protected(STATE_FILE),
                       object_pairs_hook=_unique_fields)
    if (set(state) != {
            "schema_version", "operation_id", "kind", "dataset_id",
            "target", "phase", "begun_at", "evidence", "approved_at",
            } or type(state["schema_version"]) is not int
            or state["schema_version"] != 1
            or state["kind"] not in {"recovery", "cutover"}
            or state["phase"] not in {"blocked", "evidenced", "approved"}):
        raise InterlockError("Invalid interlock state")
    uuid_value(state["operation_id"])
    uuid_value(state["dataset_id"])
    target = state["target"]
    if (set(target) != {"host", "port", "database"}
            or any(not isinstance(target[key], str) or not target[key]
                   for key in ("host", "database"))
            or type(target["port"]) is not int
            or not 1 <= target["port"] <= 65535):
        raise InterlockError("Invalid interlock target")
    # The shared strict timestamp parser does not create an AWS client.
    begun = parse_ledger_timestamp(state["begun_at"])
    now = datetime.now(timezone.utc)
    if not begun <= now:
        raise InterlockError("Invalid operation time")
    evidence = state["evidence"]
    approved = state["approved_at"]
    if state["phase"] == "blocked":
        if evidence is not None or approved is not None:
            raise InterlockError("Blocked operation contains clearance")
    else:
        if (not isinstance(evidence, dict) or set(evidence) != {
                "confirmed_at", "backup_key", "backup_version_id",
                } or not isinstance(evidence["backup_key"], str)
                or not isinstance(evidence["backup_version_id"], str)
                or not evidence["backup_key"].startswith(
                    "production/postgres/"
                ) or not evidence["backup_version_id"]
                or evidence["backup_version_id"] == "null"):
            raise InterlockError("Invalid approval evidence")
        confirmed = parse_ledger_timestamp(evidence["confirmed_at"])
        if not begun <= confirmed <= now:
            raise InterlockError("Evidence predates this operation")
        if state["phase"] == "approved":
            if not confirmed <= parse_ledger_timestamp(approved) <= now:
                raise InterlockError("Invalid approval time")
        elif approved is not None:
            raise InterlockError("Unexpected approval")
    return state


def write_state(state):
    # Atomic replacement plus fsync: a crash cannot expose partial approval.
    fd, name = tempfile.mkstemp(dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(state, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(name, STATE_FILE)
        directory = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def state_lock(write=False):
    import fcntl

    if write:
        if os.geteuid() != 0:
            raise InterlockError("Only a root operator may change clearance")
        check_parents(STATE_DIR)
        try:
            STATE_DIR.mkdir(mode=0o755)
        except FileExistsError:
            pass
        else:
            STATE_DIR.chmod(0o755)
    protected(STATE_DIR, directory=True)
    path = STATE_DIR / "lock"
    if write and not path.exists():
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.fchmod(fd, 0o644)
        os.close(fd)
    protected(path)
    with path.open("rb") as stream:
        mode = fcntl.LOCK_EX if write else fcntl.LOCK_SH
        fcntl.flock(stream, mode | fcntl.LOCK_NB)
        yield


def require_operation(state, operation_id, dataset_id, url, kind):
    if (state["operation_id"] != uuid_value(operation_id)
            or state["dataset_id"] != uuid_value(dataset_id)
            or state["target"] != database_target(url)
            or state["kind"] != kind or state["phase"] == "approved"):
        raise InterlockError("Operation, dataset or target mismatch")


@contextmanager
def evidence_operation(operation_id, dataset_id, url, kind, apply=True):
    with state_lock(write=apply):
        state = read_state()
        require_operation(state, operation_id, dataset_id, url, kind)
        if apply:
            # Invalidate earlier evidence before each attempt, even on errors.
            state.update(phase="blocked", evidence=None, approved_at=None)
            write_state(state)
        yield state


def record_evidence(state, args):
    # Caller holds the root lock; recovery calls only after confirmed commit.
    state.update(phase="evidenced", evidence={
        "confirmed_at": timestamp(), "backup_key": args.backup_key,
        "backup_version_id": args.backup_version_id,
    })
    write_state(state)


def cutover_evidence(args, url):
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import Session
    from deletion_ledger import AccountDeletionLedger
    from reconcile_account_deletions import (
        validate_metadata, validate_uuid_schema,
    )

    with evidence_operation(args.operation_id, args.expected_dataset_id,
                            url, "cutover") as state:
        ledger = AccountDeletionLedger()
        cutover = validate_metadata(ledger, args, datetime.now(timezone.utc))
        marker = read_protected(BACKUP_MARKER).strip()
        expected = f"s3://{ledger.settings.bucket}/{args.backup_key}"
        modified = datetime.fromtimestamp(
            BACKUP_MARKER.stat().st_mtime, timezone.utc,
        )
        if marker != expected or not cutover <= modified <= (
            datetime.now(timezone.utc)
        ):
            raise InterlockError("Verified post-cutover backup is required")
        # Initial approval is not a way to bypass pending deletion intents.
        if ledger.get_recovery_intents(cutover, datetime.now(timezone.utc)):
            raise InterlockError("Deletion intents exist; use recovery")
        engine = create_engine(url, hide_parameters=True,
                               connect_args={"connect_timeout": 5})
        try:
            with Session(engine) as session:
                session.execute(text("SET TRANSACTION READ ONLY"))
                session.execute(text("SET LOCAL statement_timeout = '60s'"))
                if session.scalar(text("SELECT current_database()")) != (
                    url.database
                ):
                    raise InterlockError("Database target mismatch")
                validate_uuid_schema(session)
                session.rollback()
        finally:
            engine.dispose()
        record_evidence(state, args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=(
        "begin-recovery", "begin-cutover", "record-cutover", "approve",
        "check",
    ))
    parser.add_argument("--expected-dataset-id")
    parser.add_argument("--database-host")
    parser.add_argument("--database-port", type=int, default=5432)
    parser.add_argument("--database-name")
    parser.add_argument("--operation-id")
    parser.add_argument("--backup-key")
    parser.add_argument("--backup-version-id")
    args = parser.parse_args()
    try:
        if args.action.startswith("begin-"):
            target = {"host": args.database_host.lower(),
                      "port": args.database_port,
                      "database": args.database_name}
            if (not target["host"] or not target["database"]
                    or not 1 <= target["port"] <= 65535):
                raise InterlockError("Explicit database target required")
            with state_lock(write=True):
                if args.action == "begin-cutover" and STATE_FILE.exists():
                    raise InterlockError("Initial cutover already begun")
                state = {
                    "schema_version": 1, "operation_id": str(uuid4()),
                    "kind": args.action.removeprefix("begin-"),
                    "dataset_id": uuid_value(args.expected_dataset_id),
                    "target": target, "phase": "blocked",
                    "begun_at": timestamp(), "evidence": None,
                    "approved_at": None,
                }
                write_state(state)
            print(state["operation_id"])
        elif args.action == "record-cutover":
            url = make_url(os.environ["CUTOVER_DATABASE_URL"])
            cutover_evidence(args, url)
            print("Cutover evidence recorded; operator approval required.")
        else:
            with state_lock(write=args.action == "approve"):
                state = read_state()
                url = make_url(os.environ["DATABASE_URL"])
                dataset = uuid_value(os.environ["DELETION_LEDGER_DATASET_ID"])
                if (state["dataset_id"] != dataset
                        or state["target"] != database_target(url)):
                    raise InterlockError("Configured dataset/target mismatch")
                if args.action == "approve":
                    if (state["operation_id"] != uuid_value(args.operation_id)
                            or state["phase"] != "evidenced"):
                        raise InterlockError("Current evidence is required")
                    state.update(phase="approved", approved_at=timestamp())
                    write_state(state)
                elif state["phase"] != "approved":
                    raise InterlockError("Operator approval is required")
            print("Startup clearance confirmed.")
        return 0
    except Exception:
        # Never print SQL/SDK exceptions, environment contents or credentials.
        print("Startup clearance refused. Check protected state, operation, "
              "configuration and prerequisites; keep maintenance enabled.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
