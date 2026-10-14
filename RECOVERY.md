# Account-deletion reconciliation after restore

This command is recovery-only and has not been runtime-verified. It does not
restore a dump, migrate a database, process pending live-account deletions,
write completion records, prune records, or change S3 lifecycle policies.

## Prerequisites and isolation

Keep traffic in maintenance mode. Stop the API, background writers, **the old
instance**, and anything writing/pruning the ledger. Keep them stopped through
restore, reconciliation and verification: S3 pagination is not an atomic
snapshot. Restrict the restored database to the recovery operator.

The root-controlled startup interlock below must be installed and rehearsed;
it is not enabled by committing these files. Production UUID/backup cutover
and isolated runtime verification remain outstanding. The commands cannot
enforce maintenance, stop writers or establish trustworthy restore provenance.
Do not deploy account deletion before those operational prerequisites are met.

Install the existing requirements, including boto3. Supply the four existing
`DELETION_LEDGER_*` settings and normal AWS credentials (the EC2 role in
production). Select the expected dataset UUID independently from the recovery
plan; do not just copy an unexpected value from downloaded metadata.

The operator needs S3 list/read access to the ledger prefix and read access to
backup metadata in the configured bucket. No S3 writes/deletes are required.
Existing backup-only IAM access is insufficient. This commit changes no IAM.
Disable SDK/SQL debug logging; never put database URLs on command lines.

## Required metadata contract

The reconciliation command creates neither metadata nor control records.
The repository-managed backup workflow below creates sidecars for new backups;
`control.json` still requires separate, evidence-based cutover provisioning.
Do not fabricate timestamps or metadata to make an old dump pass validation.

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

## Production backup sidecars

`operations/backup/` contains the supplied production script, service and timer
with metadata support. Nothing is installed or enabled by committing these
files. They retain the existing production Compose path, database-name guard,
root service, exclusive lock, restrictive permissions, custom-format check,
AES256 encryption, three-attempt AWS retry bound and 15-minute service timeout.
The timer remains **03:00 UTC daily**, with `Persistent=true`.

The script requires an explicit `DELETION_LEDGER_DATASET_ID` and reads the
database before capture to confirm the non-null, uniquely constrained UUID
column. Every recorded Alembic head must be an exact known revision equal to
`0010_account_uuid` or a descendant in the deployed repository's Alembic graph.
Unknown, empty or pre-UUID revision states and incompatible schemas fail closed.
Later descendant migrations need no guard edit; keep the deployed migration
files current. Graph inspection does not execute `env.py` or run migrations.
Do not run migrations concurrently with backups. Do not install
this version before the source migration has actually been applied, or scheduled
backups will fail rather than falsely attest UUID readiness.

The script captures UTC immediately before `pg_dump`, then obtains `VersionId`
from `PutObject` or `CompleteMultipartUpload`, never from a latest-object lookup.
Large dumps retain multipart support. Both the dump and its JSON sidecar are
downloaded by their exact returned version IDs and compared byte-for-byte with
the local originals. Unique keys and conditional creation prevent overwrites.
Only then is `/var/lib/job-comparer-backup/last-success` replaced, retaining its
existing single-line dump-URI format. This marker confirms verified artifacts,
**not** all account-deletion recovery prerequisites or a successful DB restore.

### Configuration and installation (operator actions, not performed here)

Prerequisites: the supplied production Docker/Compose deployment, GNU coreutils,
Python 3, the application's existing Alembic installation, and AWS CLI v2 at
`/snap/bin/aws` supporting
`--if-none-match` on both `put-object` and `complete-multipart-upload`, plus
SHA256 multipart checksums. The bucket must have versioning enabled: null or
missing version IDs fail the job. Keep using the EC2 instance role; do not add
static AWS credentials. Application `.env` is passed to Docker Compose only,
never sourced as shell code.

1. Establish the real source migration/cutover evidence and independently
   confirm the dataset UUID shared with the deletion ledger. Preserve the old
   working backup installation until these prerequisites are ready.
2. Create/edit the separate systemd environment file:

   ```sh
   sudoedit /etc/job-comparer-backup.conf
   sudo chown root:root /etc/job-comparer-backup.conf
   sudo chmod 0600 /etc/job-comparer-backup.conf
   ```

   Its required line is `DELETION_LEDGER_DATASET_ID=YOUR_EXISTING_DATASET_UUID`.
   The guard uses `/home/ubuntu/job-comparer/.venv/bin/python` by default.
   If the existing application Python environment is elsewhere, also set
   `BACKUP_ALEMBIC_PYTHON=/absolute/path/to/its/python` in this file. That
   interpreter must already have the project's Alembic dependencies installed;
   no new dependency is introduced. A missing interpreter or unreadable/invalid
   migration graph stops the backup rather than bypassing the guard.

   Replace the dataset placeholder with the independently established UUID;
   do not generate a new identity during installation or recovery. No secrets,
   timestamps, shell commands or application-environment contents belong here.
3. After confirming no backup is currently running, install from the repository:

   ```sh
   cd /home/ubuntu/job-comparer
   sudo systemctl stop job-comparer-backup.timer
   sudo install -o root -g root -m 0750 operations/backup/job-comparer-backup /usr/local/sbin/job-comparer-backup
   sudo install -o root -g root -m 0644 operations/backup/job-comparer-backup.service /etc/systemd/system/job-comparer-backup.service
   sudo install -o root -g root -m 0644 operations/backup/job-comparer-backup.timer /etc/systemd/system/job-comparer-backup.timer
   sudo systemctl daemon-reload
   sudo systemctl enable --now job-comparer-backup.timer
   ```

   The only service-setting addition is the required `EnvironmentFile`. Keep
   LF line endings as enforced by the operations directory's `.gitattributes`.
4. In a separately authorised deployment verification, run
   `sudo systemctl start job-comparer-backup.service` and inspect
   `sudo journalctl -u job-comparer-backup.service -n 100 --no-pager`.
   Confirm both artifact verifications and the updated success marker, then
   perform an isolated restore/reconciliation rehearsal before enabling account
   deletion. None of those runtime actions have been performed for this change.

### IAM and partial failures

All dump and sidecar objects remain under `production/postgres/` in
`job-comparer-prod-backups-994821533024-eu-west-1-an`. Existing prefix-scoped
`s3:PutObject` covers both uploads, including multipart initiation/parts/completion.
Exact-version downloads require **`s3:GetObjectVersion`**, which is distinct from
`s3:GetObject`; add it on `arn:aws:s3:::job-comparer-prod-backups-994821533024-eu-west-1-an/production/postgres/*`
if absent. Multipart failure cleanup also requires **`s3:AbortMultipartUpload`**
on that same resource. No bucket-wide grants or object-delete permission are
needed. This change neither modifies IAM nor adds lifecycle rules. Sidecars
remain within the existing backup retention prefix; the ledger/control prefix
must stay outside those expiry rules.

If a dump upload succeeds but metadata creation/upload/download/comparison
fails, the job exits nonzero, reports an **INCOMPLETE** backup, leaves the S3
dump untouched and does not update `last-success`. Failed verification has the
same outcome. A lost upload response is reported as uncertain, never resolved
by guessing the latest version. Completed S3 objects are never deleted for
compensation. Unfinished multipart uploads are aborted when their ID is known;
lost creation responses or failed aborts may leave parts requiring operator
review. Temporary local files are removed on exit, as in the original script.

Do not use an incomplete pair as a recovery-ready backup or manufacture a
later capture timestamp. A later run creates a new key/pair. `control.json`,
trusted cutover values, the 31-day/floor checks, installation of the startup
interlock and verified restore provenance remain separate prerequisites.

## Root-controlled startup interlock

`recovery_interlock.py` maintains `/var/lib/job-comparer-recovery/clearance.json`
outside the database and repository. The directory is root-owned `0755`; state
and lock files are root-owned `0644`. Only root may mutate them. They contain
operation/dataset UUIDs, host/port/database name, phase, timestamps and backup
key/version, **not** passwords, URLs, email addresses or account data. Protected
parents, regular files and ownership/modes are checked. Do not include this
state in database restores or restore an older clearance file with a machine
snapshot. Root/sudo-capable operators can override this control; the API user
must not be granted privileged access to modify clearance.

Each `begin-recovery` atomically replaces old clearance with a fresh operation
UUID and blocked state, with file/directory fsync. A shared/exclusive file lock
serializes checks, evidence generation and approval; concurrent operations fail
closed rather than wait indefinitely. Evidence is not approval. An apply attempt
clears previous evidence before work, and records new evidence only after its
database commit returns successfully. A failed/uncertain commit leaves startup
blocked. If evidence persistence fails after commit, keep maintenance enabled
and rerun reconciliation. Never import evidence from an old operation.

### Install the check (operator actions; not performed here)

Preserve the existing unit, `.env`, untracked `compose.production.yaml` and
working backup installation first. Stop `job-comparer.service` and all writers,
hold traffic in maintenance, pause the backup timer and wait for any running
backup to finish. Do not migrate/restore concurrently with backups. Review the
trusted checkout/dependencies before executing operator commands as root.

```sh
cd /home/ubuntu/job-comparer
sudo install -d -o root -g root -m 0755 /usr/local/lib/job-comparer-recovery
sudo install -o root -g root -m 0644 recovery_interlock.py deletion_ledger.py /usr/local/lib/job-comparer-recovery/
sudo install -d -o root -g root -m 0755 /etc/systemd/system/job-comparer.service.d
sudo install -o root -g root -m 0644 operations/recovery/job-comparer.service.d/20-recovery-interlock.conf /etc/systemd/system/job-comparer.service.d/
sudo systemctl daemon-reload
```

The drop-in adds only `ExecStartPre` using the confirmed application Python;
it does not replace the existing unit, `User=ubuntu`, environment file or
`ExecStart`. Existing pre-start commands are retained. The check runs as ubuntu,
reads the service's `DATABASE_URL` and `DELETION_LEDGER_DATASET_ID`, and performs
no AWS/database calls or writes. Missing, malformed, unapproved or mismatched
state exits nonzero and blocks startup. A valid approval remains valid for normal
restarts; it does not expire merely because the original backup ages. Reinstall
the root-owned Python copies when these helpers change.

### Initial cutover (not a restore)

Provide the following identifiers from the cutover plan, never guessed values:

```sh
sudo /home/ubuntu/job-comparer/.venv/bin/python recovery_interlock.py begin-cutover \
  --expected-dataset-id DATASET_UUID \
  --database-host DB_HOST --database-port DB_PORT --database-name DB_NAME
```

Record the printed operation UUID. `begin-cutover` refuses an existing state
file; it is not a shortcut for resetting an earlier recovery. Then complete the
real UUID migration, configure/protect the dataset and ledger, run the new backup
workflow and provision trusted `control.json` as described above. Never invent
cutover times. The following evidence command requires all of these:

- Exact configured dataset and backup key/version, validated with the existing
  control/sidecar contract, cutover floor and 31-day age limit.
- Root-protected `/var/lib/job-comparer-backup/last-success` matching that dump
  URI, written after cutover by the new workflow **only after dump and sidecar
  version-specific byte verification**. Preserve that workflow and trusted IAM;
  do not manually manufacture this marker. It is local backup evidence, not
  proof of a successful restore rehearsal.
- The explicit database's non-null, unique UUID column and known migration
  ancestry at or after `0010_account_uuid`, checked read-only. No migrations or
  replacement UUIDs are generated by the interlock.
- A fully validated ledger with no deletion intents: if intents already exist,
  use `begin-recovery` and reconciliation instead of initial-cutover approval.

Set `CUTOVER_DATABASE_URL` and the four `DELETION_LEDGER_*` variables in a
secrets-safe operator environment. Do not source the application `.env` as
shell code or put URLs/credentials on command lines. Then:

```sh
sudo --preserve-env=CUTOVER_DATABASE_URL,DELETION_LEDGER_BUCKET,DELETION_LEDGER_REGION,DELETION_LEDGER_PREFIX,DELETION_LEDGER_DATASET_ID \
  /home/ubuntu/job-comparer/.venv/bin/python recovery_interlock.py record-cutover \
  --operation-id OPERATION_UUID --expected-dataset-id DATASET_UUID \
  --backup-key production/postgres/ORIGINAL_DUMP_KEY \
  --backup-version-id ORIGINAL_S3_VERSION_ID
```

This records evidence only. Complete the isolated runtime rehearsal and other
cutover checks before the explicit approval step below. A failed check must be
fixed and rerun, never bypassed by editing clearance. Use the instance role,
not static AWS credentials.

## Operator sequence

1. Establish isolation/maintenance above. **Before any restore**, invalidate
   old clearance and bind a fresh operation to the exact intended target:

   ```sh
   sudo /home/ubuntu/job-comparer/.venv/bin/python recovery_interlock.py begin-recovery \
     --expected-dataset-id DATASET_UUID \
     --database-host DB_HOST --database-port DB_PORT --database-name DB_NAME
   ```

   Require exit zero and record the printed UUID before proceeding. Restore
   the verified eligible dump into that target. Use an isolated
   `job_comparer_recovery_<name>` database for rehearsals. The target can be the
   offline production name only with a matching root-controlled operation;
   standalone dry-runs retain the purpose-named recovery database restriction.
2. Supply its PostgreSQL SQLAlchemy URL through `RECOVERY_DATABASE_URL`, using
   the `postgresql+psycopg` driver and a secrets-safe operator environment.
   The command never falls back to application `DATABASE_URL`. It checks both
   the URL database name and PostgreSQL's actual `current_database()`.
3. Run a dry-run, substituting independently verified identifiers:

   ```sh
   /home/ubuntu/job-comparer/.venv/bin/python reconcile_account_deletions.py \
     --recovery-database DB_NAME --operation-id OPERATION_UUID \
     --expected-dataset-id DATASET_UUID \
     --backup-key production/postgres/ORIGINAL_DUMP_KEY \
     --backup-version-id ORIGINAL_S3_VERSION_ID
   ```

4. Review the count-only JSON summary. Apply now requires the current
   `--operation-id` and root access to record evidence. With the same explicit
   secrets-safe operator environment, run:

   ```sh
   sudo --preserve-env=RECOVERY_DATABASE_URL,DELETION_LEDGER_BUCKET,DELETION_LEDGER_REGION,DELETION_LEDGER_PREFIX,DELETION_LEDGER_DATASET_ID \
     /home/ubuntu/job-comparer/.venv/bin/python reconcile_account_deletions.py \
     --recovery-database DB_NAME --operation-id OPERATION_UUID \
     --expected-dataset-id DATASET_UUID \
     --backup-key production/postgres/ORIGINAL_DUMP_KEY \
     --backup-version-id ORIGINAL_S3_VERSION_ID --apply
   ```

   Dry-run uses a read-only transaction and never records evidence. Apply
   re-fetches and validates the complete ledger before database access.
5. Require exit code zero and an `applied` result. Rerun dry-run to confirm
   zero matching accounts, sessions and verification tokens before proceeding
   with explicit approval below. An old operation ID, different dataset or
   different host/port/database cannot produce or reuse evidence. Do not rename
   or copy the database after reconciliation: that is a new recovery operation.

### Approve, then start (both workflows)

Keep writers stopped and traffic in maintenance through operator review. Set
the operator environment's `DATABASE_URL` and `DELETION_LEDGER_DATASET_ID` to
the actual intended API settings, using secrets-safe handling. They must match
the evidenced target and dataset. Hostnames are compared case-insensitively,
default port is 5432; aliases/renames are not guessed. Alternate libpq routing
via query parameters or environment is rejected (SSL query options are allowed).

```sh
sudo --preserve-env=DATABASE_URL,DELETION_LEDGER_DATASET_ID \
  /home/ubuntu/job-comparer/.venv/bin/python recovery_interlock.py approve \
  --operation-id OPERATION_UUID
sudo systemctl start job-comparer.service
```

Only evidenced operations can be approved. Confirm the startup check and API
health before releasing maintenance and re-enabling the existing backup timer.
The actual service configuration must point to the **same** target; approval
does not rewrite `.env`. Preserve the backup script's `job_comparer_prod` guard
for the production deployment. On any failure keep maintenance; a fresh restore
always starts with `begin-recovery`, even if an earlier operation was approved.

**Limits:** `ExecStartPre` does not stop an already-running API, block direct
manual Uvicorn execution, verify which dump was restored, or detect restores
that bypass this procedure. Root can override the files/unit. Host/port/name
binding is not a PostgreSQL physical-instance fingerprint. Stop old instances
and all writers, protect routing/configuration and do not restore clearance
alongside a machine image. This is an explicit operator interlock, not an
automatic recovery platform or a defence against a privileged operator.

No runtime checks have been performed. Before deployment rehearse missing/
mismatched clearance, begin invalidation, stale-operation rejection, failed or
uncertain apply, successful apply/approval, normal restart and dataset/target
changes using an isolated database/ledger and disposable records. Confirm actual
systemd environment/permissions, AWS metadata access and backup verification.
Production migration, IAM/lifecycle protection, trusted control provisioning
and the isolated restore rehearsal remain required; these files do none of them.

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
