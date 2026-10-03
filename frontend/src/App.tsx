import {
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import { ApiError, checkHealth, getCurrentUser, signIn, signUp, type CurrentUser } from './api'
import './App.css'

type ConnectionStatus = 'checking' | 'connected' | 'unavailable'
type View = 'home' | 'dashboard' | 'login' | 'signup'
type IconName = 'grid' | 'briefcase' | 'document' | 'arrows' | 'login'
const statusText: Record<ConnectionStatus, string> = { checking: 'Checking API', connected: 'API connected', unavailable: 'API unavailable' }

function Icon({ name }: { name: IconName }): ReactNode {
  const shared = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.7 }
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    briefcase: <><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" /></>,
    document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></>,
    arrows: <><path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4" /></>,
    login: <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5M15 12H4" /></>,
  }
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" {...shared}>{paths[name]}</svg>
}

function HealthStatus({ status }: { status: ConnectionStatus }) { return <div className={`api-status api-status--${status}`} role="status"><span className="status-dot" aria-hidden="true" /><span>{statusText[status]}</span></div> }

function LoginView({ onBack, onLogin, error, isSubmitting }: { onBack: () => void; onLogin: (email: string, password: string) => void; error: string | null; isSubmitting: boolean }) {
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onLogin(String(form.get('email')), String(form.get('password'))) }
  return <main className="login-page"><section className="login-card" aria-labelledby="login-heading"><button type="button" className="text-button" onClick={onBack}>Back to home</button><div className="brand login-brand">Job Comparer</div><p className="eyebrow">Account</p><h1 id="login-heading">Log in</h1><p className="login-intro">Sign in to access your Job Comparer account.</p><form className="login-form" onSubmit={submit}><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" required disabled={isSubmitting} /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required disabled={isSubmitting} />{error && <p className="form-error" role="alert">{error}</p>}<button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Logging in…' : 'Log in'}</button></form></section></main>
}

function SignupView({ onBack, onLogin, onSignup, error, isSubmitting }: { onBack: () => void; onLogin: () => void; onSignup: (email: string, password: string, confirmation: string) => void; error: string | null; isSubmitting: boolean }) {
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); onSignup(String(form.get('email')), String(form.get('password')), String(form.get('confirmation'))) }
  return <main className="login-page"><section className="login-card" aria-labelledby="signup-heading"><button type="button" className="text-button" onClick={onBack}>Back to home</button><div className="brand login-brand">Job Comparer</div><p className="eyebrow">Account</p><h1 id="signup-heading">Sign up</h1><p className="login-intro">Create an account to compare your CV with the jobs you want.</p><form className="login-form" onSubmit={submit}><label htmlFor="signup-email">Email address</label><input id="signup-email" name="email" type="email" autoComplete="email" required disabled={isSubmitting} /><label htmlFor="signup-password">Password</label><input id="signup-password" name="password" type="password" autoComplete="new-password" required disabled={isSubmitting} /><label htmlFor="confirmation">Confirm password</label><input id="confirmation" name="confirmation" type="password" autoComplete="new-password" required disabled={isSubmitting} />{error && <p className="form-error" role="alert">{error}</p>}<button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating account…' : 'Create account'}</button></form><p className="form-switch">Already have an account? <button type="button" className="text-button" onClick={onLogin}>Log in</button></p></section></main>
}

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024

function StartWithCV() {
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [cvText, setCvText] = useState('')

  function selectFile(file: File | undefined) {
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (extension !== 'pdf' && extension !== 'docx') {
      setFileName(null)
      setFileError('Choose a PDF or DOCX file.')
      return
    }
    if (file.size > MAX_CV_FILE_BYTES) {
      setFileName(null)
      setFileError('Choose a file smaller than 5 MB.')
      return
    }
    setFileName(file.name)
    setFileError(null)
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0])
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    selectFile(event.dataTransfer.files[0])
  }

  return <section className="cv-starter" aria-labelledby="cv-starter-heading"><div className="cv-starter__intro"><p className="eyebrow">Your starting point</p><h2 id="cv-starter-heading">Start with your CV</h2><p>Add a PDF or DOCX, or paste your CV text. It stays in this browser for now.</p></div><div className="cv-starter__grid"><div className="cv-upload"><h3>Upload your CV</h3><div className="cv-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}><input id="cv-file" className="visually-hidden" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={handleFileChange} /><p>Drag and drop your CV here</p><span>PDF or DOCX, up to 5 MB</span><label className="cv-picker" htmlFor="cv-file">Choose a file</label></div>{fileName && <p className="cv-selection" role="status">Selected: {fileName}</p>}{fileError && <p className="cv-file-error" role="alert">{fileError}</p>}</div><div className="cv-paste"><h3>Paste your CV text</h3><label htmlFor="cv-text">Paste your CV text</label><textarea id="cv-text" value={cvText} onChange={(event) => setCvText(event.target.value)} placeholder="Paste your CV here…" rows={7} />{cvText.trim() && <p className="cv-selection" role="status">CV text added locally.</p>}</div></div></section>
}

function HomeView({ status, onLogin, onSignup, onRetry }: { status: ConnectionStatus; onLogin: () => void; onSignup: () => void; onRetry: () => void }) {
  return <div className="home-page"><header className="home-nav"><span className="home-brand">Job Comparer</span><button type="button" className="home-login" onClick={onLogin}>Log in</button></header><main className="home-content"><div className="home-layout"><div className="home-hero"><h1>Compare your CV with the jobs you want!</h1><p>Save your CV, compare it with job descriptions, and review the evidence and possible gaps.</p><button type="button" className="home-cta" onClick={onSignup}>Sign up to compare</button></div><section className="how-it-works" aria-labelledby="how-it-works-heading"><p className="eyebrow" id="how-it-works-heading">How it works</p><ol className="steps"><li><span className="step-number">1</span><div><h2>Save your CV</h2><p>Upload a PDF or DOCX, or paste your CV text.</p></div></li><li><span className="step-number">2</span><div><h2>Add a job</h2><p>Paste the job description and save the role you’re interested in.</p></div></li><li><span className="step-number">3</span><div><h2>Review the comparison</h2><p>See evidence-backed matches and possible gaps to explore.</p></div></li></ol><p className="privacy-note">Your CV and saved jobs stay private to your account.</p></section></div><StartWithCV />{status === 'unavailable' && <section className="connection-help" aria-labelledby="connection-heading"><p className="eyebrow" id="connection-heading">Connection needed</p><p>Start the FastAPI server at http://127.0.0.1:8001, then try again.</p><button type="button" onClick={onRetry}>Retry connection</button></section>}</main></div>
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [checkNumber, setCheckNumber] = useState(0)
  const [view, setView] = useState<View>('home')
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  useEffect(() => { const controller = new AbortController(); let active = true; void checkHealth(controller.signal).then((healthy) => { if (active) setStatus(healthy ? 'connected' : 'unavailable') }); return () => { active = false; controller.abort() } }, [checkNumber])
  async function handleLogin(email: string, password: string) { setError(null); setIsSubmitting(true); try { const nextToken = await signIn(email, password); const nextUser = await getCurrentUser(nextToken); setToken(nextToken); setUser(nextUser); setView('dashboard') } catch (caught) { setError(caught instanceof ApiError ? caught.message : 'Unable to sign in. Please try again.') } finally { setIsSubmitting(false) } }
  async function handleSignup(email: string, password: string, confirmation: string) { if (password.length < 12) { setError('Password must have at least 12 characters.'); return } if (password !== confirmation) { setError('Passwords do not match.'); return } setError(null); setIsSubmitting(true); try { await signUp(email, password); setView('login') } catch (caught) { setError(caught instanceof ApiError ? caught.message : 'Unable to create an account. Please try again.') } finally { setIsSubmitting(false) } }
  function retry() { setStatus('checking'); setCheckNumber((current) => current + 1) }
  function openLogin() { setError(null); setView('login') }
  function openSignup() { setError(null); setView('signup') }
  function logout() { setToken(null); setUser(null); setView('home') }
  if (view === 'login') return <LoginView onBack={() => setView('home')} onLogin={handleLogin} error={error} isSubmitting={isSubmitting} />
  if (view === 'signup') return <SignupView onBack={() => setView('home')} onLogin={openLogin} onSignup={handleSignup} error={error} isSubmitting={isSubmitting} />
  if (view === 'home') return <HomeView status={status} onLogin={openLogin} onSignup={openSignup} onRetry={retry} />
  return <div className="app-shell"><aside className="sidebar" aria-label="Primary navigation"><div className="brand"><span>Job Comparer</span></div><nav className="navigation" aria-label="Workspace"><p className="nav-label">Workspace</p><ul><li className="nav-item nav-item--current" aria-current="page"><Icon name="grid" />Dashboard</li><li className="nav-item"><Icon name="briefcase" />Jobs</li><li className="nav-item"><Icon name="document" />My CV</li><li className="nav-item"><Icon name="arrows" />Comparisons</li></ul><p className="nav-label nav-label--lower">Account</p><ul>{user && token ? <li><button type="button" className="nav-button" onClick={logout}>Log out</button></li> : <li><button type="button" className="nav-button" onClick={openLogin}><Icon name="login" />Log in</button></li>}</ul></nav>{user && <p className="account-email">{user.email}</p>}<HealthStatus status={status} /></aside><main className="main-content"><div className="page-heading"><p className="eyebrow">Workspace</p><h1>Dashboard</h1><p>Compare your CV with key aspects of job descriptions.</p></div>{status === 'unavailable' && <section className="connection-help" aria-labelledby="connection-heading"><p className="eyebrow" id="connection-heading">Connection needed</p><p>Start the FastAPI server at http://127.0.0.1:8001, then try again.</p><button type="button" onClick={retry}>Retry connection</button></section>}</main></div>
}
export default App
