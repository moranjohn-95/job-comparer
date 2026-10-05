import ipaddress
import os
from datetime import datetime
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import jwt

from fastapi import (
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from ai_usage import UsageLimitReached, reserve_attempt
from auth_rate_limit import (
    LOGIN_EMAIL_ATTEMPT_LIMIT,
    LOGIN_IP_ATTEMPT_LIMIT,
    LOGIN_WINDOW,
    SIGNUP_ATTEMPT_LIMIT,
    SIGNUP_WINDOW,
    AuthRateLimitReached,
    login_email_scope,
    login_ip_scope,
    reserve_auth_attempt,
    reserve_auth_attempts,
    signup_scope,
)
from comparison import (
    ComparisonDisabled,
    ComparisonInputTooLong,
    ComparisonResult,
    InvalidProviderOutput,
    ProviderConfigurationError,
    ProviderFailure,
    check_input_limits,
    compare,
    get_provider_settings,
)
from cv_upload import MAX_UPLOAD_BYTES, extract_cv_text
from database import get_session
from models import ComparisonHistory, SavedCV, SavedJob, User

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173"],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
bearer = HTTPBearer(auto_error=False)
MAX_CV_LENGTH = 50_000
MAX_JOB_TITLE_LENGTH = 200
MAX_JOB_COMPANY_LENGTH = 200
MAX_JOB_DESCRIPTION_LENGTH = 20_000
MAX_JOB_URL_LENGTH = 2_048


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


class JobInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=MAX_JOB_TITLE_LENGTH)
    company_name: str = Field(max_length=MAX_JOB_COMPANY_LENGTH)
    description: str = Field(max_length=MAX_JOB_DESCRIPTION_LENGTH)
    source_url: str | None = Field(default=None, max_length=MAX_JOB_URL_LENGTH)

    @field_validator("title", "company_name")
    @classmethod
    def strip_required_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("description")
    @classmethod
    def check_description(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("source_url")
    @classmethod
    def check_source_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value or any(
            character.isspace() or ord(character) < 32 for character in value
        ):
            raise ValueError("must be an absolute http or https URL")
        try:
            parsed = urlsplit(value)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            raise ValueError("must be an absolute http or https URL") from None
        if parsed.scheme not in {"http", "https"} or not hostname or port == 0:
            raise ValueError("must be an absolute http or https URL")
        return value


class JobPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    company_name: str
    description: str
    source_url: str | None


class ComparisonHistoryPublic(BaseModel):
    id: int
    job_id: int
    created_at: datetime
    cv_outdated: bool
    result: ComparisonResult


def normalized_email(email: EmailStr) -> str:
    return str(email).lower()


def invalid_credentials() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
        headers={"WWW-Authenticate": "Bearer"},
    )


def rate_limited() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many authentication attempts. Please try again later.",
    )


def trusted_proxy_ips() -> set[str]:
    values = os.getenv("TRUSTED_PROXY_IPS", "").split(",")
    proxies = set()
    for value in values:
        value = value.strip()
        if value:
            proxies.add(str(ipaddress.ip_address(value)))
    return proxies


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client is not None else "unknown"
    try:
        peer = str(ipaddress.ip_address(peer))
    except ValueError:
        return peer
    if peer not in trusted_proxy_ips():
        return peer
    forwarded_for = request.headers.get("x-forwarded-for")
    if not forwarded_for:
        return peer
    forwarded = forwarded_for.split(",", 1)[0].strip()
    try:
        return str(ipaddress.ip_address(forwarded))
    except ValueError:
        return peer


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


@app.post(
    "/signup", response_model=UserPublic, status_code=status.HTTP_201_CREATED
)
def signup(
    payload: SignupRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> User:
    try:
        reserve_auth_attempt(
            session,
            signup_scope(client_ip(request)),
            SIGNUP_ATTEMPT_LIMIT,
            SIGNUP_WINDOW,
        )
    except AuthRateLimitReached:
        raise rate_limited() from None
    email = normalized_email(payload.email)
    if session.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(
            status_code=409, detail="Email is already registered"
        )
    user = User(email=email, password_hash=hash_password(payload.password))
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409, detail="Email is already registered"
        ) from None
    session.refresh(user)
    return user


@app.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TokenResponse:
    try:
        reserve_auth_attempts(
            session,
            (
                (
                    login_ip_scope(client_ip(request)),
                    LOGIN_IP_ATTEMPT_LIMIT,
                    LOGIN_WINDOW,
                ),
                (
                    login_email_scope(normalized_email(payload.email)),
                    LOGIN_EMAIL_ATTEMPT_LIMIT,
                    LOGIN_WINDOW,
                ),
            ),
        )
    except AuthRateLimitReached:
        raise rate_limited() from None
    user = session.scalar(
        select(User).where(User.email == normalized_email(payload.email))
    )
    if user is None or not verify_password(
        payload.password, user.password_hash
    ):
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
        raise HTTPException(
            status_code=422, detail="CV text must not be blank"
        )
    if len(cv_text) > MAX_CV_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"CV text exceeds {MAX_CV_LENGTH} characters",
        )
    revision = uuid4()
    statement = insert(SavedCV).values(
        user_id=user_id, text=cv_text, revision=revision
    )
    statement = statement.on_conflict_do_update(
        index_elements=[SavedCV.user_id],
        set_={"text": cv_text, "revision": revision},
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
            raise HTTPException(
                status_code=413, detail="File exceeds the 5 MiB upload limit"
            )
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413, detail="File exceeds the 5 MiB upload limit"
            )
        extracted_text = extract_cv_text(file.filename, data)
        return persist_cv(user.id, extracted_text, session)
    finally:
        file.file.close()


@app.get("/cv", response_model=CVPublic)
def get_cv(
    user: User = Depends(current_user), session: Session = Depends(get_session)
) -> SavedCV:
    saved_cv = session.get(SavedCV, user.id)
    if saved_cv is None:
        raise HTTPException(status_code=404, detail="CV not found")
    return saved_cv


@app.delete("/cv", status_code=204)
def delete_cv(
    user: User = Depends(current_user), session: Session = Depends(get_session)
) -> Response:
    saved_cv = session.get(SavedCV, user.id)
    if saved_cv is None:
        raise HTTPException(status_code=404, detail="CV not found")
    session.delete(saved_cv)
    session.commit()
    return Response(status_code=204)


def get_owned_job(session: Session, user_id: int, job_id: int) -> SavedJob:
    job = session.scalar(
        select(SavedJob).where(
            SavedJob.id == job_id, SavedJob.user_id == user_id
        )
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/jobs", response_model=JobPublic, status_code=201)
def create_job(
    payload: JobInput,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> SavedJob:
    job = SavedJob(user_id=user.id, **payload.model_dump())
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


@app.get("/jobs", response_model=list[JobPublic])
def list_jobs(
    user: User = Depends(current_user), session: Session = Depends(get_session)
) -> list[SavedJob]:
    return list(
        session.scalars(
            select(SavedJob)
            .where(SavedJob.user_id == user.id)
            .order_by(SavedJob.id.desc())
        )
    )


@app.get("/jobs/{job_id}", response_model=JobPublic)
def view_job(
    job_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> SavedJob:
    return get_owned_job(session, user.id, job_id)


@app.post("/jobs/{job_id}/compare", response_model=ComparisonResult)
def compare_job(
    job_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ComparisonResult:
    job = get_owned_job(session, user.id, job_id)
    saved_cv = session.get(SavedCV, user.id)
    if saved_cv is None:
        raise HTTPException(status_code=404, detail="CV not found")
    user_id = user.id
    cv_text = saved_cv.text
    cv_revision = saved_cv.revision
    job_description = job.description
    try:
        settings = get_provider_settings()
        check_input_limits(cv_text, job_description)
    except ComparisonDisabled:
        raise HTTPException(
            status_code=503, detail="AI comparisons are disabled"
        ) from None
    except ProviderConfigurationError:
        raise HTTPException(
            status_code=503, detail="AI provider is not configured"
        ) from None
    except ComparisonInputTooLong as error:
        raise HTTPException(status_code=422, detail=str(error)) from None

    try:
        reserve_attempt(session, user_id)
    except UsageLimitReached as error:
        raise HTTPException(status_code=429, detail=str(error)) from None

    try:
        result = compare(cv_text, job_description, settings)
    except ProviderFailure:
        raise HTTPException(
            status_code=502, detail="AI provider is unavailable"
        ) from None
    except InvalidProviderOutput:
        raise HTTPException(
            status_code=502,
            detail="AI provider returned an invalid comparison",
        ) from None

    session.add(
        ComparisonHistory(
            user_id=user_id,
            job_id=job_id,
            cv_revision=cv_revision,
            result=result.model_dump(mode="json"),
        )
    )
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Saved job or account changed during comparison",
        ) from None
    return result


def history_public(
    entry: ComparisonHistory, current_revision: UUID | None
) -> ComparisonHistoryPublic:
    return ComparisonHistoryPublic(
        id=entry.id,
        job_id=entry.job_id,
        created_at=entry.created_at,
        cv_outdated=current_revision != entry.cv_revision,
        result=ComparisonResult.model_validate(entry.result),
    )


@app.get(
    "/jobs/{job_id}/comparisons",
    response_model=list[ComparisonHistoryPublic],
)
def list_comparisons(
    job_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[ComparisonHistoryPublic]:
    get_owned_job(session, user.id, job_id)
    saved_cv = session.get(SavedCV, user.id)
    current_revision = saved_cv.revision if saved_cv is not None else None
    entries = session.scalars(
        select(ComparisonHistory)
        .where(
            ComparisonHistory.user_id == user.id,
            ComparisonHistory.job_id == job_id,
        )
        .order_by(
            ComparisonHistory.created_at.desc(),
            ComparisonHistory.id.desc(),
        )
    )
    return [history_public(entry, current_revision) for entry in entries]


@app.get(
    "/jobs/{job_id}/comparisons/{comparison_id}",
    response_model=ComparisonHistoryPublic,
)
def view_comparison(
    job_id: int,
    comparison_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ComparisonHistoryPublic:
    get_owned_job(session, user.id, job_id)
    entry = session.scalar(
        select(ComparisonHistory).where(
            ComparisonHistory.id == comparison_id,
            ComparisonHistory.user_id == user.id,
            ComparisonHistory.job_id == job_id,
        )
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Comparison not found")
    saved_cv = session.get(SavedCV, user.id)
    current_revision = saved_cv.revision if saved_cv is not None else None
    return history_public(entry, current_revision)


@app.delete("/jobs/{job_id}", status_code=204)
def delete_job(
    job_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    job = get_owned_job(session, user.id, job_id)
    session.delete(job)
    session.commit()
    return Response(status_code=204)
