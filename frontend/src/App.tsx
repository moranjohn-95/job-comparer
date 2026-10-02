import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, checkHealth, getCurrentUser, signIn, type CurrentUser } from './api'
import './App.css'

type ConnectionStatus = 'checking' | 'connected' | 'unavailable'
type View = 'dashboard' | 'login'
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
  return <main className="login-page"><section className="login-card" aria-labelledby="login-heading"><button type="button" className="text-button" onClick={onBack}>Back to dashboard</button><div className="brand login-brand">Job Comparer</div><p className="eyebrow">Account</p><h1 id="login-heading">Log in</h1><p className="login-intro">Sign in to access your Job Comparer account.</p><form className="login-form" onSubmit={submit}><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" required disabled={isSubmitting} /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required disabled={isSubmitting} />{error && <p className="form-error" role="alert">{error}</p>}<button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Logging in…' : 'Log in'}</button></form></section></main>
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [checkNumber, setCheckNumber] = useState(0)
  const [view, setView] = useState<View>('dashboard')
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  useEffect(() => { const controller = new AbortController(); let active = true; void checkHealth(controller.signal).then((healthy) => { if (active) setStatus(healthy ? 'connected' : 'unavailable') }); return () => { active = false; controller.abort() } }, [checkNumber])
  async function handleLogin(email: string, password: string) { setError(null); setIsSubmitting(true); try { const nextToken = await signIn(email, password); const nextUser = await getCurrentUser(nextToken); setToken(nextToken); setUser(nextUser); setView('dashboard') } catch (caught) { setError(caught instanceof ApiError ? caught.message : 'Unable to sign in. Please try again.') } finally { setIsSubmitting(false) } }
  function retry() { setStatus('checking'); setCheckNumber((current) => current + 1) }
  function openLogin() { setError(null); setView('login') }
  function logout() { setToken(null); setUser(null) }
  if (view === 'login') return <LoginView onBack={() => setView('dashboard')} onLogin={handleLogin} error={error} isSubmitting={isSubmitting} />
  return <div className="app-shell"><aside className="sidebar" aria-label="Primary navigation"><div className="brand"><span>Job Comparer</span></div><nav className="navigation" aria-label="Workspace"><p className="nav-label">Workspace</p><ul><li className="nav-item nav-item--current" aria-current="page"><Icon name="grid" />Dashboard</li><li className="nav-item"><Icon name="briefcase" />Jobs</li><li className="nav-item"><Icon name="document" />My CV</li><li className="nav-item"><Icon name="arrows" />Comparisons</li></ul><p className="nav-label nav-label--lower">Account</p><ul>{user && token ? <li><button type="button" className="nav-button" onClick={logout}>Log out</button></li> : <li><button type="button" className="nav-button" onClick={openLogin}><Icon name="login" />Log in</button></li>}</ul></nav>{user && <p className="account-email">{user.email}</p>}<HealthStatus status={status} /></aside><main className="main-content"><div className="page-heading"><p className="eyebrow">Workspace</p><h1>Dashboard</h1><p>Compare your CV with key aspects of job descriptions.</p></div>{status === 'unavailable' && <section className="connection-help" aria-labelledby="connection-heading"><p className="eyebrow" id="connection-heading">Connection needed</p><p>Start the FastAPI server at http://127.0.0.1:8001, then try again.</p><button type="button" onClick={retry}>Retry connection</button></section>}</main></div>
}
export default App
