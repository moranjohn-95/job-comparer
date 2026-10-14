# Account-deletion reconciliation after restore

This command is recovery-only and has not been runtime-verified. It does not
restore a dump, migrate a database, process pending live-account deletions,
write completion records, prune records, or change S3 lifecycle policies.

## Prerequisites and isolation

Keep traffic in maintenance mode. Stop the API, background writers, **the old
instance**, and anything writing/pruning the ledger. Keep them stopped through
restore, reconciliation and verification: S3 pagination is not an atomic
snapshot. Restrict the restored database to the recovery operator.

The **deployment/startup interlock and production UUID/backup cutover remain
separate outstanding work**. This command alone cannot enforce maintenance,
stop writers, establish trustworthy backup provenance, or prevent a later
restore from bypassing it. Do not deploy account deletion before these gaps
are addressed.

Install the existing requirements, including boto3. Supply the four existing
`DELETION_LEDGER_*` settings and normal AWS credentials (the EC2 role in
production). Select the expected dataset UUID independently from the recovery
plan; do not just copy an unexpected value from downloaded metadata.

The operator needs S3 list/read access to the ledger prefix and read access to
backup metadata in the configured bucket. No S3 writes/deletes are required.
Existing backup-only IAM access is insufficient. This commit changes no IAM.
Disable SDK/SQL debug logging; never put database URLs on command lines.

## Required metadata contract

These metadata objects do not yet exist by virtue of this command. Provisioning
them securely is part of cutover/backup work, not recovery. Do not fabricate
timestamps or metadata to make an old dump pass validation.

Store `control.json` under the configured ledger prefix, normally
`production/account-deletions/v1/`. Its exact fields are:

| Field | Required value |
| --- | --- |
| `schema_version` | Integer `1` |
| `dataset_id` | Configured, independently expected dataset UUID |
| `uuid_cutover_at` | UTC time UUID migration completed on the source |
| `earliest_backup_at` | Earliest permitted original backup capture time; at or after cutover |

For each backup object, store `<backup-key>.metadata.json` in the same bucket.
For example, `production/postgres/example.dump.metadata.json`. Exact fields:

| Field | Required value |
| --- | --- |
| `schema_version` | Integer `1` |
| `dataset_id` | Same dataset UUID |
| `backup_key` | Exact original dump key under `production/postgres/` |
| `backup_version_id` | Exact original, non-null S3 dump version ID |
| `captured_at` | Original backup snapshot/capture start time, not upload, copy or restore time |
| `account_uuid_revision` | Literal `0010_account_uuid`, attesting it was applied before capture |

All timestamps use `YYYY-MM-DDTHH:MM:SS.ffffffZ` (six fractional digits).
Unknown fields, missing records, mismatches, future captures, pre-cutover
captures and captures older than 31 days are rejected. Metadata objects must
fit within 2 KiB. Keep control/ledger records outside backup expiry rules.

Protect metadata against unauthorised edits and bind it to the original
capture in the backup process. Use unique dump keys. Do not overwrite a dump
and reuse its sidecar for another version. The command validates this metadata
contract and key/version agreement; it cannot prove which dump was loaded
into PostgreSQL. The operator must independently verify and record that the
isolated database was restored from that exact object version. A later copy
or upload does not restart the 31-day window.

Never apply the UUID migration to a pre-UUID restore to qualify it: that would
generate unrelated identities. Such backups are not eligible for this flow.

## Operator sequence

1. Establish isolation/maintenance above. Restore the verified eligible dump
   into a dedicated database named `job_comparer_recovery_<name>`.
2. Supply its PostgreSQL SQLAlchemy URL through `RECOVERY_DATABASE_URL`, using
   the `postgresql+psycopg` driver and a secrets-safe operator environment.
   The command never falls back to application `DATABASE_URL`. It checks both
   the URL database name and PostgreSQL's actual `current_database()`.
3. Run a dry-run, substituting independently verified identifiers:

   ```sh
   python reconcile_account_deletions.py \
     --recovery-database job_comparer_recovery_example \
     --expected-dataset-id DATASET_UUID \
     --backup-key production/postgres/ORIGINAL_DUMP_KEY \
     --backup-version-id ORIGINAL_S3_VERSION_ID
   ```

4. Review the count-only JSON summary. Repeat the same command with `--apply`
   to change the restored database. Dry-run uses a read-only transaction;
   apply re-fetches and validates the complete ledger before database access.
5. Require exit code zero and an `applied` result. Rerun dry-run to confirm
   zero matching accounts, sessions and verification tokens before proceeding
   with the separately controlled deployment/startup process.

Every valid intent is authoritative, even without a completion. Apply uses
the shared AI-usage lock before account-row locks and deletes matching users
and their numeric-ID-prefixed AI counters in one transaction. Existing foreign
keys cascade CVs/jobs/comparisons. Shared AI/security counters are untouched.
**All** restored sessions and verification tokens are deleted, including those
for surviving accounts. Survivors must sign in again; old verification links
no longer work.

The command checks account, counter, cascade and authentication-record removal
before committing. Errors exit nonzero and roll back uncommitted changes;
unavailable ledger reads never count as an empty ledger. If commit acknowledgement
is lost, the outcome is uncertain: keep maintenance enabled and rerun. Reruns
are safe. No success output is emitted until commit returns successfully.

This protects account deletions only. Individual CV/job/comparison deletions
can still reappear after restore and need separate reconciliation coverage.
