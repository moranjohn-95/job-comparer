from fastapi.testclient import TestClient

from main import app


def test_health_returns_ok() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["content-type"] == "application/json"


def test_health_cors_allows_only_local_frontend() -> None:
    client = TestClient(app)
    allowed = client.get(
        "/health", headers={"Origin": "http://127.0.0.1:5173"}
    )
    other = client.get(
        "/health", headers={"Origin": "https://example.com"}
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == (
        "http://127.0.0.1:5173"
    )
    assert other.status_code == 200
    assert "access-control-allow-origin" not in other.headers
