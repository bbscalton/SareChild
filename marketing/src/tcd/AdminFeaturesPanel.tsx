import { useEffect, useState } from 'react'
import * as adminRepo from './adminRepo'
import type { AdminFeatureConfig, FeatureKey } from './types'
import { FEATURE_KEYS, FEATURE_LABELS } from './types'

export function AdminFeaturesPanel({
  busy,
  onBusy,
  onStatus,
  onError,
}: {
  busy: boolean
  onBusy: (v: boolean) => void
  onStatus: (msg: string) => void
  onError: (msg: string | null) => void
}) {
  const [config, setConfig] = useState<AdminFeatureConfig | null>(null)
  const [overrideUid, setOverrideUid] = useState('')
  const [overrides, setOverrides] = useState<Partial<Record<FeatureKey, boolean>>>({})

  useEffect(() => {
    return adminRepo.observeAdminFeatures(setConfig, (e) => onError(e.message))
  }, [onError])

  const toggleGlobal = (key: FeatureKey) => {
    if (!config) return
    setConfig({
      ...config,
      global: { ...config.global, [key]: !config.global[key] },
    })
  }

  const saveGlobal = async () => {
    if (!config) return
    onBusy(true)
    onError(null)
    try {
      await adminRepo.saveAdminFeatures(config)
      onStatus('Global feature toggles saved.')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      onBusy(false)
    }
  }

  const loadOverrides = async () => {
    const uid = overrideUid.trim()
    if (!uid) {
      onError('Enter a parent uid for per-account overrides.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      setOverrides(await adminRepo.loadFeatureOverrides(uid))
      onStatus(`Loaded overrides for ${uid}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Load overrides failed')
    } finally {
      onBusy(false)
    }
  }

  const saveOverrides = async () => {
    const uid = overrideUid.trim()
    if (!uid) {
      onError('Enter a parent uid.')
      return
    }
    onBusy(true)
    onError(null)
    try {
      await adminRepo.saveFeatureOverrides(uid, overrides)
      onStatus(`Saved overrides for ${uid}.`)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save overrides failed')
    } finally {
      onBusy(false)
    }
  }

  if (!config) {
    return (
      <div className="tcd-card">
        <p className="tcd-empty-note">Loading feature configuration…</p>
      </div>
    )
  }

  return (
    <div className="tcd-admin-features-grid">
      <div className="tcd-card">
        <div className="tcd-card-head">
          <h2>Global kill switches</h2>
          <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void saveGlobal()}>
            Save global
          </button>
        </div>
        <p className="muted small">Parent-web and child apps can read these flags from Firestore. Enforcement rolls out client-side.</p>
        <ul className="tcd-feature-list">
          {FEATURE_KEYS.map((key) => (
            <li key={key} className="tcd-feature-row">
              <label className="tcd-toggle">
                <input type="checkbox" checked={config.global[key]} onChange={() => toggleGlobal(key)} />
                <span>{FEATURE_LABELS[key]}</span>
              </label>
              <span className={`pill ${config.global[key] ? 'tcd-ok' : 'tcd-fail'}`}>{config.global[key] ? 'ON' : 'OFF'}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="tcd-card">
        <div className="tcd-card-head">
          <h2>Live view defaults</h2>
        </div>
        <div className="tcd-form-grid">
          <label>
            Daily credits
            <input
              type="number"
              min={1}
              max={99}
              value={config.liveView.defaultDailyCredits}
              onChange={(e) =>
                setConfig({
                  ...config,
                  liveView: { ...config.liveView, defaultDailyCredits: Number(e.target.value) || 10 },
                })
              }
            />
          </label>
          <label>
            Max session (minutes)
            <input
              type="number"
              min={1}
              max={5}
              value={config.liveView.maxSessionMinutes}
              onChange={(e) =>
                setConfig({
                  ...config,
                  liveView: { ...config.liveView, maxSessionMinutes: Math.min(5, Math.max(1, Number(e.target.value) || 5)) },
                })
              }
            />
          </label>
          <label>
            Default data retention (days)
            <input
              type="number"
              min={2}
              max={90}
              value={config.defaultRetentionDays}
              onChange={(e) =>
                setConfig({
                  ...config,
                  defaultRetentionDays: Math.min(90, Math.max(2, Number(e.target.value) || 2)),
                })
              }
            />
          </label>
          <label>
            Default chat video length (seconds)
            <input
              type="number"
              min={30}
              max={600}
              value={config.defaultMaxChatVideoSeconds}
              onChange={(e) =>
                setConfig({
                  ...config,
                  defaultMaxChatVideoSeconds: Math.min(600, Math.max(30, Number(e.target.value) || 180)),
                })
              }
            />
          </label>
        </div>
        <p className="muted small">
          Families without <code>retentionDays</code> inherit this default (2). Families without{' '}
          <code>maxChatVideoSeconds</code> inherit the chat video default (180s / 3 min) — child devices offer 1/2/3
          minute options clamped to whichever is lower. Per-account overrides on Accounts → Retention / Chat video.
        </p>
        {config.updatedAtMs > 0 && (
          <p className="muted small">Last updated {new Date(config.updatedAtMs).toLocaleString()} by {config.updatedBy ?? 'admin'}</p>
        )}
      </div>

      <div className="tcd-card tcd-card-wide">
        <div className="tcd-card-head">
          <h2>Per-account overrides</h2>
        </div>
        <div className="tcd-admin-toolbar">
          <input
            type="text"
            placeholder="Parent uid…"
            value={overrideUid}
            onChange={(e) => setOverrideUid(e.target.value)}
            className="tcd-admin-search"
          />
          <button className="btn btn-ghost compact" type="button" disabled={busy} onClick={() => void loadOverrides()}>
            Load
          </button>
          <button className="btn btn-primary compact" type="button" disabled={busy} onClick={() => void saveOverrides()}>
            Save overrides
          </button>
        </div>
        <ul className="tcd-feature-list">
          {FEATURE_KEYS.map((key) => (
            <li key={key} className="tcd-feature-row">
              <span>{FEATURE_LABELS[key]}</span>
              <select
                value={overrides[key] === undefined ? 'inherit' : overrides[key] ? 'on' : 'off'}
                onChange={(e) => {
                  const v = e.target.value
                  setOverrides((prev) => {
                    const next = { ...prev }
                    if (v === 'inherit') delete next[key]
                    else next[key] = v === 'on'
                    return next
                  })
                }}
                className="tcd-admin-select"
              >
                <option value="inherit">Inherit global</option>
                <option value="on">Force ON</option>
                <option value="off">Force OFF</option>
              </select>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
