import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../AuthContext'
import * as repo from '../lib/parentRepo'
import { WENT_DARK_AFTER_MS } from '../firebase'
import { LoginPage } from './LoginPage'
import type { DeviceStatus, FamilyAlert, GuardianInfo, SafetyCommand, TcdOverview, TcdReport } from '../types'

function isDeviceOnline(device: DeviceStatus, nowMs: number): boolean {
  return device.lastHeartbeatMs > 0 && nowMs - device.lastHeartbeatMs < WENT_DARK_AFTER_MS
}

export function TcdStandalonePage() {
  const { user, loading, familyId, refreshFamilyId, signOut } = useAuth()
  const [report, setReport] = useState<TcdReport | null>(null)
  const [overview, setOverview] = useState<TcdOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [repairLog, setRepairLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // Live Firestore listeners: fleet online/offline and alerts update instantly,
  // independent of the periodic edge/platform health poll below.
  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [alerts, setAlerts] = useState<FamilyAlert[]>([])
  const [guardians, setGuardians] = useState<GuardianInfo[]>([])
  const [commands, setCommands] = useState<SafetyCommand[]>([])
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!familyId) return
    const unsubs = [
      repo.observeDevices(familyId, setDevices),
      repo.observeAlerts(familyId, setAlerts),
      repo.observeGuardians(familyId, setGuardians),
      repo.observeCommands(familyId, setCommands),
    ]
    return () => unsubs.forEach((u) => u())
  }, [familyId])

  const liveFleet = useMemo(() => {
    const cutoff24h = nowTick - 24 * 60 * 60 * 1000
    const onlineDevices = devices.filter((d) => isDeviceOnline(d, nowTick)).length
    const alertsLast24h = alerts.filter((a) => a.createdAtMs >= cutoff24h).length
    const criticalAlertsLast24h = alerts.filter(
      (a) => a.createdAtMs >= cutoff24h && a.severity.toUpperCase() === 'CRITICAL',
    ).length
    const pendingCommands = commands.filter((c) => c.status === 'PENDING').length
    return {
      registeredDevices: devices.length,
      onlineDevices,
      offlineDevices: Math.max(0, devices.length - onlineDevices),
      guardians: guardians.length,
      alertsLast24h,
      criticalAlertsLast24h,
      pendingCommands,
      generatedAtMs: nowTick,
    }
  }, [devices, alerts, commands, guardians, nowTick])

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

  const runRepair = async () => {
    if (!familyId) return
    setBusy(true)
    setError(null)
    setStatusMsg(null)
    try {
      const log = await repo.runTcdAutoRepair(familyId)
      setRepairLog(log)
      await run()
      setStatusMsg('Auto-repair completed and health re-checked.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run auto-repair')
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
      {statusMsg && <div className="banner ok-banner">{statusMsg}</div>}

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
              <button className="btn ghost" type="button" disabled={busy || !familyId} onClick={() => void runRepair()}>
                Run auto-repair
              </button>
              <a className="btn ghost compact" href="/SareChild/" target="_blank" rel="noreferrer">
                Open parent dashboard
              </a>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Live fleet status (real-time)</h3>
              <span className="muted small">{new Date(liveFleet.generatedAtMs).toLocaleTimeString()}</span>
            </div>
            <p className="muted small">
              Pushed straight from Firestore listeners — no click or reload needed.
            </p>
            <ul className="meta">
              <li>Registered devices: {liveFleet.registeredDevices}</li>
              <li>Online devices: {liveFleet.onlineDevices}</li>
              <li>Offline devices: {liveFleet.offlineDevices}</li>
              <li>Guardians registered: {liveFleet.guardians}</li>
              <li>Alerts in last 24h: {liveFleet.alertsLast24h}</li>
              <li>Critical alerts in last 24h: {liveFleet.criticalAlertsLast24h}</li>
              <li>Pending commands: {liveFleet.pendingCommands}</li>
            </ul>
          </div>

          {overview && (overview.offlineDevices > 0 || overview.guardians === 0) && (
            <div className="card">
              <h3>Action items</h3>
              <ul className="meta">
                {overview.offlineDevices > 0 && (
                  <li>
                    Child device offline — open the SareChild child app, tap Start protection, and confirm
                    permissions are granted.
                  </li>
                )}
                {overview.guardians === 0 && (
                  <li>
                    No guardians in family record — click <strong>Run auto-repair</strong> to restore the owner
                    guardian entry.
                  </li>
                )}
              </ul>
            </div>
          )}

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
                  Edge cache source: {overview.edgeSource || 'n/a'}
                  {overview.edgeLatencyMs != null ? ` (${overview.edgeLatencyMs} ms)` : ''}
                </li>
                <li>
                  Latest heartbeat:{' '}
                  {overview.latestHeartbeatMs > 0
                    ? new Date(overview.latestHeartbeatMs).toLocaleString()
                    : 'No heartbeat recorded'}
                </li>
              </ul>
            </div>
          )}

          {repairLog.length > 0 && (
            <div className="card">
              <h3>Last auto-repair actions</h3>
              <ul className="meta">
                {repairLog.map((line, idx) => (
                  <li key={`${line}-${idx}`}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
