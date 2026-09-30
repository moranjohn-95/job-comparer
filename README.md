# Job Comparer API

A FastAPI backend with PostgreSQL accounts, a health check, and Alembic migrations.

## Install

Create and activate a Python virtual environment, then install dependencies (PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Set up the development database

Docker Desktop must be running. For a fresh setup, copy the example file:

```powershell
Copy-Item .env.example .env
```

If `.env` already exists, keep it and add the new `AUTH_SECRET_KEY` setting. Edit `.env` before starting Docker:

- Replace the placeholder in `POSTGRES_PASSWORD` and `DATABASE_URL` with the same local password. Letters and digits work without URL encoding.
- Replace `AUTH_SECRET_KEY` with a random secret of at least 32 characters. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"` and paste the output into `.env`. Keep it private.
- Keep `POSTGRES_DB` and the database name in `DATABASE_URL` in sync. If port 5432 is occupied, change `POSTGRES_PORT` and the port in `DATABASE_URL` together.

```powershell
docker compose up -d --wait
python -m alembic upgrade head
```

Alembic creates the `users` table. Docker stores PostgreSQL data in the `postgres_data` named volume. To stop the database without deleting its data, run `docker compose down`.

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

## Run the test

With the development database running and `.env` configured:

```powershell
python -m pytest
```

The tests use the development PostgreSQL database. The account tests create unique users and remove them afterward; the database test runs `SELECT 1` and confirms the connection is to `POSTGRES_DB`.
