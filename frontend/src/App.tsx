import { useEffect, useState } from 'react'
import { checkHealth } from './api'
import './App.css'

type ConnectionStatus = 'checking' | 'connected' | 'unavailable'

const statusText: Record<ConnectionStatus, string> = {
  checking: 'Checking API',
  connected: 'API connected',
  unavailable: 'API unavailable',
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [checkNumber, setCheckNumber] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    void checkHealth(controller.signal).then((healthy) => {
      if (active) {
        setStatus(healthy ? 'connected' : 'unavailable')
      }
    })

    return () => {
      active = false
      controller.abort()
    }
  }, [checkNumber])

  function retry() {
    setStatus('checking')
    setCheckNumber((current) => current + 1)
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">JC</span>
          <span>Job Comparer</span>
        </div>
        <div className={`api-status api-status--${status}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {statusText[status]}
        </div>
      </header>

      <main className="main-content">
        <p className="eyebrow">Your workspace</p>
        <h1>Job Comparer</h1>
        <p className="intro">
          A simple place to start. This screen checks whether the local API
          is ready to respond.
        </p>
        {status === 'unavailable' && (
          <div className="connection-help">
            <p>Start the FastAPI server at http://127.0.0.1:8001, then try again.</p>
            <button type="button" onClick={retry}>Retry connection</button>
          </div>
        )}
      </main>

      <footer className="site-footer">
        Local development · Frontend on 5173 · API on 8001
      </footer>
    </div>
  )
}

export default App
