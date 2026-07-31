import heroImage from './assets/hero.webp'
import { Reveal } from './Reveal'
import {
  CHILD_APK_URL,
  GITHUB_REPO_URL,
  PARENT_APK_URL,
  PARENT_WEB_URL,
} from './config'

export default function App() {
  return (
    <div className="page">
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <Downloads />
        <TrialSection />
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
        <a href="#how">How it works</a>
        <a href="#features">Features</a>
        <a href="#download">Download</a>
        <a href="#trial">Free trial</a>
      </nav>
      <div className="nav-ctas">
        <a className="btn btn-ghost-on-light" href={PARENT_WEB_URL}>
          Open dashboard
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
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-inner">
        <p className="eyebrow eyebrow-on-dark">Family safety, built on consent</p>
        <h1 className="hero-title">Know they're okay. Without the creepiness.</h1>
        <p className="hero-sub">
          SareChild pairs a parent phone and a child phone so you can see they're safe —
          live location, real alerts, and a family chat — while your child always knows
          exactly what's shared and why.
        </p>
        <div className="hero-ctas">
          <a className="btn btn-primary btn-lg" href={PARENT_WEB_URL}>
            Start your free 30-day trial
          </a>
          <a className="btn btn-ghost-on-dark btn-lg" href="#how">
            See how it works
          </a>
        </div>
        <p className="hero-note">Full features included. No credit card required.</p>
      </div>
    </section>
  )
}

function HowItWorks() {
  const steps = [
    {
      n: '1',
      title: 'Pair',
      body: "Parent creates a one-time pairing code in SareChild. Your child enters it once to connect the two apps.",
    },
    {
      n: '2',
      title: 'Consent',
      body: 'Your child reviews and accepts exactly what gets monitored — no hidden permissions, no stealth mode, ever.',
    },
    {
      n: '3',
      title: 'Live dashboard',
      body: 'You see location, battery, alerts, and safety check-ins update in real time from the parent app or web.',
    },
  ]
  return (
    <Reveal as="section" className="section how" delayMs={0}>
      <div className="section-inner">
        <p className="eyebrow">How it works</p>
        <h2 className="section-title">Set up in minutes, not settings menus</h2>
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

function Features() {
  const features = [
    {
      title: 'Live location & geofences',
      body: "See where they are on a map, and get a gentle notification when they arrive at or leave home, school, or a safe zone you've drawn.",
    },
    {
      title: 'Alerts that mean something',
      body: 'SOS button, keyword detection, low battery, and "went dark" warnings — with context attached, not noise you learn to ignore.',
    },
    {
      title: 'Consent-first safety checks',
      body: "Screen share, camera, and mic checks always show an Accept/Decline prompt and an ongoing notification on your child's phone. Nothing runs silently.",
    },
    {
      title: 'Family chat',
      body: 'A private space for the whole family to check in — texts, photos, and voice notes — inside the same app your child already trusts.',
    },
  ]
  return (
    <Reveal as="section" id="features" className="section features">
      <div className="section-inner">
        <p className="eyebrow">Peace of mind, honestly</p>
        <h2 className="section-title">Everything a parent needs. Nothing a child should hide from.</h2>
        <div className="feature-grid">
          {features.map((f) => (
            <article className="feature-card" key={f.title}>
              <h3>{f.title}</h3>
              <p className="muted">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </Reveal>
  )
}

function Downloads() {
  return (
    <Reveal as="section" id="download" className="section download">
      <div className="section-inner">
        <p className="eyebrow eyebrow-on-dark">Get the apps</p>
        <h2 className="section-title on-dark">One app for you, one for your kid</h2>
        <p className="muted on-dark download-lede">
          Direct APK downloads hosted on Cloudflare — install the Parent app on your
          phone and the Child app on theirs, then pair them in under a minute. Since
          we're not on Google Play yet, Android will ask you to allow installs from
          this source once.
        </p>
        <div className="download-grid">
          <a className="download-card" href={PARENT_APK_URL}>
            <span className="download-kind">Parent app</span>
            <span className="download-cta">Download parent.apk ↓</span>
            <span className="download-meta">Pair devices, live dashboard, alerts, chat</span>
          </a>
          <a className="download-card" href={CHILD_APK_URL}>
            <span className="download-kind">Child app</span>
            <span className="download-cta">Download child.apk ↓</span>
            <span className="download-meta">Pairing, consent screens, visible protection badge</span>
          </a>
        </div>
        <p className="muted small on-dark">
          Preview / trial build (debug-signed) while we validate demand — fully
          functional, just not yet notarized for the Play Store. Already paired?{' '}
          <a className="inline-link" href={PARENT_WEB_URL}>
            Open your dashboard
          </a>
          .
        </p>
      </div>
    </Reveal>
  )
}

function TrialSection() {
  const points = [
    'Full access to every safety feature for 30 days — nothing gated behind a paywall.',
    'No credit card required to start.',
    "A quick weekly check-in (opening the dashboard or checking on your kid) keeps your account active.",
    'Paid plans are coming later for families who want to keep going after their trial — this trial period is how we validate SareChild is worth building further.',
  ]
  return (
    <Reveal as="section" id="trial" className="section trial">
      <div className="section-inner trial-inner">
        <div>
          <p className="eyebrow">Free trial</p>
          <h2 className="section-title">One plan. Every feature. 30 days, free.</h2>
          <ul className="trial-list">
            {points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <a className="btn btn-primary btn-lg" href={PARENT_WEB_URL}>
            Start your free trial
          </a>
        </div>
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
          <p className="muted small">Consent-first family safety. Built for peace of mind, not surveillance.</p>
        </div>
        <div className="footer-links">
          <a href={PARENT_WEB_URL}>Parent dashboard</a>
          <a href={GITHUB_REPO_URL}>Source on GitHub</a>
          <a href="tcd.html" className="footer-ops-link">
            Ops / TCD
          </a>
          <a href="#top">Back to top</a>
        </div>
      </div>
    </footer>
  )
}
