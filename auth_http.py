"""Validated cookie and browser-origin policy for session authentication."""

import ipaddress
import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from auth_sessions import get_session_lifetime


@dataclass(frozen=True)
class AuthSettings:
    origins: tuple[str, ...]
    secure: bool

    @property
    def cookie_name(self) -> str:
        return (
            "__Host-job_comparer_session" if self.secure
            else "job_comparer_session"
        )

    @property
    def cookie_options(self) -> dict:
        return {"path": "/", "secure": self.secure,
                "httponly": True, "samesite": "lax"}


def get_auth_settings() -> AuthSettings:
    environment = os.getenv("APP_ENV", "production")
    if environment not in {"production", "development"}:
        raise RuntimeError("APP_ENV must be production or development.")
    secure = os.getenv("SESSION_COOKIE_SECURE", "true")
    if secure not in {"true", "false"}:
        raise RuntimeError("SESSION_COOKIE_SECURE must be true or false.")
    if environment == "production" and secure != "true":
        raise RuntimeError("Production session cookies must be Secure.")
    origins = os.getenv("AUTH_ALLOWED_ORIGINS", "").split(",")
    for origin in origins:
        origin = origin.strip()
        try:
            parsed = urlsplit(origin)
            hostname = parsed.hostname or ""
            label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
            valid_host = bool(re.fullmatch(
                rf"{label}(?:\.{label})*", hostname
            ))
            try:
                address = ipaddress.ip_address(hostname)
                valid_host = True
                loopback = address.is_loopback
            except ValueError:
                loopback = hostname == "localhost"
            valid = (
                valid_host and parsed.scheme in {"http", "https"}
                and parsed.username is None and parsed.password is None
                and not parsed.path and not parsed.query
                and not parsed.fragment and parsed.port != 0
                and origin == f"{parsed.scheme}://{parsed.netloc}"
                and not any(character.isspace() for character in origin)
            )
            if parsed.scheme == "http":
                valid = valid and environment == "development" and loopback
        except ValueError:
            valid = False
        if not valid:
            raise RuntimeError(
                "AUTH_ALLOWED_ORIGINS must contain exact HTTPS origins "
                "without paths or wildcards; HTTP loopback origins are "
                "allowed only with APP_ENV=development."
            )
    get_session_lifetime()
    return AuthSettings(tuple(origin.strip() for origin in origins),
                        secure == "true")
