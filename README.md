# Job Comparer API

A FastAPI backend with PostgreSQL accounts, one saved CV per user, a health check, and Alembic migrations. CV text can be entered directly or extracted from a PDF or DOCX upload.

## Install

Create and activate a Python virtual environment, then install dependencies (PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Set up the databases

Docker Desktop must be running. For a fresh setup, copy the example file:

```powershell
Copy-Item .env.example .env
```

If `.env` already exists, keep it and add the `POSTGRES_TEST_*` and `TEST_DATABASE_URL` settings from `.env.example`. Edit `.env` before starting Docker:

- Replace the placeholder in `POSTGRES_PASSWORD` and `DATABASE_URL` with the same local password. Letters and digits work without URL encoding.
- Replace the placeholder in `POSTGRES_TEST_PASSWORD` and `TEST_DATABASE_URL` with a second local password. The test URL must name `POSTGRES_TEST_DB`, which must differ from `POSTGRES_DB`.
- Replace `AUTH_SECRET_KEY` with a random secret of at least 32 characters. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"` and paste the output into `.env`. Keep it private.
- Keep `POSTGRES_DB` and the database name in `DATABASE_URL` in sync. If port 5432 or 5433 is occupied, change the matching `POSTGRES_PORT` or `POSTGRES_TEST_PORT` and URL port together.

```powershell
docker compose up -d --wait
python -m alembic upgrade head
python -m alembic -x database=test upgrade head
```

Compose starts separate development and test PostgreSQL containers. Alembic creates the `users` and `cvs` tables in each database. Docker stores their data in separate `postgres_data` and `postgres_test_data` named volumes. To stop both without deleting data, run `docker compose down`.

## Run the API

```powershell
python -m uvicorn main:app --reload
```

Open <http://127.0.0.1:8000/health> to see `{"status":"ok"}`.

## Accounts

`POST /signup` accepts JSON with `email` and `password` (12 to 128 characters) and returns the user ID and normalized email. `POST /login` accepts the same fields and returns a bearer token valid for one hour. Send that token as `Authorization: Bearer <token>` to `GET /me` to retrieve the current user's ID and email. Invalid input returns 422, duplicate email returns 409, and invalid login or authentication returns 401. Passwords are stored as Argon2 hashes and are never included in API responses.

PowerShell example, with the API running:

```powershell
$body = @{ email = 'dev@example.com'; password = 'a-local-password-123' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/signup -ContentType application/json -Body $body
$token = (Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/login -ContentType application/json -Body $body).access_token
Invoke-RestMethod -Uri http://127.0.0.1:8000/me -Headers @{ Authorization = "Bearer $token" }
```

## Saved CV

Each authenticated account can have one plain-text CV of up to 50,000 characters. Whitespace-only text and longer input return 422 with a clear error. The API derives ownership from the bearer token; there is no user ID in these routes.

| Method | Endpoint | Result |
| --- | --- | --- |
| `PUT` | `/cv` | Save or replace the current user's CV with JSON `{"text":"..."}`; returns the saved text. |
| `GET` | `/cv` | Return the current user's CV, or 404 if none is saved. |
| `DELETE` | `/cv` | Delete the current user's CV; returns 204, or 404 if none is saved. |
| `POST` | `/cv/upload` | Upload a PDF or DOCX as multipart field `file`, extract its text, and replace the current user's CV only if validation succeeds. |

All three routes return 401 without a valid bearer token. With `$token` from the login example above, try them in PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $token" }
$cvBody = @{ text = "Software engineer`nPython and PostgreSQL experience" } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:8000/cv -Headers $headers -ContentType application/json -Body $cvBody
Invoke-RestMethod -Uri http://127.0.0.1:8000/cv -Headers $headers
Invoke-RestMethod -Method Delete -Uri http://127.0.0.1:8000/cv -Headers $headers
```

To upload a local PDF or DOCX instead, use the token from the login example and replace the sample path:

```powershell
curl.exe -X POST http://127.0.0.1:8000/cv/upload -H "Authorization: Bearer $token" -F "file=@C:\path\to\resume.pdf"
```

Uploads must be no larger than 5 MiB. The filename and file structure must match PDF or DOCX, and extracted text must meet the same 50,000-character limit as direct text entry. Unsupported formats or mismatched content return 415; files over the limit return 413. Damaged, encrypted, scanned or image-only, and text-empty documents return 422 with a specific error. A failed upload leaves the saved CV unchanged. The original upload is closed after processing and is not stored by the application. Image text is not processed with OCR.

## Run the tests

With both databases running and `.env` configured:

```powershell
python -m pytest
python -m alembic -x database=test check
```

Pytest switches to `TEST_DATABASE_URL` and applies pending migrations before tests. It refuses to run if that URL names the development database or if the live connection does not reach `POSTGRES_TEST_DB`. The account and CV tests create unique users in the test database and remove them afterward. The connection test runs `SELECT 1` and confirms the test database name.
