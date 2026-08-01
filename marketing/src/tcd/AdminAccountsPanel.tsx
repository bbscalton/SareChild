import { useMemo, useState } from 'react'
import * as adminRepo from './adminRepo'
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

export function AdminAccountsPanel({
  accounts,
  busy,
  onBusy,
  onStatus,
  onError,
}: {
  accounts: AdminParentAccountRow[]
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'blocked' | 'at_risk' | 'active'>('all')
  const [creditUid, setCreditUid] = useState<string | null>(null)
  const [creditAmount, setCreditAmount] = useState('5')

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

  return (
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
      </div>

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
              const daysLeft =
                row.trialEndsAt && row.plan === 'trial'
                  ? Math.max(0, Math.ceil((row.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
                  : null
              return (
                <tr key={row.uid} className={blocked ? 'row-blocked' : ''}>
                  <td>
                    <div className="tcd-cell-main">{row.email || row.uid.slice(0, 10)}</div>
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
                    <div className="tcd-row-actions">
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
  )
}
