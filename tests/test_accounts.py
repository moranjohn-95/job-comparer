from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha256
import re
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
import jwt
from conftest import BrowserClient as TestClient, signup_verified
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response

from auth import verify_password
from auth_sessions import create_session
from auth_http import get_auth_settings
from auth_rate_limit import (
    LOGIN_EMAIL_ATTEMPT_LIMIT,
    LOGIN_IP_ATTEMPT_LIMIT,
    LOGIN_WINDOW,
    SIGNUP_ATTEMPT_LIMIT,
    login_email_scope,
)
from database import get_engine
from main import app, client_ip
import main
import email_verification
import mail_delivery
from models import AuthRateLimitCounter, AuthSession, User, VerificationToken

PASSWORD = "correct-horse-battery-123"


def emailed_token(client, email):
    body = next(body for to, _, body in reversed(client.outbox) if to == email)
    return re.search(r"#token=([A-Za-z0-9_-]{43})", body).group(1)


def end_email_cooldown():
    with Session(get_engine()) as db:
        db.execute(update(AuthRateLimitCounter).values(
            last_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=61)
        ))
        db.commit()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def email() -> Iterator[str]:
    address = f"account-test-{uuid4().hex}@example.com"
    yield address
    with Session(get_engine()) as session:
        session.execute(delete(User).where(User.email == address))
        session.commit()


def signup(client: TestClient, email: str) -> None:
    signup_verified(client, email, PASSWORD)


def test_signup_hashes_password_without_exposing_account_state(
    client: TestClient, email: str
) -> None:
    response = client.post(
        "/signup", json={"email": email.upper(), "password": PASSWORD}
    )

    assert response.status_code == 202
    assert set(response.json()) == {"message"}
    assert "set-cookie" not in response.headers
    assert PASSWORD not in response.text
    with Session(get_engine()) as session:
        user = session.scalar(select(User).where(User.email == email))
        assert user is not None
        assert user.password_hash != PASSWORD
        assert verify_password(PASSWORD, user.password_hash)
        assert user.email_verified_at is None


def test_verification_requires_password_and_unlocks_login(client, email):
    response = client.post("/signup", json={
        "email": email, "password": PASSWORD,
    })
    assert response.status_code == 202
    token = emailed_token(client, email)
    assert token not in response.text
    assert "/verify-email#token=" in client.outbox[-1][2]
    with Session(get_engine()) as db:
        user = db.scalar(select(User).where(User.email == email))
        saved = db.scalar(select(VerificationToken).where(
            VerificationToken.user_id == user.id
        ))
        assert saved.token_hash == sha256(
            f"email_verification:{token}".encode()
        ).hexdigest()
        assert saved.expires_at - saved.created_at == timedelta(hours=24)
        session_cookie = create_session(db, user.id)
        db.commit()
    cookie = {"Cookie": f"job_comparer_session={session_cookie}"}
    blocked = client.get("/me", headers=cookie)
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "email_verification_required"
    assert client.post("/login", json={
        "email": email, "password": "incorrect",
    }).status_code == 401
    login = client.post("/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 403
    assert "set-cookie" not in login.headers
    wrong = client.post("/verification/confirm", json={
        "token": token, "password": "incorrect",
    })
    assert wrong.status_code == 400
    confirmed = client.post("/verification/confirm", json={
        "token": token, "password": PASSWORD,
    })
    assert confirmed.status_code == 200
    assert "set-cookie" not in confirmed.headers
    assert client.get("/me", headers=cookie).status_code == 401
    assert client.post("/login", json={
        "email": email, "password": PASSWORD,
    }).status_code == 200
    assert client.get("/me").status_code == 200
    assert client.post("/verification/confirm", json={
        "token": token, "password": PASSWORD,
    }).status_code == 400


def test_expired_links_and_all_outstanding_tokens_are_invalidated(
    client, email
):
    client.post("/signup", json={"email": email, "password": PASSWORD})
    expired = emailed_token(client, email)
    with Session(get_engine()) as db:
        db.execute(update(VerificationToken).where(
            VerificationToken.token_hash
            == email_verification.token_digest(expired)
        ).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        db.commit()
    assert client.post("/verification/confirm", json={
        "token": expired, "password": PASSWORD,
    }).status_code == 400
    tokens = []
    for _ in range(2):
        end_email_cooldown()
        assert client.post("/verification/resend", json={
            "email": email,
        }).status_code == 202
        tokens.append(emailed_token(client, email))
    assert tokens[0] != tokens[1]
    assert client.post("/verification/confirm", json={
        "token": tokens[0], "password": PASSWORD,
    }).status_code == 200
    assert client.post("/verification/confirm", json={
        "token": tokens[1], "password": PASSWORD,
    }).status_code == 400
    with Session(get_engine()) as db:
        user = db.scalar(select(User).where(User.email == email))
        assert db.scalar(select(VerificationToken.id).where(
            VerificationToken.user_id == user.id,
            VerificationToken.consumed_at.is_(None),
        )) is None


def test_confirmation_is_atomic_across_workers(client, email):
    client.post("/signup", json={"email": email, "password": PASSWORD})
    token = emailed_token(client, email)

    def confirm(_):
        with TestClient(app) as browser:
            return browser.post("/verification/confirm", json={
                "token": token, "password": PASSWORD,
            }).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(confirm, range(2))) == [200, 400]


def test_resend_is_generic_and_has_persistent_cooldown(client, email):
    signup(client, email)
    end_email_cooldown()
    known = client.post("/verification/resend", json={"email": email})
    unknown = client.post("/verification/resend", json={
        "email": f"unknown-{uuid4().hex}@example.com",
    })
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    with TestClient(app) as another_worker:
        limited = another_worker.post("/verification/resend", json={
            "email": email,
        })
    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "60"
    end_email_cooldown()
    assert client.post("/verification/resend", json={
        "email": email,
    }).status_code == 202


def test_verification_password_attempts_are_limited(client, email):
    client.post("/signup", json={"email": email, "password": PASSWORD})
    token = emailed_token(client, email)
    for _ in range(5):
        assert client.post("/verification/confirm", json={
            "token": token, "password": "wrong-password",
        }).status_code == 400
    assert client.post("/verification/confirm", json={
        "token": token, "password": PASSWORD,
    }).status_code == 429


def test_missing_mail_config_is_recoverable_through_resend(
    client, email, monkeypatch
):
    mocked_delivery = email_verification.send_email
    for name in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"):
        monkeypatch.setenv(name, "")
    # Exercise real configuration rejection, without making an SMTP connection.
    monkeypatch.setattr(email_verification, "send_email",
                        mail_delivery.send_email)
    response = client.post("/signup", json={
        "email": email, "password": PASSWORD,
    })
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "email_delivery_failed"
    assert client.outbox == []
    with Session(get_engine()) as db:
        user = db.scalar(select(User).where(User.email == email))
        assert user is not None and user.email_verified_at is None
    monkeypatch.setattr(email_verification, "send_email", mocked_delivery)
    end_email_cooldown()
    assert client.post("/verification/resend", json={
        "email": email,
    }).status_code == 202
    assert client.post("/verification/confirm", json={
        "token": emailed_token(client, email), "password": PASSWORD,
    }).status_code == 200


@pytest.mark.parametrize("url", [
    "", "http://app.example", "https://untrusted.example", "https://[",
    "https://app.example#token=not-allowed", "https://app.example?redirect=x",
])
def test_verification_links_require_configured_https_url(monkeypatch, url):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "true")
    monkeypatch.setenv("AUTH_ALLOWED_ORIGINS", "https://app.example")
    monkeypatch.setenv("PUBLIC_FRONTEND_URL", url)
    with pytest.raises(mail_delivery.MailDeliveryError):
        email_verification.public_frontend_url()


@pytest.mark.parametrize("setting,value", [
    ("SMTP_TLS_MODE", "none"), ("SMTP_PORT", "0"),
    ("SMTP_TIMEOUT_SECONDS", "0"), ("SMTP_TIMEOUT_SECONDS", "31"),
    ("SMTP_USERNAME", ""),
])
def test_mail_rejects_unsafe_configuration_before_connecting(
    monkeypatch, setting, value
):
    for name, valid in {
        "SMTP_HOST": "smtp.example.invalid", "SMTP_PORT": "465",
        "SMTP_USERNAME": "test-only", "SMTP_PASSWORD": "test-only",
        "SMTP_FROM": "sender@example.com", "SMTP_TLS_MODE": "implicit",
        "SMTP_TIMEOUT_SECONDS": "10",
    }.items():
        monkeypatch.setenv(name, valid)
    monkeypatch.setenv(setting, value)
    with pytest.raises(mail_delivery.MailDeliveryError):
        mail_delivery.send_email("recipient@example.com", "Test", "Test")


def test_login_issues_cookie_only(client: TestClient, email: str) -> None:
    signup(client, email)

    response = client.post(
        "/login", json={"email": email, "password": PASSWORD}
    )

    assert response.status_code == 200
    assert set(response.json()) == {"id", "email"}
    token = response.cookies["job_comparer_session"]
    assert token not in response.text
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Path=/" in cookie and "Domain=" not in cookie
    assert response.headers["cache-control"] == "no-store"
    with Session(get_engine()) as db:
        saved = db.scalar(select(AuthSession).where(
            AuthSession.token_hash == sha256(token.encode()).hexdigest()
        ))
        assert saved is not None
        expires = cookie.split("expires=", 1)[1].split(";", 1)[0]
        assert parsedate_to_datetime(expires) == saved.expires_at.replace(
            microsecond=0
        )
    again = client.post(
        "/login", json={"email": email, "password": PASSWORD}
    )
    assert again.cookies["job_comparer_session"] != token
    assert PASSWORD not in response.text


def test_duplicate_signup_preserves_password_and_returns_generic_response(
    client: TestClient, email: str
) -> None:
    signup(client, email)
    with Session(get_engine()) as db:
        db.execute(update(AuthRateLimitCounter).values(last_attempt_at=None))
        db.commit()

    response = client.post(
        "/signup", json={
            "email": email.upper(), "password": "changed-password",
        }
    )

    assert response.status_code == 202
    assert set(response.json()) == {"message"}
    with Session(get_engine()) as db:
        user = db.scalar(select(User).where(User.email == email))
        assert verify_password(PASSWORD, user.password_hash)
        assert not verify_password("changed-password", user.password_hash)


@pytest.mark.parametrize("wrong_field", ["email", "password"])
def test_invalid_login_is_rejected(
    client: TestClient, email: str, wrong_field: str
) -> None:
    signup(client, email)
    credentials = {"email": email, "password": PASSWORD}
    credentials[wrong_field] = (
        "someone-else@example.com"
        if wrong_field == "email"
        else "wrong-password"
    )

    response = client.post("/login", json=credentials)

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid email or password"}


def test_login_email_limit_uses_normalized_email_and_returns_generic_429(
    client: TestClient, email: str
) -> None:
    for _ in range(LOGIN_EMAIL_ATTEMPT_LIMIT):
        response = client.post(
            "/login",
            json={"email": email.upper(), "password": "wrong-password"},
        )
        assert response.status_code == 401

    response = client.post(
        "/login", json={"email": email, "password": "wrong-password"}
    )

    assert response.status_code == 429
    assert response.json() == {
        "detail": "Too many authentication attempts. Please try again later."
    }


def test_login_limit_resets_in_a_new_window(
    client: TestClient, email: str
) -> None:
    old_window = (
        datetime.now(timezone.utc) - LOGIN_WINDOW - timedelta(minutes=1)
    )
    with Session(get_engine()) as session:
        session.add(
            AuthRateLimitCounter(
                counter_key=(
                    f"{login_email_scope(email)}:{old_window.isoformat()}"
                ),
                attempt_count=LOGIN_EMAIL_ATTEMPT_LIMIT,
            )
        )
        session.commit()

    response = client.post(
        "/login", json={"email": email, "password": "wrong-password"}
    )

    assert response.status_code == 401


def test_changing_email_does_not_bypass_login_ip_limit() -> None:
    with TestClient(app, client=("198.51.100.10", 50000)) as client:
        for _ in range(LOGIN_IP_ATTEMPT_LIMIT):
            response = client.post(
                "/login",
                json={
                    "email": f"ip-limit-{uuid4().hex}@example.com",
                    "password": "wrong-password",
                },
            )
            assert response.status_code == 401

        response = client.post(
            "/login",
            json={
                "email": f"ip-limit-{uuid4().hex}@example.com",
                "password": "wrong-password",
            },
        )

    assert response.status_code == 429


def test_changing_ip_does_not_bypass_login_email_limit() -> None:
    email = f"email-limit-{uuid4().hex}@example.com"
    for index in range(LOGIN_EMAIL_ATTEMPT_LIMIT):
        with TestClient(
            app, client=(f"198.51.100.{index + 20}", 50000)
        ) as client:
            response = client.post(
                "/login", json={"email": email, "password": "wrong-password"}
            )
            assert response.status_code == 401

    with TestClient(app, client=("198.51.100.30", 50000)) as client:
        response = client.post(
            "/login", json={"email": email, "password": "wrong-password"}
        )

    assert response.status_code == 429


def test_signup_limit_is_per_ip(client: TestClient) -> None:
    for _ in range(SIGNUP_ATTEMPT_LIMIT):
        response = client.post(
            "/signup",
            json={
                "email": f"signup-limit-{uuid4().hex}@example.com",
                "password": PASSWORD,
            },
        )
        assert response.status_code == 202

    response = client.post(
        "/signup",
        json={
            "email": f"signup-limit-{uuid4().hex}@example.com",
            "password": PASSWORD,
        },
    )

    assert response.status_code == 429
    assert response.json() == {
        "detail": "Too many authentication attempts. Please try again later."
    }


def test_forwarded_ip_is_used_only_for_a_trusted_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TRUSTED_PROXY_IPS", "10.0.0.1")
    scope = {
        "type": "http",
        "client": ("10.0.0.1", 443),
        "headers": [(b"x-forwarded-for", b"198.51.100.8, 10.0.0.2")],
    }
    assert client_ip(Request(scope)) == "198.51.100.8"

    scope["client"] = ("198.51.100.9", 443)
    assert client_ip(Request(scope)) == "198.51.100.9"


def test_me_requires_authentication(client: TestClient) -> None:
    response = client.get("/me")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_me_returns_authenticated_user(client: TestClient, email: str) -> None:
    signup(client, email)
    client.post(
        "/login", json={"email": email, "password": PASSWORD}
    )

    response = client.get("/me")

    assert response.status_code == 200
    assert response.json() == {"id": response.json()["id"], "email": email}
    assert PASSWORD not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_me_rejects_bearer_authentication(client, email) -> None:
    signup(client, email)
    with Session(get_engine()) as db:
        user_id = db.scalar(select(User.id).where(User.email == email))
    legacy = jwt.encode(
        {"sub": str(user_id),
         "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
        "test-legacy-signing-key-at-least-32-characters", algorithm="HS256",
    )
    response = client.get(
        "/me", headers={"Authorization": f"Bearer {legacy}"}
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_failed_login_commit_never_issues_cookie(client, email, monkeypatch):
    signup(client, email)
    original_create = main.create_session

    def fail_commit():
        raise RuntimeError("Test database commit failure")

    def create_without_commit(db, user_id):
        token = original_create(db, user_id)
        monkeypatch.setattr(db, "commit", fail_commit)
        return token

    monkeypatch.setattr(main, "create_session", create_without_commit)
    with TestClient(app, raise_server_exceptions=False) as browser:
        response = browser.post(
            "/login", json={"email": email, "password": PASSWORD}
        )
    assert response.status_code == 500
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    with Session(get_engine()) as db:
        assert db.scalar(select(AuthSession.id).join(User).where(
            User.email == email
        )) is None


def test_failed_logout_commit_does_not_clear_cookie(
    client, email, monkeypatch
):
    signup(client, email)
    login = client.post(
        "/login", json={"email": email, "password": PASSWORD}
    )
    token = login.cookies["job_comparer_session"]
    original_revoke = main.revoke_session

    def fail_commit():
        raise RuntimeError("Test database commit failure")

    def revoke_without_commit(db, value):
        original_revoke(db, value)
        monkeypatch.setattr(db, "commit", fail_commit)

    monkeypatch.setattr(main, "revoke_session", revoke_without_commit)
    with TestClient(app, raise_server_exceptions=False) as browser:
        response = browser.post("/logout", headers={
            "Cookie": f"job_comparer_session={token}",
        })
    assert response.status_code == 500
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    assert client.get("/me").status_code == 200


def test_logout_revokes_cookie_and_is_idempotent(client, email) -> None:
    signup(client, email)
    login = client.post(
        "/login", json={"email": email, "password": PASSWORD}
    )
    token = login.cookies["job_comparer_session"]
    response = client.post("/logout")
    assert response.status_code == 204
    cookie = response.headers["set-cookie"]
    for attribute in ("HttpOnly", "SameSite=lax", "Path=/", "Max-Age=0"):
        assert attribute in cookie
    assert "Domain=" not in cookie
    assert client.get("/me").status_code == 401
    old_cookie = {"Cookie": f"job_comparer_session={token}"}
    assert client.get("/me", headers=old_cookie).status_code == 401
    assert client.post("/logout", headers=old_cookie).status_code == 204
    assert client.post("/logout").status_code == 204


@pytest.mark.parametrize("method,path", [
    ("POST", "/signup"), ("POST", "/login"), ("POST", "/logout"),
    ("POST", "/cv/upload"), ("PUT", "/cv"), ("POST", "/jobs"),
    ("POST", "/jobs/1/compare"), ("DELETE", "/jobs/1"),
    ("POST", "/verification/resend"), ("POST", "/verification/confirm"),
])
@pytest.mark.parametrize("origin,protection", [
    (None, "1"), ("null", "1"), ("https://untrusted.example", "1"),
    ("http://127.0.0.1:5173", None),
])
def test_mutations_require_origin_and_protection(
    client, method, path, origin, protection
) -> None:
    client.headers.pop("Origin")
    client.headers.pop("X-CSRF-Protection")
    headers = {}
    if origin is not None:
        headers["Origin"] = origin
    if protection is not None:
        headers["X-CSRF-Protection"] = protection
    response = client.request(method, path, headers=headers)
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    with Session(get_engine()) as db:
        assert db.scalar(select(AuthRateLimitCounter.counter_key)) is None


@pytest.mark.parametrize("setting,value", [
    ("SESSION_COOKIE_SECURE", "false"),
    ("SESSION_COOKIE_SECURE", "maybe"),
    ("APP_ENV", "prod"),
    ("AUTH_ALLOWED_ORIGINS", ""),
    ("AUTH_ALLOWED_ORIGINS", "*"),
    ("AUTH_ALLOWED_ORIGINS", "http://127.0.0.1:5173"),
    ("AUTH_ALLOWED_ORIGINS", "https://app.example/path"),
    ("AUTH_ALLOWED_ORIGINS", "https://user:pass@app.example"),
])
def test_production_rejects_insecure_configuration(
    monkeypatch, setting, value
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "true")
    monkeypatch.setenv("AUTH_ALLOWED_ORIGINS", "https://app.example")
    monkeypatch.setenv(setting, value)
    with pytest.raises(RuntimeError):
        get_auth_settings()


def test_production_cookie_defaults(monkeypatch) -> None:
    monkeypatch.delenv("APP_ENV")
    monkeypatch.delenv("SESSION_COOKIE_SECURE")
    monkeypatch.setenv("AUTH_ALLOWED_ORIGINS", "https://app.example")
    settings = get_auth_settings()
    assert settings.origins == ("https://app.example",)
    response = Response()
    response.set_cookie(settings.cookie_name, "test-only",
                        **settings.cookie_options)
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("__Host-job_comparer_session=")
    for attribute in ("Secure", "HttpOnly", "Path=/", "SameSite=lax"):
        assert attribute in cookie
    assert "Domain=" not in cookie


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": PASSWORD},
        {"email": "valid@example.com", "password": "short"},
    ],
)
def test_signup_validates_inputs(
    client: TestClient, payload: dict[str, str]
) -> None:
    response = client.post("/signup", json=payload)

    assert response.status_code == 422
