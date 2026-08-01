import { useAuth } from '../AuthContext'

export function BlockedAccountPage() {
  const { signOut } = useAuth()
  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 480 }}>
        <h1>Account suspended</h1>
        <p className="muted">
          Your SareChild account has been suspended by the project administrator. Contact support if you believe this
          is a mistake.
        </p>
        <button className="btn primary" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  )
}
