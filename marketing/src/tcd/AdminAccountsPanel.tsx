import { useEffect, useMemo, useState } from 'react'
import * as adminRepo from './adminRepo'
import { ADMIN_EMAIL } from './admin'
import { FEATURE_KEYS, FEATURE_LABELS, type AdminParentAccountRow, type FeatureKey, type LiveViewQuotaAdmin } from './types'

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

function fmtDate(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function initials(email: string, uid: string): string {
  const base = (email.split('@')[0] || uid).trim()
  if (base.length >= 2) return base.slice(0, 2).toUpperCase()
  return base.slice(0, 1).toUpperCase() || '?'
}

function accountBlocked(row: AdminParentAccountRow): boolean {
  return row.adminBlocked || row.status === 'blocked'
}

function statusTone(row: AdminParentAccountRow): 'blocked' | 'at_risk' | 'purged' | 'active' {
  if (accountBlocked(row)) return 'blocked'
  if (row.status === 'at_risk') return 'at_risk'
  if (row.status === 'purged') return 'purged'
  return 'active'
}

type ConfirmModalProps = {
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  fields: Array<{ key: string; label: string; placeholder: string; expected?: string }>
  onCancel: () => void
  onConfirm: (values: Record<string, string>, selfConfirm: boolean) => void
  isSelf: boolean
}

function ConfirmModal({ title, description, confirmLabel, busy, fields, onCancel, onConfirm, isSelf }: ConfirmModalProps) {
  const [values, setValues] = useState<Record<string, string>>({})

  const valid = fields.every((f) => {
    const v = (values[f.key] ?? '').trim()
    if (!v) return false
    if (f.expected != null && v !== f.expected) return false
    return true
  })

  const selfConfirmOk = !isSelf || (values.selfConfirm ?? '').trim().toUpperCase() === 'CONFIRM-SELF'

  return (
    <div className="tcd-modal-backdrop" role="presentation" onClick={onCancel}>
      <div className="tcd-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="muted small">{description}</p>
        {isSelf && (
          <p className="tcd-banner warn" style={{ marginBottom: '0.75rem' }}>
            You are acting on your own admin account ({ADMIN_EMAIL}). Type <strong>CONFIRM-SELF</strong> below.
          </p>
        )}
        <div className="tcd-form-grid">
          {fields.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="text"
                autoComplete="off"
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          {isSelf && (
            <label>
              Self-confirm
              <input
                type="text"
                autoComplete="off"
                placeholder="CONFIRM-SELF"
                value={values.selfConfirm ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, selfConfirm: e.target.value }))}
              />
            </label>
          )}
        </div>
        <div className="tcd-modal-actions">
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary compact danger"
            type="button"
            disabled={busy || !valid || !selfConfirmOk}
            onClick={() => onConfirm(values, isSelf && selfConfirmOk)}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ row }: { row: AdminParentAccountRow }) {
  const tone = statusTone(row)
  const labels: Record<typeof tone, string> = {
    blocked: 'Blocked',
    at_risk: 'At risk',
    purged: 'Purged',
    active: row.status ?? 'Active',
  }
  return <span className={`tcd-acct-pill tone-${tone}`}>{labels[tone]}</span>
}

type AccountDrawerProps = {
  row: AdminParentAccountRow
  adminEmail: string
  busy: boolean
  onClose: () => void
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
  onReset: (row: AdminParentAccountRow) => void
  onDelete: (row: AdminParentAccountRow) => void
}

function AccountDrawer({
  row,
  adminEmail,
  busy,
  onClose,
  onBusy,
  onStatus,
  onError,
  onReset,
  onDelete,
}: AccountDrawerProps) {
  const blocked = accountBlocked(row)
  const isSelf = adminRepo.isSelfAdminAccount(row.email, adminEmail)
  const daysLeft =
    row.trialEndsAt && row.plan === 'trial'
      ? Math.max(0, Math.ceil((row.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
      : null

  const [quota, setQuota] = useState<LiveViewQuotaAdmin | null>(null)
  const [retentionCurrent, setRetentionCurrent] = useState<number | null>(null)
  const [overrides, setOverrides] = useState<Partial<Record<FeatureKey, boolean>> | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)

  const [creditAmount, setCreditAmount] = useState('5')
  const [trialExtendDays, setTrialExtendDays] = useState('7')
  const [trialPlan, setTrialPlan] = useState<'trial' | 'paid'>((row.plan as 'trial' | 'paid') ?? 'trial')
  const [trialStatus, setTrialStatus] = useState<'active' | 'at_risk' | 'blocked'>(
    row.status === 'at_risk' ? 'at_risk' : row.status === 'blocked' ? 'blocked' : 'active',
  )
  const [retentionDays, setRetentionDays] = useState('2')
  const [chatVideoSecondsCurrent, setChatVideoSecondsCurrent] = useState<number | null>(null)
  const [chatVideoSeconds, setChatVideoSeconds] = useState('180')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setDetailLoading(true)
    setQuota(null)
    setRetentionCurrent(null)
    setOverrides(null)
    setRetentionDays('2')
    setChatVideoSecondsCurrent(null)
    setChatVideoSeconds('180')

    void (async () => {
      try {
        const [q, ov] = await Promise.all([
          adminRepo.loadLiveViewQuota(row.uid),
          adminRepo.loadFeatureOverrides(row.uid),
        ])
        if (cancelled) return
        setQuota(q)
        setOverrides(ov)
        if (row.familyId) {
          const [days, chatSecs] = await Promise.all([
            adminRepo.loadFamilyRetentionDays(row.familyId),
            adminRepo.loadFamilyMaxChatVideoSeconds(row.familyId),
          ])
          if (!cancelled) {
            setRetentionCurrent(days)
            setRetentionDays(String(days))
            setChatVideoSecondsCurrent(chatSecs)
            setChatVideoSeconds(String(chatSecs))
          }
        }
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : 'Could not load account details')
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [row.uid, row.familyId, onError])

  const overrideSummary = useMemo(() => {
    if (!overrides) return null
    const entries = FEATURE_KEYS.filter((k) => overrides[k] != null)
    if (entries.length === 0) return 'None — inherits global defaults'
    return entries.map((k) => `${FEATURE_LABELS[k]}: ${overrides[k] ? 'on' : 'off'}`).join(' · ')
  }, [overrides])

  const runBlock = async () => {
    if (!window.confirm(`Block ${row.email || row.uid}? They will be signed out and denied family access.`)) return
    onBusy(true)
    onError(null)
    try {
      await adminRepo.blockAccount(row.uid)
      onStatus(`Blocked ${row.email || row.uid}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Block failed')
    } finally {
      onBusy(false)
    }
  }

  const runUnblock = async () => {
    onBusy(true)
    onError(null)
    try {
      await adminRepo.unblockAccount(row.uid)
      onStatus(`Unblocked ${row.email || row.uid}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Unblock failed')
    } finally {
      onBusy(false)
    }
  }

  const runGrantCredits = async () => {
    const add = Number(creditAmount)
    if (!Number.isFinite(add) || add <= 0) {
      onError('Enter a positive credit amount.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      await adminRepo.grantLiveViewCredits(row.uid, { addCredits: add, bonusCredits: add })
      onStatus(`Granted ${add} live-view credit(s).`)
      const q = await adminRepo.loadLiveViewQuota(row.uid)
      setQuota(q)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Grant credits failed')
    } finally {
      onBusy(false)
    }
  }

  const runAdjustTrial = async () => {
    const extendDays = Number(trialExtendDays)
    onBusy(true)
    onError(null)
    try {
      await adminRepo.adminAdjustTrial(row.uid, {
        plan: trialPlan,
        status: trialStatus,
        extendDays: Number.isFinite(extendDays) && extendDays > 0 ? extendDays : undefined,
      })
      onStatus(`Trial updated for ${row.email || row.uid}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Trial update failed')
    } finally {
      onBusy(false)
    }
  }

  const runAdjustRetention = async () => {
    const days = Number(retentionDays)
    if (!row.familyId) {
      onError('Account has no familyId.')
      return
    }
    if (!Number.isFinite(days) || days < 2 || days > 90) {
      onError('Retention must be between 2 and 90 days.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminSetRetention(row.uid, days)
      onStatus(`Retention set to ${result.retentionDays} day(s) for family ${result.familyId.slice(0, 10)}…`)
      setRetentionCurrent(result.retentionDays)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Retention update failed')
    } finally {
      onBusy(false)
    }
  }

  const runAdjustChatVideoLimit = async () => {
    const seconds = Number(chatVideoSeconds)
    if (!row.familyId) {
      onError('Account has no familyId.')
      return
    }
    if (!Number.isFinite(seconds) || seconds < 30 || seconds > 600) {
      onError('Chat video length must be between 30 and 600 seconds.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminSetChatVideoLimit(row.uid, seconds)
      onStatus(`Chat video length set to ${result.maxChatVideoSeconds}s for family ${result.familyId.slice(0, 10)}…`)
      setChatVideoSecondsCurrent(result.maxChatVideoSeconds)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Chat video length update failed')
    } finally {
      onBusy(false)
    }
  }

  const runRevoke = async () => {
    if (!window.confirm(`Force sign-out ${row.email || row.uid}? Revokes refresh tokens and clears FCM.`)) return
    onBusy(true)
    onError(null)
    try {
      await adminRepo.adminRevokeSessions(row.uid)
      onStatus(`Revoked sessions for ${row.email || row.uid}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Revoke failed')
    } finally {
      onBusy(false)
    }
  }

  return (
    <>
      <div className="tcd-acct-drawer-backdrop" role="presentation" onClick={onClose} />
      <aside className="tcd-acct-drawer is-open" role="dialog" aria-modal="true" aria-label={`Manage ${row.email || row.uid}`}>
        <header className="tcd-acct-drawer-head">
          <div className="tcd-acct-drawer-identity">
            <div className="tcd-acct-avatar" aria-hidden="true">
              {initials(row.email, row.uid)}
            </div>
            <div>
              <div className="tcd-acct-drawer-email">
                {row.email || row.uid}
                {isSelf && <span className="tcd-acct-you-badge">YOU</span>}
              </div>
              <StatusPill row={row} />
            </div>
          </div>
          <button className="tcd-acct-drawer-close" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="tcd-acct-drawer-body">
          <dl className="tcd-acct-meta-grid">
            <div>
              <dt>UID</dt>
              <dd className="tcd-cell-mono">{row.uid}</dd>
            </div>
            <div>
              <dt>Family ID</dt>
              <dd className="tcd-cell-mono">{row.familyId ?? '—'}</dd>
            </div>
            <div>
              <dt>Registered</dt>
              <dd>{fmtDate(row.registeredAt)}</dd>
            </div>
            <div>
              <dt>Last active</dt>
              <dd>{row.lastActiveAt ? timeAgo(row.lastActiveAt) : '—'}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>
                {row.plan ?? '—'}
                {daysLeft != null && <span className="tcd-acct-meta-sub"> · {daysLeft}d trial left</span>}
              </dd>
            </div>
            <div>
              <dt>Devices</dt>
              <dd>{row.deviceCount ?? '—'}</dd>
            </div>
          </dl>

          <div className="tcd-acct-detail-strip">
            <div className="tcd-acct-detail-chip">
              <span className="tcd-acct-detail-label">Live-view credits</span>
              <span className="tcd-acct-detail-value">
                {detailLoading ? '…' : quota ? `${quota.creditsRemaining} / ${quota.dailyAllowance} daily` : 'Not provisioned'}
              </span>
            </div>
            <div className="tcd-acct-detail-chip">
              <span className="tcd-acct-detail-label">Retention</span>
              <span className="tcd-acct-detail-value">
                {detailLoading ? '…' : retentionCurrent != null ? `${retentionCurrent} days` : row.familyId ? '—' : 'No family'}
              </span>
            </div>
            <div className="tcd-acct-detail-chip">
              <span className="tcd-acct-detail-label">Chat video cap</span>
              <span className="tcd-acct-detail-value">
                {detailLoading
                  ? '…'
                  : chatVideoSecondsCurrent != null
                    ? `${chatVideoSecondsCurrent}s`
                    : row.familyId
                      ? '—'
                      : 'No family'}
              </span>
            </div>
            <div className="tcd-acct-detail-chip tcd-acct-detail-chip-wide">
              <span className="tcd-acct-detail-label">Feature overrides</span>
              <span className="tcd-acct-detail-value tcd-acct-detail-value-sm">
                {detailLoading ? '…' : overrideSummary}
              </span>
            </div>
          </div>

          <section className="tcd-acct-drawer-section">
            <h3>Access</h3>
            <p className="tcd-acct-section-hint">Session and account access controls.</p>
            <div className="tcd-acct-action-row">
              {blocked ? (
                <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runUnblock()}>
                  Unblock account
                </button>
              ) : (
                <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => void runBlock()}>
                  Block account
                </button>
              )}
              <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runRevoke()}>
                Force sign out
              </button>
            </div>
          </section>

          <section className="tcd-acct-drawer-section">
            <h3>Plan &amp; quotas</h3>
            <p className="tcd-acct-section-hint">Trial, live-view credits, and data retention.</p>

            <div className="tcd-acct-form-block">
              <label className="tcd-acct-form-label">Grant live-view credits</label>
              <div className="tcd-acct-form-row">
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                  className="tcd-acct-input"
                />
                <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void runGrantCredits()}>
                  Grant credits
                </button>
              </div>
            </div>

            <div className="tcd-acct-form-block">
              <label className="tcd-acct-form-label">Adjust trial</label>
              <div className="tcd-acct-form-grid">
                <select value={trialPlan} onChange={(e) => setTrialPlan(e.target.value as typeof trialPlan)} className="tcd-acct-input">
                  <option value="trial">Trial plan</option>
                  <option value="paid">Paid plan</option>
                </select>
                <select value={trialStatus} onChange={(e) => setTrialStatus(e.target.value as typeof trialStatus)} className="tcd-acct-input">
                  <option value="active">Active</option>
                  <option value="at_risk">At risk</option>
                  <option value="blocked">Blocked</option>
                </select>
                <input
                  type="number"
                  min={0}
                  max={365}
                  placeholder="Extend days"
                  value={trialExtendDays}
                  onChange={(e) => setTrialExtendDays(e.target.value)}
                  className="tcd-acct-input"
                />
                <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void runAdjustTrial()}>
                  Apply trial
                </button>
              </div>
            </div>

            <div className="tcd-acct-form-block">
              <label className="tcd-acct-form-label">
                Operational retention
                {retentionCurrent != null && <span className="tcd-acct-form-hint">Current: {retentionCurrent} days</span>}
              </label>
              <div className="tcd-acct-form-row">
                <input
                  type="number"
                  min={2}
                  max={90}
                  placeholder="Days (2–90)"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  className="tcd-acct-input"
                  disabled={!row.familyId}
                />
                <button
                  className="btn btn-primary compact"
                  type="button"
                  disabled={busy || !row.familyId}
                  onClick={() => void runAdjustRetention()}
                >
                  Set retention
                </button>
              </div>
            </div>

            <div className="tcd-acct-form-block">
              <label className="tcd-acct-form-label">
                Max chat video length
                {chatVideoSecondsCurrent != null && (
                  <span className="tcd-acct-form-hint">Current: {chatVideoSecondsCurrent}s</span>
                )}
              </label>
              <div className="tcd-acct-form-row">
                <input
                  type="number"
                  min={30}
                  max={600}
                  placeholder="Seconds (30–600)"
                  value={chatVideoSeconds}
                  onChange={(e) => setChatVideoSeconds(e.target.value)}
                  className="tcd-acct-input"
                  disabled={!row.familyId}
                />
                <button
                  className="btn btn-primary compact"
                  type="button"
                  disabled={busy || !row.familyId}
                  onClick={() => void runAdjustChatVideoLimit()}
                >
                  Set video limit
                </button>
              </div>
              <p className="tcd-acct-section-hint">
                Child devices offer 1/2/3 minute video-note options, clamped to this family's cap.
              </p>
            </div>
          </section>

          <section className="tcd-acct-drawer-section tcd-acct-drawer-danger">
            <h3>Danger zone</h3>
            <p className="tcd-acct-section-hint">
              <strong>Reset</strong> wipes family data and gives a fresh empty family (Auth kept).{' '}
              <strong>Delete</strong> removes Auth + profile + all data permanently.
            </p>
            <div className="tcd-acct-action-row">
              <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => onReset(row)}>
                Reset account
              </button>
              <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => onDelete(row)}>
                Delete permanently
              </button>
            </div>
          </section>
        </div>
      </aside>
    </>
  )
}

export function AdminAccountsPanel({
  accounts,
  adminEmail,
  busy,
  onBusy,
  onStatus,
  onError,
  onlineDevices,
}: {
  accounts: AdminParentAccountRow[]
  adminEmail: string
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
  onlineDevices?: number | null
}) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'blocked' | 'at_risk' | 'active'>('all')
  const [selected, setSelected] = useState<AdminParentAccountRow | null>(null)
  const [resetTarget, setResetTarget] = useState<AdminParentAccountRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminParentAccountRow | null>(null)
  const [defaultRetentionDays, setDefaultRetentionDays] = useState(2)

  useEffect(() => {
    return adminRepo.observeAdminFeatures(
      (cfg) => setDefaultRetentionDays(cfg.defaultRetentionDays),
      () => {},
    )
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return accounts.filter((a) => {
      if (statusFilter === 'blocked' && !accountBlocked(a)) return false
      if (statusFilter === 'at_risk' && a.status !== 'at_risk') return false
      if (statusFilter === 'active' && (accountBlocked(a) || a.status === 'purged')) return false
      if (!q) return true
      return a.email.toLowerCase().includes(q) || a.uid.includes(q) || (a.familyId ?? '').includes(q)
    })
  }, [accounts, query, statusFilter])

  const stats = useMemo(() => {
    const blocked = accounts.filter((a) => accountBlocked(a)).length
    const atRisk = accounts.filter((a) => a.status === 'at_risk' && !accountBlocked(a)).length
    const active = accounts.filter((a) => !accountBlocked(a) && a.status !== 'purged').length
    const totalDevices = accounts.reduce((sum, a) => sum + (a.deviceCount ?? 0), 0)
    return { total: accounts.length, active, blocked, atRisk, totalDevices }
  }, [accounts])

  const selectedLive = selected ? accounts.find((a) => a.uid === selected.uid) ?? selected : null

  const runReset = async (row: AdminParentAccountRow, selfConfirm: boolean) => {
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminWipeUser(row.uid, selfConfirm)
      onStatus(`Reset ${row.email || row.uid}. New family ${result.newFamilyId.slice(0, 10)}… — user can sign in fresh.`)
      setResetTarget(null)
      if (selected?.uid === row.uid) setSelected(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      onBusy(false)
    }
  }

  const runDelete = async (row: AdminParentAccountRow, selfConfirm: boolean) => {
    onBusy(true)
    onError(null)
    try {
      await adminRepo.adminDeleteUser(row.uid, selfConfirm)
      onStatus(`Deleted ${row.email || row.uid} and all data.`)
      setDeleteTarget(null)
      if (selected?.uid === row.uid) setSelected(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      onBusy(false)
    }
  }

  const exportCsv = () => {
    adminRepo.downloadCsv(`sarechild-accounts-${new Date().toISOString().slice(0, 10)}.csv`, adminRepo.exportAccountsCsv(filtered))
    onStatus(`Exported ${filtered.length} account(s) to CSV.`)
  }

  const openManage = (row: AdminParentAccountRow) => {
    setSelected(row)
    onError(null)
  }

  return (
    <>
      <div className="tcd-card tcd-card-wide tcd-acct-card">
        <div className="tcd-card-head tcd-acct-card-head">
          <div>
            <h2>Account management</h2>
            <p className="tcd-acct-card-sub">Parent profiles · real-time sync</p>
          </div>
          <span className="tcd-card-timestamp">{accounts.length} profiles</span>
        </div>

        <div className="tcd-acct-summary">
          <div className="tcd-acct-stat-card">
            <span className="tcd-acct-stat-value">{stats.total}</span>
            <span className="tcd-acct-stat-label">Total accounts</span>
          </div>
          <div className="tcd-acct-stat-card">
            <span className="tcd-acct-stat-value ok">{stats.active}</span>
            <span className="tcd-acct-stat-label">Active</span>
          </div>
          <div className="tcd-acct-stat-card">
            <span className="tcd-acct-stat-value fail">{stats.blocked}</span>
            <span className="tcd-acct-stat-label">Blocked</span>
          </div>
          <div className="tcd-acct-stat-card">
            <span className="tcd-acct-stat-value warn">{stats.atRisk}</span>
            <span className="tcd-acct-stat-label">At risk</span>
          </div>
          <div className="tcd-acct-stat-card">
            <span className="tcd-acct-stat-value">
              {onlineDevices != null ? onlineDevices : stats.totalDevices}
            </span>
            <span className="tcd-acct-stat-label">
              {onlineDevices != null ? 'Devices online' : 'Registered devices'}
            </span>
          </div>
          <div className="tcd-acct-stat-card">
            <span className="tcd-acct-stat-value">{defaultRetentionDays}d</span>
            <span className="tcd-acct-stat-label">Default retention</span>
          </div>
        </div>

        <div className="tcd-admin-toolbar tcd-acct-toolbar">
          <input
            type="search"
            placeholder="Search email, uid, familyId…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="tcd-admin-search tcd-acct-search"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="tcd-admin-select tcd-acct-select"
          >
            <option value="all">All accounts</option>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
            <option value="at_risk">At risk</option>
          </select>
          <button className="btn btn-ghost compact tcd-acct-export" type="button" disabled={busy} onClick={exportCsv}>
            Export CSV
          </button>
        </div>

        <div className="tcd-acct-table-wrap">
          <table className="tcd-acct-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Activity</th>
                <th>Plan</th>
                <th>Devices</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const blocked = accountBlocked(row)
                const isSelf = adminRepo.isSelfAdminAccount(row.email, adminEmail)
                const daysLeft =
                  row.trialEndsAt && row.plan === 'trial'
                    ? Math.max(0, Math.ceil((row.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
                    : null
                const isSelected = selected?.uid === row.uid
                return (
                  <tr
                    key={row.uid}
                    className={[
                      blocked ? 'row-blocked' : '',
                      isSelf ? 'row-admin-self' : '',
                      isSelected ? 'row-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td>
                      <div className="tcd-acct-email-cell">
                        <span className="tcd-acct-row-avatar" aria-hidden="true">
                          {initials(row.email, row.uid)}
                        </span>
                        <div>
                          <div className="tcd-cell-main">
                            {row.email || row.uid.slice(0, 12)}
                            {isSelf && <span className="tcd-acct-you-badge">YOU</span>}
                          </div>
                          <div className="tcd-cell-sub tcd-cell-mono">{row.uid.slice(0, 14)}…</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="tcd-acct-activity">
                        <span>{row.lastActiveAt ? timeAgo(row.lastActiveAt) : '—'}</span>
                        <span className="tcd-cell-sub">Joined {fmtDate(row.registeredAt)}</span>
                      </div>
                    </td>
                    <td>
                      <div className="tcd-acct-plan">
                        <span>{row.plan ?? '—'}</span>
                        {daysLeft != null && <span className="tcd-cell-sub">{daysLeft}d left</span>}
                      </div>
                    </td>
                    <td>
                      <span className="tcd-acct-device-count">{row.deviceCount ?? '—'}</span>
                    </td>
                    <td>
                      <StatusPill row={row} />
                    </td>
                    <td className="tcd-acct-actions-col">
                      <button
                        className="btn btn-ghost compact tcd-acct-manage-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => openManage(row)}
                        aria-label={`Manage ${row.email || row.uid}`}
                      >
                        Manage
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {filtered.length === 0 && (
            <div className="tcd-acct-empty">
              <p className="tcd-acct-empty-title">No accounts match</p>
              <p className="tcd-acct-empty-sub">
                {query.trim() || statusFilter !== 'all'
                  ? 'Try clearing filters or broadening your search.'
                  : 'Parent profiles will appear here once registered.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {selectedLive && (
        <AccountDrawer
          row={selectedLive}
          adminEmail={adminEmail}
          busy={busy}
          onClose={() => setSelected(null)}
          onBusy={onBusy}
          onStatus={onStatus}
          onError={onError}
          onReset={(row) => {
            setSelected(null)
            setResetTarget(row)
          }}
          onDelete={(row) => {
            setSelected(null)
            setDeleteTarget(row)
          }}
        />
      )}

      {resetTarget && (
        <ConfirmModal
          title="Reset account (keep Auth)"
          description={`Wipes all family data for ${resetTarget.email || resetTarget.uid}, creates a new empty family, resets trial & live-view quota, and revokes active sessions. Email, uid, and TOS acceptance are kept.`}
          confirmLabel="Reset account"
          busy={busy}
          isSelf={adminRepo.isSelfAdminAccount(resetTarget.email, adminEmail)}
          fields={[{ key: 'email', label: 'Type account email to confirm', placeholder: resetTarget.email || resetTarget.uid, expected: resetTarget.email || resetTarget.uid }]}
          onCancel={() => setResetTarget(null)}
          onConfirm={(_values, selfConfirm) => void runReset(resetTarget, selfConfirm)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete account + all data"
          description={`Permanently deletes Firebase Auth, parentProfiles, owned family, and all subcollections for ${deleteTarget.email || deleteTarget.uid}. This cannot be undone.`}
          confirmLabel="Delete permanently"
          busy={busy}
          isSelf={adminRepo.isSelfAdminAccount(deleteTarget.email, adminEmail)}
          fields={[
            { key: 'deleteWord', label: 'Type DELETE', placeholder: 'DELETE', expected: 'DELETE' },
            {
              key: 'email',
              label: 'Type account email',
              placeholder: deleteTarget.email || deleteTarget.uid,
              expected: deleteTarget.email || deleteTarget.uid,
            },
          ]}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(_values, selfConfirm) => void runDelete(deleteTarget, selfConfirm)}
        />
      )}
    </>
  )
}
