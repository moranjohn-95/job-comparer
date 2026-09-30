# Job Comparer API

A minimal FastAPI backend with a health check.

## Install

Create and activate a Python virtual environment, then install dependencies:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## Run the API

```powershell
python -m uvicorn main:app --reload
```

Open <http://127.0.0.1:8000/health> to see `{"status":"ok"}`.

## Run the test

```powershell
python -m pytest
```
