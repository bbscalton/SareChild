import { useEffect, useState } from 'react'
import { useAuth } from '../AuthContext'
import * as repo from '../lib/parentRepo'
import { LoginPage } from './LoginPage'
import type { TcdOverview, TcdReport } from '../types'

export function TcdStandalonePage() {
  const { user, loading, familyId, refreshFamilyId, signOut } = useAuth()
  const [report, setReport] = useState<TcdReport | null>(null)
  const [overview, setOverview] = useState<TcdOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    try {
      const [nextReport, nextOverview] = await Promise.all([
        repo.runTcdHealthCheck(familyId),
        repo.loadTcdOverview(familyId),
      ])
      setReport(nextReport)
      setOverview(nextOverview)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run TCD checks')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!familyId) return
    void run()
    const id = window.setInterval(() => {
      void run()
    }, 60_000)
    return () => window.clearInterval(id)
  }, [familyId])

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Loading TCD…</p>
      </div>
    )
  }

  if (!user) return <LoginPage />

  return (
    <div className="dash">
      <header className="topbar">
        <div>
          <p className="eyebrow">SareChild</p>
          <h1>TCD Monitor Console</h1>
          <p className="muted small">{user.email}</p>
          <p className="muted small">Family: {familyId || 'not linked yet'}</p>
        </div>
        <div className="btn-row">
          <button className="btn ghost compact" type="button" onClick={() => void refreshFamilyId()}>
            Refresh family link
          </button>
          <button className="btn ghost compact" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {error && <div className="banner error-banner">{error}</div>}

      <main className="panel">
        <section className="stack">
          <div className="card form-card">
            <h3>Platform health checks</h3>
            <p className="muted small">
              Auto-refresh runs every 60 seconds. Use manual run for immediate diagnostics.
            </p>
            <div className="btn-row">
              <button className="btn primary" type="button" disabled={busy || !familyId} onClick={() => void run()}>
                Run now
              </button>
              <a className="btn ghost compact" href="/SareChild/" target="_blank" rel="noreferrer">
                Open parent dashboard
              </a>
            </div>
          </div>

          {report && (
            <div className="card">
              <div className="card-head">
                <h3>Connectivity and service checks</h3>
                <span className="muted small">{new Date(report.generatedAtMs).toLocaleString()}</span>
              </div>
              <ul className="meta">
                {report.checks.map((check) => (
                  <li key={check.id}>
                    <span className={`pill tcd-${check.status}`}>{check.status.toUpperCase()}</span>{' '}
                    <strong>{check.label}:</strong> {check.message}
                    {check.latencyMs != null ? ` (${check.latencyMs} ms)` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {overview && (
            <div className="card">
              <div className="card-head">
                <h3>Application fleet status</h3>
                <span className="muted small">{new Date(overview.generatedAtMs).toLocaleString()}</span>
              </div>
              <ul className="meta">
                <li>Registered devices: {overview.registeredDevices}</li>
                <li>Online devices: {overview.onlineDevices}</li>
                <li>Offline devices: {overview.offlineDevices}</li>
                <li>Guardians registered: {overview.guardians}</li>
                <li>Alerts in last 24h: {overview.alertsLast24h}</li>
                <li>Critical alerts in last 24h: {overview.criticalAlertsLast24h}</li>
                <li>Pending commands: {overview.pendingCommands}</li>
                <li>
                  Latest heartbeat:{' '}
                  {overview.latestHeartbeatMs > 0
                    ? new Date(overview.latestHeartbeatMs).toLocaleString()
                    : 'No heartbeat recorded'}
                </li>
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
