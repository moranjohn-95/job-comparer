"""Write-once account deletion records, independent of database snapshots.

No AWS client is created at import time. Callers must not log SDK debug output.
An intent records an authorised request, not a committed database deletion.
This helper neither deletes accounts nor participates in a DB transaction.
"""

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    NoCredentialsError,
    ParamValidationError,
    PartialCredentialsError,
)


class LedgerError(Exception):
    """Safe application-level message, without provider response contents."""


class LedgerConfigurationError(LedgerError):
    """Required configuration is missing or invalid; no write attempted."""


class LedgerRecordError(LedgerError):
    """Invalid input or stored record; never accept it as confirmation."""


class LedgerUnavailable(LedgerError):
    """A read/client setup failed, not evidence of a missing record."""


class LedgerWriteFailed(LedgerError):
    """This attempt definitely did not write; older records may still exist."""


class LedgerOutcomeUnknown(LedgerError):
    """A write may have succeeded; reconciliation is required."""


@dataclass(frozen=True)
class LedgerSettings:
    bucket: str
    region: str
    prefix: str
    dataset_id: str


def get_ledger_settings() -> LedgerSettings:
    values = {
        name: os.getenv(f"DELETION_LEDGER_{name.upper()}", "")
        for name in ("bucket", "region", "prefix", "dataset_id")
    }
    try:
        valid = (
            re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]",
                         values["bucket"])
            and not values["bucket"].startswith("xn--")
            and not values["bucket"].endswith(("--x-s3", "--table-s3"))
            and re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]*",
                             values["region"])
            and len(values["prefix"]) <= 200
            and re.fullmatch(
                r"(?:[A-Za-z0-9_-]+/)+account-deletions/v1/",
                values["prefix"],
            )
            and "postgres" not in values["prefix"].split("/")
            and str(UUID(values["dataset_id"])) == values["dataset_id"]
            and UUID(values["dataset_id"]).int != 0
        )
    except ValueError:
        valid = False
    if not valid:
        raise LedgerConfigurationError(
            "Set valid DELETION_LEDGER_BUCKET, REGION, PREFIX and "
            "DATASET_ID settings. The dataset ID must be a nonzero UUID; "
            "the separate prefix must end in /account-deletions/v1/."
        )
    return LedgerSettings(**values)


RecordKind = Literal["intent", "completion"]
_TIMESTAMP_FIELD = {"intent": "requested_at", "completion": "confirmed_at"}
_MAX_RECORD_BYTES = 2048


def _utc_timestamp(value: datetime) -> str:
    if (not isinstance(value, datetime) or value.tzinfo is None
            or value.utcoffset() != timedelta(0)):
        raise LedgerRecordError("A timezone-aware UTC timestamp is required")
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _unique_fields(pairs: list) -> dict:
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError
        result[name] = value
    return result


class AccountDeletionLedger:
    """Construct on use; AWS resolves credentials, including instance roles.

    Each S3 operation has 3s connect/5s socket-read timeouts, one SDK attempt.
    These are not a total deadline for the AWS credential-provider chain.
    """

    def __init__(self) -> None:
        self.settings = get_ledger_settings()
        try:
            self._s3 = boto3.client(
                "s3", region_name=self.settings.region,
                config=Config(
                    connect_timeout=3, read_timeout=5,
                    retries={"mode": "standard", "total_max_attempts": 1},
                    ignore_configured_endpoint_urls=True,
                ),
            )
        except (BotoCoreError, OSError, ValueError):
            raise LedgerUnavailable("Ledger client is unavailable") from None

    def _key(self, account_uuid: UUID, kind: RecordKind) -> str:
        if not isinstance(account_uuid, UUID) or account_uuid.int == 0:
            raise LedgerRecordError("A nonzero account UUID is required")
        return f"{self.settings.prefix}{account_uuid}/{kind}.json"

    def _validate(self, body: object, account_uuid: UUID,
                  kind: RecordKind) -> dict:
        field = _TIMESTAMP_FIELD[kind]
        try:
            if (
                not isinstance(body, dict)
                or set(body) != {
                    "schema_version", "dataset_id", "account_uuid", field,
                }
                or type(body["schema_version"]) is not int
                or body["schema_version"] != 1
                or body["dataset_id"] != self.settings.dataset_id
                or body["account_uuid"] != str(account_uuid)
                or not isinstance(body[field], str)
                or not re.fullmatch(
                    r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z", body[field]
                )
            ):
                raise ValueError
            _utc_timestamp(datetime.fromisoformat(body[field]))
        except (ValueError, TypeError, LedgerRecordError):
            raise LedgerRecordError("Invalid ledger record") from None
        return body

    def _read(self, account_uuid: UUID, kind: RecordKind) -> dict | None:
        key = self._key(account_uuid, kind)
        try:
            response = self._s3.get_object(
                Bucket=self.settings.bucket, Key=key,
            )
            stream = response["Body"]
            try:
                raw = stream.read(_MAX_RECORD_BYTES + 1)
            finally:
                stream.close()
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "NoSuchKey":
                return None
            raise LedgerUnavailable("Ledger read is unavailable") from None
        except (BotoCoreError, OSError):
            raise LedgerUnavailable("Ledger read is unavailable") from None
        try:
            if len(raw) > _MAX_RECORD_BYTES:
                raise ValueError
            body = json.loads(raw, object_pairs_hook=_unique_fields)
        except (ValueError, UnicodeError, RecursionError):
            raise LedgerRecordError("Invalid ledger record") from None
        return self._validate(body, account_uuid, kind)

    def get_intent(self, account_uuid: UUID) -> dict | None:
        """None means S3 returned NoSuchKey, never an unavailable read."""
        return self._read(account_uuid, "intent")

    def _require_intent(self, account_uuid: UUID) -> dict:
        intent = self.get_intent(account_uuid)
        if intent is None:
            raise LedgerRecordError("Completion requires an existing intent")
        return intent

    @staticmethod
    def _check_completion(intent: dict, completion: dict) -> None:
        if completion["confirmed_at"] < intent["requested_at"]:
            raise LedgerRecordError("Completion predates its intent")

    def get_completion(self, account_uuid: UUID) -> dict | None:
        completion = self._read(account_uuid, "completion")
        if completion is not None:
            intent = self._require_intent(account_uuid)
            self._check_completion(intent, completion)
        return completion

    def _record(self, account_uuid: UUID, kind: RecordKind,
                timestamp: datetime) -> dict:
        key = self._key(account_uuid, kind)
        body = {
            "schema_version": 1,
            "dataset_id": self.settings.dataset_id,
            "account_uuid": str(account_uuid),
            _TIMESTAMP_FIELD[kind]: _utc_timestamp(timestamp),
        }
        try:
            self._s3.put_object(
                Bucket=self.settings.bucket, Key=key,
                Body=json.dumps(body).encode("utf-8"),
                ContentType="application/json", IfNoneMatch="*",
            )
            return body
        except (NoCredentialsError, PartialCredentialsError,
                ParamValidationError):
            raise LedgerWriteFailed("Ledger write was not sent") from None
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code")
            if code in {
                "AccessDenied", "NoSuchBucket", "InvalidAccessKeyId",
                "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken",
                "InvalidArgument", "InvalidRequest", "InvalidBucketName",
                "AuthorizationHeaderMalformed",
            }:
                raise LedgerWriteFailed("Ledger write was rejected") from None
            # Includes 412 (already exists), conflicts and server failures.
        except (BotoCoreError, OSError):
            pass
        # Never retry a PUT here. Even a subsequent NoSuchKey cannot prove
        # that an in-flight timed-out write will not finish later.
        try:
            existing = self._read(account_uuid, kind)
        except LedgerUnavailable:
            raise LedgerOutcomeUnknown(
                "Ledger write outcome is unresolved; confirmation read "
                "is unavailable. Reconciliation is required"
            ) from None
        if existing is not None:
            return existing
        raise LedgerOutcomeUnknown(
            "Ledger write outcome is unresolved; reconcile before proceeding"
        ) from None

    def record_intent(self, account_uuid: UUID) -> dict:
        """Confirm intent recording, preserving an existing request time."""
        return self._record(account_uuid, "intent", datetime.now(timezone.utc))

    def record_completion(self, account_uuid: UUID,
                          confirmed_at: datetime) -> dict:
        """Call only after confirmed DB deletion, with that confirmation time.

        This helper cannot itself verify a database commit. Repeated calls
        preserve the first valid completion timestamp.
        """
        intent = self._require_intent(account_uuid)
        self._check_completion(
            intent, {"confirmed_at": _utc_timestamp(confirmed_at)},
        )
        completion = self._record(account_uuid, "completion", confirmed_at)
        self._check_completion(intent, completion)
        return completion
