import { useState } from 'react'
import { useAuth } from '../AuthContext'
import { PRIVACY_URL, TERMS_URL } from '../lib/legal'

export function TosGatePage() {
  const { acceptTerms, signOut } = useAuth()
  const [acceptTermsBox, setAcceptTermsBox] = useState(false)
  const [acceptPrivacyBox, setAcceptPrivacyBox] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!acceptTermsBox || !acceptPrivacyBox) {
      setError('Please accept both the Terms of Service and Privacy Policy to continue.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await acceptTerms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your agreement')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card legal-gate">
        <p className="eyebrow">Before you continue</p>
        <h1>Terms &amp; Privacy</h1>
        <p className="muted">
          SareChild is a consent-first parental monitoring product. Please review and accept our
          policies before accessing your dashboard.
        </p>

        <div className="legal-scroll">
          <p>
            By using SareChild you confirm that you are the parent or legal guardian of any child
            device you pair, that you will obtain appropriate consent where required, and that you
            will use monitoring features responsibly and lawfully.
          </p>
          <p>
            Read the full{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Privacy Policy
            </a>{' '}
            before continuing.
          </p>
        </div>

        <label className="legal-check">
          <input
            type="checkbox"
            checked={acceptTermsBox}
            onChange={(e) => setAcceptTermsBox(e.target.checked)}
          />
          <span>I agree to the Terms of Service</span>
        </label>

        <label className="legal-check">
          <input
            type="checkbox"
            checked={acceptPrivacyBox}
            onChange={(e) => setAcceptPrivacyBox(e.target.checked)}
          />
          <span>I agree to the Privacy Policy</span>
        </label>

        {error && <p className="error">{error}</p>}

        <button
          className="btn primary"
          type="button"
          disabled={busy || !acceptTermsBox || !acceptPrivacyBox}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : 'Agree and continue'}
        </button>

        <button className="btn ghost" type="button" disabled={busy} onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  )
}
