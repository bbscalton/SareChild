import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { FirebaseError } from 'firebase/app'
import { useAuth } from '../AuthContext'
import { PRIVACY_URL, TERMS_URL } from '../lib/legal'

export function RegisterPage() {
  const { signUp, signInWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptPrivacy, setAcceptPrivacy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (!acceptTerms || !acceptPrivacy) {
      setError('Please accept the Terms of Service and Privacy Policy.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signUp(email.trim(), password, acceptTerms && acceptPrivacy)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setBusy(false)
    }
  }

  const submitGoogle = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle()
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'auth/account-exists-with-different-credential') {
        setError('An account already exists with this email using a password. Sign in instead.')
      } else {
        setError(err instanceof Error ? err.message : 'Google sign-in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <p className="eyebrow">SareChild</p>
        <h1>Create parent account</h1>
        <p className="muted">
          Register to pair your own child devices. Each account gets a private family space.
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </label>

        <label>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={6}
          />
        </label>

        <label className="legal-check">
          <input
            type="checkbox"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
          />
          <span>
            I agree to the{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms of Service
            </a>
          </span>
        </label>

        <label className="legal-check">
          <input
            type="checkbox"
            checked={acceptPrivacy}
            onChange={(e) => setAcceptPrivacy(e.target.checked)}
          />
          <span>
            I agree to the{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
          </span>
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
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

        <p className="muted small" style={{ textAlign: 'center', marginTop: '1rem' }}>
          Already registered? <Link to="/">Sign in</Link>
        </p>
      </form>
    </div>
  )
}
