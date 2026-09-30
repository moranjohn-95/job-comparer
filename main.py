import jwt
from fastapi import Depends, FastAPI, File, HTTPException, Response, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import create_access_token, decode_access_token, hash_password, verify_password
from cv_upload import MAX_UPLOAD_BYTES, extract_cv_text
from database import get_session
from models import SavedCV, User

app = FastAPI()
bearer = HTTPBearer(auto_error=False)
MAX_CV_LENGTH = 50_000


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


class CVInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str


class CVPublic(BaseModel):
    text: str


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


@app.put("/cv", response_model=CVPublic)
def save_cv(
    payload: CVInput,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> CVPublic:
    return persist_cv(user.id, payload.text, session)


def persist_cv(user_id: int, cv_text: str, session: Session) -> CVPublic:
    if not cv_text.strip():
        raise HTTPException(status_code=422, detail="CV text must not be blank")
    if len(cv_text) > MAX_CV_LENGTH:
        raise HTTPException(status_code=422, detail=f"CV text exceeds {MAX_CV_LENGTH} characters")
    statement = insert(SavedCV).values(user_id=user_id, text=cv_text)
    statement = statement.on_conflict_do_update(
        index_elements=[SavedCV.user_id],
        set_={"text": cv_text},
    )
    session.execute(statement)
    session.commit()
    return CVPublic(text=cv_text)


@app.post("/cv/upload", response_model=CVPublic)
def upload_cv(
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> CVPublic:
    try:
        if file.size is not None and file.size > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="File exceeds the 5 MiB upload limit")
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="File exceeds the 5 MiB upload limit")
        extracted_text = extract_cv_text(file.filename, data)
        return persist_cv(user.id, extracted_text, session)
    finally:
        file.file.close()


@app.get("/cv", response_model=CVPublic)
def get_cv(user: User = Depends(current_user), session: Session = Depends(get_session)) -> SavedCV:
    saved_cv = session.get(SavedCV, user.id)
    if saved_cv is None:
        raise HTTPException(status_code=404, detail="CV not found")
    return saved_cv


@app.delete("/cv", status_code=204)
def delete_cv(user: User = Depends(current_user), session: Session = Depends(get_session)) -> Response:
    saved_cv = session.get(SavedCV, user.id)
    if saved_cv is None:
        raise HTTPException(status_code=404, detail="CV not found")
    session.delete(saved_cv)
    session.commit()
    return Response(status_code=204)
