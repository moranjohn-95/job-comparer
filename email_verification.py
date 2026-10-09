"""Password-confirmed email verification; callers commit state changes."""

import os
import re
import secrets
from datetime import timedelta, timezone
from hashlib import sha256
from urllib.parse import urlsplit

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from auth import verify_password
from auth_http import get_auth_settings
from auth_sessions import revoke_user_sessions
from mail_delivery import MailDeliveryError, send_email
from models import User, VerificationToken

PURPOSE = "email_verification"


def verification_lifetime() -> timedelta:
    try:
        value = os.getenv("EMAIL_VERIFICATION_LIFETIME_SECONDS", "86400")
        seconds = int(value)
        if not 1 <= seconds <= 31_536_000:
            raise ValueError
        return timedelta(seconds=seconds)
    except ValueError:
        raise MailDeliveryError(
            "EMAIL_VERIFICATION_LIFETIME_SECONDS must be between 1 and "
            "31536000 seconds"
        ) from None


def public_frontend_url() -> str:
    value = os.getenv("PUBLIC_FRONTEND_URL", "").rstrip("/")
    try:
        parsed = urlsplit(value)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if (
            not value or parsed.query or parsed.fragment
            or origin not in get_auth_settings().origins
            or any(c.isspace() for c in value)
            or "\\" in value or "%" in value
        ):
            raise ValueError
    except (ValueError, RuntimeError):
        raise MailDeliveryError(
            "PUBLIC_FRONTEND_URL is invalid or missing"
        ) from None
    return value


def token_digest(token: str) -> str | None:
    if re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
        return None
    return sha256(f"{PURPOSE}:{token}".encode("ascii")).hexdigest()


def issue_verification(db: Session, user: User) -> tuple[str, timedelta]:
    lifetime = verification_lifetime()
    now = db.scalar(select(func.clock_timestamp())).astimezone(timezone.utc)
    token = secrets.token_urlsafe(32)
    db.add(VerificationToken(
        user_id=user.id, purpose=PURPOSE, token_hash=token_digest(token),
        created_at=now, expires_at=now + lifetime,
    ))
    db.flush()
    return token, lifetime


def send_verification_email(db: Session, email: str) -> None:
    """Send for every address, avoiding response-based account enumeration.

    Unknown/already-verified recipients get sign-in/signup guidance instead.
    Tokens are committed before delivery so a delivered link always works.
    Resends leave earlier links valid until one confirmation invalidates all.
    """
    base = public_frontend_url()
    verification_lifetime()
    user = db.scalar(select(User).where(User.email == email).with_for_update())
    if user is not None and user.email_verified_at is None:
        token, lifetime = issue_verification(db, user)
        body = (
            "Confirm your email address for Job Comparer.\n\n"
            f"{base}/verify-email#token={token}\n\n"
            "Open the link, then enter your account password and select "
            "Verify email. Opening the link alone does not verify anything.\n"
            f"The link expires in {int(lifetime.total_seconds())} seconds.\n"
        )
    else:
        body = (
            "You requested email verification for Job Comparer.\n\n"
            f"Visit {base} to sign in or create an account. "
            "If your email is already verified, you can sign in.\n"
        )
    db.commit()
    send_email(email, "Job Comparer email verification", body + (
        "\nIf you did not sign up or request this email, ignore it. "
        "Do not enter a password supplied by someone else."
    ))


def verification_email(db: Session, token: str) -> str | None:
    digest = token_digest(token)
    if digest is None:
        return None
    return db.scalar(select(User.email).join(VerificationToken).where(
        VerificationToken.token_hash == digest,
        VerificationToken.purpose == PURPOSE,
    ))


def confirm_verification(db: Session, token: str, password: str) -> bool:
    digest = token_digest(token)
    if digest is None:
        return False
    # Serialize both confirmation and issuance on the owner, not just one
    # token: simultaneous different links must not both verify this account.
    user = db.scalar(select(User).join(VerificationToken).where(
        VerificationToken.token_hash == digest,
        VerificationToken.purpose == PURPOSE,
    ).with_for_update(of=User))
    if user is None or user.email_verified_at is not None:
        return False
    valid = db.scalar(select(VerificationToken.id).where(
        VerificationToken.token_hash == digest,
        VerificationToken.purpose == PURPOSE,
        VerificationToken.consumed_at.is_(None),
        VerificationToken.expires_at > func.clock_timestamp(),
    ))
    if valid is None or not verify_password(password, user.password_hash):
        return False
    now = db.scalar(select(func.clock_timestamp()))
    user.email_verified_at = now
    db.execute(update(VerificationToken).where(
        VerificationToken.user_id == user.id,
        VerificationToken.purpose == PURPOSE,
        VerificationToken.consumed_at.is_(None),
    ).values(consumed_at=now))
    revoke_user_sessions(db, user.id)
    db.flush()
    return True
