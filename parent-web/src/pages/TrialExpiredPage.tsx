import { useState, type FormEvent } from 'react'
import { useAuth } from '../AuthContext'
import * as repo from '../lib/parentRepo'
import type { TrialInfo } from '../types'

export function TrialExpiredPage({ trialInfo }: { trialInfo: TrialInfo }) {
  const { signOut } = useAuth()
  const isPurged = trialInfo.status === 'purged'
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const onRedeem = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setError(null)
    setOkMsg(null)
    try {
      const res = await repo.redeemVoucher(code)
      setOkMsg(
        `Activated ${res.planDays} days — paid until ${new Date(res.paidUntilMs).toLocaleString()}. Reloading…`,
      )
      window.setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not redeem voucher')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="eyebrow">SareChild</p>
        <h1>{isPurged ? 'This trial account was removed' : 'Your access has ended'}</h1>
        <p className="muted">
          {isPurged
            ? 'This account was inactive for too long during its free trial and, per our trial cleanup policy, the account and its family data were removed.'
            : 'Your free trial or paid period has finished. If you bought a voucher from a SareChild reseller, enter it below to reactivate.'}
        </p>

        {!isPurged && (
          <form className="voucher-redeem-form" onSubmit={(e) => void onRedeem(e)}>
            <label>
              Voucher code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SC-XXXX-XXXX-XXXX"
                autoComplete="off"
                disabled={busy}
              />
            </label>
            {error && <p className="error">{error}</p>}
            {okMsg && <p className="muted">{okMsg}</p>}
            <button className="btn" type="submit" disabled={busy || !code.trim()}>
              {busy ? 'Redeeming…' : 'Redeem voucher'}
            </button>
          </form>
        )}

        <p className="muted small">
          Questions? Contact your reseller or SareChild support. Paid plans restore full access for 15, 30, or 90 days.
        </p>
        <button className="btn ghost" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  )
}
