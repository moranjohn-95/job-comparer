import {
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
  signIn,
  signUp,
  saveCvText,
  uploadCv,
  type CurrentUser,
  type ComparisonResult,
  type SavedJob,
} from "./api";
import "./App.css";

type ConnectionStatus = "checking" | "connected" | "unavailable";
type View = "home" | "dashboard" | "login" | "signup";
type CvInputMethod = "file" | "text" | null;
type SaveStage = "cv" | "job" | "complete";
type IconName = "grid" | "briefcase" | "document" | "arrows" | "login";
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
const MAX_JOB_TITLE_LENGTH = 200;
const MAX_JOB_COMPANY_LENGTH = 200;
const statusText: Record<ConnectionStatus, string> = {
  checking: "Checking API",
  connected: "API connected",
  unavailable: "API unavailable",
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

function LoginView({
  onBack,
  onLogin,
  error,
  isSubmitting,
}: {
  onBack: () => void;
  onLogin: (email: string, password: string) => void;
  error: string | null;
  isSubmitting: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onLogin(String(form.get("email")), String(form.get("password")));
  }
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-heading">
        <button type="button" className="text-button" onClick={onBack}>
          Back to home
        </button>
        <div className="brand login-brand">Job Comparer</div>
        <p className="eyebrow">Account</p>
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
      </section>
    </main>
  );
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
    <main className="login-page">
      <section className="login-card" aria-labelledby="signup-heading">
        <button type="button" className="text-button" onClick={onBack}>
          Back to home
        </button>
        <div className="brand login-brand">Job Comparer</div>
        <p className="eyebrow">Account</p>
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
      </section>
    </main>
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
}: DraftProps) {
  const [fileError, setFileError] = useState<string | null>(null);
  function selectFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "pdf" && extension !== "docx") {
      onFileChange(null);
      setFileError("Choose a PDF or DOCX file.");
      return;
    }
    if (file.size > MAX_CV_FILE_BYTES) {
      onFileChange(null);
      setFileError("Choose a file smaller than 5 MB.");
      return;
    }
    onFileChange(file);
    setFileError(null);
  }
  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0]);
  }
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    selectFile(event.dataTransfer.files[0]);
  }
  return (
    <section className="cv-starter" aria-labelledby="cv-starter-heading">
      <div className="cv-starter__intro">
        <h2 id="cv-starter-heading">Start with your CV</h2>
        <p>Add a PDF or DOCX, or paste your CV text.</p>
      </div>
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
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
            rows={7}
          />
          {cvText.trim() && (
            <p className="cv-selection" role="status">
              CV text added locally.
            </p>
          )}
        </div>
      </div>
      <div className="job-description">
        <div className="job-details">
          <div>
            <label htmlFor="job-title">Job title</label>
            <input
              id="job-title"
              value={jobTitle}
              onChange={(event) => onJobTitleChange(event.target.value)}
              maxLength={MAX_JOB_TITLE_LENGTH}
            />
          </div>
          <div>
            <label htmlFor="company-name">Company name</label>
            <input
              id="company-name"
              value={companyName}
              onChange={(event) => onCompanyNameChange(event.target.value)}
              maxLength={MAX_JOB_COMPANY_LENGTH}
            />
          </div>
        </div>
        <h3>Add a job description</h3>
        <label className="visually-hidden" htmlFor="job-description">
          Job description
        </label>
        <textarea
          id="job-description"
          value={jobDescription}
          onChange={(event) => onJobDescriptionChange(event.target.value)}
          placeholder="Paste the full job description, responsibilities, and requirements here."
          rows={10}
        />
      </div>
      {cvFile && cvText.trim() && (
        <fieldset className="cv-method">
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
      )}
      <div className="cv-starter__actions">
        <button
          type="button"
          className="cv-save"
          onClick={() => onSave(fileError)}
        >
          Save
        </button>
      </div>
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
        <span className="home-brand">Job Comparer</span>
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
              Start the FastAPI server at http://127.0.0.1:8001, then try again.
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

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("checking");
  const [checkNumber, setCheckNumber] = useState(0);
  const [view, setView] = useState<View>("home");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
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
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const isPersistingRef = useRef(false);
  const isComparingRef = useRef(false);
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
    setError(null);
    setIsSubmitting(true);
    try {
      const nextToken = await signIn(email, password);
      const nextUser = await getCurrentUser(nextToken);
      setToken(nextToken);
      setUser(nextUser);
      if (isSavingDraft) {
        await saveAuthenticatedDraft(nextToken);
      } else {
        setView("dashboard");
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to sign in. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  async function saveAuthenticatedDraft(authToken: string) {
    if (isPersistingRef.current) return;
    isPersistingRef.current = true;
    setIsSavingDraft(true);
    setSaveError(null);
    setView("dashboard");
    try {
      if (saveStage === "cv") {
        if (cvFile && selectedInputMethod !== "text") {
          await uploadCv(authToken, cvFile);
        } else {
          await saveCvText(authToken, cvText.trim());
        }
        setSaveStage("job");
      }
      const job = await createJob(authToken, {
        title: jobTitle.trim(),
        company_name: companyName.trim(),
        description: jobDescription.trim(),
      });
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
      setSaveError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to save your draft. Please try again.",
      );
    } finally {
      isPersistingRef.current = false;
      setIsSavingDraft(false);
    }
  }
  function retrySave() {
    if (token && saveStage !== "complete") {
      void saveAuthenticatedDraft(token);
    }
  }
  async function runComparison() {
    if (!token || !savedJob || isComparingRef.current) return;
    isComparingRef.current = true;
    setIsComparing(true);
    setComparisonError(null);
    try {
      setComparison(await compareJob(token, savedJob.id));
    } catch (caught) {
      setComparisonError(
        caught instanceof ApiError
          ? caught.message
          : "Unable to compare this job right now. Please try again later.",
      );
    } finally {
      isComparingRef.current = false;
      setIsComparing(false);
    }
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
      setView("login");
    } catch (caught) {
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
      setComparison(null);
      setComparisonError(null);
      setError(null);
      setView("signup");
    }
  }
  function retry() {
    setStatus("checking");
    setCheckNumber((current) => current + 1);
  }
  function openLogin() {
    setError(null);
    setView("login");
  }
  function openSignup() {
    setError(null);
    setIsSavingDraft(false);
    setView("signup");
  }
  function logout() {
    setToken(null);
    setUser(null);
    setView("home");
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
  if (view === "login")
    return (
      <LoginView
        onBack={() => setView("home")}
        onLogin={handleLogin}
        error={error}
        isSubmitting={isSubmitting}
      />
    );
  if (view === "signup")
    return (
      <SignupView
        onBack={() => setView("home")}
        onLogin={openLogin}
        onSignup={handleSignup}
        error={error}
        isSubmitting={isSubmitting}
        isSavingDraft={isSavingDraft}
      />
    );
  if (view === "home")
    return (
      <>
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
      </>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span>Job Comparer</span>
        </div>
        <nav className="navigation" aria-label="Workspace">
          <p className="nav-label">Workspace</p>
          <ul>
            <li className="nav-item nav-item--current" aria-current="page">
              <Icon name="grid" />
              Dashboard
            </li>
            <li className="nav-item">
              <Icon name="briefcase" />
              Jobs
            </li>
            <li className="nav-item">
              <Icon name="document" />
              My CV
            </li>
            <li className="nav-item">
              <Icon name="arrows" />
              Comparisons
            </li>
          </ul>
          <p className="nav-label nav-label--lower">Account</p>
          <ul>
            {user && token ? (
              <li>
                <button type="button" className="nav-button" onClick={logout}>
                  Log out
                </button>
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
        {user && <p className="account-email">{user.email}</p>}
        <div className={`api-status api-status--${status}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          <span>{statusText[status]}</span>
        </div>
      </aside>
      <main className="main-content">
        <div className="page-heading">
          <p className="eyebrow">Workspace</p>
          <h1>Dashboard</h1>
          <p>Compare your CV with key aspects of job descriptions.</p>
        </div>
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
        {savedJob && (
          <section className="save-confirmation">
            <h2>Job saved</h2>
            <p>
              {savedJob.title} at {savedJob.company_name} has been saved.
            </p>
            <button
              type="button"
              onClick={runComparison}
              disabled={isComparing}
            >
              {isComparing ? "Comparing…" : "Compare"}
            </button>
            {isComparing && <p role="status">Comparing your CV and job…</p>}
            {comparisonError && (
              <p role="alert">Comparison unavailable: {comparisonError}</p>
            )}
            {comparison && (
              <section aria-labelledby="comparison-heading">
                <h2 id="comparison-heading">Comparison results</h2>
                <h3>Matched requirements</h3>
                <ul>
                  {comparison.matched_requirements.map((match) => (
                    <li key={`${match.requirement}-${match.cv_evidence}`}>
                      <strong>{match.requirement}</strong>
                      <p>CV evidence: {match.cv_evidence}</p>
                      <p>Job evidence: {match.job_evidence}</p>
                    </li>
                  ))}
                </ul>
                <h3>Possible gaps</h3>
                <ul>
                  {comparison.possible_gaps.map((gap) => (
                    <li key={`${gap.requirement}-${gap.job_evidence}`}>
                      <strong>{gap.requirement}</strong>
                      <p>Job evidence: {gap.job_evidence}</p>
                    </li>
                  ))}
                </ul>
                <p>{comparison.interpretation}</p>
              </section>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
