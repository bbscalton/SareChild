import { useEffect, useState } from 'react'
import * as adminRepo from './adminRepo'
import {
  FIREBASE_AUTH_CONSOLE_URL,
  FIREBASE_CONSOLE_URL,
  FIREBASE_FIRESTORE_CONSOLE_URL,
  FIREBASE_FUNCTIONS_CONSOLE_URL,
  FUNCTIONS_HEALTH_URL,
  GITHUB_REPO_URL,
  MARKETING_URL,
  PARENT_WEB_URL,
  PLATFORM_HEALTH_URL,
  TCD_URL,
} from './firebase'
import type { AdminAuditLogEntry } from './types'

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

const ACTION_LABELS: Record<string, string> = {
  wipe_user: 'Reset / wipe',
  delete_user: 'Delete account',
  revoke_sessions: 'Force sign-out',
  adjust_trial: 'Adjust trial',
  grant_credits: 'Grant credits',
  block_account: 'Block',
  unblock_account: 'Unblock',
  trigger_purge_trials: 'Purge trials',
  trigger_purge_retention: 'Purge retention data',
  set_retention: 'Set retention',
  set_chat_video_limit: 'Set chat video limit',
  repair_orphans: 'Repair orphans',
  repair_cross_tenant: 'Repair cross-tenant',
  send_test_fcm: 'Test FCM',
}

export function AdminSystemPanel({
  busy,
  onBusy,
  onStatus,
  onError,
}: {
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
}) {
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([])
  const [functionsHealth, setFunctionsHealth] = useState<string>('not checked')
  const [platformHealth, setPlatformHealth] = useState<string>('not checked')
  const [repairLog, setRepairLog] = useState<string[]>([])
  const [testFamilyId, setTestFamilyId] = useState('')
  const [testDeviceId, setTestDeviceId] = useState('')

  useEffect(() => {
    return adminRepo.observeAdminAuditLogs(setAuditLogs, (e) => onError(e.message))
  }, [onError])

  const checkHealth = async () => {
    onBusy(true)
    onError(null)
    try {
      const [fnRes, platRes] = await Promise.all([
        FUNCTIONS_HEALTH_URL
          ? fetch(FUNCTIONS_HEALTH_URL).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
          : Promise.reject(new Error('VITE_FUNCTIONS_HEALTH_URL not set')),
        fetch(PLATFORM_HEALTH_URL).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))),
      ])
      setFunctionsHealth(`ok · ${JSON.stringify(fnRes).slice(0, 120)}…`)
      setPlatformHealth(`ok · families sample ${platRes.sampleFamilyCount ?? '?'} · devices ${platRes.sampleDeviceCount ?? '?'}`)
      onStatus('Health probes completed.')
    } catch (e) {
      setFunctionsHealth(e instanceof Error ? e.message : 'fail')
      onError(e instanceof Error ? e.message : 'Health check failed')
    } finally {
      onBusy(false)
    }
  }

  const runPurge = async () => {
    if (!window.confirm('Run inactive-trial purge now? This may delete Auth accounts marked for purge.')) return
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminTriggerPurgeTrials()
      onStatus(`Purge complete: warned=${result.warned}, purged=${result.purged}, scanned=${result.scanned}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Purge failed')
    } finally {
      onBusy(false)
    }
  }

  const runRetentionPurge = async () => {
    if (
      !window.confirm(
        'Run operational data retention purge now? Deletes event/timeline docs older than each family\'s retentionDays (default 2). Account shells and devices are kept.',
      )
    ) {
      return
    }
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminTriggerPurgeRetention()
      onStatus(
        `Retention purge: families=${result.familiesScanned}, docs deleted=${result.docsDeleted}, R2 media=${result.mediaDeleted}.`,
      )
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Retention purge failed')
    } finally {
      onBusy(false)
    }
  }

  const runRepair = async () => {
    onBusy(true)
    onError(null)
    try {
      const fixes = await adminRepo.adminRepairOrphans()
      setRepairLog(fixes)
      onStatus('Orphan repair completed.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Repair failed')
    } finally {
      onBusy(false)
    }
  }

  const runCrossTenantRepair = async () => {
    if (
      !window.confirm(
        'Scan all parent accounts for illegitimate cross-tenant guardian links (2026-08-05 exploit pattern)? Rogue guardians will be deleted and affected users get a fresh empty family.',
      )
    ) {
      return
    }
    onBusy(true)
    onError(null)
    try {
      const fixes = await adminRepo.adminRepairCrossTenantGuardians()
      setRepairLog(fixes)
      onStatus('Cross-tenant guardian repair completed.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Cross-tenant repair failed')
    } finally {
      onBusy(false)
    }
  }

  const runTestFcm = async () => {
    const familyId = testFamilyId.trim()
    const deviceId = testDeviceId.trim()
    if (!familyId || !deviceId) {
      onError('Enter familyId and deviceId for test FCM.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminSendTestFcm(familyId, deviceId)
      onStatus(`Test FCM sent (${result.successCount} device token(s) accepted).`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Test FCM failed')
    } finally {
      onBusy(false)
    }
  }

  return (
    <div className="tcd-admin-features-grid">
      <div className="tcd-card">
        <div className="tcd-card-head">
          <h2>System tools</h2>
        </div>
        <div className="tcd-system-actions">
          <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void checkHealth()}>
            Probe functions health
          </button>
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runPurge()}>
            Trigger purge-inactive-trials
          </button>
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runRetentionPurge()}>
            Trigger retention purge
          </button>
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runRepair()}>
            Repair orphaned families
          </button>
          <button
            className="btn btn-ghost compact"
            type="button"
            disabled={busy}
            onClick={() => void runCrossTenantRepair()}
          >
            Repair cross-tenant guardians
          </button>
        </div>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          <strong>Data retention:</strong> operational event data (alerts, trails, recordings, chat, usage) is kept for{' '}
          <strong>2 days</strong> by default per family. Increase per account on the Accounts tab (2–90 days). Runs
          automatically every 24h via <code>purgeExpiredRetentionData</code>.
        </p>
        <ul className="tcd-check-list" style={{ marginTop: '1rem' }}>
          <li className="tcd-check-row">
            <span>
              <strong>Functions</strong> — {functionsHealth}
            </span>
          </li>
          <li className="tcd-check-row">
            <span>
              <strong>Platform edge</strong> — {platformHealth}
            </span>
          </li>
        </ul>
        {repairLog.length > 0 && (
          <ul className="tcd-repair-log">
            {repairLog.map((line, idx) => (
              <li key={`${line}-${idx}`}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="tcd-card">
        <div className="tcd-card-head">
          <h2>Quick links</h2>
        </div>
        <ul className="tcd-link-list">
          <li>
            <a href={FIREBASE_CONSOLE_URL} target="_blank" rel="noreferrer">
              Firebase project console
            </a>
          </li>
          <li>
            <a href={FIREBASE_AUTH_CONSOLE_URL} target="_blank" rel="noreferrer">
              Auth users
            </a>
          </li>
          <li>
            <a href={FIREBASE_FIRESTORE_CONSOLE_URL} target="_blank" rel="noreferrer">
              Firestore database
            </a>
          </li>
          <li>
            <a href={FIREBASE_FUNCTIONS_CONSOLE_URL} target="_blank" rel="noreferrer">
              Cloud Functions
            </a>
          </li>
          <li>
            <a href={PARENT_WEB_URL} target="_blank" rel="noreferrer">
              Parent dashboard (Hosting)
            </a>
          </li>
          <li>
            <a href={TCD_URL} target="_blank" rel="noreferrer">
              TCD (GitHub Pages)
            </a>
          </li>
          <li>
            <a href={MARKETING_URL} target="_blank" rel="noreferrer">
              Marketing site
            </a>
          </li>
          <li>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              GitHub repository
            </a>
          </li>
        </ul>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          After deploys, hard-refresh TCD with <kbd>Ctrl+Shift+R</kbd> to bust cached JS/CSS.
        </p>
      </div>

      <div className="tcd-card">
        <div className="tcd-card-head">
          <h2>Send test FCM</h2>
        </div>
        <div className="tcd-form-grid">
          <label>
            familyId
            <input type="text" value={testFamilyId} onChange={(e) => setTestFamilyId(e.target.value)} placeholder="family doc id" />
          </label>
          <label>
            deviceId
            <input type="text" value={testDeviceId} onChange={(e) => setTestDeviceId(e.target.value)} placeholder="device doc id" />
          </label>
        </div>
        <button className="btn btn-primary compact" type="button" disabled={busy} style={{ marginTop: '0.75rem' }} onClick={() => void runTestFcm()}>
          Send test push
        </button>
      </div>

      <div className="tcd-card tcd-card-wide">
        <div className="tcd-card-head">
          <h2>Admin audit log</h2>
          <span className="tcd-card-timestamp">{auditLogs.length} recent · real-time</span>
        </div>
        <p className="muted small">Impersonation-safe record of destructive and sensitive admin actions (server + client logged).</p>
        <div className="tcd-table-wrap">
          <table className="tcd-admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Admin</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.map((log) => (
                <tr key={log.id}>
                  <td>{timeAgo(log.atMs)}</td>
                  <td>
                    <span className="pill tcd-warn">{ACTION_LABELS[log.action] ?? log.action}</span>
                  </td>
                  <td className="tcd-cell-sub">{log.adminEmail}</td>
                  <td>
                    <div className="tcd-cell-main">{log.targetEmail || log.targetUid.slice(0, 10)}</div>
                    <div className="tcd-cell-sub">{log.targetUid.slice(0, 12)}…</div>
                  </td>
                  <td className="tcd-cell-sub">{log.detail ?? '—'}</td>
                </tr>
              ))}
              {auditLogs.length === 0 && (
                <tr>
                  <td colSpan={5} className="tcd-empty-note">
                    No audit entries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
