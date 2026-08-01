import { useMemo, useState } from 'react'
import * as adminRepo from './adminRepo'
import { ADMIN_EMAIL } from './admin'
import type { AdminParentAccountRow } from './types'

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
  return new Date(ms).toLocaleDateString()
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

export function AdminAccountsPanel({
  accounts,
  adminEmail,
  busy,
  onBusy,
  onStatus,
  onError,
}: {
  accounts: AdminParentAccountRow[]
  adminEmail: string
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'blocked' | 'at_risk' | 'active'>('all')
  const [creditUid, setCreditUid] = useState<string | null>(null)
  const [creditAmount, setCreditAmount] = useState('5')
  const [trialUid, setTrialUid] = useState<string | null>(null)
  const [trialExtendDays, setTrialExtendDays] = useState('7')
  const [trialPlan, setTrialPlan] = useState<'trial' | 'paid'>('trial')
  const [trialStatus, setTrialStatus] = useState<'active' | 'at_risk' | 'blocked'>('active')
  const [resetTarget, setResetTarget] = useState<AdminParentAccountRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminParentAccountRow | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return accounts.filter((a) => {
      if (statusFilter === 'blocked' && !(a.adminBlocked || a.status === 'blocked')) return false
      if (statusFilter === 'at_risk' && a.status !== 'at_risk') return false
      if (statusFilter === 'active' && (a.adminBlocked || a.status === 'blocked' || a.status === 'purged')) return false
      if (!q) return true
      return a.email.toLowerCase().includes(q) || a.uid.includes(q) || (a.familyId ?? '').includes(q)
    })
  }, [accounts, query, statusFilter])

  const runBlock = async (row: AdminParentAccountRow) => {
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

  const runUnblock = async (row: AdminParentAccountRow) => {
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

  const runGrantCredits = async (uid: string) => {
    const add = Number(creditAmount)
    if (!Number.isFinite(add) || add <= 0) {
      onError('Enter a positive credit amount.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      await adminRepo.grantLiveViewCredits(uid, { addCredits: add, bonusCredits: add })
      onStatus(`Granted ${add} live-view credit(s).`)
      setCreditUid(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Grant credits failed')
    } finally {
      onBusy(false)
    }
  }

  const runAdjustTrial = async (uid: string) => {
    const extendDays = Number(trialExtendDays)
    onBusy(true)
    onError(null)
    try {
      await adminRepo.adminAdjustTrial(uid, {
        plan: trialPlan,
        status: trialStatus,
        extendDays: Number.isFinite(extendDays) && extendDays > 0 ? extendDays : undefined,
      })
      onStatus(`Trial updated for ${uid.slice(0, 8)}…`)
      setTrialUid(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Trial update failed')
    } finally {
      onBusy(false)
    }
  }

  const runRevoke = async (row: AdminParentAccountRow) => {
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

  const runReset = async (row: AdminParentAccountRow, selfConfirm: boolean) => {
    onBusy(true)
    onError(null)
    try {
      const result = await adminRepo.adminWipeUser(row.uid, selfConfirm)
      onStatus(`Reset ${row.email || row.uid}. New family ${result.newFamilyId.slice(0, 10)}… — user can sign in fresh.`)
      setResetTarget(null)
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

  return (
    <>
      <div className="tcd-card tcd-card-wide">
        <div className="tcd-card-head">
          <h2>Account management</h2>
          <span className="tcd-card-timestamp">{accounts.length} profiles · real-time</span>
        </div>

        <div className="tcd-admin-toolbar">
          <input
            type="search"
            placeholder="Search email, uid, familyId…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="tcd-admin-search"
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="tcd-admin-select">
            <option value="all">All accounts</option>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
            <option value="at_risk">At risk</option>
          </select>
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={exportCsv}>
            Export CSV
          </button>
        </div>

        <p className="muted small" style={{ marginBottom: '0.75rem' }}>
          <strong>Reset</strong> wipes family data and gives a fresh empty family (Auth kept).{' '}
          <strong>Delete</strong> removes Auth + profile + all data permanently.
        </p>

        <div className="tcd-table-wrap">
          <table className="tcd-admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Registered</th>
                <th>Last active</th>
                <th>Plan / trial</th>
                <th>Family</th>
                <th>Devices</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const blocked = row.adminBlocked || row.status === 'blocked'
                const isSelf = adminRepo.isSelfAdminAccount(row.email, adminEmail)
                const daysLeft =
                  row.trialEndsAt && row.plan === 'trial'
                    ? Math.max(0, Math.ceil((row.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
                    : null
                return (
                  <tr key={row.uid} className={blocked ? 'row-blocked' : isSelf ? 'row-admin-self' : ''}>
                    <td>
                      <div className="tcd-cell-main">
                        {row.email || row.uid.slice(0, 10)}
                        {isSelf && <span className="pill tcd-warn" style={{ marginLeft: '0.35rem' }}>YOU</span>}
                      </div>
                      <div className="tcd-cell-sub">{row.uid.slice(0, 12)}…</div>
                    </td>
                    <td>{fmtDate(row.registeredAt)}</td>
                    <td>{row.lastActiveAt ? timeAgo(row.lastActiveAt) : '—'}</td>
                    <td>
                      {row.plan ?? '—'}
                      {daysLeft != null && <span className="tcd-cell-sub"> · {daysLeft}d left</span>}
                      {row.status === 'at_risk' && <span className="pill tcd-warn">AT RISK</span>}
                      {row.status === 'purged' && <span className="pill tcd-fail">PURGED</span>}
                    </td>
                    <td className="tcd-cell-mono">{row.familyId?.slice(0, 10) ?? '—'}</td>
                    <td>{row.deviceCount ?? '—'}</td>
                    <td>
                      {blocked ? (
                        <span className="pill tcd-fail">BLOCKED</span>
                      ) : (
                        <span className="pill tcd-ok">{row.status ?? 'active'}</span>
                      )}
                    </td>
                    <td>
                      <div className="tcd-row-actions tcd-row-actions-wrap">
                        {blocked ? (
                          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runUnblock(row)}>
                            Unblock
                          </button>
                        ) : (
                          <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => void runBlock(row)}>
                            Block
                          </button>
                        )}
                        <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => setCreditUid(row.uid)}>
                          Credits
                        </button>
                        <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => setTrialUid(row.uid)}>
                          Trial
                        </button>
                        <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void runRevoke(row)}>
                          Sign out
                        </button>
                        <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => setResetTarget(row)}>
                          Reset
                        </button>
                        <button className="btn btn-ghost compact danger" type="button" disabled={busy} onClick={() => setDeleteTarget(row)}>
                          Delete
                        </button>
                      </div>
                      {creditUid === row.uid && (
                        <div className="tcd-inline-form">
                          <input
                            type="number"
                            min={1}
                            max={99}
                            value={creditAmount}
                            onChange={(e) => setCreditAmount(e.target.value)}
                            className="tcd-admin-input-sm"
                          />
                          <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void runGrantCredits(row.uid)}>
                            Grant
                          </button>
                          <button className="btn btn-ghost compact" type="button" onClick={() => setCreditUid(null)}>
                            Cancel
                          </button>
                        </div>
                      )}
                      {trialUid === row.uid && (
                        <div className="tcd-inline-form tcd-inline-form-wrap">
                          <select value={trialPlan} onChange={(e) => setTrialPlan(e.target.value as typeof trialPlan)} className="tcd-admin-select">
                            <option value="trial">trial</option>
                            <option value="paid">paid</option>
                          </select>
                          <select value={trialStatus} onChange={(e) => setTrialStatus(e.target.value as typeof trialStatus)} className="tcd-admin-select">
                            <option value="active">active</option>
                            <option value="at_risk">at_risk</option>
                            <option value="blocked">blocked</option>
                          </select>
                          <input
                            type="number"
                            min={0}
                            max={365}
                            placeholder="+days"
                            value={trialExtendDays}
                            onChange={(e) => setTrialExtendDays(e.target.value)}
                            className="tcd-admin-input-sm"
                          />
                          <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void runAdjustTrial(row.uid)}>
                            Apply
                          </button>
                          <button className="btn btn-ghost compact" type="button" onClick={() => setTrialUid(null)}>
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="tcd-empty-note">
                    No accounts match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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
