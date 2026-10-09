import {
  Activity,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ApiError,
  checkHealth,
  compareJob,
  createJob,
  getCurrentUser,
  getJobs,
  getJob,
  getSavedComparisons,
  getSavedComparison,
  getComparisonSummaries,
  getSavedCv,
  signIn,
  signOut,
  signUp,
  resetSessionRequests,
  resendVerification,
  confirmEmail,
  saveCvText,
  uploadCv,
  type CurrentUser,
  type ComparisonResult,
  type SavedJob,
  type JobDetails,
  type SavedComparison,
  type ComparisonSummary,
} from "./api";
import { formatCvPreview } from "./formatCvPreview";
import "./App.css";

type ConnectionStatus = "checking" | "connected" | "unavailable";
const appViews = ["home", "dashboard", "jobs", "add-job", "comparisons", "my-cv",
  "dashboard-comparison", "login", "signup", "check-email", "verify-email"] as const;
type View = typeof appViews[number];
const publicPageTitles = { privacy: "Privacy", terms: "Terms", contact: "Contact" } as const;
type PublicPage = keyof typeof publicPageTitles;

function currentPublicPage(): PublicPage | null {
  const base = import.meta.env.BASE_URL;
  if (!window.location.pathname.startsWith(base)) return null;
  const page = window.location.pathname.slice(base.length).replace(/\/$/, "");
  return Object.hasOwn(publicPageTitles, page) ? page as PublicPage : null;
}
type CvInputMethod = "file" | "text" | null;
type SaveStage = "cv" | "job" | "complete";
type RequirementCategory =
  | "matched_requirements"
  | "possible_gaps"
  | "needs_review";
type RequirementSelection = {
  comparison: ComparisonResult;
  category: RequirementCategory;
  index: number;
};
type ComparisonRun = {
  pending: boolean;
  result: ComparisonResult | null;
  error: string | null;
  version: number;
  cvOutdated?: boolean;
};
type ComparisonOutcome = {
  result: ComparisonResult; comparisonId: number | null;
} | { error: string };
type DashboardComparisonSelection = Pick<ComparisonSummary,
  "id" | "job_id" | "job_title" | "company_name">;
const savedComparisonNavigationError = "Your comparison was saved, but its identifier was not returned.";

function ComparisonNavigationRecovery({ onOpenComparisons }: {
  onOpenComparisons: () => void;
}) {
  return <p className="form-error" role="alert">
    {savedComparisonNavigationError} <a className="text-button" href="#comparisons" onClick={(event) => {
      event.preventDefault();
      onOpenComparisons();
    }}>Open Comparisons</a> to view it. Do not compare again.
  </p>;
}
type JobComparisonActions = {
  run?: ComparisonRun;
  currentResult?: ComparisonResult;
  onCompare: (jobId: number) => Promise<ComparisonOutcome | null>;
  onShowResult: (jobId: number) => void;
};
type JobHistoryCache = Map<number, {
  version: number;
  entries: SavedComparison[];
  error: string | null;
}>;
type IconName =
  | "grid" | "briefcase" | "document" | "arrows" | "login" | "logout"
  | "plus" | "arrow-right" | "arrow-left";
type DraftProps = {
  cvFile: File | null;
  cvText: string;
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  selectedInputMethod: CvInputMethod;
  onFileChange: (file: File | null) => void;
  onCvTextChange: (value: string) => void;
  onJobTitleChange: (value: string) => void;
  onCompanyNameChange: (value: string) => void;
  onJobDescriptionChange: (value: string) => void;
  onInputMethodChange: (method: CvInputMethod) => void;
  onSave: (fileError: string | null) => void;
};

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CV_TEXT_LENGTH = 50_000;
const CV_FILE_ACCEPT = ".pdf,.docx,application/pdf,"
  + "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function cvFileError(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "pdf" && extension !== "docx") {
    return "Choose a PDF or DOCX file.";
  }
  if (file.size > MAX_CV_FILE_BYTES) return "Choose a file no larger than 5 MB.";
  if (file.size === 0) return "Choose a file that is not empty.";
  return null;
}

const MAX_JOB_TITLE_LENGTH = 200;
const MAX_JOB_COMPANY_LENGTH = 200;
const MAX_JOB_DESCRIPTION_LENGTH = 20_000;
const requirementCategoryLabels: Record<RequirementCategory, string> = {
  matched_requirements: "Matched requirement",
  possible_gaps: "Possible gap",
  needs_review: "Needs review",
};

function Icon({ name }: { name: IconName }): ReactNode {
  const shared = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
  };
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    "arrow-right": <path d="M4 12h16M14 6l6 6-6 6" />,
    "arrow-left": <path d="M20 12H4M10 6l-6 6 6 6" />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    briefcase: (
      <>
        <rect x="3" y="7" width="18" height="12" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" />
      </>
    ),
    document: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6M8 13h8M8 17h6" />
      </>
    ),
    arrows: (
      <>
        <path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4" />
      </>
    ),
    login: (
      <>
        <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
        <path d="M10 17l5-5-5-5M15 12H4" />
      </>
    ),
    logout: (
      <>
        <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
        <path d="M16 7l5 5-5 5M21 12H10" />
      </>
    ),
  };
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...shared}
    >
      {paths[name]}
    </svg>
  );
}

function BrandMark() {
  return <>
    <img className="brand-logo" src={`${import.meta.env.BASE_URL}images/job-comparer-logo.svg`}
      alt="" aria-hidden="true" />
    <span className="brand-name">Job <span className="brand-name-accent">Comparer</span></span>
  </>;
}

function SiteFooter({ currentPage, onNavigate }: {
  currentPage: PublicPage | null;
  onNavigate: (page: PublicPage) => void;
}) {
  return <footer className="site-footer">
    <div className="site-footer__inner">
      <nav className="site-footer__links" aria-label="Footer">
        {(Object.keys(publicPageTitles) as PublicPage[]).map((page) => (
          <a key={page} href={`${import.meta.env.BASE_URL}${page}`}
            aria-current={currentPage === page ? "page" : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onNavigate(page);
            }}>
            {publicPageTitles[page]}
          </a>
        ))}
      </nav>
      <div className="site-footer__identity">
        <span className="brand site-footer__brand"><BrandMark /></span>
      </div>
    </div>
  </footer>;
}

function PageFrame({ publicPage, signedIn, onNavigate, onReturn, children }: {
  publicPage: PublicPage | null;
  signedIn: boolean;
  onNavigate: (page: PublicPage) => void;
  onReturn: () => void;
  children: ReactNode;
}) {
  return <div className="page-frame">
    <div className="page-content" hidden={publicPage !== null}>{children}</div>
    {publicPage && <AuthLayout headingId="public-page-heading" onBack={onReturn}
      className="login-page public-info-page"
      backLabel={signedIn ? "Back to dashboard" : "Back to home"}>
      <h1 id="public-page-heading" tabIndex={-1}>{publicPageTitles[publicPage]}</h1>
    </AuthLayout>}
    <SiteFooter currentPage={publicPage} onNavigate={onNavigate} />
  </div>;
}

function AuthLayout({ headingId, onBack, backLabel = "Back to home", className = "login-page", children }: {
  headingId: string;
  onBack: () => void;
  backLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return <main className={className}>
    <div className="auth-layout">
      <a className="auth-back-link" href={import.meta.env.BASE_URL} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onBack();
      }}>
        <Icon name="arrow-left" />
        {backLabel}
      </a>
      <section className="login-card" aria-labelledby={headingId}>
        <div className="brand login-brand"><BrandMark /></div>
        {children}
      </section>
    </div>
  </main>;
}

function LoginView({
  onBack,
  onLogin,
  onSignup,
  error,
  isSubmitting,
}: {
  onBack: () => void;
  onLogin: (email: string, password: string) => void;
  onSignup: () => void;
  error: string | null;
  isSubmitting: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onLogin(String(form.get("email")), String(form.get("password")));
  }
  return (
    <AuthLayout headingId="login-heading" onBack={onBack}>
        <h1 id="login-heading">Log in</h1>
        <p className="login-intro">
          Sign in to access your Job Comparer account.
        </p>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={isSubmitting}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Logging in…" : "Log in"}
          </button>
        </form>
        <p className="form-switch">
          New to Job Comparer?{" "}
          <button type="button" className="text-button" onClick={onSignup}>
            Create an account
          </button>
        </p>
    </AuthLayout>
  );
}

function CheckEmailView({ email: initialEmail, initialError, sent, onBack, onLogin }: {
  email: string; initialError: string | null; sent: boolean;
  onBack: () => void; onLogin: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState(initialError);
  const [delivered, setDelivered] = useState(sent);
  const [saving, setSaving] = useState(false);
  const [cooldown, setCooldown] = useState(sent ? 60 : 0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || cooldown > 0) return;
    const controller = new AbortController(); request.current = controller;
    setSaving(true); setError(null);
    try {
      await resendVerification(email, controller.signal);
      if (!controller.signal.aborted) { setDelivered(true); setCooldown(60); }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof ApiError ? caught.message : "Email could not be sent. Please retry.");
        if (caught instanceof ApiError && caught.retryAfter) setCooldown(caught.retryAfter);
      }
    } finally {
      if (!controller.signal.aborted) { request.current = null; setSaving(false); }
    }
  }
  return <AuthLayout headingId="check-email-heading" onBack={onBack}>
    <h1 id="check-email-heading">Check your email</h1>
    <p className="login-intro">{delivered
      ? "Check your inbox and spam folder for the next steps. Your existing account details have not been changed."
      : "Verify your email before signing in. Request an email below to continue."}</p>
    <p className="login-intro">Confirm using the password you chose for this account. Do not use a password supplied by someone else.</p>
    <form className="login-form" onSubmit={submit}>
      <label htmlFor="verification-email">Email address</label>
      <input id="verification-email" type="email" autoComplete="email" required
        value={email} onChange={(event) => setEmail(event.target.value)} disabled={saving} />
      {error && <p className="form-error" role="alert">{error}</p>}
      {cooldown > 0 && <p role="status">You can resend in {cooldown} seconds.</p>}
      <button type="submit" disabled={saving || cooldown > 0}>
        {saving ? "Sending…" : "Resend email"}
      </button>
    </form>
    <p className="form-switch"><button type="button" className="text-button" onClick={onLogin}>Back to sign in</button></p>
  </AuthLayout>;
}

function VerifyEmailView({ token, onBack, onLogin, onResend, onVerified }: {
  token: string | null; onBack: () => void; onLogin: () => void;
  onResend: () => void; onVerified: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verified, setVerified] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setSaving(true); setError(null);
    try {
      await confirmEmail(token, password, controller.signal);
      if (!controller.signal.aborted) {
        setVerified(true); setPassword(""); onVerified();
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof ApiError
        ? caught.message : "Verification could not be completed. Please retry.");
    } finally {
      if (!controller.signal.aborted) { request.current = null; setSaving(false); }
    }
  }
  return <AuthLayout headingId="verify-email-heading" onBack={onBack}>
    <h1 id="verify-email-heading">{verified ? "Email verified" : "Verify your email"}</h1>
    {verified ? <p role="status">Your email is verified. Sign in to continue.</p>
      : token ? <>
        <p className="login-intro">Enter the password you chose when signing up, then confirm. Opening this page does not activate an account.</p>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="verification-password">Account password</label>
          <input id="verification-password" type="password" autoComplete="current-password"
            required maxLength={128} value={password}
            onChange={(event) => setPassword(event.target.value)} disabled={saving} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" disabled={saving}>{saving ? "Verifying…" : "Verify email"}</button>
        </form>
      </> : <p role="alert">This verification link is missing or invalid. Request a new email below.</p>}
    {!verified && <p className="form-switch"><button className="text-button" type="button" onClick={onResend}>Resend email</button></p>}
    <p className="form-switch"><button className="text-button" type="button" onClick={onLogin}>Back to sign in</button></p>
  </AuthLayout>;
}

function SignupView({
  onBack,
  onLogin,
  onSignup,
  error,
  isSubmitting,
  isSavingDraft,
}: {
  onBack: () => void;
  onLogin: () => void;
  onSignup: (email: string, password: string, confirmation: string) => void;
  error: string | null;
  isSubmitting: boolean;
  isSavingDraft: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSignup(
      String(form.get("email")),
      String(form.get("password")),
      String(form.get("confirmation")),
    );
  }
  const intro = isSavingDraft
    ? "Create an account to save your CV and job description."
    : "Create an account to compare your CV with the jobs you want.";
  return (
    <AuthLayout headingId="signup-heading" onBack={onBack}>
        <h1 id="signup-heading">Sign up</h1>
        <p className="login-intro">{intro}</p>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="signup-email">Email address</label>
          <input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
          />
          <label htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
          />
          <label htmlFor="confirmation">Confirm password</label>
          <input
            id="confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="form-switch">
          Already have an account?{" "}
          <button type="button" className="text-button" onClick={onLogin}>
            Log in
          </button>
        </p>
    </AuthLayout>
  );
}

function StartWithCV({
  cvFile,
  cvText,
  jobTitle,
  companyName,
  jobDescription,
  selectedInputMethod,
  onFileChange,
  onCvTextChange,
  onJobTitleChange,
  onCompanyNameChange,
  onJobDescriptionChange,
  onInputMethodChange,
  onSave,
  compareFlow = false,
  busy = false,
  cvSaved = false,
  jobChoice,
  jobAction,
  cvChoice,
  cvAction,
  hideJobFields = false,
  hideCvFields = false,
  unavailable = false,
  submissionBlocked = false,
  compact = false,
  getReadiness,
}: DraftProps & {
  compareFlow?: boolean;
  busy?: boolean;
  cvSaved?: boolean;
  jobChoice?: ReactNode;
  jobAction?: ReactNode;
  cvChoice?: ReactNode;
  cvAction?: ReactNode;
  hideJobFields?: boolean;
  hideCvFields?: boolean;
  unavailable?: boolean;
  submissionBlocked?: boolean;
  compact?: boolean;
  getReadiness?: (fileError: string | null) => string | null;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  function selectFile(file: File | undefined) {
    if (busy || cvSaved || unavailable) return;
    if (!file) return;
    const error = cvFileError(file);
    onFileChange(error ? null : file);
    setFileError(error);
  }
  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0]);
  }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    selectFile(event.dataTransfer.files[0]);
  }
  const jobFields = (
    <fieldset className="starter-fields job-description" disabled={busy || unavailable}>
      {compareFlow && <legend className="dashboard-step-heading">
        <span className="step-number" aria-hidden="true">1</span>
        {compact ? "Choose a job" : "Job details"}
      </legend>}
      <div className="dashboard-step-content">
      {jobChoice}
      {!hideJobFields && <>
      <div className="job-details">
        <div>
          <label htmlFor="job-title">Job title</label>
          <input id="job-title" value={jobTitle}
            onChange={(event) => onJobTitleChange(event.target.value)}
            maxLength={MAX_JOB_TITLE_LENGTH} />
        </div>
        <div>
          <label htmlFor="company-name">Company name</label>
          <input id="company-name" value={companyName}
            onChange={(event) => onCompanyNameChange(event.target.value)}
            maxLength={MAX_JOB_COMPANY_LENGTH} />
        </div>
      </div>
      <h3>Add a job description</h3>
      <label className="visually-hidden" htmlFor="job-description">Job description</label>
      <textarea id="job-description" value={jobDescription}
        onChange={(event) => onJobDescriptionChange(event.target.value)}
        placeholder="Paste the full job description, responsibilities, and requirements here."
        rows={compact ? 6 : 10} />
      </>}
      </div>
      {compareFlow && <div className="dashboard-step-action">{jobAction}</div>}
    </fieldset>
  );
  const cvMethod = (
    !hideCvFields && cvFile && cvText.trim() && (
        <fieldset className="cv-method" disabled={busy || cvSaved || unavailable}>
          <legend>Which CV should we use?</legend>
          <p>Choose one CV source before saving.</p>
          <label>
            <input
              type="radio"
              name="cv-input-method"
              checked={selectedInputMethod === "file"}
              onChange={() => onInputMethodChange("file")}
            />{" "}
            Use the uploaded file
          </label>
          <label>
            <input
              type="radio"
              name="cv-input-method"
              checked={selectedInputMethod === "text"}
              onChange={() => onInputMethodChange("text")}
            />{" "}
            Use the pasted CV text
          </label>
        </fieldset>
      )
  );
  const cvFields = (
      <fieldset className="starter-fields dashboard-step--cv" disabled={busy || unavailable}>
      {compareFlow && <legend className="dashboard-step-heading">
        <span className="step-number" aria-hidden="true">2</span>Your CV
      </legend>}
      <div className="dashboard-step-content">
      {cvChoice}
      {!hideCvFields && <>
      <div className="cv-starter__grid">
        <div className="cv-upload">
          <h3>Upload your CV</h3>
          <div
            className="cv-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <input
              id="cv-file"
              className="visually-hidden"
              type="file"
              accept={CV_FILE_ACCEPT}
              onChange={handleFileChange}
            />
            <p>Drag and drop your CV here</p>
            <span>PDF or DOCX, up to 5 MB</span>
            <label className="cv-picker" htmlFor="cv-file">
              Choose a file
            </label>
          </div>
          {cvFile && (
            <p className="cv-selection" role="status">
              Selected: {cvFile.name}
            </p>
          )}
          {fileError && (
            <p className="cv-file-error" role="alert">
              {fileError}
            </p>
          )}
        </div>
        <div className="cv-paste">
          <h3>Paste your CV text</h3>
          <label className="visually-hidden" htmlFor="cv-text">
            Paste your CV text
          </label>
          <textarea
            id="cv-text"
            value={cvText}
            onChange={(event) => onCvTextChange(event.target.value)}
            placeholder="Paste your CV here…"
            rows={compact ? 5 : 7}
          />
          {cvText.trim() && (
            <p className="cv-selection" role="status">
              CV text added locally.
            </p>
          )}
        </div>
      </div>
      </>}
      {compareFlow && cvMethod}
      </div>
      {compareFlow && <div className="dashboard-step-action">{cvAction}</div>}
      </fieldset>
  );
  const readiness = getReadiness?.(fileError) ?? null;
  const compareButton = <button
    type="button"
    className="cv-save"
    onClick={() => onSave(fileError)}
    disabled={busy || unavailable || submissionBlocked || (compact && readiness !== null)}
    aria-describedby={compact && !submissionBlocked ? "dashboard-compare-readiness" : undefined}
  >
    {compareFlow ? busy ? "Working…" : "Compare" : "Save"}
  </button>;
  const actions = (
    <div className="cv-starter__actions dashboard-step--compare">
      {compareFlow && <h3 className="dashboard-step-heading">
        <span className="step-number" aria-hidden="true">3</span>Compare
      </h3>}
      {compareFlow && <div className="dashboard-step-content compare-readiness">
        {compact && !submissionBlocked && <p id="dashboard-compare-readiness" role="status">
          {busy ? "Saving and comparing your details…"
            : unavailable ? "Saved details must load before comparing."
            : readiness ?? "Your job and CV are ready to compare."}
        </p>}
      </div>}
      {compareFlow ? <div className="dashboard-step-action">{compareButton}</div> : compareButton}
    </div>
  );
  return (
    <section className={`cv-starter${compact ? " cv-starter--compact" : ""}`} aria-labelledby="cv-starter-heading">
      <div className="cv-starter__intro">
        <h2 id="cv-starter-heading">{compareFlow ? "Start a comparison" : "Start with your CV"}</h2>
        {!compact && <p>{compareFlow ? "Choose a job and your CV below, then compare." : "Add a PDF or DOCX, or paste your CV text."}</p>}
      </div>
      {compareFlow ? (
        <div className="dashboard-comparison-steps">{jobFields}{cvFields}{actions}</div>
      ) : <>
        {compact ? <div className="cv-starter__sections">{jobFields}{cvFields}</div>
          : <>{cvFields}{jobFields}</>}
        {cvMethod}
        {actions}
      </>}
    </section>
  );
}

function HomeView({
  status,
  onLogin,
  onSignup,
  onRetry,
  ...draftProps
}: {
  status: ConnectionStatus;
  onLogin: () => void;
  onSignup: () => void;
  onRetry: () => void;
} & DraftProps) {
  return (
    <div className="home-page">
      <header className="home-nav">
        <span className="home-brand"><BrandMark /></span>
        <button type="button" className="home-login" onClick={onLogin}>
          Log in
        </button>
      </header>
      <main className="home-content">
        <div className="home-layout">
          <div className="home-hero">
            <h1>Compare your CV with the jobs you want!</h1>
            <p>
              Save your CV, compare it with job descriptions, and review the
              evidence and possible gaps.
            </p>
            <button type="button" className="home-cta" onClick={onSignup}>
              Sign up to compare
            </button>
          </div>
          <section
            className="how-it-works"
            aria-labelledby="how-it-works-heading"
          >
            <p className="eyebrow" id="how-it-works-heading">
              How it works
            </p>
            <ol className="steps">
              <li>
                <span className="step-number">1</span>
                <div>
                  <h2>Save your CV</h2>
                  <p>Upload a PDF or DOCX, or paste your CV text.</p>
                </div>
              </li>
              <li>
                <span className="step-number">2</span>
                <div>
                  <h2>Add a job</h2>
                  <p>
                    Paste the job description and save the role you’re
                    interested in.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">3</span>
                <div>
                  <h2>Review the comparison</h2>
                  <p>
                    See evidence-backed matches and possible gaps to explore.
                  </p>
                </div>
              </li>
            </ol>
            <p className="privacy-note">
              Your CV and saved jobs stay private to your account.
            </p>
          </section>
        </div>
        <StartWithCV {...draftProps} />
        {status === "unavailable" && (
          <section
            className="connection-help"
            aria-labelledby="connection-heading"
          >
            <p className="eyebrow" id="connection-heading">
              Connection needed
            </p>
            <p>
              Unable to reach the API. Please try again.
            </p>
            <button type="button" onClick={onRetry}>
              Retry connection
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

function ComparisonStatusIcon({ category }: {
  category: RequirementCategory;
}) {
  return (
    <svg
      className="comparison-status-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <g
        fill="none"
        stroke="var(--color-surface)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {category === "matched_requirements" ? (
          <path d="m7 12 3 3 7-7" />
        ) : category === "possible_gaps" ? (
          <path d="M7 12h10" />
        ) : (
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" />
        )}
      </g>
    </svg>
  );
}

function RequirementRow({ title, category, selected, onSelect }: {
  title: string;
  category: RequirementCategory;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="comparison-item">
      <button
        type="button"
        className="comparison-option"
        aria-pressed={selected}
        aria-controls="comparison-details"
        onClick={onSelect}
      >
        <ComparisonStatusIcon category={category} />
        <span className="comparison-option__title">{title}</span>
        {selected && (
          <span className="comparison-option__selected" aria-hidden="true">
            Selected
          </span>
        )}
        <svg
          className="comparison-option__chevron"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
    </li>
  );
}

function ComparisonEvidence({ cv, job }: {
  cv?: string | null;
  job: string;
}) {
  return (
    <dl className="comparison-evidence">
      {cv && (
        <div>
          <dt>CV evidence</dt>
          <dd>{cv}</dd>
        </div>
      )}
      <div>
        <dt>Job evidence</dt>
        <dd>{job}</dd>
      </div>
    </dl>
  );
}

function ComparisonResults({ comparison, requirementSelection,
  setRequirementSelection }: {
  comparison: ComparisonResult;
  requirementSelection: RequirementSelection | null;
  setRequirementSelection: (selection: RequirementSelection) => void;
}) {
  const firstCategory = (
    ["matched_requirements", "possible_gaps", "needs_review"] as const
  ).find((category) => comparison && comparison[category].length > 0);
  const activeSelection = comparison && firstCategory
    ? requirementSelection?.comparison === comparison
      ? requirementSelection
      : { comparison, category: firstCategory, index: 0 }
    : null;
  const selectedRequirement = activeSelection
    ? activeSelection.comparison[activeSelection.category][activeSelection.index]
    : null;

  function selectRequirement(category: RequirementCategory, index: number) {
    if (comparison) {
      setRequirementSelection({ comparison, category, index });
    }
  }

  return (
    <section
      className="comparison-results"
      aria-labelledby="comparison-heading"
    >
      <div className="comparison-overview">
        <section
          className="comparison-section comparison-section--matched"
          aria-labelledby="comparison-matches-heading"
        >
          <h3 id="comparison-matches-heading">
            <ComparisonStatusIcon category="matched_requirements" />
            Matched requirements{" "}
            <span className="comparison-count">
              {comparison.matched_requirements.length}
            </span>
          </h3>
          {comparison.matched_requirements.length > 0 ? (
            <ul className="comparison-list">
              {comparison.matched_requirements.map((match, index) => (
                <RequirementRow
                  key={`match-${index}`}
                  title={match.requirement}
                  category="matched_requirements"
                  selected={
                    activeSelection?.category
                      === "matched_requirements"
                    && activeSelection.index === index
                  }
                  onSelect={() =>
                    selectRequirement("matched_requirements", index)
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="comparison-empty">
              No matched requirements were returned.
            </p>
          )}
        </section>
        <section
          className="comparison-section comparison-section--gaps"
          aria-labelledby="comparison-gaps-heading"
        >
          <h3 id="comparison-gaps-heading">
            <ComparisonStatusIcon category="possible_gaps" />
            Possible gaps{" "}
            <span className="comparison-count">
              {comparison.possible_gaps.length}
            </span>
          </h3>
          {comparison.possible_gaps.length > 0 ? (
            <ul className="comparison-list">
              {comparison.possible_gaps.map((gap, index) => (
                <RequirementRow
                  key={`gap-${index}`}
                  title={gap.requirement}
                  category="possible_gaps"
                  selected={
                    activeSelection?.category === "possible_gaps"
                    && activeSelection.index === index
                  }
                  onSelect={() =>
                    selectRequirement("possible_gaps", index)
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="comparison-empty">
              No possible gaps were returned.
            </p>
          )}
        </section>
        {comparison.needs_review.length > 0 && (
          <section
            className="comparison-section comparison-section--review"
            aria-labelledby="comparison-review-heading"
          >
            <h3 id="comparison-review-heading">
              <ComparisonStatusIcon category="needs_review" />
              Needs review{" "}
              <span className="comparison-count">
                {comparison.needs_review.length}
              </span>
            </h3>
            <ul className="comparison-list">
              {comparison.needs_review.map((item, index) => (
                <RequirementRow
                  key={`review-${index}`}
                  title={item.requirement}
                  category="needs_review"
                  selected={
                    activeSelection?.category === "needs_review"
                    && activeSelection.index === index
                  }
                  onSelect={() =>
                    selectRequirement("needs_review", index)
                  }
                />
              ))}
            </ul>
          </section>
        )}
      </div>
      {selectedRequirement && (
        <section
          id="comparison-details"
          className="comparison-details"
          aria-labelledby="comparison-details-heading"
        >
          <div className="comparison-details-header">
            <h3 id="comparison-details-heading">
              Requirement details
            </h3>
            {activeSelection && (
              <span
                className="comparison-category"
                data-category={activeSelection.category}
              >
                <ComparisonStatusIcon
                  category={activeSelection.category}
                />
                {requirementCategoryLabels[activeSelection.category]}
              </span>
            )}
          </div>
          <h4>{selectedRequirement.requirement}</h4>
          {"reason" in selectedRequirement && (
            <p className="comparison-item__reason">
              {selectedRequirement.reason}
            </p>
          )}
          <ComparisonEvidence
            cv={"cv_evidence" in selectedRequirement
              ? selectedRequirement.cv_evidence
              : undefined}
            job={selectedRequirement.job_evidence}
          />
        </section>
      )}
      <p className="comparison-notice">
        {comparison.interpretation}
      </p>
    </section>
  );
}

function SavedComparisonHistory({ accountKey, job, comparisonId, onSelect,
  actions, historyCache, rowAction = false, backLabel = "Back to job" }: {
  accountKey: number;
  job: SavedJob;
  comparisonId: number | null;
  onSelect: (id: number | null) => void;
  actions?: JobComparisonActions;
  historyCache: JobHistoryCache;
  rowAction?: boolean;
  backLabel?: string;
}) {
  const historyVersion = actions?.run?.version ?? 0;
  const cached = comparisonId === null && !actions?.currentResult
    && historyCache.get(job.id)?.version === historyVersion
    ? historyCache.get(job.id) : undefined;
  const [entries, setEntries] = useState<SavedComparison[]>(
    cached?.entries ?? [],
  );
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<RequirementSelection | null>(null);
  const [loadedVersion, setLoadedVersion] = useState(historyVersion);
  const [loadedCache, setLoadedCache] = useState(historyCache);
  const currentResult = actions?.currentResult;
  const historyLoading = loading || loadedVersion !== historyVersion
    || loadedCache !== historyCache;
  const active = useRef(0);
  useEffect(() => {
    active.current += 1;
    return () => { active.current += 1; };
  }, []);
  useEffect(() => {
    if (currentResult) return;
    const cachedHistory = historyCache.get(job.id);
    const controller = new AbortController();
    let active = true;
    let request: Promise<SavedComparison[]>;
    if (comparisonId === null && attempt === 0
      && cachedHistory?.version === historyVersion) {
      request = cachedHistory.error
        ? Promise.reject(new ApiError(cachedHistory.error))
        : Promise.resolve(cachedHistory.entries);
    } else {
      request = comparisonId === null
        ? getSavedComparisons(job.id, controller.signal)
        : getSavedComparison(job.id, comparisonId, controller.signal)
          .then((entry) => [entry]);
    }
    void request.then(
      (result) => {
        if (!active) return;
        if (comparisonId === null) {
          historyCache.set(job.id, {
            version: historyVersion, entries: result, error: null,
          });
        }
        setEntries(result);
        setError(null);
        setLoadedVersion(historyVersion);
        setLoadedCache(historyCache);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        const message = caught instanceof ApiError
          ? caught.message
          : "Unable to load saved comparisons. Please try again.";
        if (comparisonId === null) {
          historyCache.set(job.id, {
            version: historyVersion, entries: [], error: message,
          });
        }
        setError(message);
        setLoadedVersion(historyVersion);
        setLoadedCache(historyCache);
        setLoading(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountKey, job.id, comparisonId, attempt, historyVersion, currentResult,
    historyCache]);

  async function startComparison() {
    const origin = active.current;
    const outcome = await actions?.onCompare(job.id);
    if (outcome && "result" in outcome && active.current === origin) {
      actions?.onShowResult(job.id);
    }
  }
  const progress = !currentResult && historyLoading ? (
    <p role="status">Loading saved comparisons…</p>
  ) : error ? (
    <div className="jobs-message">
      <p role="alert">Could not load saved comparisons: {error}</p>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          setLoading(true);
          setError(null);
          setEntries([]);
          setAttempt((value) => value + 1);
        }}
      >
        Retry
      </button>
    </div>
  ) : null;
  if (comparisonId !== null || currentResult) {
    const entry = entries[0];
    const result = currentResult
      ?? (historyLoading || error ? undefined : entry?.result);
    const cvOutdated = currentResult
      ? actions?.run?.cvOutdated : entry?.cv_outdated;
    return (
      <main className="main-content main-content--comparison">
        <button
          type="button"
          className="text-button job-back"
          onClick={() => onSelect(null)}
        >
          {backLabel}
        </button>
        <h1 id="comparison-heading">
          {currentResult ? "Comparison results" : "Saved comparison"}
        </h1>
        <div className="comparison-job-bar">
          <div className="comparison-job-summary">
            <h2>{job.title}</h2>
            <p>{job.company_name}</p>
            {entry && (
              <time dateTime={entry.created_at}>
                {new Date(entry.created_at).toLocaleString()}
              </time>
            )}
          </div>
        </div>
        {progress}
        {result && (
          <>
            {cvOutdated && (
              <p className="comparison-notice saved-cv-notice" role="status">
                The CV used for this comparison is no longer the current
                saved CV.
              </p>
            )}
            <ComparisonResults
              comparison={result}
              requirementSelection={selection}
              setRequirementSelection={setSelection}
            />
          </>
        )}
      </main>
    );
  }
  if (rowAction) return (
    <div className="job-comparison-action">
      {progress}
      {!historyLoading && !error && (entries.length > 0 ? (
        <button
          type="button"
          className="cv-save job-primary"
          onClick={() => onSelect(entries[0].id)}
        >
          <span>View latest comparison</span>
          <Icon name="arrow-right" />
        </button>
      ) : (
        <button
          type="button"
          className="cv-save job-primary"
          onClick={() => void startComparison()}
          disabled={actions?.run?.pending}
        >
          <span>{actions?.run?.pending ? "Comparing…" : "Compare with my CV"}</span>
          <Icon name="arrow-right" />
        </button>
      ))}
      {actions?.run?.pending && (
        <p role="status">Comparing your CV and job…</p>
      )}
      {actions?.run?.error && (
        <p role="alert">Comparison unavailable: {actions.run.error}</p>
      )}
    </div>
  );
  return (
    <section className="saved-comparisons" aria-labelledby="history-heading">
      <h2 id="history-heading">Saved comparisons</h2>
      {progress ?? (entries.length === 0 ? (
        <p>No saved comparisons yet.</p>
      ) : (
        <ul className="saved-jobs-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <time className="job-history-date" dateTime={entry.created_at}>
                <span>
                  {new Date(entry.created_at).toLocaleDateString(undefined, {
                    day: "numeric", month: "short", year: "numeric",
                  })}
                </span>
                <span>
                  {new Date(entry.created_at).toLocaleTimeString(undefined, {
                    hour: "2-digit", minute: "2-digit",
                  })}
                </span>
              </time>
              <button
                type="button"
                className="cv-save job-primary"
                aria-label={
                  `View comparison: ${new Date(entry.created_at).toLocaleString()}`
                }
                onClick={() => onSelect(entry.id)}
              >
                <span>View</span>
                <Icon name="arrow-right" />
              </button>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

function MyCvView({ accountKey, visible, onSaved }: {
  accountKey: number;
  visible: boolean;
  onSaved: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState("");
  const [inputMethod, setInputMethod] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const saveRequest = useRef<AbortController | null>(null);
  // Match the backend's Unicode code-point limit, not UTF-16 code units.
  const textTooLong = [...draft].length > MAX_CV_TEXT_LENGTH;
  const inputValid = inputMethod === "file"
    ? file !== null && !fileError : Boolean(draft.trim()) && !textTooLong;

  useEffect(() => () => { saveRequest.current?.abort(); }, []);

  function selectFiles(files: FileList) {
    if (saving || files.length === 0) return;
    const error = files.length !== 1
      ? "Choose one PDF or DOCX file." : cvFileError(files[0]);
    setFile(error ? null : files[0]);
    setFileError(error);
    setSaveError(null);
    setSaved(false);
  }

  async function save() {
    if (saveRequest.current || loading || error || !inputValid) return;
    setSaved(false);
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setSaveError(null);
    try {
      let savedText = draft;
      if (inputMethod === "file" && file) {
        savedText = await uploadCv(file, controller.signal);
      } else {
        await saveCvText(draft, controller.signal);
      }
      if (controller.signal.aborted) return;
      setText(savedText);
      if (inputMethod === "file") setFile(null);
      else setDraft("");
      setSaved(true);
      onSaved();
    } catch (caught) {
      if (controller.signal.aborted) return;
      setSaveError(caught instanceof ApiError
        ? caught.message : "Unable to save your CV. Please try again.");
    } finally {
      if (!controller.signal.aborted) {
        saveRequest.current = null;
        setSaving(false);
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getSavedCv(controller.signal).then(
      (result) => {
        if (!active) return;
        setText(result);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError
          ? caught.message : "Unable to load your saved CV. Please retry.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountKey, attempt]);

  return (
    <main
      className="main-content jobs-page jobs-list-page my-cv-page"
      hidden={!visible}
    >
      {preview && (
        <button
          type="button"
          className="text-button job-back"
          onClick={() => setPreview(false)}
        >
          Back to My CV
        </button>
      )}
      <div className="jobs-heading">
        <h1>{preview ? "Current CV" : "My CV"}</h1>
      </div>
      {loading ? (
        <p className="jobs-message" role="status">Loading saved CV…</p>
      ) : error ? (
        <div className="jobs-message">
          <p role="alert">Could not load saved CV: {error}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setError(null);
              setLoading(true);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : text === null ? (
        <p className="jobs-message">No CV saved yet.</p>
      ) : preview ? (
        <section className="saved-cv-preview" aria-label="Saved CV text">
          <p>{formatCvPreview(text)}</p>
        </section>
      ) : (
        <section
          className="current-cv-strip"
          aria-labelledby="current-cv-heading"
        >
          <div className="current-cv-summary">
            <Icon name="document" />
            <h2 id="current-cv-heading">Current CV</h2>
            <span className="comparison-saved-status">Saved</span>
          </div>
          <button
            type="button"
            className="cv-save job-primary"
            aria-label="View current CV"
            onClick={() => setPreview(true)}
          >
            View <Icon name="arrow-right" />
          </button>
        </section>
      )}
      {!preview && !loading && !error && (
        <section className="cv-paste saved-cv-form" aria-label="Save CV">
          <div className="saved-cv-tabs" role="tablist" aria-label="CV input">
            {(["file", "text"] as const).map((method) => (
              <button
                key={method}
                type="button"
                role="tab"
                id={`saved-cv-tab-${method}`}
                aria-controls={`saved-cv-panel-${method}`}
                aria-selected={inputMethod === method}
                tabIndex={inputMethod === method ? 0 : -1}
                disabled={saving}
                onClick={() => setInputMethod(method)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"]
                    .includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "file"
                    : event.key === "End" ? "text"
                    : method === "file" ? "text" : "file";
                  setInputMethod(next);
                  document.getElementById(`saved-cv-tab-${next}`)?.focus();
                }}
              >
                {method === "file" ? "Upload file" : "Paste text"}
              </button>
            ))}
          </div>
          <div
            id="saved-cv-panel-file"
            role="tabpanel"
            aria-labelledby="saved-cv-tab-file"
            hidden={inputMethod !== "file"}
          >
            <div
              className="cv-dropzone"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = saving ? "none" : "copy";
              }}
              onDrop={(event) => {
                event.preventDefault();
                selectFiles(event.dataTransfer.files);
              }}
            >
              <Icon name="document" />
              <p>Drag and drop your CV here</p>
              <span>One PDF or DOCX, up to 5 MB</span>
              <input
                ref={fileInput}
                type="file"
                accept={CV_FILE_ACCEPT}
                hidden
                disabled={saving}
                onChange={(event) => {
                  if (event.target.files) selectFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="cv-picker"
                disabled={saving}
                onClick={() => fileInput.current?.click()}
              >
                {file ? "Change file" : "Choose file"}
              </button>
            </div>
            {file && (
              <div className="saved-cv-file">
                <p role="status">Selected: {file.name}</p>
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => {
                    setFile(null);
                    setSaveError(null);
                  }}
                >
                  Clear file
                </button>
              </div>
            )}
            {fileError && <p className="cv-file-error" role="alert">{fileError}</p>}
          </div>
          <div
            id="saved-cv-panel-text"
            className="saved-cv-text"
            role="tabpanel"
            aria-labelledby="saved-cv-tab-text"
            hidden={inputMethod !== "text"}
          >
            <label htmlFor="saved-cv-draft">CV text</label>
            <p id="saved-cv-help">Paste your CV text (up to 50,000 characters).</p>
            <textarea
              id="saved-cv-draft"
              aria-describedby="saved-cv-help"
              aria-invalid={textTooLong}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaveError(null);
                setSaved(false);
              }}
              disabled={saving}
              required
            />
            {textTooLong && (
              <p className="form-error" role="alert">
                CV text must be 50,000 characters or fewer.
              </p>
            )}
          </div>
          {text !== null && (
            <p>Your current CV will be replaced when you save.</p>
          )}
          {saveError && <p className="form-error" role="alert">{saveError}</p>}
          {(saving || saved) && (
            <p role="status">{saving ? "Saving your CV…" : "CV saved."}</p>
          )}
          <button
            type="button"
            className="cv-save job-primary"
            disabled={saving || !inputValid}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : text === null ? "Save CV" : "Save replacement"}
          </button>
        </section>
      )}
    </main>
  );
}


function DashboardComparisonFlow({ jobs, savedCv, preferredJobId,
  unavailable, onCvSaved, onJobSaved, onCompare, onCompleted, onOpenComparisons }: {
  jobs: SavedJob[];
  savedCv: string | null;
  preferredJobId: number | null;
  unavailable: boolean;
  onCvSaved: (text: string) => void;
  onJobSaved: (job: SavedJob) => void;
  onCompare: JobComparisonActions["onCompare"];
  onCompleted: (job: SavedJob, comparisonId: number) => void;
  onOpenComparisons: () => void;
}) {
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvText, setCvText] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [method, setMethod] = useState<CvInputMethod>(null);
  // Keep the empty-account form stable through its staged saves and retries.
  const [compact, setCompact] = useState(jobs.length > 0 || savedCv !== null);
  const [jobMode, setJobMode] = useState<"saved" | "add">(
    jobs.length > 0 ? "saved" : "add",
  );
  const [selectedId, setSelectedId] = useState<number | null>(preferredJobId);
  const [replacingCv, setReplacingCv] = useState(false);
  const savedJob = jobMode === "saved"
    ? jobs.find((job) => job.id === selectedId) ?? null : null;
  const cvSaved = savedCv !== null && !replacingCv;
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);

  function validateInputs(fileError: string | null) {
    const errors: string[] = [];
    if (jobMode === "saved" && !savedJob) {
      errors.push("Choose a job to continue.");
    } else if (!savedJob) {
      if (!jobTitle.trim() || !companyName.trim() || !jobDescription.trim()) {
        errors.push("Enter a job title, company name and description, not just spaces.");
      }
      if ([...jobTitle.trim()].length > MAX_JOB_TITLE_LENGTH
        || [...companyName.trim()].length > MAX_JOB_COMPANY_LENGTH) {
        errors.push("Job title and company name must each be 200 characters or fewer.");
      }
      if ([...jobDescription.trim()].length > MAX_JOB_DESCRIPTION_LENGTH) {
        errors.push("Job description must be 20,000 characters or fewer.");
      }
    }
    if (!cvSaved) {
      if (fileError || (!cvFile && !cvText.trim())) errors.push("Add a valid CV file or paste your CV text.");
      if (cvFile && cvText.trim() && !method) errors.push("Choose whether to use the uploaded file or pasted CV text.");
      if ((!cvFile || method === "text") && [...cvText.trim()].length > MAX_CV_TEXT_LENGTH) {
        errors.push("CV text must be 50,000 characters or fewer.");
      }
    }
    return errors;
  }

  async function submit(fileError: string | null) {
    if (request.current || unavailable || navigationError) return;
    const errors = validateInputs(fileError);
    setError(errors.length ? errors.join(" ") : null);
    if (errors.length) return;
    const controller = new AbortController();
    request.current = controller;
    let job = savedJob;
    let hasCv = cvSaved;
    try {
      if (!job) {
        setProgress("Saving your job details…");
        job = await createJob({
          title: jobTitle.trim(), company_name: companyName.trim(),
          description: jobDescription.trim(),
        }, controller.signal);
        if (controller.signal.aborted) return;
        setSelectedId(job.id);
        setJobMode("saved");
        setJobTitle(""); setCompanyName(""); setJobDescription("");
        onJobSaved(job);
      }
      if (!hasCv) {
        setProgress("Saving your CV…");
        const text = cvFile && method !== "text"
          ? await uploadCv(cvFile, controller.signal)
          : (await saveCvText(cvText.trim(), controller.signal), cvText.trim());
        if (controller.signal.aborted) return;
        hasCv = true;
        setReplacingCv(false);
        setCvFile(null); setCvText(""); setMethod(null);
        onCvSaved(text);
      }
      setProgress("Comparing your CV and job…");
      const outcome = await onCompare(job.id);
      if (controller.signal.aborted) return;
      if (outcome && "result" in outcome) {
        if (outcome.comparisonId === null) setNavigationError(savedComparisonNavigationError);
        else {
          setCompact(true);
          onCompleted(job, outcome.comparisonId);
        }
      } else setError("Your job and CV are saved, but the comparison failed. "
        + (outcome && "error" in outcome ? outcome.error : "Please try again.")
        + " Click Compare to retry using the saved details.");
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = caught instanceof ApiError ? caught.message : "Please try again.";
      setError(job && !hasCv
        ? `Your job is saved, but your CV could not be saved. ${message} Click Compare to retry; your job will be reused.`
        : `Could not save your job. ${message} Your entries are still here.`);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setProgress(null);
      }
    }
  }

  return (
    <section className="dashboard-flow" aria-label="Compare your CV with a job">
        <StartWithCV compareFlow busy={progress !== null} unavailable={unavailable}
          compact={compact} submissionBlocked={navigationError !== null}
          getReadiness={(fileError) => validateInputs(fileError)[0] ?? null}
          hideJobFields={jobMode === "saved"} hideCvFields={cvSaved}
          cvSaved={cvSaved}
          jobChoice={<>
            {jobMode === "saved" && (!compact && savedJob ? (
              <div className="dashboard-job-summary">
                <div><strong>{savedJob.title}</strong><span>{savedJob.company_name}</span></div>
              </div>
            ) : (
              <label className="dashboard-job-picker" htmlFor="dashboard-saved-job">
                <span className="visually-hidden">Use saved job</span>
                <select id="dashboard-saved-job" value={selectedId ?? ""}
                  onChange={(event) => {
                    setSelectedId(event.target.value ? Number(event.target.value) : null);
                  }}>
                  <option value="">Select a saved job</option>
                  {jobs.map((job) => <option key={job.id} value={job.id}>{job.title} — {job.company_name}</option>)}
                </select>
              </label>
            ))}
            {compact && jobMode === "add" && jobs.length === 0
              && <p className="dashboard-guidance">Add your first job below.</p>}
          </>}
          jobAction={jobMode === "saved" ? (compact ? (
              <button type="button" className="text-button dashboard-job-alternative"
                onClick={() => setJobMode("add")}>Add new job</button>
            ) : savedJob ? (
              <button type="button" className="text-button dashboard-job-alternative"
                onClick={() => setCompact(true)}>Change job</button>
            ) : null) : compact && jobs.length > 0 ? (
              <button type="button" className="text-button dashboard-job-alternative"
                onClick={() => setJobMode("saved")}>Use saved job</button>
            ) : null}
          cvChoice={<>
            {savedCv !== null && (replacingCv ? (
              <div className="dashboard-cv-actions">
                <p>Your current CV will be replaced when you click Compare.</p>
              </div>
            ) : (
              <div className="current-cv-strip">
                <div className="current-cv-summary"><Icon name="document" /><span>Using your saved CV</span></div>
              </div>
            ))}
          </>}
          cvAction={savedCv !== null && (replacingCv ? (
            <button type="button" className="text-button dashboard-cv-alternative"
              onClick={() => setReplacingCv(false)}>Cancel replacement</button>
          ) : (
            <button type="button" className="text-button dashboard-cv-alternative"
              onClick={() => setReplacingCv(true)} aria-label="Replace CV">Replace</button>
          ))}
          cvFile={cvFile} cvText={cvText} jobTitle={jobTitle} companyName={companyName}
          jobDescription={jobDescription} selectedInputMethod={method}
          onFileChange={setCvFile} onCvTextChange={setCvText} onJobTitleChange={setJobTitle}
          onCompanyNameChange={setCompanyName} onJobDescriptionChange={setJobDescription}
          onInputMethodChange={setMethod} onSave={(fileError) => void submit(fileError)} />
      {progress && <p role="status">{progress}</p>}
      {navigationError ? <ComparisonNavigationRecovery onOpenComparisons={onOpenComparisons} />
        : error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function DashboardOverview({ accountKey, onNavigate, onView, onCvSaved, onJobSaved,
  preferredJobId, refreshVersion, showFlow, onCompare, onCompleted, children }: {
  accountKey: number;
  onNavigate: (section: "my-cv" | "jobs" | "comparisons") => void;
  onView: (entry: ComparisonSummary) => void;
  onCvSaved: () => void;
  onJobSaved: () => void;
  preferredJobId: number | null;
  refreshVersion: number;
  showFlow: boolean;
  onCompare: JobComparisonActions["onCompare"];
  onCompleted: (job: SavedJob, comparisonId: number) => void;
  children?: ReactNode;
}) {
  const [data, setData] = useState<{
    cvText: string | null;
    jobs: SavedJob[];
    comparisons: ComparisonSummary[];
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<{
    key: string; error: string | null;
  } | null>(null);
  const requestKey = `${refreshVersion}:${attempt}`;
  const loading = loadState?.key !== requestKey;
  const error = loading ? null : loadState?.error ?? null;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void Promise.all([
      getSavedCv(controller.signal),
      getJobs(controller.signal),
      getComparisonSummaries(controller.signal),
    ]).then(
      ([cv, jobs, comparisons]) => {
        if (!active) return;
        setData({
          cvText: cv, jobs,
          comparisons: [...comparisons].sort((left, right) =>
            Date.parse(right.created_at) - Date.parse(left.created_at)
              || right.id - left.id),
        });
        setLoadState({ key: requestKey, error: null });
      },
      (caught: unknown) => {
        if (!active) return;
        setLoadState({ key: requestKey, error: caught instanceof ApiError
          ? caught.message : "Unable to load your overview. Please try again." });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountKey, requestKey]);

  const cards = [
    { section: "my-cv", icon: "document", label: "My CV",
      value: data?.cvText != null ? "Saved" : "Not added",
      detail: data?.cvText != null ? "Use your saved CV." : "Add a CV to compare." },
    { section: "jobs", icon: "briefcase", label: "Saved jobs",
      value: data?.jobs.length,
      detail: data?.jobs.length ? "Choose a job to compare." : "Add a job to compare." },
    { section: "comparisons", icon: "arrows", label: "Comparisons",
      value: data?.comparisons.length,
      detail: data?.comparisons.length ? "Review saved results." : "No saved results yet." },
  ] as const;
  return (
    <section className="dashboard-overview" aria-label="Account overview">
      <div className="dashboard-cards">
        {cards.map((card) => (
          <a
            key={card.section}
            className="dashboard-card"
            href={`#${card.section}`}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(card.section);
            }}
          >
            <span className="dashboard-card__icon" aria-hidden="true">
              <Icon name={card.icon} />
            </span>
            <span className="dashboard-card__content">
              <strong className="dashboard-card__title">{card.label}</strong>
              <span className="dashboard-card__value">
                {error ? "Unavailable" : loading ? "Loading…" : card.value}
              </span>
              <span className="dashboard-card__detail">
                {error ? "Retry to load your details." : loading ? "Checking your details." : card.detail}
              </span>
            </span>
          </a>
        ))}
      </div>
      {error && (
        <div className="jobs-message">
          <p role="alert">Could not load dashboard: {error}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading && <p role="status">Loading dashboard…</p>}
      {children}
      {data && <div hidden={!showFlow}><DashboardComparisonFlow
        jobs={data.jobs} savedCv={data.cvText}
        preferredJobId={preferredJobId} unavailable={loading || error !== null}
        onCompare={onCompare} onCompleted={onCompleted}
        onOpenComparisons={() => onNavigate("comparisons")}
        onCvSaved={(text) => {
          setData((current) => current ? { ...current, cvText: text } : current);
          onCvSaved();
        }}
        onJobSaved={(job) => {
          setData((current) => current ? {
            ...current, jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)],
          } : current);
          onJobSaved();
        }}
      /></div>}
      <section className="dashboard-recent" aria-labelledby="recent-heading">
        <div className="jobs-heading">
          <h2 id="recent-heading">Recent comparisons</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => onNavigate("comparisons")}
          >
            View all
          </button>
        </div>
        {data && !error && !loading ? (data.comparisons.length === 0 ? (
          <p className="jobs-message">Your saved comparisons will appear here.</p>
        ) : (
          <ul className="saved-jobs-list" aria-label="Recent comparisons">
            {data.comparisons.slice(0, 3).map((entry) => (
              <li key={entry.id}>
                <div>
                  <h3>{entry.job_title}</h3>
                  <p>{entry.company_name}</p>
                </div>
                <time dateTime={entry.created_at}>
                  {new Date(entry.created_at).toLocaleString(undefined, {
                    day: "numeric", month: "short", year: "numeric",
                    hour: "2-digit", minute: "2-digit",
                  })}
                </time>
                <button
                  type="button"
                  className="cv-save job-primary"
                  aria-label={`View comparison: ${entry.job_title} at ${
                    entry.company_name
                  }, ${new Date(entry.created_at).toLocaleString()}`}
                  onClick={() => onView(entry)}
                >
                  View <Icon name="arrow-right" />
                </button>
              </li>
            ))}
          </ul>
        )) : (
          <p className="jobs-message">
            {error ? "Recent comparisons are unavailable. Retry above."
              : "Loading recent comparisons…"}
          </p>
        )}
      </section>
    </section>
  );
}

function ComparisonsView({ accountKey, historyCache }: {
  accountKey: number;
  historyCache: JobHistoryCache;
}) {
  const [entries, setEntries] = useState<ComparisonSummary[]>([]);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [selected, setSelected] = useState<ComparisonSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getComparisonSummaries(controller.signal).then(
      (result) => {
        if (!active) return;
        setEntries(result);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError
          ? caught.message : "Unable to load comparison history. Please retry.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountKey, attempt]);

  if (selected) return (
    <SavedComparisonHistory
      key={selected.id}
      accountKey={accountKey}
      job={{
        id: selected.job_id, title: selected.job_title,
        company_name: selected.company_name,
      }}
      comparisonId={selected.id}
      historyCache={historyCache}
      backLabel="Back to comparisons"
      onSelect={() => setSelected(null)}
    />
  );
  const sortedEntries = [...entries].sort((left, right) => {
    const difference = Date.parse(left.created_at) - Date.parse(right.created_at)
      || left.id - right.id;
    return sortOrder === "oldest" ? difference : -difference;
  });
  return (
    <main
      className="main-content jobs-page jobs-list-page comparison-history-page"
    >
      <div className="jobs-heading">
        <h1>Comparisons</h1>
        <select
          className="history-order"
          aria-label="Sort comparison history"
          value={sortOrder}
          onPointerDown={(event) => {
            event.currentTarget.dataset.pointerFocus = "true";
          }}
          onKeyDown={(event) => {
            delete event.currentTarget.dataset.pointerFocus;
          }}
          onBlur={(event) => {
            delete event.currentTarget.dataset.pointerFocus;
          }}
          onChange={(event) => setSortOrder(
            event.target.value === "oldest" ? "oldest" : "newest",
          )}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div className="jobs-table">
        <div className="jobs-table-header" aria-hidden="true">
          <span>Job</span>
          <span>Compared</span>
          <span>Results</span>
          <span>Action</span>
        </div>
        {loading ? (
          <p className="jobs-message" role="status">Loading saved comparisons…</p>
        ) : error ? (
          <div className="jobs-message">
            <p role="alert">Could not load saved comparisons: {error}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setError(null);
                setLoading(true);
                setAttempt((value) => value + 1);
              }}
            >
              Retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <p className="jobs-message">You have no saved comparisons yet.</p>
        ) : (
          <ul className="saved-jobs-list" aria-label="Saved comparisons">
            {sortedEntries.map((entry) => (
              <li key={entry.id} className="comparison-history-row">
                <div className="history-job">
                  <h2>{entry.job_title}</h2>
                  <p>{entry.company_name}</p>
                </div>
                <time className="history-date" dateTime={entry.created_at}>
                  <span>
                    {new Date(entry.created_at).toLocaleDateString(undefined, {
                      day: "numeric", month: "short", year: "numeric",
                    })}
                  </span>
                  <span>
                    {new Date(entry.created_at).toLocaleTimeString(undefined, {
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                </time>
                <div className="history-counts">
                  <span
                    className="history-count comparison-category"
                    data-category="matched_requirements"
                  >
                    <ComparisonStatusIcon category="matched_requirements" />
                    <span>{entry.matched_requirements_count} matched</span>
                  </span>
                  <span
                    className="history-count comparison-category"
                    data-category="possible_gaps"
                  >
                    <ComparisonStatusIcon category="possible_gaps" />
                    <span>{entry.possible_gaps_count} possible gaps</span>
                  </span>
                  <span
                    className="history-count comparison-category"
                    data-category="needs_review"
                  >
                    <ComparisonStatusIcon category="needs_review" />
                    <span>{entry.needs_review_count} needs review</span>
                  </span>
                </div>
                <div className="job-comparison-action history-view">
                  <button
                    type="button"
                    className="cv-save job-primary"
                    aria-label={
                      `View comparison for ${entry.job_title} at `
                      + `${entry.company_name}, `
                      + new Date(entry.created_at).toLocaleString()
                    }
                    onClick={() => setSelected(entry)}
                  >
                    <span>View</span>
                    <Icon name="arrow-right" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function JobDetailsView({ accountKey, jobId, onBack,
  comparisonId, onSelectComparison, successMessage, comparisonActions,
  historyCache }: {
  accountKey: number;
  jobId: number;
  onBack: () => void;
  comparisonId: number | null;
  onSelectComparison: (id: number | null) => void;
  successMessage?: string;
  comparisonActions: JobComparisonActions;
  historyCache: JobHistoryCache;
}) {
  const [job, setJob] = useState<JobDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getJob(jobId, controller.signal).then(
      (result) => {
        if (!active) return;
        setJob(result);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError
          ? caught.message
          : "Unable to load this job. Please try again.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountKey, jobId, attempt]);

  if (job && (comparisonId !== null || comparisonActions.currentResult)) {
    return (
      <SavedComparisonHistory
        key={comparisonId ?? "current"}
        accountKey={accountKey}
        job={job}
        comparisonId={comparisonId}
        onSelect={onSelectComparison}
        actions={comparisonActions}
        historyCache={historyCache}
      />
    );
  }
  return (
    <main className="main-content jobs-page job-details-page">
      <header className="job-detail-header">
        <button type="button" className="text-button job-back" onClick={onBack}>
          Back to jobs
        </button>
        <h1>{job?.title ?? "Job details"}</h1>
        {job && <p className="jobs-intro">{job.company_name}</p>}
      </header>
      {successMessage && (
        <p className="job-saved-notice" role="status">{successMessage}</p>
      )}
      {loading ? (
        <p role="status">Loading job details…</p>
      ) : error || !job ? (
        <div className="jobs-message job-detail-message">
          <p role="alert">
            {error ? `Could not load job: ${error}`
              : "This job was not found or is no longer available to you."}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setLoading(true);
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="job-detail-layout">
          <SavedComparisonHistory
            accountKey={accountKey}
            job={job}
            comparisonId={null}
            onSelect={onSelectComparison}
            actions={comparisonActions}
            historyCache={historyCache}
          />
          <section
            className="saved-job-description"
            aria-label="Job description"
          >
            <h2>Job description</h2>
            <div className="job-description-text">
              {job.description.split(/(\r?\n(?:[ \t]*\r?\n)+)/).map(
                (part, index) => index % 2 === 0 && part.trim()
                  ? <p key={index}>{part}</p> : part,
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function AddJobForm({ onCancel, onSaved }: {
  onCancel: () => void;
  onSaved: (job: SavedJob) => void;
}) {
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    if (!title.trim() || !company.trim() || !description.trim()) {
      setError("Enter a job title, company name and description, not just spaces.");
      return;
    }
    if (
      title.length > MAX_JOB_TITLE_LENGTH ||
      company.length > MAX_JOB_COMPANY_LENGTH
    ) {
      setError("Job title and company name must each be 200 characters or fewer.");
      return;
    }
    if (description.length > MAX_JOB_DESCRIPTION_LENGTH) {
      setError("Job description must be 20,000 characters or fewer.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError(null);
    try {
      const job = await createJob({
        title: title.trim(), company_name: company.trim(), description,
      }, controller.signal);
      if (!controller.signal.aborted) onSaved(job);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof ApiError
          ? caught.message
          : "Unable to save this job. Your entries are still here; try again.");
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setSaving(false);
      }
    }
  }

  return (
    <main className="main-content jobs-page">
      <h1 id="add-job-heading">Add job</h1>
      <form
        className="job-description workspace-job-form"
        aria-labelledby="add-job-heading"
        onSubmit={submit}
      >
        <div className="job-details">
          <div>
            <label htmlFor="new-job-title">Job title</label>
            <input
              id="new-job-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={MAX_JOB_TITLE_LENGTH}
              required
              disabled={saving}
            />
          </div>
          <div>
            <label htmlFor="new-company-name">Company name</label>
            <input
              id="new-company-name"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              maxLength={MAX_JOB_COMPANY_LENGTH}
              required
              disabled={saving}
            />
          </div>
        </div>
        <label htmlFor="new-job-description">Job description</label>
        <textarea
          id="new-job-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={MAX_JOB_DESCRIPTION_LENGTH}
          rows={10}
          required
          disabled={saving}
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="cv-starter__actions job-form-actions">
          <button
            type="button"
            className="text-button"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className="cv-save job-primary" disabled={saving}>
            {saving ? "Saving…" : "Save job"}
          </button>
        </div>
        {saving && <p role="status">Saving your job…</p>}
      </form>
    </main>
  );
}

function JobsView({ accountKey, selectedJobId, onSelectJob,
  comparisonId, onSelectComparison, addingJob, onAddJob, onShowJobs,
  comparisonActions, comparisonRuns, historyCache, onJobSaved }: {
  accountKey: number;
  selectedJobId: number | null;
  onSelectJob: (id: number | null) => void;
  comparisonId: number | null;
  onSelectComparison: (id: number | null) => void;
  addingJob: boolean;
  onAddJob: () => void;
  onShowJobs: () => void;
  comparisonActions: JobComparisonActions;
  comparisonRuns: Record<number, ComparisonRun>;
  historyCache: JobHistoryCache;
  onJobSaved: () => void;
}) {
  const [jobs, setJobs] = useState<SavedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [createdJobId, setCreatedJobId] = useState<number | null>(null);
  const [comparisonFromList, setComparisonFromList] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getJobs(controller.signal).then(
      (result) => {
        if (!active) return;
        setJobs(result);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof ApiError
          ? caught.message
          : "Unable to load your jobs. Please try again.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountKey, attempt]);

  if (addingJob) {
    return (
      <AddJobForm
        onCancel={onShowJobs}
        onSaved={(job) => {
          onJobSaved();
          setJobs((current) => [
            job, ...current.filter((item) => item.id !== job.id),
          ]);
          setError(null);
          setCreatedJobId(job.id);
          onSelectJob(job.id);
          onShowJobs();
        }}
      />
    );
  }

  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  if (comparisonFromList && selectedJob
    && (comparisonId !== null || comparisonActions.currentResult)) {
    return (
      <SavedComparisonHistory
        key={`${selectedJob.id}:${comparisonId ?? "current"}`}
        accountKey={accountKey}
        job={selectedJob}
        comparisonId={comparisonId}
        actions={comparisonActions}
        historyCache={historyCache}
        backLabel="Back to jobs"
        onSelect={() => {
          onSelectComparison(null);
          onSelectJob(null);
          setComparisonFromList(false);
        }}
      />
    );
  }
  if (selectedJobId !== null) {
    return (
      <JobDetailsView
        key={selectedJobId}
        accountKey={accountKey}
        jobId={selectedJobId}
        onBack={() => {
          setCreatedJobId(null);
          onSelectJob(null);
        }}
        comparisonId={comparisonId}
        onSelectComparison={onSelectComparison}
        successMessage={createdJobId === selectedJobId ? "Job saved." : undefined}
        comparisonActions={comparisonActions}
        historyCache={historyCache}
      />
    );
  }

  return (
    <main className="main-content jobs-page jobs-list-page">
      <div className="jobs-heading">
        <h1>Jobs</h1>
        <button
          type="button"
          className="cv-save job-primary"
          onClick={onAddJob}
          disabled={loading}
        >
          <Icon name="plus" />
          Add job
        </button>
      </div>
      {loading ? (
        <p role="status">Loading saved jobs…</p>
      ) : error ? (
        <div className="jobs-message">
          <p role="alert">Could not load saved jobs: {error}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setLoading(true);
              setJobs([]);
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : jobs.length === 0 ? (
        <p className="jobs-message">You have no saved jobs yet.</p>
      ) : (
        <div className="jobs-table">
          <div className="jobs-table-header" aria-hidden="true">
            <span>Job title</span>
            <span>Company</span>
            <span>Actions</span>
          </div>
          <ul className="saved-jobs-list" aria-label="Saved jobs">
            {jobs.map((job) => (
              <li key={job.id} className="saved-job-row">
                <div className="saved-job-summary">
                  <h2>{job.title}</h2>
                  <p>{job.company_name}</p>
                </div>
                <div className="saved-job-actions">
                  <button
                    type="button"
                    className="text-button job-view-button"
                    aria-label={`View job: ${job.title} at ${job.company_name}`}
                    onClick={() => {
                      setCreatedJobId(null);
                      setComparisonFromList(false);
                      onSelectJob(job.id);
                    }}
                  >
                    View job
                  </button>
                  <SavedComparisonHistory
                    accountKey={accountKey}
                    job={job}
                    comparisonId={null}
                    historyCache={historyCache}
                    rowAction
                    onSelect={(id) => {
                      setComparisonFromList(true);
                      onSelectJob(job.id);
                      onSelectComparison(id);
                    }}
                    actions={{
                      run: comparisonRuns[job.id],
                      onCompare: comparisonActions.onCompare,
                      onShowResult: (jobId) => {
                        setComparisonFromList(true);
                        onSelectJob(jobId);
                        comparisonActions.onShowResult(jobId);
                      },
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("checking");
  const [checkNumber, setCheckNumber] = useState(0);
  const [view, setView] = useState<View>(() => window.location.pathname
    === `${import.meta.env.BASE_URL}verify-email` ? "verify-email" : "home");
  const [verificationToken, setVerificationToken] = useState<string | null>(null);
  const [verificationVisit, setVerificationVisit] = useState(0);
  const [verificationEmail, setVerificationEmail] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [publicPage, setPublicPage] = useState<PublicPage | null>(currentPublicPage);
  const [accountKey, setAccountKey] = useState<number | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authError, setAuthError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const authRequest = useRef(0);
  const logoutPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvText, setCvText] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [selectedInputMethod, setSelectedInputMethod] =
    useState<CvInputMethod>(null);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [saveStage, setSaveStage] = useState<SaveStage>("cv");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedJob, setSavedJob] = useState<SavedJob | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparisonNavigationError, setComparisonNavigationError] = useState<string | null>(null);
  const [comparisonRuns, setComparisonRuns] =
    useState<Record<number, ComparisonRun>>({});
  const [currentComparisonJobId, setCurrentComparisonJobId] =
    useState<number | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [savedComparisonId, setSavedComparisonId] = useState<number | null>(null);
  const [jobsVisited, setJobsVisited] = useState(false);
  const [jobsScreen, setJobsScreen] = useState<"jobs" | "add-job">("jobs");
  const [comparisonVisit, setComparisonVisit] = useState(0);
  const [comparisonsVisited, setComparisonsVisited] = useState(false);
  const [cvVisited, setCvVisited] = useState(false);
  const [historyCache, setHistoryCache] = useState<JobHistoryCache>(
    () => new Map(),
  );
  const [overviewVersion, setOverviewVersion] = useState(0);
  const [jobsVersion, setJobsVersion] = useState(0);
  const [dashboardCvVersion, setDashboardCvVersion] = useState(0);
  const [anotherDashboardComparison, setAnotherDashboardComparison] = useState(false);
  const [dashboardSelection, setDashboardSelection] =
    useState<DashboardComparisonSelection | null>(null);
  const cvVersion = useRef(0);
  const handoffRequest = useRef<AbortController | null>(null);
  const comparisonRequests = useRef(new Set<number>());
  const isComparing = savedJob
    ? Boolean(comparisonRuns[savedJob.id]?.pending) : false;
  const viewingJobComparison = view === "jobs" && (
    savedComparisonId !== null || currentComparisonJobId !== null
  );

  useEffect(() => {
    function captureVerificationLink() {
      if (window.location.pathname !== `${import.meta.env.BASE_URL}verify-email`
        || !window.location.hash) return;
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      setVerificationToken(token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null);
      setVerificationVisit((value) => value + 1);
      setView("verify-email");
      setPublicPage(null);
      // The token lives only in component memory, never history or storage.
      window.history.replaceState({ jobComparerView: "verify-email" }, "",
        `${import.meta.env.BASE_URL}verify-email`);
    }
    captureVerificationLink();
    window.addEventListener("hashchange", captureVerificationLink);
    return () => window.removeEventListener("hashchange", captureVerificationLink);
  }, []);

  useEffect(() => {
    function restorePublicNavigation(event: PopStateEvent) {
      setPublicPage(currentPublicPage());
      const previousView: unknown = event.state?.jobComparerView;
      if (typeof previousView === "string" && appViews.includes(previousView as View)) {
        const requiresSession = !["home", "login", "signup", "check-email", "verify-email"].includes(previousView);
        setView(requiresSession && (!accountKey || !user) ? "home" : previousView as View);
      }
    }
    window.addEventListener("popstate", restorePublicNavigation);
    return () => window.removeEventListener("popstate", restorePublicNavigation);
  }, [accountKey, user]);

  useEffect(() => {
    if (publicPage) document.getElementById("public-page-heading")?.focus();
  }, [publicPage]);

  function openPublicPage(page: PublicPage) {
    if (page === publicPage) return;
    const state = { ...window.history.state, jobComparerView: view };
    window.history.replaceState(state, "", window.location.href);
    window.history.pushState(state, "", `${import.meta.env.BASE_URL}${page}`);
    setPublicPage(page);
  }
  function leavePublicPage(nextView: View) {
    if (publicPage === null) return;
    window.history.pushState({ ...window.history.state, jobComparerView: nextView },
      "", import.meta.env.BASE_URL);
    setPublicPage(null);
  }
  const pageFrameProps = {
    publicPage,
    signedIn: Boolean(accountKey && user),
    onNavigate: openPublicPage,
    onReturn: () => {
      const nextView = accountKey && user ? "dashboard" : "home";
      leavePublicPage(nextView);
      setView(nextView);
    },
  };

  function clearComparisonRequests() {
    handoffRequest.current?.abort();
    handoffRequest.current = null;
    setSavedJob(null);
    setSaveError(null);
    setComparisonError(null);
    setComparisonNavigationError(null);
    comparisonRequests.current = new Set();
    setComparisonRuns({});
    setCurrentComparisonJobId(null);
    setJobsVisited(false);
    setJobsScreen("jobs");
    setComparisonsVisited(false);
    setCvVisited(false);
    setHistoryCache(new Map());
    setOverviewVersion(0);
    setJobsVersion(0);
    setDashboardCvVersion(0);
    setAnotherDashboardComparison(false);
    setDashboardSelection(null);
    cvVersion.current = 0;
  }
  function handleCvSaved() {
    cvVersion.current += 1;
    setOverviewVersion((value) => value + 1);
    setHistoryCache(new Map());
    setComparisonRuns((current) => Object.fromEntries(
      Object.entries(current).map(([id, run]) => [
        id, { ...run, cvOutdated: true },
      ]),
    ));
  }

  useEffect(() => {
    const controller = new AbortController();
    const request = ++authRequest.current;
    resetSessionRequests();
    void getCurrentUser(controller.signal).then((currentUser) => {
      if (controller.signal.aborted || request !== authRequest.current) return;
      setUser(currentUser);
      setAccountKey(request);
      setView((current) => current === "verify-email" ? current : "dashboard");
      setAuthLoading(false);
    }, (caught: unknown) => {
      if (controller.signal.aborted || request !== authRequest.current) return;
      if (caught instanceof ApiError && caught.code === "email_verification_required") {
        setVerificationEmail(caught.email ?? "");
        setView((current) => current === "verify-email" ? current : "check-email");
      } else if (!(caught instanceof ApiError && caught.status === 401)) {
        setAuthError("Unable to check your session. Please retry.");
      }
      setAuthLoading(false);
    });
    return () => { controller.abort(); resetSessionRequests(); };
  }, [authAttempt]);

  useEffect(() => {
    function expired() {
      clearPrivateSession();
      setError("Your session has expired. Please log in again.");
      setView("login");
    }
    function unverified(event: Event) {
      clearPrivateSession();
      const email: unknown = (event as CustomEvent).detail;
      setVerificationEmail(typeof email === "string" ? email : "");
      setVerificationSent(false);
      setView("check-email");
    }
    window.addEventListener("session-expired", expired);
    window.addEventListener("verification-required", unverified);
    return () => {
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("verification-required", unverified);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void checkHealth(controller.signal).then((healthy) => {
      if (active) setStatus(healthy ? "connected" : "unavailable");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [checkNumber]);
  async function handleLogin(email: string, password: string) {
    if (isSubmitting) return;
    const request = ++authRequest.current;
    resetSessionRequests();
    setError(null);
    setIsSubmitting(true);
    try {
      await signIn(email, password);
      const nextUser = await getCurrentUser();
      if (request !== authRequest.current) return;
      clearComparisonRequests();
      setAccountKey(request);
      setUser(nextUser);
      setSelectedJobId(null);
      setSavedComparisonId(null);
      if (isSavingDraft) {
        await saveAuthenticatedDraft();
      } else {
        setView("dashboard");
      }
    } catch (caught) {
      if (request !== authRequest.current) return;
      if (caught instanceof ApiError && caught.code === "email_verification_required") {
        setVerificationEmail(email); setVerificationSent(false);
        setView("check-email");
        return;
      }
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to sign in. Please try again.",
      );
    } finally {
      if (request === authRequest.current) setIsSubmitting(false);
    }
  }
  async function saveAuthenticatedDraft() {
    if (handoffRequest.current) return;
    const controller = new AbortController();
    handoffRequest.current = controller;
    setIsSavingDraft(true);
    setSaveError(null);
    setView("dashboard");
    try {
      if (saveStage === "cv") {
        if (cvFile && selectedInputMethod !== "text") {
          await uploadCv(cvFile, controller.signal);
        } else {
          await saveCvText(cvText.trim(), controller.signal);
        }
        if (controller.signal.aborted) return;
        setSaveStage("job");
      }
      const job = await createJob({
        title: jobTitle.trim(),
        company_name: companyName.trim(),
        description: jobDescription.trim(),
      }, controller.signal);
      if (controller.signal.aborted) return;
      setSavedJob(job);
      setSaveStage("complete");
      setCvFile(null);
      setCvText("");
      setJobTitle("");
      setCompanyName("");
      setJobDescription("");
      setSelectedInputMethod(null);
      setDraftErrors([]);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setSaveError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to save your draft. Please try again.",
      );
    } finally {
      if (!controller.signal.aborted) {
        handoffRequest.current = null;
        setIsSavingDraft(false);
        setOverviewVersion((value) => value + 1);
      }
    }
  }
  function retrySave() {
    if (accountKey && saveStage !== "complete") {
      void saveAuthenticatedDraft();
    }
  }
  async function requestComparison(
    jobId: number,
  ): Promise<ComparisonOutcome | null> {
    const requests = comparisonRequests.current;
    if (!accountKey || requests.has(jobId)) return null;
    requests.add(jobId);
    const sourceVersion = cvVersion.current;
    setComparisonRuns((current) => ({
      ...current,
      [jobId]: {
        pending: true, error: null,
        result: current[jobId]?.result ?? null,
        version: current[jobId]?.version ?? 0,
        cvOutdated: current[jobId]?.cvOutdated,
      },
    }));
    try {
      const { result, comparisonId } = await compareJob(jobId);
      if (comparisonRequests.current !== requests) return null;
      setOverviewVersion((value) => value + 1);
      setComparisonRuns((current) => ({
        ...current,
        [jobId]: {
          pending: false, error: null, result,
          version: (current[jobId]?.version ?? 0) + 1,
          cvOutdated: cvVersion.current !== sourceVersion,
        },
      }));
      return { result, comparisonId };
    } catch (caught) {
      if (comparisonRequests.current !== requests) return null;
      const error = caught instanceof ApiError
        ? caught.message
        : "Unable to compare this job right now. Please try again later.";
      setComparisonRuns((current) => ({
        ...current, [jobId]: { ...current[jobId], pending: false, error },
      }));
      return { error };
    } finally {
      requests.delete(jobId);
    }
  }
  async function runComparison() {
    if (!savedJob || comparisonNavigationError
      || comparisonRequests.current.has(savedJob.id)) return;
    setComparisonError(null);
    const outcome = await requestComparison(savedJob.id);
    if (outcome && "result" in outcome) {
      if (outcome.comparisonId === null) setComparisonNavigationError(savedComparisonNavigationError);
      else completeDashboardComparison(savedJob, outcome.comparisonId);
    }
    else if (outcome) setComparisonError(outcome.error);
  }
  function openDashboardComparison(job: SavedJob, comparisonId: number) {
    setDashboardSelection({
      id: comparisonId, job_id: job.id,
      job_title: job.title, company_name: job.company_name,
    });
    setView("dashboard-comparison");
  }
  function completeDashboardComparison(job: SavedJob, comparisonId: number) {
    setAnotherDashboardComparison(true);
    openDashboardComparison(job, comparisonId);
  }
  async function handleSignup(
    email: string,
    password: string,
    confirmation: string,
  ) {
    if (password.length < 12) {
      setError("Password must have at least 12 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await signUp(email, password);
      setVerificationEmail(email); setVerificationSent(true);
      setView("check-email");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "email_delivery_failed") {
        setVerificationEmail(email); setVerificationSent(false);
        setView("check-email");
      }
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to create an account. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  function saveDraft(fileError: string | null) {
    const errors: string[] = [];
    const hasText = Boolean(cvText.trim());
    if (fileError || (!cvFile && !hasText))
      errors.push("Add a valid CV file or paste your CV text.");
    if (!jobTitle.trim()) errors.push("Add a job title.");
    else if (jobTitle.length > MAX_JOB_TITLE_LENGTH)
      errors.push("Job title must be 200 characters or fewer.");
    if (!companyName.trim()) errors.push("Add a company name.");
    else if (companyName.length > MAX_JOB_COMPANY_LENGTH)
      errors.push("Company name must be 200 characters or fewer.");
    if (!jobDescription.trim()) errors.push("Add a job description.");
    if (cvFile && hasText && !selectedInputMethod)
      errors.push("Choose whether to use the uploaded file or pasted CV text.");
    setDraftErrors(errors);
    if (errors.length === 0) {
      setIsSavingDraft(true);
      setSaveStage("cv");
      setSaveError(null);
      setSavedJob(null);
      setComparisonError(null);
      setComparisonNavigationError(null);
      setError(null);
      setView("signup");
    }
  }
  function retry() {
    setStatus("checking");
    setCheckNumber((current) => current + 1);
  }
  function showDashboard() {
    leavePublicPage("dashboard");
    setView("dashboard");
  }
  function showJobs() {
    if (!accountKey || !user) return openLogin();
    leavePublicPage(view === "jobs" || view === "add-job" ? "jobs" : jobsScreen);
    if (view === "jobs" || view === "add-job") {
      setSelectedJobId(null);
      setSavedComparisonId(null);
      setCurrentComparisonJobId(null);
      setJobsScreen("jobs");
      setView("jobs");
    } else {
      setView(jobsScreen);
    }
    setJobsVisited(true);
  }
  function showCv() {
    if (!accountKey || !user) return openLogin();
    leavePublicPage("my-cv");
    setCvVisited(true);
    setView("my-cv");
  }
  function showComparisons() {
    if (!accountKey || !user) return openLogin();
    leavePublicPage("comparisons");
    if (view === "comparisons") {
      setComparisonVisit((value) => value + 1);
    }
    setComparisonsVisited(true);
    setView("comparisons");
  }
  function openLogin() {
    if (window.location.pathname === `${import.meta.env.BASE_URL}verify-email`) {
      window.history.replaceState({ jobComparerView: "login" }, "", import.meta.env.BASE_URL);
    }
    setError(null);
    setView("login");
  }
  function openSignup() {
    setError(null);
    setIsSavingDraft(false);
    setView("signup");
  }
  function clearPrivateSession() {
    ++authRequest.current;
    resetSessionRequests();
    window.history.replaceState({ jobComparerView: "home" }, "", import.meta.env.BASE_URL);
    setPublicPage(null);
    clearComparisonRequests();
    setIsSavingDraft(false);
    setSaveStage("cv");
    setCvFile(null); setCvText(""); setSelectedInputMethod(null);
    setJobTitle(""); setCompanyName(""); setJobDescription("");
    setDraftErrors([]);
    setSavedComparisonId(null);
    setSelectedJobId(null);
    setAccountKey(null);
    setUser(null);
    setError(null);
    setIsSubmitting(false);
    setLogoutError(null);
    setLoggingOut(false);
    logoutPending.current = false;
    setView("home");
  }
  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    const request = authRequest.current;
    try {
      await signOut();
      if (request === authRequest.current) clearPrivateSession();
    } catch {
      if (request === authRequest.current) {
        setLogoutError("Could not log out on the server. Please retry.");
      }
    } finally {
      if (request === authRequest.current) {
        logoutPending.current = false;
        setLoggingOut(false);
      }
    }
  }
  const draftProps: DraftProps = {
    cvFile,
    cvText,
    jobTitle,
    companyName,
    jobDescription,
    selectedInputMethod,
    onFileChange: setCvFile,
    onCvTextChange: setCvText,
    onJobTitleChange: setJobTitle,
    onCompanyNameChange: setCompanyName,
    onJobDescriptionChange: setJobDescription,
    onInputMethodChange: setSelectedInputMethod,
    onSave: saveDraft,
  };
  if (authLoading || authError) return (
    <PageFrame {...pageFrameProps}>
      <main className="login-page">
        {authError ? <div>
          <p role="alert">{authError}</p>
          <button type="button" className="text-button" onClick={() => {
            setAuthError(null); setAuthLoading(true);
            setAuthAttempt((attempt) => attempt + 1);
          }}>Retry session</button>
        </div> : <p role="status">Checking your session…</p>}
      </main>
    </PageFrame>
  );
  if (view === "verify-email" || view === "check-email") return (
    <PageFrame {...pageFrameProps}>
      {view === "verify-email" ? <VerifyEmailView key={verificationVisit} token={verificationToken}
        onVerified={() => setVerificationToken(null)} onLogin={openLogin}
        onResend={() => { setError(null); setVerificationSent(false); setView("check-email"); }}
        onBack={() => { openLogin(); setView("home"); }} />
        : <CheckEmailView email={verificationEmail} initialError={error}
          sent={verificationSent} onLogin={openLogin}
          onBack={() => { openLogin(); setView("home"); }} />}
    </PageFrame>
  );
  if (view === "login")
    return (
      <PageFrame {...pageFrameProps}>
      <LoginView
        onBack={() => setView("home")}
        onLogin={handleLogin}
        onSignup={() => {
          setError(null);
          setView("signup");
        }}
        error={error}
        isSubmitting={isSubmitting}
      />
      </PageFrame>
    );
  if (view === "signup")
    return (
      <PageFrame {...pageFrameProps}>
      <SignupView
        onBack={() => setView("home")}
        onLogin={openLogin}
        onSignup={handleSignup}
        error={error}
        isSubmitting={isSubmitting}
        isSavingDraft={isSavingDraft}
      />
      </PageFrame>
    );
  if (view === "home")
    return (
      <PageFrame {...pageFrameProps}>
        <HomeView
          status={status}
          onLogin={openLogin}
          onSignup={openSignup}
          onRetry={retry}
          {...draftProps}
        />
        {draftErrors.length > 0 && (
          <div className="draft-errors" role="alert">
            {draftErrors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}
      </PageFrame>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand"><BrandMark /></div>
        <nav className="navigation" aria-label="Workspace">
          <p className="nav-label">Workspace</p>
          <ul className="workspace-navigation">
            <li>
              <button
                type="button"
                className="nav-button"
                aria-current={view === "dashboard" ? "page" : undefined}
                onClick={showDashboard}
              >
                <Icon name="grid" />
                Dashboard
              </button>
            </li>
            <li>
              <button
                type="button"
                className="nav-button"
                aria-current={(view === "jobs" || view === "add-job")
                  && !viewingJobComparison
                  ? "page" : undefined}
                onClick={showJobs}
              >
                <Icon name="briefcase" />
                Jobs
              </button>
            </li>
            <li>
              <button
                type="button"
                className="nav-button"
                aria-current={view === "my-cv" ? "page" : undefined}
                onClick={showCv}
              >
                <Icon name="document" />
                My CV
              </button>
            </li>
            <li>
              <button
                type="button"
                className="nav-button"
                aria-current={view === "comparisons" || viewingJobComparison
                  || view === "dashboard-comparison"
                  ? "page" : undefined}
                onClick={showComparisons}
              >
                <Icon name="arrows" />
                Comparisons
              </button>
            </li>
          </ul>
          <p className="nav-label nav-label--lower">Account</p>
          <ul>
            {user && accountKey ? (
              <li>
                <button type="button" className="nav-button" onClick={logout}
                  disabled={loggingOut}>
                  <Icon name="logout" />
                  Log out
                </button>
                {loggingOut && <p role="status">Logging out…</p>}
                {logoutError && <div>
                  <p role="alert">{logoutError}</p>
                  <button type="button" className="text-button" onClick={logout}>
                    Retry logout
                  </button>
                </div>}
              </li>
            ) : (
              <li>
                <button
                  type="button"
                  className="nav-button"
                  onClick={openLogin}
                >
                  <Icon name="login" />
                  Log in
                </button>
              </li>
            )}
          </ul>
        </nav>
        {user && accountKey && <p className="sidebar-identity">{user.email}</p>}
      </aside>
      <PageFrame {...pageFrameProps}>
      {jobsVisited && accountKey && user && (
        <Activity mode={view === "jobs" || view === "add-job"
          ? "visible" : "hidden"}>
          <JobsView
            key={`${user.id}:${accountKey}:${jobsVersion}`}
            accountKey={accountKey}
            selectedJobId={selectedJobId}
            historyCache={historyCache}
            onJobSaved={() => {
              setOverviewVersion((value) => value + 1);
              setJobsVersion((value) => value + 1);
            }}
            onSelectJob={setSelectedJobId}
            comparisonId={savedComparisonId}
            comparisonRuns={comparisonRuns}
            onSelectComparison={(id) => {
              setSavedComparisonId(id);
              setCurrentComparisonJobId(null);
            }}
            comparisonActions={{
              run: selectedJobId !== null
                ? comparisonRuns[selectedJobId] : undefined,
              currentResult: selectedJobId !== null
                && currentComparisonJobId === selectedJobId
                ? comparisonRuns[selectedJobId]?.result ?? undefined
                : undefined,
              onCompare: requestComparison,
              onShowResult: setCurrentComparisonJobId,
            }}
            addingJob={jobsScreen === "add-job"}
            onAddJob={() => {
              setJobsScreen("add-job");
              setView("add-job");
            }}
            onShowJobs={() => {
              setJobsScreen("jobs");
              setView("jobs");
            }}
          />
        </Activity>
      )}
      {comparisonsVisited && accountKey && user && (
        <Activity mode={view === "comparisons" ? "visible" : "hidden"}>
          <ComparisonsView
            key={`${user.id}:${accountKey}:${comparisonVisit}`}
            accountKey={accountKey}
            historyCache={historyCache}
          />
        </Activity>
      )}
      {cvVisited && accountKey && user && (
        <MyCvView
          key={`${user.id}:${accountKey}:${dashboardCvVersion}`}
          accountKey={accountKey}
          visible={view === "my-cv"}
          onSaved={handleCvSaved}
        />
      )}
      {accountKey && user && (
        <main className="main-content jobs-page jobs-list-page dashboard-page"
          hidden={view !== "dashboard"}>
          <div className="jobs-heading"><h1>Dashboard</h1></div>
          {isSavingDraft && (
            <p role="status">
              {saveStage === "cv"
                ? "Saving your CV…"
                : "Saving your job details…"}
            </p>
          )}
          {saveError && (
            <section className="draft-errors" role="alert">
              <p>We could not save your draft: {saveError}</p>
              <button type="button" onClick={retrySave}>
                Retry save
              </button>
            </section>
          )}
          {!isSavingDraft && !saveError && (
            <DashboardOverview
              key={`${user.id}:${accountKey}`}
              accountKey={accountKey}
              onCvSaved={() => {
                handleCvSaved();
                setDashboardCvVersion((value) => value + 1);
              }}
              onJobSaved={() => setJobsVersion((value) => value + 1)}
              preferredJobId={savedJob?.id ?? null}
              refreshVersion={overviewVersion}
              showFlow={!savedJob || anotherDashboardComparison}
              onCompare={requestComparison}
              onCompleted={completeDashboardComparison}
              onNavigate={(section) => {
                if (section === "my-cv") setCvVisited(true);
                if (section === "jobs") setJobsVisited(true);
                if (section === "comparisons") {
                  setComparisonsVisited(true);
                  setComparisonVisit((value) => value + 1);
                }
                setView(section === "jobs" ? jobsScreen : section);
              }}
              onView={(entry) => {
                openDashboardComparison({ id: entry.job_id,
                  title: entry.job_title, company_name: entry.company_name }, entry.id);
              }}
            >
              {savedJob && !anotherDashboardComparison && (
                <section className="save-confirmation">
                  <div>
                    <h2>Job saved</h2>
                    <p>
                      {savedJob.title} at {savedJob.company_name} has been saved.
                    </p>
                    <button
                      type="button"
                      onClick={runComparison}
                      disabled={isComparing || comparisonNavigationError !== null}
                    >
                      {isComparing ? "Comparing…" : "Compare"}
                    </button>
                  </div>
                  {isComparing && <p role="status">Comparing your CV and job…</p>}
                  {comparisonError && (
                    <p role="alert">Comparison unavailable: {comparisonError}</p>
                  )}
                  {comparisonNavigationError && <ComparisonNavigationRecovery
                    onOpenComparisons={showComparisons} />}
                </section>
              )}
              {savedJob && !isSavingDraft && !saveError && (
                <button type="button" className="text-button" disabled={isComparing}
                  onClick={() => setAnotherDashboardComparison((value) => !value)}>
                  {anotherDashboardComparison ? "Back to saved homepage job" : "Compare another job"}
                </button>
              )}
            </DashboardOverview>
          )}
        </main>
      )}
      {view === "dashboard-comparison" && dashboardSelection && accountKey && user && (
        <SavedComparisonHistory
          key={`${user.id}:${accountKey}:${dashboardSelection.id}`}
          accountKey={accountKey}
          job={{
            id: dashboardSelection.job_id,
            title: dashboardSelection.job_title,
            company_name: dashboardSelection.company_name,
          }}
          comparisonId={dashboardSelection.id}
          historyCache={historyCache}
          backLabel="Back to Dashboard"
          onSelect={() => {
            setDashboardSelection(null);
            setView("dashboard");
          }}
        />
      )}
      </PageFrame>
    </div>
  );
}

export default App;
