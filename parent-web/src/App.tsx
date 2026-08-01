import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { TosGatePage } from './pages/TosGatePage'
import { DashboardPage } from './pages/DashboardPage'
import { TrialExpiredPage } from './pages/TrialExpiredPage'

function AuthedApp() {
  const { user, loading, trialInfo, needsTerms } = useAuth()

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Loading SareChild…</p>
      </div>
    )
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    )
  }

  if (needsTerms) return <TosGatePage />

  const now = Date.now()
  const blocked =
    trialInfo != null &&
    (trialInfo.status === 'purged' ||
      (trialInfo.plan === 'trial' && trialInfo.trialEndsAt > 0 && now > trialInfo.trialEndsAt))

  if (blocked && trialInfo) return <TrialExpiredPage trialInfo={trialInfo} />

  return (
    <Routes>
      <Route path="*" element={<DashboardPage />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthedApp />
    </BrowserRouter>
  )
}
