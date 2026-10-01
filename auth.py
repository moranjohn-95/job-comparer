import os
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

password_hasher = PasswordHasher()
TOKEN_ALGORITHM = "HS256"
TOKEN_LIFETIME = timedelta(hours=1)


def get_auth_secret() -> str:
    secret = os.getenv("AUTH_SECRET_KEY")
    if (
        not secret
        or len(secret) < 32
        or secret == "replace-with-a-long-random-secret"
    ):
        raise RuntimeError(
            "Set AUTH_SECRET_KEY in .env to a random value of at least "
            "32 characters."
        )
    return secret


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": str(user_id), "iat": now, "exp": now + TOKEN_LIFETIME},
        get_auth_secret(),
        algorithm=TOKEN_ALGORITHM,
    )


def decode_access_token(token: str) -> int:
    payload = jwt.decode(
        token,
        get_auth_secret(),
        algorithms=[TOKEN_ALGORITHM],
        options={"require": ["sub", "exp"]},
    )
    return int(payload["sub"])
