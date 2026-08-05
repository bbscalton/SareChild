import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { FirebaseError } from 'firebase/app'
import { useAuth } from './authContext'
import * as repo from './repo'
import * as adminRepo from './adminRepo'
import { AdminAccountsPanel } from './AdminAccountsPanel'
import { AdminResellersPanel } from './AdminResellersPanel'
import { AdminFeaturesPanel } from './AdminFeaturesPanel'
import { AdminSystemPanel } from './AdminSystemPanel'
import { ArchitectureTree, buildArchNodes } from './ArchitectureTree'
import { PARENT_WEB_URL, TCD_URL, WENT_DARK_AFTER_MS } from './firebase'
import type {
  AdminParentAccountRow,
  ApkHealth,
  ChatActivity,
  DeviceStatus,
  FamilyAlert,
  GuardianInfo,
  GuardianInviteStats,
  PairingStats,
  PlatformFault,
  SafetyCommand,
  SiteUptime,
  TcdCheck,
  TcdCheckStatus,
  TcdOverview,
  TcdReport,
  TcdTab,
} from './types'

const STATUS_RANK: Record<TcdCheckStatus, number> = { ok: 0, warn: 1, fail: 2 }

function worst(statuses: TcdCheckStatus[]): TcdCheckStatus | null {
  if (statuses.length === 0) return null
  return statuses.reduce((acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc))
}

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function isDeviceOnline(d: DeviceStatus, nowMs: number): boolean {
  return d.lastHeartbeatMs > 0 && nowMs - d.lastHeartbeatMs < WENT_DARK_AFTER_MS
}

export function TcdApp() {
  const { configured, user, loading, isAdmin, blockedMessage, familyId, trialInfo, refreshFamilyId, signIn, signInWithGoogle, signOut } =
    useAuth()

  if (!configured) {
    return (
      <div className="tcd-auth-wrap">
        <div className="tcd-auth-card">
          <p className="eyebrow eyebrow-on-dark">SareChild Ops</p>
          <h1>TCD not configured</h1>
          <p className="muted on-dark">
            This build is missing Firebase environment variables. Set the VITE_FIREBASE_* GitHub Actions secrets
            used by the marketing Pages workflow and redeploy.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return <div className="tcd-loading">Loading TCD console…</div>
  }

  if (!user) {
    return <TcdLogin signIn={signIn} signInWithGoogle={signInWithGoogle} />
  }

  if (blockedMessage) {
    return (
      <div className="tcd-auth-wrap">
        <div className="tcd-auth-card">
          <p className="eyebrow eyebrow-on-dark">SareChild Ops</p>
          <h1>Account suspended</h1>
          <p className="muted on-dark">{blockedMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <TcdDashboard
      email={user.email || ''}
      isAdmin={isAdmin}
      familyId={familyId}
      trialInfo={trialInfo}
      refreshFamilyId={refreshFamilyId}
      signOut={signOut}
    />
  )
}

function TcdLogin({
  signIn,
  signInWithGoogle,
}: {
  signIn: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  const onGoogle = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle()
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'auth/account-exists-with-different-credential') {
        setError('This email already has a password account — sign in with email + password instead.')
      } else {
        setError(err instanceof Error ? err.message : 'Google sign-in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tcd-auth-wrap">
      <form className="tcd-auth-card" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <p className="eyebrow eyebrow-on-dark">SareChild Ops</p>
          <h1>TCD Control Plane</h1>
          <p className="muted on-dark small" style={{ marginTop: '0.5rem' }}>
            Sign in with your SareChild parent account. Project owner gets full admin: accounts, features, architecture, and repairs.
          </p>
        </div>

        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button className="btn btn-ghost-on-dark" type="button" disabled={busy} onClick={() => void onGoogle()}>
          Continue with Google
        </button>
      </form>
    </div>
  )
}

function TcdDashboard({
  email,
  isAdmin,
  familyId,
  trialInfo,
  refreshFamilyId,
  signOut,
}: {
  email: string
  isAdmin: boolean
  familyId: string | null
  trialInfo: import('./types').TrialInfo | null
  refreshFamilyId: () => Promise<void>
  signOut: () => Promise<void>
}) {
  const [tab, setTab] = useState<TcdTab>('overview')
  const [adminAccounts, setAdminAccounts] = useState<AdminParentAccountRow[]>([])
  const [archSelected, setArchSelected] = useState<string | null>(null)
  const [report, setReport] = useState<TcdReport | null>(null)
  const [overview, setOverview] = useState<TcdOverview | null>(null)
  const [apkHealth, setApkHealth] = useState<ApkHealth[]>([])
  const [siteUptime, setSiteUptime] = useState<SiteUptime[]>([])
  const [pairingStats, setPairingStats] = useState<PairingStats | null>(null)
  const [guardianInviteStats, setGuardianInviteStats] = useState<GuardianInviteStats | null>(null)
  const [chatActivity, setChatActivity] = useState<ChatActivity | null>(null)

  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [alerts, setAlerts] = useState<FamilyAlert[]>([])
  const [guardians, setGuardians] = useState<GuardianInfo[]>([])
  const [commands, setCommands] = useState<SafetyCommand[]>([])
  const [nowTick, setNowTick] = useState(() => Date.now())

  const [error, setError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [repairLog, setRepairLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [lastRunMs, setLastRunMs] = useState<number | null>(null)

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

  useEffect(() => {
    if (!isAdmin) return
    return adminRepo.observeAdminAccounts(setAdminAccounts, (e) => setError(e.message))
  }, [isAdmin])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const healthFamilyId = familyId ?? adminAccounts.find((a) => a.familyId)?.familyId
      const healthPromise = healthFamilyId ? repo.runTcdHealthCheck(healthFamilyId) : Promise.resolve({ generatedAtMs: Date.now(), checks: [] as TcdCheck[] })
      const overviewPromise = healthFamilyId ? repo.loadTcdOverview(healthFamilyId) : Promise.resolve(null)
      const pairingPromise = healthFamilyId ? repo.loadPairingStats(healthFamilyId) : Promise.resolve(null)
      const invitesPromise = healthFamilyId ? repo.loadGuardianInviteStats(healthFamilyId) : Promise.resolve(null)
      const chatPromise = healthFamilyId ? repo.loadChatActivity(healthFamilyId) : Promise.resolve(null)

      const [nextReport, nextOverview, apk, uptime, pairing, invites, chat] = await Promise.all([
        healthPromise,
        overviewPromise,
        repo.loadApkHealth(),
        repo.loadSiteUptime(),
        pairingPromise,
        invitesPromise,
        chatPromise,
      ])
      setReport(nextReport)
      setOverview(nextOverview)
      setApkHealth(apk)
      setSiteUptime(uptime)
      setPairingStats(pairing)
      setGuardianInviteStats(invites)
      setChatActivity(chat)
      setLastRunMs(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run TCD checks')
    } finally {
      setBusy(false)
    }
  }

  const runRepair = async () => {
    setBusy(true)
    setError(null)
    setStatusMsg(null)
    try {
      const logs: string[] = []
      if (familyId) {
        logs.push(...(await repo.runTcdAutoRepair(familyId)))
      }
      if (isAdmin) {
        logs.push(...(await adminRepo.runPlatformAutoRepair()))
      }
      setRepairLog(logs)
      await run()
      setStatusMsg('Auto-repair completed and health re-checked.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run auto-repair')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!familyId && !isAdmin) return
    void run()
    const id = window.setInterval(() => void run(), 60_000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId, isAdmin])

  const liveFleet = useMemo(() => {
    const cutoff24h = nowTick - 24 * 60 * 60 * 1000
    const onlineDevices = devices.filter((d) => isDeviceOnline(d, nowTick)).length
    const alertsLast24h = alerts.filter((a) => a.createdAtMs >= cutoff24h).length
    const criticalAlertsLast24h = alerts.filter((a) => a.createdAtMs >= cutoff24h && a.severity.toUpperCase() === 'CRITICAL').length
    const pendingCommands = commands.filter((c) => c.status === 'PENDING').length
    return {
      registeredDevices: devices.length,
      onlineDevices,
      offlineDevices: Math.max(0, devices.length - onlineDevices),
      guardians: guardians.length,
      alertsLast24h,
      criticalAlertsLast24h,
      pendingCommands,
    }
  }, [devices, alerts, commands, guardians, nowTick])

  const platformChecks = report?.checks.filter((c) => c.group === 'platform') ?? []
  const fleetChecks = report?.checks.filter((c) => c.group === 'fleet') ?? []

  const overallStatus = useMemo<TcdCheckStatus | 'checking'>(() => {
    if (!report) return 'checking'
    const statuses: TcdCheckStatus[] = [
      ...report.checks.map((c) => c.status),
      ...apkHealth.map((a) => a.status),
      ...siteUptime.map((s) => s.status),
    ]
    return worst(statuses) ?? 'ok'
  }, [report, apkHealth, siteUptime])

  const statusCopy: Record<TcdCheckStatus | 'checking', { title: string; sub: string }> = {
    checking: { title: 'Checking systems…', sub: 'Running the first diagnostic sweep now.' },
    ok: { title: 'All systems nominal', sub: 'Every monitored service is healthy across Firebase and the Cloudflare edge.' },
    warn: { title: 'Degraded — attention needed', sub: 'One or more checks need a look. See action items below.' },
    fail: { title: 'Critical — action required', sub: 'A core service is down. See action items below for the fastest fix.' },
  }

  const siteStatusMap = useMemo(() => Object.fromEntries(siteUptime.map((s) => [s.id, s.status])), [siteUptime])

  const archNodes = useMemo(
    () => buildArchNodes([...(report?.checks ?? []), ...apkHealth.map((a) => ({ id: a.id, label: a.label, group: 'platform' as const, status: a.status, message: a.message }))], siteStatusMap),
    [report, apkHealth, siteStatusMap],
  )

  const platformFaults = useMemo((): PlatformFault[] => {
    const faults: PlatformFault[] = []
    report?.checks.forEach((c) => {
      if (c.status === 'fail') {
        faults.push({ id: c.id, severity: 'critical', title: c.label, detail: c.message, source: 'health-check' })
      } else if (c.status === 'warn') {
        faults.push({ id: c.id, severity: 'warning', title: c.label, detail: c.message, source: 'health-check' })
      }
    })
    apkHealth.forEach((a) => {
      if (a.status === 'fail') {
        faults.push({ id: a.id, severity: 'critical', title: a.label, detail: a.message, source: 'apk-download' })
      }
    })
    siteUptime.forEach((s) => {
      if (s.status === 'fail') {
        faults.push({ id: s.id, severity: 'critical', title: s.label, detail: s.message, source: 'uptime' })
      }
    })
    if (isAdmin) {
      const blockedCount = adminAccounts.filter((a) => a.adminBlocked || a.status === 'blocked').length
      if (blockedCount > 0) {
        faults.push({
          id: 'blocked-accounts',
          severity: 'info',
          title: `${blockedCount} blocked account(s)`,
          detail: 'Review the Accounts tab for suspended users.',
          source: 'admin',
        })
      }
    }
    return faults
  }, [report, apkHealth, siteUptime, isAdmin, adminAccounts])

  const actionItems = useMemo(() => {
    const items: string[] = []
    if (liveFleet.offlineDevices > 0) {
      items.push(
        `${liveFleet.offlineDevices} child device(s) offline — open the SareChild child app, tap Start protection, and confirm permissions.`,
      )
    }
    if (liveFleet.guardians === 0) {
      items.push('No guardians in family record — run Auto-repair to restore the owner guardian entry.')
    }
    if (liveFleet.criticalAlertsLast24h > 0) {
      items.push(`${liveFleet.criticalAlertsLast24h} critical alert(s) in the last 24h — review the family alerts feed.`)
    }
    report?.checks.forEach((c) => {
      if (c.status === 'fail') items.push(`${c.label}: ${c.message}`)
    })
    apkHealth.forEach((a) => {
      if (a.status === 'fail') items.push(`${a.label} download is unreachable — check R2 bucket contents.`)
    })
    siteUptime.forEach((s) => {
      if (s.status === 'fail') items.push(`${s.label} appears unreachable.`)
    })
    if (pairingStats && pairingStats.expired > 0) {
      items.push(`${pairingStats.expired} expired pairing code(s) — safe to ignore, or clear from Firestore.`)
    }
    if (trialInfo?.status === 'at_risk') {
      items.push('Your trial is at risk of expiring due to inactivity — open the parent dashboard to check in.')
    }
    return items
  }, [liveFleet, report, apkHealth, siteUptime, pairingStats, trialInfo])

  return (
    <div className="tcd-shell">
      <header className="tcd-hero">
        <div className="tcd-hero-top">
          <div className="tcd-brand">
            <span className="brand-mark" aria-hidden="true" />
            SareChild Ops
          </div>
          <div className="tcd-identity">
            <p>
              Signed in as <strong>{email}</strong>
              {isAdmin && <span className="tcd-admin-badge">ADMIN</span>}
            </p>
            <p>Family: {familyId || 'not linked yet'}</p>
          </div>
        </div>

        {isAdmin && (
          <nav className="tcd-tabs" aria-label="Control plane sections">
            {(
              [
                ['overview', 'Overview'],
                ['accounts', 'Accounts'],
                ['resellers', 'Resellers'],
                ['features', 'Features'],
                ['system', 'System'],
                ['architecture', 'Architecture'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`tcd-tab ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}

        <div className="tcd-status-composition">
          <div className={`tcd-orb status-${overallStatus}`}>
            <span className="tcd-orb-dot" />
          </div>
          <div>
            <h1 className="tcd-status-title">{statusCopy[overallStatus].title}</h1>
            <p className="tcd-status-sub">{statusCopy[overallStatus].sub}</p>
            <div className="tcd-hero-actions">
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void run()}>
                {busy ? 'Running…' : 'Run health check'}
              </button>
              <button className="btn btn-ghost-on-dark" type="button" disabled={busy} onClick={() => void runRepair()}>
                Run auto-repair
              </button>
              <a className="btn btn-ghost-on-dark" href={PARENT_WEB_URL} target="_blank" rel="noreferrer">
                Open parent dashboard
              </a>
              <button className="btn btn-ghost-on-dark" type="button" onClick={() => void refreshFamilyId()}>
                Refresh family link
              </button>
              <button className="btn btn-ghost-on-dark" type="button" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
            <p className="tcd-refresh-note" style={{ marginTop: '1rem' }}>
              <span className="tcd-refresh-dot" aria-hidden="true" />
              Auto-refresh every 60s · last run {timeAgo(lastRunMs)}
            </p>
          </div>
        </div>
      </header>

      <main className="tcd-main">
        {error && <div className="tcd-banner error">{error}</div>}
        {statusMsg && <div className="tcd-banner ok">{statusMsg}</div>}

        {platformFaults.length > 0 && tab === 'overview' && (
          <section className="tcd-faults">
            <h2>Alerts &amp; faults</h2>
            <ul>
              {platformFaults.map((f) => (
                <li key={f.id} className={`tcd-fault severity-${f.severity}`}>
                  <span className={`pill tcd-${f.severity === 'critical' ? 'fail' : f.severity === 'warning' ? 'warn' : 'ok'}`}>
                    {f.severity.toUpperCase()}
                  </span>
                  <span>
                    <strong>{f.title}</strong> — {f.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {actionItems.length > 0 && tab === 'overview' && (
          <section className="tcd-action-items">
            <h2>Action items</h2>
            <ul>
              {actionItems.map((item, i) => (
                <li key={`${item}-${i}`}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        {tab === 'accounts' && isAdmin && (
          <AdminAccountsPanel
            accounts={adminAccounts}
            adminEmail={email}
            busy={busy}
            onBusy={setBusy}
            onStatus={setStatusMsg}
            onError={setError}
            onlineDevices={overview?.onlineDevices ?? null}
          />
        )}

        {tab === 'resellers' && isAdmin && (
          <AdminResellersPanel busy={busy} onBusy={setBusy} onStatus={setStatusMsg} onError={setError} />
        )}

        {tab === 'system' && isAdmin && (
          <AdminSystemPanel busy={busy} onBusy={setBusy} onStatus={setStatusMsg} onError={setError} />
        )}

        {tab === 'features' && isAdmin && (
          <AdminFeaturesPanel busy={busy} onBusy={setBusy} onStatus={setStatusMsg} onError={setError} />
        )}

        {tab === 'architecture' && isAdmin && (
          <div className="tcd-card tcd-card-wide tcd-arch-card">
            <div className="tcd-card-head">
              <h2>System architecture</h2>
              <span className="tcd-card-timestamp">live probe status</span>
            </div>
            <ArchitectureTree
              nodes={archNodes}
              selectedId={archSelected}
              onSelect={setArchSelected}
              loading={!report}
            />
          </div>
        )}

        {tab === 'overview' && (
        <div className="tcd-grid">
          <FleetCard liveFleet={liveFleet} overview={overview} checks={fleetChecks} chatActivity={chatActivity} nowTick={nowTick} />
          <PlatformCard checks={platformChecks} generatedAtMs={report?.generatedAtMs} />
          <UptimeCard siteUptime={siteUptime} apkHealth={apkHealth} />
          <TrialCard trialInfo={trialInfo} />
          <PairingCard pairingStats={pairingStats} guardianInviteStats={guardianInviteStats} />
          {repairLog.length > 0 && (
            <div className="tcd-card">
              <div className="tcd-card-head">
                <h2>Last auto-repair actions</h2>
              </div>
              <ul className="tcd-repair-log">
                {repairLog.map((line, idx) => (
                  <li key={`${line}-${idx}`}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        )}
      </main>

      <p className="tcd-footer-note">
        SareChild Total Control Dashboard · <a href={TCD_URL}>GitHub Pages TCD</a> ·{' '}
        <a href={PARENT_WEB_URL}>Firebase Hosting mirror</a> ·{' '}
        <a href="./">Back to marketing site</a>
        {isAdmin && (
          <>
            {' '}
            · Hard-refresh (Ctrl+Shift+R) after deploys to bust cached JS/CSS.
          </>
        )}
      </p>
    </div>
  )
}

function CheckPill({ status }: { status: TcdCheckStatus }) {
  return <span className={`pill tcd-${status}`}>{status.toUpperCase()}</span>
}

function CheckList({ checks }: { checks: TcdCheck[] }) {
  if (checks.length === 0) return <p className="tcd-empty-note">No checks run yet — click Run health check above.</p>
  return (
    <ul className="tcd-check-list">
      {checks.map((c) => (
        <li key={c.id} className="tcd-check-row">
          <CheckPill status={c.status} />
          <span>
            <strong>{c.label}</strong> — {c.message}
            {c.latencyMs != null && <span className="muted small"> ({c.latencyMs} ms)</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function FleetCard({
  liveFleet,
  overview,
  checks,
  chatActivity,
  nowTick,
}: {
  liveFleet: {
    registeredDevices: number
    onlineDevices: number
    offlineDevices: number
    guardians: number
    alertsLast24h: number
    criticalAlertsLast24h: number
    pendingCommands: number
  }
  overview: TcdOverview | null
  checks: TcdCheck[]
  chatActivity: ChatActivity | null
  nowTick: number
}) {
  const edgeAgeMs = overview ? nowTick - overview.generatedAtMs : null
  return (
    <div className="tcd-card">
      <div className="tcd-card-head">
        <h2>Live fleet status</h2>
        <span className="tcd-card-timestamp">real-time</span>
      </div>
      <div className="tcd-stat-row">
        <div className="tcd-stat">
          <span className="tcd-stat-value ok">{liveFleet.onlineDevices}</span>
          <span className="tcd-stat-label">Online</span>
        </div>
        <div className="tcd-stat">
          <span className={`tcd-stat-value ${liveFleet.offlineDevices > 0 ? 'warn' : ''}`}>{liveFleet.offlineDevices}</span>
          <span className="tcd-stat-label">Offline</span>
        </div>
        <div className="tcd-stat">
          <span className="tcd-stat-value">{liveFleet.guardians}</span>
          <span className="tcd-stat-label">Guardians</span>
        </div>
        <div className="tcd-stat">
          <span className={`tcd-stat-value ${liveFleet.criticalAlertsLast24h > 0 ? 'fail' : ''}`}>{liveFleet.alertsLast24h}</span>
          <span className="tcd-stat-label">Alerts / 24h</span>
        </div>
        <div className="tcd-stat">
          <span className="tcd-stat-value">{liveFleet.pendingCommands}</span>
          <span className="tcd-stat-label">Pending cmds</span>
        </div>
      </div>
      <CheckList checks={checks} />
      <ul className="tcd-check-list">
        <li className="tcd-check-row">
          <span>
            Edge snapshot: {overview ? `${overview.edgeSource || 'n/a'} · ${timeAgo(overview.generatedAtMs)}` : 'not loaded yet'}
            {overview?.edgeLatencyMs != null && ` (${overview.edgeLatencyMs} ms)`}
            {edgeAgeMs != null && edgeAgeMs > 5 * 60 * 1000 && <span className="pill tcd-warn" style={{ marginLeft: '0.4rem' }}>STALE</span>}
          </span>
        </li>
        <li className="tcd-check-row">
          <span>
            Family chat: {chatActivity?.lastMessageAtMs ? `last message ${timeAgo(chatActivity.lastMessageAtMs)} from ${chatActivity.lastSenderRole || 'unknown'}` : 'no messages yet'}
          </span>
        </li>
      </ul>
    </div>
  )
}

function PlatformCard({ checks, generatedAtMs }: { checks: TcdCheck[]; generatedAtMs?: number }) {
  return (
    <div className="tcd-card">
      <div className="tcd-card-head">
        <h2>Platform health</h2>
        {generatedAtMs != null && <span className="tcd-card-timestamp">{new Date(generatedAtMs).toLocaleTimeString()}</span>}
      </div>
      <p className="muted small">Firebase, Firestore, Auth, and the Cloudflare edge (R2 / D1 / KV).</p>
      <CheckList checks={checks} />
    </div>
  )
}

function UptimeCard({ siteUptime, apkHealth }: { siteUptime: SiteUptime[]; apkHealth: ApkHealth[] }) {
  return (
    <div className="tcd-card">
      <div className="tcd-card-head">
        <h2>Uptime &amp; downloads</h2>
      </div>
      <ul className="tcd-check-list">
        {siteUptime.map((s) => (
          <li key={s.id} className="tcd-check-row">
            <CheckPill status={s.status} />
            <span>
              <strong>{s.label}</strong> — {s.message}
              {s.latencyMs != null && <span className="muted small"> ({s.latencyMs} ms)</span>}
            </span>
          </li>
        ))}
        {apkHealth.map((a) => (
          <li key={a.id} className="tcd-check-row">
            <CheckPill status={a.status} />
            <span>
              <strong>{a.label}</strong> — {a.message}
              {a.sizeBytes != null && <span className="muted small"> ({(a.sizeBytes / (1024 * 1024)).toFixed(1)} MB)</span>}
            </span>
          </li>
        ))}
        {siteUptime.length === 0 && apkHealth.length === 0 && <p className="tcd-empty-note">Run a health check to probe uptime.</p>}
      </ul>
    </div>
  )
}

function TrialCard({ trialInfo }: { trialInfo: import('./types').TrialInfo | null }) {
  const daysLeft = trialInfo ? Math.max(0, Math.ceil((trialInfo.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000))) : null
  return (
    <div className="tcd-card">
      <div className="tcd-card-head">
        <h2>Your trial &amp; account</h2>
      </div>
      {!trialInfo ? (
        <p className="tcd-empty-note">No trial record for this account yet.</p>
      ) : (
        <ul className="tcd-check-list">
          <li className="tcd-check-row">
            <span className={`pill ${trialInfo.status === 'active' ? 'tcd-ok' : trialInfo.status === 'at_risk' ? 'tcd-warn' : 'tcd-fail'}`}>
              {trialInfo.status.toUpperCase()}
            </span>
            <span>
              Plan <strong>{trialInfo.plan}</strong> · {trialInfo.plan === 'trial' && daysLeft != null ? `${daysLeft} day(s) left` : 'no expiry'}
            </span>
          </li>
          <li className="tcd-check-row">
            <span>Last login: {trialInfo.lastLoginAt ? timeAgo(trialInfo.lastLoginAt) : 'never'}</span>
          </li>
          <li className="tcd-check-row">
            <span>Last parent check-in: {trialInfo.lastParentCheckInAt ? timeAgo(trialInfo.lastParentCheckInAt) : 'never'}</span>
          </li>
        </ul>
      )}
    </div>
  )
}

function PairingCard({
  pairingStats,
  guardianInviteStats,
}: {
  pairingStats: PairingStats | null
  guardianInviteStats: GuardianInviteStats | null
}) {
  return (
    <div className="tcd-card">
      <div className="tcd-card-head">
        <h2>Pairing &amp; guardians</h2>
      </div>
      {!pairingStats && !guardianInviteStats ? (
        <p className="tcd-empty-note">Run a health check to load pairing stats.</p>
      ) : (
        <div className="tcd-stat-row">
          <div className="tcd-stat">
            <span className="tcd-stat-value">{pairingStats?.pending ?? 0}</span>
            <span className="tcd-stat-label">Codes pending</span>
          </div>
          <div className="tcd-stat">
            <span className="tcd-stat-value">{pairingStats?.expired ?? 0}</span>
            <span className="tcd-stat-label">Codes expired</span>
          </div>
          <div className="tcd-stat">
            <span className="tcd-stat-value">{pairingStats?.claimed ?? 0}</span>
            <span className="tcd-stat-label">Codes claimed</span>
          </div>
          <div className="tcd-stat">
            <span className="tcd-stat-value">{guardianInviteStats?.pending ?? 0}</span>
            <span className="tcd-stat-label">Invites pending</span>
          </div>
        </div>
      )}
    </div>
  )
}
