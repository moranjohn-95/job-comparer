# Job Comparer API

A FastAPI backend with PostgreSQL accounts, one saved CV and private saved jobs per user, a one-off AI comparison endpoint, a health check, and Alembic migrations. CV text can be entered directly or extracted from a PDF or DOCX upload.

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
- AI comparisons are disabled by default. To enable them, set `AI_COMPARISON_ENABLED=true`, set `OPENAI_API_KEY` to your private provider key, and keep `OPENAI_MODEL=gpt-4o-mini`. The server rejects other model names. Keep the key on the server and out of client requests. Tests use mocked responses and do not need a provider key.
- Keep `POSTGRES_DB` and the database name in `DATABASE_URL` in sync. If port 5432 or 5433 is occupied, change the matching `POSTGRES_PORT` or `POSTGRES_TEST_PORT` and URL port together.

```powershell
docker compose up -d --wait
python -m alembic upgrade head
python -m alembic -x database=test upgrade head
```

Compose starts separate development and test PostgreSQL containers. Alembic creates the `users`, `cvs`, `jobs`, and `ai_usage_counters` tables in each database. Docker stores their data in separate `postgres_data` and `postgres_test_data` named volumes. To stop both without deleting data, run `docker compose down`.

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

All CV routes return 401 without a valid bearer token. With `$token` from the login example above, try them in PowerShell:

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

## Saved jobs

Jobs belong to the authenticated user. A job needs a title (up to 200 characters), company name (up to 200), and pasted description (up to 20,000). An optional source URL can be up to 2,048 characters and must be an absolute `http` or `https` URL. The server stores the URL as supplied after trimming outer whitespace; it does not visit or fetch it. Blank required fields, invalid URLs, and overlong values return 422.

| Method | Endpoint | Result |
| --- | --- | --- |
| `POST` | `/jobs` | Create a job; returns 201 and the saved job. |
| `GET` | `/jobs` | List the current user's jobs, newest first. |
| `GET` | `/jobs/{job_id}` | View one owned job; returns 404 if missing or owned by someone else. |
| `DELETE` | `/jobs/{job_id}` | Delete one owned job; returns 204, or 404 if missing or owned by someone else. |

All job routes require a bearer token and return 401 without one. With `$token` from the login example:

```powershell
$headers = @{ Authorization = "Bearer $token" }
$jobBody = @{ title = 'Backend Engineer'; company_name = 'Example Co'; description = 'Build Python APIs'; source_url = 'https://example.com/jobs/123' } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/jobs -Headers $headers -ContentType application/json -Body $jobBody
Invoke-RestMethod -Uri http://127.0.0.1:8000/jobs -Headers $headers
Invoke-RestMethod -Uri "http://127.0.0.1:8000/jobs/$($job.id)" -Headers $headers
Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:8000/jobs/$($job.id)" -Headers $headers
```

## Compare a saved CV with an owned job

`POST /jobs/{job_id}/compare` requires a bearer token, an owned saved job, and a saved CV. When enabled, it sends the saved CV text and that job's description to the configured OpenAI model for a one-off comparison. The result has `matched_requirements` with short excerpts from both texts, and `possible_gaps` with a job excerpt and the status `not_found_in_cv`. A possible gap only means the saved CV does not show evidence of a requirement; it does not establish that the user lacks the skill. The endpoint gives no suitability score or hiring prediction. It does not store comparison results.

With `$token` and `$job` from the examples above, and a saved CV:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/jobs/$($job.id)/compare" -Headers @{ Authorization = "Bearer $token" }
```

Example response shape (the actual requirements and excerpts depend on the saved texts):

```json
{
  "matched_requirements": [
    {"requirement": "Python APIs", "job_evidence": "Build Python APIs", "cv_evidence": "Built Python APIs"}
  ],
  "possible_gaps": [
    {"requirement": "Kubernetes", "job_evidence": "Deploy services with Kubernetes", "status": "not_found_in_cv"}
  ],
  "interpretation": "A possible gap means evidence was not found in the saved CV; it does not establish that the person lacks the skill."
}
```

Missing or unowned jobs return 404 without contacting the provider; a missing CV also returns 404. Disabled mode or invalid provider configuration returns 503. A saved CV over 12,000 characters or 16,000 UTF-8 bytes, or a job description over 8,000 characters or 12,000 UTF-8 bytes, returns 422 before any provider call. The serialized CV and job text together must also fit within 32,000 UTF-8 bytes. The complete saved text must fit these limits; it is not silently truncated.

Each account can make at most 3 comparison attempts per UTC day. Across all accounts sharing the same PostgreSQL database, the app allows at most 10 attempts per UTC day and 50 per UTC calendar month. A reached limit returns 429 with the specific account, daily app, or monthly app limit. PostgreSQL locks a shared counter row and commits the reservation before the provider call, so simultaneous requests and extra accounts cannot exceed the app limits. Provider failures and timeouts still count because the provider may have processed and charged for the request. Counters are not reset when an account is deleted. There are no automatic provider retries. Each request uses only `gpt-4o-mini` and caps output at 1,200 tokens.

Provider failures or invalid output return a generic 502 without including CV text, the API key, or provider error details. No comparison result is saved on failure or success. A comparison uses provider tokens and may incur a charge on each request. These controls limit this endpoint's attempts, not currency spent: token prices and input tokenization vary, a timed-out call may still be charged, and use of the same API key outside this app is not counted. Separate app installations with separate databases have separate limits. The request sets `store: false` to disable response storage, but the provider's default abuse monitoring logs may still retain request content for up to 30 days; review [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data?article_id=8510) before sending sensitive CV data. Results are AI generated and should be checked against the source texts; excerpt checks cannot prove the model's interpretation is correct.

## Run the tests

With both databases running and `.env` configured:

```powershell
python -m pytest
python -m alembic -x database=test check
```

Pytest switches to `TEST_DATABASE_URL` and applies pending migrations before tests. It refuses to run if that URL names the development database or if the live connection does not reach `POSTGRES_TEST_DB`. The account, CV, and job tests create unique users in the test database and remove them afterward. The connection test runs `SELECT 1` and confirms the test database name.

## Lint Python files

Install Flake8 in the active virtual environment and check all project Python
files, including tests and Alembic migrations:

```powershell
python -m pip install flake8==7.4.1
python -m flake8 . --exclude .venv --jobs 1
```

The check uses Flake8's default 79-character line limit. GitHub Actions runs
the same command on pushes and pull requests. The `.venv` directory is excluded.
