import { useCallback, useEffect, useState } from 'react'
import * as adminRepo from './adminRepo'
import type { ResellerLedgerEntry, ResellerRow } from './adminRepo'

const DEFAULT_PRICING = {
  plans: {
    15: { days: 15, retailGyd: 2200, label: 'Starter' },
    30: { days: 30, retailGyd: 4000, label: 'Monthly' },
    90: { days: 90, retailGyd: 10800, label: 'Quarterly' },
  },
  gydPerUsd: 209,
  xcdPerUsd: 2.7,
  wholesaleGydPerCreditDay: 110,
}

type Props = {
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string | null) => void
  onError: (msg: string | null) => void
}

function formatMs(ms?: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

export function AdminResellersPanel({ busy, onBusy, onStatus, onError }: Props) {
  const [rows, setRows] = useState<ResellerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [notes, setNotes] = useState('')
  const [selected, setSelected] = useState<ResellerRow | null>(null)
  const [topUpAmount, setTopUpAmount] = useState('300')
  const [topUpNote, setTopUpNote] = useState('')
  const [ledger, setLedger] = useState<ResellerLedgerEntry[]>([])
  const [wholesale, setWholesale] = useState(String(DEFAULT_PRICING.wholesaleGydPerCreditDay))
  const [gyd15, setGyd15] = useState(String(DEFAULT_PRICING.plans[15].retailGyd))
  const [gyd30, setGyd30] = useState(String(DEFAULT_PRICING.plans[30].retailGyd))
  const [gyd90, setGyd90] = useState(String(DEFAULT_PRICING.plans[90].retailGyd))

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await adminRepo.listResellers()
      setRows(list)
      if (selected) {
        const fresh = list.find((r) => r.uid === selected.uid) ?? null
        setSelected(fresh)
      }
      onError(null)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to load resellers')
    } finally {
      setLoading(false)
    }
  }, [onError, selected])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadLedger = async (uid: string) => {
    try {
      const entries = await adminRepo.getResellerLedger(uid)
      setLedger(entries)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to load ledger')
    }
  }

  const activate = async () => {
    if (!email.trim()) {
      onError('Enter the partner email (they must already have signed up).')
      return
    }
    onBusy(true)
    onError(null)
    try {
      const res = await adminRepo.setResellerStatus({
        email: email.trim(),
        status: 'active',
        displayName: displayName.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      onStatus(`Reseller activated: ${res.email}`)
      setEmail('')
      setDisplayName('')
      setNotes('')
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Activate failed')
    } finally {
      onBusy(false)
    }
  }

  const setStatus = async (row: ResellerRow, status: 'active' | 'suspended' | 'pending') => {
    onBusy(true)
    try {
      await adminRepo.setResellerStatus({ uid: row.uid, status })
      onStatus(`${row.email} → ${status}`)
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Status update failed')
    } finally {
      onBusy(false)
    }
  }

  const topUp = async () => {
    if (!selected) return
    const amount = Math.floor(Number(topUpAmount))
    if (!Number.isFinite(amount) || amount === 0) {
      onError('Enter a non-zero credit-day amount.')
      return
    }
    onBusy(true)
    try {
      const balance = await adminRepo.topUpResellerCredits(selected.uid, amount, topUpNote.trim() || undefined)
      onStatus(`Topped up ${amount} credit-days. New balance: ${balance}`)
      setTopUpNote('')
      await refresh()
      await loadLedger(selected.uid)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Top-up failed')
    } finally {
      onBusy(false)
    }
  }

  const savePricing = async () => {
    onBusy(true)
    try {
      await adminRepo.saveResellerPricing({
        ...DEFAULT_PRICING,
        wholesaleGydPerCreditDay: Number(wholesale) || 110,
        plans: {
          15: { days: 15, retailGyd: Number(gyd15) || 2200, label: 'Starter' },
          30: { days: 30, retailGyd: Number(gyd30) || 4000, label: 'Monthly' },
          90: { days: 90, retailGyd: Number(gyd90) || 10800, label: 'Quarterly' },
        },
      })
      onStatus('Reseller pricing saved.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save pricing failed')
    } finally {
      onBusy(false)
    }
  }

  return (
    <section className="tcd-admin-panel">
      <header className="tcd-admin-panel-head">
        <div>
          <h2>Resellers</h2>
          <p className="tcd-acct-section-hint">
            Partners sign up with Google or email like any parent account. Activate them here, top up{' '}
            <strong>credit-days</strong> (1 credit = 1 day of paid service), then they use{' '}
            <a href="./reseller.html" target="_blank" rel="noreferrer">
              reseller.html
            </a>{' '}
            to activate customers or mint vouchers. Separate from live-view minute credits.
          </p>
        </div>
        <button type="button" className="btn btn-ghost-on-dark" disabled={busy || loading} onClick={() => void refresh()}>
          Refresh
        </button>
      </header>

      <div className="tcd-acct-section">
        <h3>Activate reseller</h3>
        <div className="tcd-acct-form-row">
          <label className="tcd-acct-form-label">
            Partner email
            <input
              className="tcd-acct-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="partner@example.com"
            />
          </label>
          <label className="tcd-acct-form-label">
            Display name
            <input
              className="tcd-acct-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional"
            />
          </label>
          <label className="tcd-acct-form-label">
            Notes
            <input className="tcd-acct-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void activate()}>
            Activate
          </button>
        </div>
      </div>

      <div className="tcd-acct-section">
        <h3>Retail pricing (display)</h3>
        <p className="tcd-acct-section-hint">Shown on the reseller portal in GYD / USD / XCD. Credits deducted stay 15 / 30 / 90.</p>
        <div className="tcd-acct-form-row">
          <label className="tcd-acct-form-label">
            15-day GYD
            <input className="tcd-acct-input" value={gyd15} onChange={(e) => setGyd15(e.target.value)} />
          </label>
          <label className="tcd-acct-form-label">
            30-day GYD
            <input className="tcd-acct-input" value={gyd30} onChange={(e) => setGyd30(e.target.value)} />
          </label>
          <label className="tcd-acct-form-label">
            90-day GYD
            <input className="tcd-acct-input" value={gyd90} onChange={(e) => setGyd90(e.target.value)} />
          </label>
          <label className="tcd-acct-form-label">
            Wholesale GYD / credit-day
            <input className="tcd-acct-input" value={wholesale} onChange={(e) => setWholesale(e.target.value)} />
          </label>
          <button type="button" className="btn btn-ghost-on-dark" disabled={busy} onClick={() => void savePricing()}>
            Save pricing
          </button>
        </div>
      </div>

      <div className="tcd-acct-table-wrap">
        <table className="tcd-acct-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Status</th>
              <th>Credits</th>
              <th>Activated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5}>Loading…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5}>No resellers yet — activate a partner email above.</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.uid} className={selected?.uid === row.uid ? 'selected' : undefined}>
                <td>
                  <strong>{row.displayName || row.email}</strong>
                  {row.displayName ? <div className="tcd-acct-meta-sub">{row.email}</div> : null}
                </td>
                <td>
                  <span className={`pill tcd-${row.status === 'active' ? 'ok' : row.status === 'suspended' ? 'fail' : 'warn'}`}>
                    {row.status}
                  </span>
                </td>
                <td>{row.creditBalance}</td>
                <td>{formatMs(row.activatedAtMs)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-ghost-on-dark"
                    disabled={busy}
                    onClick={() => {
                      setSelected(row)
                      void loadLedger(row.uid)
                    }}
                  >
                    Manage
                  </button>
                  {row.status !== 'active' && (
                    <button type="button" className="btn btn-ghost-on-dark" disabled={busy} onClick={() => void setStatus(row, 'active')}>
                      Activate
                    </button>
                  )}
                  {row.status === 'active' && (
                    <button
                      type="button"
                      className="btn btn-ghost-on-dark"
                      disabled={busy}
                      onClick={() => void setStatus(row, 'suspended')}
                    >
                      Suspend
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="tcd-acct-section">
          <h3>
            Manage {selected.email} — balance <strong>{selected.creditBalance}</strong> credit-days
          </h3>
          <div className="tcd-acct-form-row">
            <label className="tcd-acct-form-label">
              Top-up amount (credit-days)
              <input className="tcd-acct-input" value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} />
            </label>
            <label className="tcd-acct-form-label">
              Note
              <input
                className="tcd-acct-input"
                value={topUpNote}
                onChange={(e) => setTopUpNote(e.target.value)}
                placeholder="Bank transfer ref…"
              />
            </label>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void topUp()}>
              Top up
            </button>
          </div>
          <h4>Ledger</h4>
          <ul className="tcd-reseller-ledger">
            {ledger.length === 0 && <li className="muted">No ledger entries yet.</li>}
            {ledger.map((e) => (
              <li key={e.id}>
                <strong>
                  {e.delta > 0 ? '+' : ''}
                  {e.delta}
                </strong>{' '}
                {e.reason} → balance {e.balanceAfter} · {formatMs(e.createdAtMs)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
