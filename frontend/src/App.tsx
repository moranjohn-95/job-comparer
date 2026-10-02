import { useEffect, useState, type ReactNode } from 'react'
import { checkHealth } from './api'
import './App.css'

type ConnectionStatus = 'checking' | 'connected' | 'unavailable'
type IconName = 'grid' | 'briefcase' | 'document' | 'arrows' | 'settings'

const statusText: Record<ConnectionStatus, string> = {
  checking: 'Checking API',
  connected: 'API connected',
  unavailable: 'API unavailable',
}

function Icon({ name }: { name: IconName }): ReactNode {
  const shared = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.7 }
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    briefcase: <><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" /></>,
    document: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></>,
    arrows: <><path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20.3h-3v-.08A1.7 1.7 0 0 0 10.68 18.66a1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7.02 15a1.7 1.7 0 0 0-1.56-1.03h-.08v-3h.08A1.7 1.7 0 0 0 7.02 9.94a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56V4.7h3v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.08v3h-.08A1.7 1.7 0 0 0 19.4 15Z" /></>,
  }
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" {...shared}>{paths[name]}</svg>
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [checkNumber, setCheckNumber] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void checkHealth(controller.signal).then((healthy) => { if (active) setStatus(healthy ? 'connected' : 'unavailable') })
    return () => { active = false; controller.abort() }
  }, [checkNumber])
  function retry() { setStatus('checking'); setCheckNumber((current) => current + 1) }
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand"><span>Job Comparer</span></div>
        <nav className="navigation" aria-label="Workspace">
          <p className="nav-label">Workspace</p>
          <ul>
            <li className="nav-item nav-item--current" aria-current="page"><Icon name="grid" />Dashboard</li>
            <li className="nav-item"><Icon name="briefcase" />Jobs</li><li className="nav-item"><Icon name="document" />My CV</li><li className="nav-item"><Icon name="arrows" />Comparisons</li>
          </ul>
          <p className="nav-label nav-label--lower">Account</p><ul><li className="nav-item"><Icon name="settings" />Settings</li></ul>
        </nav>
        <div className={`api-status api-status--${status}`} role="status"><span className="status-dot" aria-hidden="true" /><span>{statusText[status]}</span></div>
      </aside>
      <main className="main-content">
        <div className="page-heading"><p className="eyebrow">Workspace</p><h1>Dashboard</h1><p>Compare your CV with key aspects of job descriptions.</p></div>
        {status === 'unavailable' && <section className="connection-help" aria-labelledby="connection-heading"><p className="eyebrow" id="connection-heading">Connection needed</p><p>Start the FastAPI server at http://127.0.0.1:8001, then try again.</p><button type="button" onClick={retry}>Retry connection</button></section>}
      </main>
    </div>
  )
}
export default App
