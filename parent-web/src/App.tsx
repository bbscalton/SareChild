import { useAuth } from './AuthContext'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { TrialExpiredPage } from './pages/TrialExpiredPage'

export default function App() {
  const { user, loading, trialInfo } = useAuth()

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Loading SareChild…</p>
      </div>
    )
  }

  if (!user) return <LoginPage />

  // Full features while status === "active" and the trial window hasn't elapsed yet.
  // `trialInfo` briefly being null right after sign-in (profile still loading) is
  // treated as active so the dashboard doesn't flash an expired screen.
  const now = Date.now()
  const blocked =
    trialInfo != null &&
    (trialInfo.status === 'purged' ||
      (trialInfo.plan === 'trial' && trialInfo.trialEndsAt > 0 && now > trialInfo.trialEndsAt))

  if (blocked && trialInfo) return <TrialExpiredPage trialInfo={trialInfo} />

  return <DashboardPage />
}
