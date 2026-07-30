import { useAuth } from '../AuthContext'
import type { TrialInfo } from '../types'

export function TrialExpiredPage({ trialInfo }: { trialInfo: TrialInfo }) {
  const { signOut } = useAuth()
  const isPurged = trialInfo.status === 'purged'

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="eyebrow">SareChild</p>
        <h1>{isPurged ? 'This trial account was removed' : 'Your free trial has ended'}</h1>
        <p className="muted">
          {isPurged
            ? 'This account was inactive for too long during its free trial and, per our trial cleanup policy, the account and its family data were removed to keep things tidy while we validate demand.'
            : 'Your 30-day free trial has finished. Paid plans are coming soon — thanks for trying SareChild!'}
        </p>
        <p className="muted small">
          Questions? Reach out and we can help you start a fresh trial, or sign up for the
          waitlist for paid plans with more history and longer retention.
        </p>
        <button className="btn ghost" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  )
}
