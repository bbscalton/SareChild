import { useState, type FormEvent } from 'react'
import heroImage from './assets/hero.webp'
import { Reveal } from './Reveal'
import {
  APKS_ARE_RELEASE_SIGNED,
  CHILD_APK_URL,
  CHILD_APK_VERSION,
  GITHUB_REPO_URL,
  PARENT_APK_URL,
  PARENT_APK_VERSION,
  PARENT_WEB_URL,
  PLAN_COMPARISON_ROWS,
  PRIVACY_URL,
  RESELLER_PORTAL_URL,
  TERMS_URL,
} from './config'
import { applyErrorMessage, submitResellerApplication } from './resellerApplyApi'

export default function App() {
  return (
    <div className="page">
      <Nav />
      <main>
        <Hero />
        <ProductTruth />
        <HowItWorks />
        <Plans />
        <Trust />
        <Downloads />
        <ResellerSection />
      </main>
      <Footer />
    </div>
  )
}

function Nav() {
  return (
    <header className="nav">
      <a className="brand" href="#top">
        <span className="brand-mark" aria-hidden="true" />
        SareChild
      </a>
      <nav className="nav-links" aria-label="Section navigation">
        <a href="#product">Product</a>
        <a href="#how">How it works</a>
        <a href="#plans">Trial vs Paid</a>
        <a href="#download">Download</a>
        <a href="#reseller">Resellers</a>
      </nav>
      <div className="nav-ctas">
        <a className="btn btn-ghost" href="#download">
          Download
        </a>
        <a className="btn btn-primary" href={PARENT_WEB_URL}>
          Start free trial
        </a>
      </div>
    </header>
  )
}

function Hero() {
  return (
    <section id="top" className="hero">
      <div className="hero-media" style={{ backgroundImage: `url(${heroImage})` }} aria-hidden="true" />
      <div className="hero-scrim" aria-hidden="true" />
      <div className="hero-inner">
        <p className="hero-brand">SareChild</p>
        <h1 className="hero-title">When they’re out of sight, you’re still sure they’re safe.</h1>
        <p className="hero-sub">
          Consent-first family safety — live location, WhatsApp awareness, and a parent dashboard
          that upgrades when you need more depth.
        </p>
        <div className="hero-ctas">
          <a className="btn btn-primary btn-lg" href={PARENT_WEB_URL}>
            Start free trial
          </a>
          <a className="btn btn-ghost-on-dark btn-lg" href="#download">
            Download apps
          </a>
        </div>
      </div>
    </section>
  )
}

function ProductTruth() {
  const truths = [
    {
      title: 'Live map that feels present',
      body: 'See where they are, replay today’s path on trial, and keep longer history when you upgrade — without drowning in noise.',
    },
    {
      title: 'WhatsApp safety signals',
      body: 'Typing and message awareness with retained history so you catch risk patterns, not every chat bubble.',
    },
    {
      title: 'Call & watchdog awareness',
      body: 'Know when calls happen and keep a watchdog eye on critical moments — always with visible protection on the child phone.',
    },
  ]
  return (
    <Reveal as="section" id="product" className="section product">
      <div className="section-inner">
        <p className="eyebrow">What parents actually get</p>
        <h2 className="section-title">Safety you can feel — not a feature checklist</h2>
        <div className="truth-list">
          {truths.map((t, i) => (
            <article className="truth-item" key={t.title} style={{ transitionDelay: `${i * 80}ms` }}>
              <h3>{t.title}</h3>
              <p className="muted">{t.body}</p>
            </article>
          ))}
        </div>
      </div>
    </Reveal>
  )
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Pair',
      body: 'Create a one-time code in the parent dashboard. Your child enters it once on their phone.',
    },
    {
      n: '02',
      title: 'Enable protections',
      body: 'Your child reviews and accepts what’s shared — location, alerts, WhatsApp awareness — with ongoing visibility.',
    },
    {
      n: '03',
      title: 'Parent dashboard',
      body: 'Open the web dashboard for live map, alerts, and depth that grows from trial to paid.',
    },
  ]
  return (
    <Reveal as="section" id="how" className="section how" delayMs={0}>
      <div className="section-inner">
        <p className="eyebrow">How it works</p>
        <h2 className="section-title">Three steps from install to peace of mind</h2>
        <div className="steps">
          {steps.map((s, i) => (
            <div className="step" key={s.n}>
              <span className="step-num">{s.n}</span>
              <h3>{s.title}</h3>
              <p className="muted">{s.body}</p>
              {i < steps.length - 1 && <span className="step-connector" aria-hidden="true" />}
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  )
}

function Plans() {
  return (
    <Reveal as="section" id="plans" className="section plans">
      <div className="section-inner">
        <p className="eyebrow">Trial → Paid</p>
        <h2 className="section-title">Start free. Upgrade when depth matters.</h2>
        <p className="section-lede muted">
          Core safety — SOS, last location, geofence alerts — is never limited. Trial caps depth so
          paid feels worth it when you need more children, history, and live check-ins.
        </p>
        <div className="plan-table-wrap">
          <table className="plan-table">
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Trial</th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {PLAN_COMPARISON_ROWS.map((row) => (
                <tr key={row.area}>
                  <th scope="row">{row.area}</th>
                  <td>{row.trial}</td>
                  <td>{row.paid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="plans-cta">
          <a className="btn btn-primary btn-lg" href={PARENT_WEB_URL}>
            Start free trial
          </a>
          <p className="muted small">No credit card. Redeem a voucher anytime to unlock paid.</p>
        </div>
      </div>
    </Reveal>
  )
}

function Trust() {
  return (
    <Reveal as="section" id="trust" className="section trust">
      <div className="section-inner trust-inner">
        <p className="eyebrow">Built honestly</p>
        <h2 className="section-title">Consent-first. Clear about Android limits.</h2>
        <div className="trust-copy">
          <p>
            Your child always sees what’s monitored — no stealth mode. Permissions and ongoing
            notifications stay visible on their phone.
          </p>
          <p>
            Call awareness leans on mic-side capture where Android allows it; some OEMs and VoIP
            paths are imperfect. Uninstall protection adds friction for parents who want it — it is
            not an absolute lock.
          </p>
          <p className="muted">
            We’d rather tell you the truth than sell magic. That’s how families stay with SareChild
            after the trial.
          </p>
        </div>
      </div>
    </Reveal>
  )
}

function Downloads() {
  return (
    <Reveal as="section" id="download" className="section download">
      <div className="section-inner">
        <p className="eyebrow eyebrow-on-dark">Downloads</p>
        <h2 className="section-title on-dark">Get the apps. Open the dashboard.</h2>
        <p className="muted on-dark download-lede">
          Install the Child APK on their phone and the Parent APK on yours, then pair. The{' '}
          <a className="inline-link" href={PARENT_WEB_URL}>
            parent web dashboard
          </a>{' '}
          has the full feature set; the Android parent APK may be thinner. Outside Play Store,
          Android asks once to allow installs from this source.
        </p>
        <div className="download-grid">
          <a className="download-card" href={CHILD_APK_URL}>
            <span className="download-kind">Child app</span>
            <span className="download-cta">Download child.apk</span>
            <span className="download-meta">v{CHILD_APK_VERSION} · Pairing, consent, protection badge</span>
          </a>
          <a className="download-card" href={PARENT_APK_URL}>
            <span className="download-kind">Parent app</span>
            <span className="download-cta">Download parent.apk</span>
            <span className="download-meta">v{PARENT_APK_VERSION} · Pair, alerts, chat</span>
          </a>
        </div>
        <p className="download-web">
          <a className="btn btn-primary" href={PARENT_WEB_URL}>
            Open parent dashboard
          </a>
        </p>
        {!APKS_ARE_RELEASE_SIGNED && (
          <p className="muted small on-dark">
            Preview / trial builds (debug-signed) while we validate demand — fully functional, not
            yet on Play Store.
          </p>
        )}
      </div>
    </Reveal>
  )
}

function ResellerSection() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('')
  const [businessType, setBusinessType] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await submitResellerApplication({
        name,
        email,
        phone,
        country,
        businessType: businessType.trim() || undefined,
        message: message.trim() || undefined,
      })
      setDone(true)
    } catch (err) {
      setError(applyErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Reveal as="section" id="reseller" className="section reseller">
      <div className="section-inner reseller-layout">
        <div className="reseller-pitch">
          <p className="eyebrow">Partners</p>
          <h2 className="section-title">Sell vouchers. Earn as a SareChild reseller.</h2>
          <p className="muted">
            Activate families with 15 / 30 / 90-day vouchers, top up credit-days, and serve parents
            who want paid depth after their trial. Apply below — ops reviews every request.
          </p>
          <ul className="reseller-bullets">
            <li>Wholesale credit-days for Starter, Monthly, and Quarterly plans</li>
            <li>Mint vouchers offline or activate a parent account directly</li>
            <li>
              Already approved?{' '}
              <a className="inline-link" href={RESELLER_PORTAL_URL}>
                Open the reseller portal
              </a>
            </li>
          </ul>
        </div>

        {done ? (
          <div className="reseller-success" role="status">
            <h3>Application received</h3>
            <p>
              Thanks — we’ll review your details and email you next steps. After approval, create a
              Google or email login with the same address, then use the{' '}
              <a className="inline-link" href={RESELLER_PORTAL_URL}>
                reseller portal
              </a>{' '}
              once ops activates your account.
            </p>
          </div>
        ) : (
          <form className="reseller-form" onSubmit={(e) => void onSubmit(e)}>
            <label>
              Full name
              <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label>
              Phone / WhatsApp
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                autoComplete="tel"
              />
            </label>
            <label>
              Country
              <input
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                required
                autoComplete="country-name"
              />
            </label>
            <label>
              Business type <span className="optional">(optional)</span>
              <input
                value={businessType}
                onChange={(e) => setBusinessType(e.target.value)}
                placeholder="Retail shop, mobile agent, school…"
              />
            </label>
            <label>
              Message <span className="optional">(optional)</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                placeholder="Where you sell, expected volume, questions…"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
              {busy ? 'Submitting…' : 'Apply to become a reseller'}
            </button>
          </form>
        )}
      </div>
    </Reveal>
  )
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <p className="brand footer-brand">
            <span className="brand-mark" aria-hidden="true" />
            SareChild
          </p>
          <p className="muted small">Consent-first family safety. Try free — upgrade when depth matters.</p>
        </div>
        <div className="footer-links">
          <a href={PARENT_WEB_URL}>Parent dashboard</a>
          <a href={TERMS_URL}>Terms</a>
          <a href={PRIVACY_URL}>Privacy</a>
          <a href={RESELLER_PORTAL_URL}>Reseller portal</a>
          <a href={GITHUB_REPO_URL}>GitHub</a>
          <a href="tcd.html" className="footer-ops-link">
            Ops / TCD
          </a>
        </div>
      </div>
    </footer>
  )
}
