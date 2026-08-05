import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { FirebaseError } from 'firebase/app'
import { useAuth } from '../tcd/authContext'
import { MARKETING_URL, TCD_URL } from '../tcd/firebase'
import * as api from './resellerApi'
import type { ParentAccountView, PlanDays, ResellerDashboard } from './resellerApi'

function errMsg(e: unknown): string {
  if (e instanceof FirebaseError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

function formatMs(ms?: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function TcdLogin({
  signIn,
  signInWithGoogle,
}: {
  signIn: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="reseller-auth-wrap">
      <div className="reseller-auth-card">
        <p className="eyebrow">SareChild partners</p>
        <h1>Reseller portal</h1>
        <p className="muted">
          Sign in with the same Google or email account you used to register. An ops admin must activate your reseller
          profile in TCD before you can sell activations.
        </p>
        <form onSubmit={(e) => void onSubmit(e)}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            void signInWithGoogle()
              .catch((err) => setError(errMsg(err)))
              .finally(() => setBusy(false))
          }}
        >
          Continue with Google
        </button>
      </div>
    </div>
  )
}

export function ResellerApp() {
  const { configured, user, loading, blockedMessage, signIn, signInWithGoogle, signOut } = useAuth()
  const [gate, setGate] = useState<'checking' | 'pending' | 'active' | 'missing'>('checking')
  const [dash, setDash] = useState<ResellerDashboard | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const [lookupEmail, setLookupEmail] = useState('')
  const [account, setAccount] = useState<ParentAccountView | null>(null)
  const [planDays, setPlanDays] = useState<PlanDays>(30)
  const [voucherPlan, setVoucherPlan] = useState<PlanDays>(30)
  const [redeemWithin, setRedeemWithin] = useState<30 | 60 | 90>(60)
  const [lastVoucher, setLastVoucher] = useState<string | null>(null)

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.fetchDashboard()
      setDash(data)
      setGate('active')
    } catch (e) {
      const msg = errMsg(e)
      if (msg.includes('Not a reseller') || msg.includes('permission-denied')) {
        const own = await api.getOwnResellerDoc()
        if (!own) setGate('missing')
        else if (own.status !== 'active') setGate('pending')
        else setGate('missing')
        setDash(null)
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!user) {
      setGate('checking')
      setDash(null)
      return
    }
    void (async () => {
      const own = await api.getOwnResellerDoc()
      if (!own) {
        setGate('missing')
        return
      }
      if (own.status !== 'active') {
        setGate('pending')
        return
      }
      await refresh()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid])

  const pricing = dash?.pricing
  const planCards = useMemo(() => {
    if (!pricing) return []
    return ([15, 30, 90] as const).map((d) => {
      const p = pricing.plans[String(d)] ?? { days: d, retailGyd: d === 15 ? 2200 : d === 30 ? 4000 : 10800, label: `${d} days` }
      const money = api.formatMoney(p.retailGyd, pricing)
      return { days: d as PlanDays, label: p.label, ...money, credits: d }
    })
  }, [pricing])

  if (!configured) {
    return (
      <div className="reseller-auth-wrap">
        <div className="reseller-auth-card">
          <h1>Not configured</h1>
          <p className="muted">Firebase env vars missing for this marketing build.</p>
        </div>
      </div>
    )
  }

  if (loading) return <div className="reseller-loading">Loading reseller portal…</div>
  if (!user) return <TcdLogin signIn={signIn} signInWithGoogle={signInWithGoogle} />
  if (blockedMessage) {
    return (
      <div className="reseller-auth-wrap">
        <div className="reseller-auth-card">
          <h1>Account blocked</h1>
          <p className="muted">{blockedMessage}</p>
          <button className="btn btn-primary" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (gate === 'checking') return <div className="reseller-loading">Checking reseller access…</div>

  if (gate === 'missing' || gate === 'pending') {
    return (
      <div className="reseller-auth-wrap">
        <div className="reseller-auth-card">
          <p className="eyebrow">Almost there</p>
          <h1>{gate === 'pending' ? 'Waiting for activation' : 'Reseller not set up'}</h1>
          <p className="muted">
            Signed in as <strong>{user.email}</strong>.{' '}
            {gate === 'pending'
              ? 'Your reseller profile exists but is not active yet. Ask SareChild ops to activate you in TCD.'
              : 'Ask SareChild ops to activate this email as a reseller in the TCD Resellers tab after you have signed up.'}
          </p>
          <div className="reseller-auth-actions">
            <a className="btn btn-ghost" href={MARKETING_URL}>
              Marketing site
            </a>
            <button className="btn btn-primary" type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  const balance = dash?.reseller.creditBalance ?? 0

  return (
    <div className="reseller-shell">
      <header className="reseller-hero">
        <div>
          <p className="eyebrow eyebrow-on-dark">Partner console</p>
          <h1>Reseller</h1>
          <p className="on-dark muted">
            {dash?.reseller.displayName || dash?.reseller.email} · 1 credit = 1 day of paid service
          </p>
        </div>
        <div className="reseller-balance-card">
          <span className="reseller-balance-label">Credit-days</span>
          <strong className="reseller-balance-value">{balance}</strong>
          <button className="btn btn-ghost-on-dark" type="button" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
          <button className="btn btn-ghost-on-dark" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {(error || status) && (
        <div className={`reseller-banner ${error ? 'error' : 'ok'}`}>{error || status}</div>
      )}

      <section className="reseller-plans">
        <h2>Plans</h2>
        <div className="reseller-plan-grid">
          {planCards.map((p) => (
            <button
              key={p.days}
              type="button"
              className={`reseller-plan-card ${planDays === p.days ? 'active' : ''}`}
              onClick={() => {
                setPlanDays(p.days)
                setVoucherPlan(p.days)
              }}
            >
              <span className="reseller-plan-label">{p.label}</span>
              <strong>{p.days} days</strong>
              <span>{p.gyd}</span>
              <span className="muted small">
                {p.usd} · {p.xcd}
              </span>
              <span className="reseller-plan-credits">{p.credits} credits</span>
            </button>
          ))}
        </div>
      </section>

      <div className="reseller-grid">
        <section className="reseller-card">
          <h2>Lookup & activate</h2>
          <p className="muted small">Customer must already have a SareChild parent account for this email.</p>
          <form
            className="reseller-form"
            onSubmit={(e) => {
              e.preventDefault()
              setBusy(true)
              setError(null)
              setStatus(null)
              void api
                .lookupParent(lookupEmail)
                .then((a) => {
                  setAccount(a)
                  setStatus(`Found ${a.email}`)
                })
                .catch((err) => setError(errMsg(err)))
                .finally(() => setBusy(false))
            }}
          >
            <label>
              Parent email
              <input
                type="email"
                value={lookupEmail}
                onChange={(e) => setLookupEmail(e.target.value)}
                placeholder="parent@example.com"
                required
              />
            </label>
            <button className="btn btn-ghost" type="submit" disabled={busy}>
              Lookup
            </button>
          </form>

          {account && (
            <div className="reseller-account">
              <p>
                <strong>{account.email}</strong>
              </p>
              <ul>
                <li>
                  Plan: {account.plan} · Status: {account.status}
                  {account.adminBlocked ? ' · BLOCKED' : ''}
                </li>
                <li>Trial ends: {formatMs(account.trialEndsAt)}</li>
                <li>Paid until: {formatMs(account.paidUntilMs)}</li>
                <li>Paid access now: {account.hasPaidAccess ? 'Yes' : 'No'}</li>
                <li>Last login: {formatMs(account.lastLoginAt)}</li>
              </ul>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || balance < planDays}
                onClick={() => {
                  if (!confirm(`Activate ${planDays} days for ${account.email}? Deducts ${planDays} credits.`)) return
                  setBusy(true)
                  setError(null)
                  void api
                    .activateParent(account.email, planDays)
                    .then((res) => {
                      setAccount(res.account)
                      setStatus(`Activated ${planDays} days. Paid until ${formatMs(res.account.paidUntilMs)}`)
                      return refresh()
                    })
                    .catch((err) => setError(errMsg(err)))
                    .finally(() => setBusy(false))
                }}
              >
                Activate {planDays}-day plan (−{planDays} credits)
              </button>
            </div>
          )}
        </section>

        <section className="reseller-card">
          <h2>Vouchers</h2>
          <p className="muted small">
            Mint a code to sell offline. Credits are deducted now; customer redeems later in the parent app. Void unused
            vouchers to refund credits.
          </p>
          <div className="reseller-form">
            <label>
              Plan
              <select value={voucherPlan} onChange={(e) => setVoucherPlan(Number(e.target.value) as PlanDays)}>
                <option value={15}>15 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </label>
            <label>
              Redeem within
              <select value={redeemWithin} onChange={(e) => setRedeemWithin(Number(e.target.value) as 30 | 60 | 90)}>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
            </label>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || balance < voucherPlan}
              onClick={() => {
                if (!confirm(`Mint ${voucherPlan}-day voucher? Deducts ${voucherPlan} credits now.`)) return
                setBusy(true)
                setError(null)
                void api
                  .createVoucher(voucherPlan, redeemWithin)
                  .then((res) => {
                    setLastVoucher(res.voucher.code)
                    setStatus(`Voucher ${res.voucher.code} created`)
                    return refresh()
                  })
                  .catch((err) => setError(errMsg(err)))
                  .finally(() => setBusy(false))
              }}
            >
              Mint voucher (−{voucherPlan})
            </button>
          </div>
          {lastVoucher && (
            <p className="reseller-voucher-code">
              Latest code: <code>{lastVoucher}</code>
            </p>
          )}
          <ul className="reseller-voucher-list">
            {(dash?.vouchers ?? []).map((v) => (
              <li key={v.code}>
                <code>{v.code}</code> · {v.planDays}d · {v.status} · expires {formatMs(v.expiresAtMs)}
                {v.status === 'active' && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Void ${v.code} and refund credits?`)) return
                      setBusy(true)
                      void api
                        .voidVoucher(v.code)
                        .then(() => refresh())
                        .catch((err) => setError(errMsg(err)))
                        .finally(() => setBusy(false))
                    }}
                  >
                    Void
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="reseller-card">
        <h2>Recent ledger</h2>
        <ul className="reseller-ledger">
          {(dash?.ledger ?? []).length === 0 && <li className="muted">No activity yet.</li>}
          {(dash?.ledger ?? []).map((e) => (
            <li key={e.id}>
              <strong>
                {e.delta > 0 ? '+' : ''}
                {e.delta}
              </strong>{' '}
              {e.reason} → {e.balanceAfter} · {formatMs(e.createdAtMs)}
            </li>
          ))}
        </ul>
        <p className="muted small">
          Ops console: <a href={TCD_URL}>TCD</a>
        </p>
      </section>
    </div>
  )
}
