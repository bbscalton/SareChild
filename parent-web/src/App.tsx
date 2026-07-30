import { useAuth } from './AuthContext'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="muted">Loading SareChild…</p>
      </div>
    )
  }

  return user ? <DashboardPage /> : <LoginPage />
}
