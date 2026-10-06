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
  getJobs,
  getJob,
  getSavedComparisons,
  getSavedComparison,
  signIn,
  signUp,
  saveCvText,
  uploadCv,
  type CurrentUser,
  type ComparisonResult,
  type SavedJob,
  type JobDetails,
  type SavedComparison,
} from "./api";
import "./App.css";

type ConnectionStatus = "checking" | "connected" | "unavailable";
type View = "home" | "dashboard" | "jobs" | "add-job" | "login" | "signup";
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
};
type ComparisonOutcome = { result: ComparisonResult } | { error: string };
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
const MAX_JOB_DESCRIPTION_LENGTH = 20_000;
const statusText: Record<ConnectionStatus, string> = {
  checking: "Checking API",
  connected: "API connected",
  unavailable: "API unavailable",
};
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

function SavedComparisonHistory({ token, job, comparisonId, onSelect,
  actions, historyCache, rowAction = false, backLabel = "Back to job" }: {
  token: string;
  job: SavedJob;
  comparisonId: number | null;
  onSelect: (id: number | null) => void;
  actions: JobComparisonActions;
  historyCache: JobHistoryCache;
  rowAction?: boolean;
  backLabel?: string;
}) {
  const historyVersion = actions.run?.version ?? 0;
  const cached = comparisonId === null && !actions.currentResult
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
  const currentResult = actions.currentResult;
  const historyLoading = loading || loadedVersion !== historyVersion;
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (currentResult) return;
    if (comparisonId === null && attempt === 0
      && historyCache.get(job.id)?.version === historyVersion) return;
    const controller = new AbortController();
    let active = true;
    const request = comparisonId === null
      ? getSavedComparisons(token, job.id, controller.signal)
      : getSavedComparison(token, job.id, comparisonId, controller.signal)
        .then((entry) => [entry]);
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
        setLoading(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [token, job.id, comparisonId, attempt, historyVersion, currentResult,
    historyCache]);

  async function startComparison() {
    const outcome = await actions.onCompare(job.id);
    if (outcome && "result" in outcome && active.current) {
      actions.onShowResult(job.id);
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
    const result = currentResult ?? entry?.result;
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
            {entry?.cv_outdated && (
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
          View latest comparison
        </button>
      ) : (
        <button
          type="button"
          className="cv-save job-primary"
          onClick={() => void startComparison()}
          disabled={actions.run?.pending}
        >
          {actions.run?.pending ? "Comparing…" : "Compare with my CV"}
        </button>
      ))}
      {actions.run?.pending && (
        <p role="status">Comparing your CV and job…</p>
      )}
      {actions.run?.error && (
        <p role="alert">Comparison unavailable: {actions.run.error}</p>
      )}
    </div>
  );
  return (
    <section className="saved-comparisons" aria-labelledby="history-heading">
      <h2 id="history-heading">Saved comparisons</h2>
      {progress ?? (entries.length === 0 ? (
        <p>No saved comparisons for this job yet.</p>
      ) : (
        <ul className="saved-jobs-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <time dateTime={entry.created_at}>
                {new Date(entry.created_at).toLocaleString()}
              </time>
              <button
                type="button"
                className="text-button"
                aria-label={
                  `View comparison: ${new Date(entry.created_at).toLocaleString()}`
                }
                onClick={() => onSelect(entry.id)}
              >
                View comparison
              </button>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

function JobDetailsView({ token, jobId, onBack,
  comparisonId, onSelectComparison, successMessage, comparisonActions,
  historyCache }: {
  token: string;
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
    void getJob(token, jobId, controller.signal).then(
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
  }, [token, jobId, attempt]);

  if (job && (comparisonId !== null || comparisonActions.currentResult)) {
    return (
      <SavedComparisonHistory
        key={comparisonId ?? "current"}
        token={token}
        job={job}
        comparisonId={comparisonId}
        onSelect={onSelectComparison}
        actions={comparisonActions}
        historyCache={historyCache}
      />
    );
  }
  return (
    <main className="main-content jobs-page">
      <button type="button" className="text-button job-back" onClick={onBack}>
        Back to jobs
      </button>
      <h1>{job?.title ?? "Job details"}</h1>
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
        <>
          <p className="jobs-intro">{job.company_name}</p>
          <section
            className="saved-job-description"
            aria-label="Job description"
          >
            <h2>Job description</h2>
            <p>{job.description}</p>
          </section>
          <SavedComparisonHistory
            token={token}
            job={job}
            comparisonId={null}
            onSelect={onSelectComparison}
            actions={comparisonActions}
            historyCache={historyCache}
          />
        </>
      )}
    </main>
  );
}

function AddJobForm({ token, onCancel, onSaved }: {
  token: string;
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
      const job = await createJob(token, {
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

function JobsView({ token, selectedJobId, onSelectJob,
  comparisonId, onSelectComparison, addingJob, onAddJob, onShowJobs,
  comparisonActions, comparisonRuns }: {
  token: string;
  selectedJobId: number | null;
  onSelectJob: (id: number | null) => void;
  comparisonId: number | null;
  onSelectComparison: (id: number | null) => void;
  addingJob: boolean;
  onAddJob: () => void;
  onShowJobs: () => void;
  comparisonActions: JobComparisonActions;
  comparisonRuns: Record<number, ComparisonRun>;
}) {
  const [jobs, setJobs] = useState<SavedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [createdJobId, setCreatedJobId] = useState<number | null>(null);
  const [comparisonFromList, setComparisonFromList] = useState(false);
  const [historyCache] = useState<JobHistoryCache>(() => new Map());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getJobs(token, controller.signal).then(
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
  }, [token, attempt]);

  if (addingJob) {
    return (
      <AddJobForm
        token={token}
        onCancel={onShowJobs}
        onSaved={(job) => {
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
        token={token}
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
        token={token}
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
    <main className="main-content jobs-page">
      <div className="jobs-heading">
        <h1>Jobs</h1>
        <button
          type="button"
          className="cv-save job-primary"
          onClick={onAddJob}
          disabled={loading}
        >
          Add job
        </button>
      </div>
      <p className="jobs-intro">Your saved jobs, newest first.</p>
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
        <ul className="saved-jobs-list" aria-label="Saved jobs">
          {jobs.map((job) => (
            <li key={job.id} className="saved-job-row">
              <div className="saved-job-summary">
                <h2>{job.title}</h2>
                <p>{job.company_name}</p>
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
              </div>
              <SavedComparisonHistory
                token={token}
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
            </li>
          ))}
        </ul>
      )}
    </main>
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
  const [requirementSelection, setRequirementSelection] =
    useState<RequirementSelection | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparisonRuns, setComparisonRuns] =
    useState<Record<number, ComparisonRun>>({});
  const [currentComparisonJobId, setCurrentComparisonJobId] =
    useState<number | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [savedComparisonId, setSavedComparisonId] = useState<number | null>(null);
  const isPersistingRef = useRef(false);
  const comparisonRequests = useRef(new Set<number>());
  const isComparing = savedJob
    ? Boolean(comparisonRuns[savedJob.id]?.pending) : false;
  const viewingJobComparison = view === "jobs" && (
    savedComparisonId !== null || currentComparisonJobId !== null
  );

  function clearComparisonRequests() {
    comparisonRequests.current = new Set();
    setComparisonRuns({});
    setCurrentComparisonJobId(null);
  }

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
      clearComparisonRequests();
      setToken(nextToken);
      setUser(nextUser);
      setSelectedJobId(null);
      setSavedComparisonId(null);
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
  async function requestComparison(
    jobId: number,
  ): Promise<ComparisonOutcome | null> {
    const requests = comparisonRequests.current;
    if (!token || requests.has(jobId)) return null;
    requests.add(jobId);
    setComparisonRuns((current) => ({
      ...current,
      [jobId]: {
        pending: true, error: null,
        result: current[jobId]?.result ?? null,
        version: current[jobId]?.version ?? 0,
      },
    }));
    try {
      const result = await compareJob(token, jobId);
      if (comparisonRequests.current !== requests) return null;
      setComparisonRuns((current) => ({
        ...current,
        [jobId]: {
          pending: false, error: null, result,
          version: (current[jobId]?.version ?? 0) + 1,
        },
      }));
      return { result };
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
    if (!savedJob || comparisonRequests.current.has(savedJob.id)) return;
    setComparisonError(null);
    const outcome = await requestComparison(savedJob.id);
    if (outcome && "result" in outcome) setComparison(outcome.result);
    else if (outcome) setComparisonError(outcome.error);
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
    clearComparisonRequests();
    setSavedComparisonId(null);
    setSelectedJobId(null);
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
          <ul className="workspace-navigation">
            <li>
              <button
                type="button"
                className="nav-button"
                aria-current={view === "dashboard" ? "page" : undefined}
                onClick={() => setView("dashboard")}
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
                onClick={() => {
                  if (token && user) {
                    setSelectedJobId(null);
                    setSavedComparisonId(null);
                    setCurrentComparisonJobId(null);
                    setView("jobs");
                  }
                  else openLogin();
                }}
              >
                <Icon name="briefcase" />
                Jobs
              </button>
            </li>
            <li className="nav-item">
              <Icon name="document" />
              My CV
            </li>
            <li
              className={viewingJobComparison
                ? "nav-item nav-item--current" : "nav-item"}
              aria-current={viewingJobComparison
                ? "page" : undefined}
            >
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
      {(view === "jobs" || view === "add-job") && token && user ? (
        <JobsView
          key={`${user.id}:${token}`}
          token={token}
          selectedJobId={selectedJobId}
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
          addingJob={view === "add-job"}
          onAddJob={() => setView("add-job")}
          onShowJobs={() => setView("jobs")}
        />
      ) : (
        <main
          className={comparison
            ? "main-content main-content--comparison"
            : "main-content"}
        >
          <div className="page-heading">
            {comparison ? (
              <h1 id="comparison-heading">Comparison results</h1>
            ) : (
              <>
                <p className="eyebrow">Workspace</p>
                <h1>Dashboard</h1>
                <p>Compare your CV with key aspects of job descriptions.</p>
              </>
            )}
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
              <div className={comparison ? "comparison-job-bar" : undefined}>
                {comparison ? (
                  <div className="comparison-job-summary">
                    <h2>{savedJob.title}</h2>
                    <p>{savedJob.company_name}</p>
                    <span className="comparison-saved-status">Saved</span>
                  </div>
                ) : (
                  <>
                    <h2>Job saved</h2>
                    <p>
                      {savedJob.title} at {savedJob.company_name} has been saved.
                    </p>
                  </>
                )}
                <button
                  type="button"
                  onClick={runComparison}
                  disabled={isComparing}
                >
                  {isComparing
                    ? "Comparing…"
                    : comparison ? "Compare again" : "Compare"}
                </button>
              </div>
              {isComparing && <p role="status">Comparing your CV and job…</p>}
              {comparisonError && (
                <p role="alert">Comparison unavailable: {comparisonError}</p>
              )}
              {comparison && (
                <ComparisonResults
                  comparison={comparison}
                  requirementSelection={requirementSelection}
                  setRequirementSelection={setRequirementSelection}
                />
              )}
            </section>
          )}
        </main>
      )}
    </div>
  );
}

export default App;
