import { useState, type FormEvent } from 'react'
import { FirebaseError } from 'firebase/app'
import { useAuth } from '../AuthContext'

export function LoginPage() {
  const { signIn, signUp, signInWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (mode: 'in' | 'up') => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'in') await signIn(email.trim(), password)
      else await signUp(email.trim(), password)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const submitGoogle = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle()
    } catch (e) {
      if (e instanceof FirebaseError && e.code === 'auth/account-exists-with-different-credential') {
        setError('An account already exists with this email using a password. Sign in with your email and password instead.')
      } else {
        setError(e instanceof Error ? e.message : 'Google sign-in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void submit('in')
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit}>
        <p className="eyebrow">SareChild</p>
        <h1>Parent dashboard</h1>
        <p className="muted">
          Sign in with the same account as the Android parent app to monitor
          paired child devices.
        </p>

        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : 'Sign in'}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void submit('up')}
        >
          Create parent account
        </button>

        <p className="muted" style={{ textAlign: 'center', margin: '12px 0 0' }}>
          or
        </p>

        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void submitGoogle()}
        >
          Continue with Google
        </button>
      </form>
    </div>
  )
}
