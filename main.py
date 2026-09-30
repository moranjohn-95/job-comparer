import jwt
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import create_access_token, decode_access_token, hash_password, verify_password
from database import get_session
from models import User

app = FastAPI()
bearer = HTTPBearer(auto_error=False)


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


def normalized_email(email: EmailStr) -> str:
    return str(email).lower()


def invalid_credentials() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: Session = Depends(get_session),
) -> User:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        user_id = decode_access_token(credentials.credentials)
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/signup", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
def signup(payload: SignupRequest, session: Session = Depends(get_session)) -> User:
    email = normalized_email(payload.email)
    if session.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(status_code=409, detail="Email is already registered")
    user = User(email=email, password_hash=hash_password(payload.password))
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(status_code=409, detail="Email is already registered") from None
    session.refresh(user)
    return user


@app.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, session: Session = Depends(get_session)) -> TokenResponse:
    user = session.scalar(select(User).where(User.email == normalized_email(payload.email)))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise invalid_credentials()
    return TokenResponse(access_token=create_access_token(user.id))


@app.get("/me", response_model=UserPublic)
def me(user: User = Depends(current_user)) -> User:
    return user
