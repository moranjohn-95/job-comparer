# Job Comparer API

A minimal FastAPI backend with a health check.

## Install

Create and activate a Python virtual environment, then install dependencies (PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Set up the development database

Docker Desktop must be running. Copy the example environment file, then edit `.env` and replace the placeholder password in both `POSTGRES_PASSWORD` and `DATABASE_URL` with the same local password (letters and digits work without URL encoding). Keep `POSTGRES_DB` and the database name in `DATABASE_URL` in sync. If port 5432 is occupied, change `POSTGRES_PORT` and the port in `DATABASE_URL` together.

```powershell
Copy-Item .env.example .env
docker compose up -d --wait
python -m alembic upgrade head
```

The initial migration records the migration baseline; there are no application tables yet. Docker stores PostgreSQL data in the `postgres_data` named volume. To stop the database without deleting its data, run `docker compose down`.

## Run the API

```powershell
python -m uvicorn main:app --reload
```

Open <http://127.0.0.1:8000/health> to see `{"status":"ok"}`.

## Run the test

With the development database running and `.env` configured:

```powershell
python -m pytest
```

The database test runs `SELECT 1` and confirms the connection is to `POSTGRES_DB`.
