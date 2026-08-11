import { useEffect, useMemo, useState } from 'react'
import type { DeviceStatus, ScreenSnapshot } from '../types'
import {
  clearScreenSnapshots,
  isIgnorableFirestoreListenerError,
  observeScreenSnapshots,
  startScreenSnapshots,
  stopScreenSnapshots,
} from '../lib/parentRepo'
import { ClearAllConfirm, CLEAR_CONFIRM_TEXT } from './ClearAllConfirm'

type Props = {
  familyId: string
  devices: DeviceStatus[]
  busy: boolean
  setBusy: (v: boolean) => void
  setStatusMsg: (msg: string | null) => void
  setError: (msg: string | null) => void
}

const PAGE_SIZE = 100

function relativeTime(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ms).toLocaleString()
}

export function ScreenSnapshotsSection({
  familyId,
  devices,
  busy,
  setBusy,
  setStatusMsg,
  setError,
}: Props) {
  const [deviceId, setDeviceId] = useState('')
  const [snapshots, setSnapshots] = useState<ScreenSnapshot[]>([])
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearConfirmText, setClearConfirmText] = useState('')
  const [clearError, setClearError] = useState<string | null>(null)
  const [clearBusy, setClearBusy] = useState(false)
  const [captureOverride, setCaptureOverride] = useState<boolean | null>(null)

  useEffect(() => {
    if (!deviceId && devices.length > 0) setDeviceId(devices[0]!.id)
  }, [devices, deviceId])

  useEffect(() => {
    if (!familyId || !deviceId) return
    return observeScreenSnapshots(
      familyId,
      deviceId,
      setSnapshots,
      (err) => {
        if (!isIgnorableFirestoreListenerError(err)) setError(err.message)
      },
    )
  }, [familyId, deviceId, setError])

  const visibleSnapshots = useMemo(
    () => snapshots.slice(0, displayCount),
    [snapshots, displayCount],
  )

  const selectedDevice = devices.find((d) => d.id === deviceId)
  const status = selectedDevice?.screenSnapshotStatus
  const accessibilityReady =
    status?.accessibilityAccess ??
    selectedDevice?.eventRecorderStatus?.accessibilityAccess ??
    false
  const remoteCapturing = Boolean(selectedDevice?.screenSnapshotsActive || status?.active)
  const capturing = captureOverride ?? remoteCapturing

  useEffect(() => {
    if (captureOverride != null && remoteCapturing === captureOverride) {
      setCaptureOverride(null)
    }
  }, [captureOverride, remoteCapturing])
  const selected = selectedIndex != null ? visibleSnapshots[selectedIndex] ?? null : null

  const toggleCapture = async () => {
    if (!familyId || !deviceId) return
    setBusy(true)
    setError(null)
    try {
      if (capturing) {
        setCaptureOverride(false)
        await stopScreenSnapshots(familyId, deviceId)
        setStatusMsg('Stopped screen snapshots.')
      } else {
        setCaptureOverride(true)
        await startScreenSnapshots(familyId, deviceId)
        setStatusMsg('Screen snapshots started — first image in ~5 seconds.')
      }
    } catch (e) {
      setCaptureOverride(null)
      setError(e instanceof Error ? e.message : 'Could not toggle screen snapshots')
    } finally {
      setBusy(false)
    }
  }

  const openAt = (index: number) => setSelectedIndex(index)
  const closeLightbox = () => setSelectedIndex(null)
  const showPrev = () => {
    if (selectedIndex == null || selectedIndex >= visibleSnapshots.length - 1) return
    setSelectedIndex(selectedIndex + 1)
  }
  const showNext = () => {
    if (selectedIndex == null || selectedIndex <= 0) return
    setSelectedIndex(selectedIndex - 1)
  }

  const canLoadMore = displayCount < snapshots.length
  const canClear = Boolean(familyId && deviceId && snapshots.length > 0)

  const openClear = () => {
    setClearOpen(true)
    setClearConfirmText('')
    setClearError(null)
  }

  const cancelClear = () => {
    setClearOpen(false)
    setClearConfirmText('')
    setClearError(null)
  }

  const confirmClear = async () => {
    if (!familyId || !deviceId) return
    if (clearConfirmText.trim().toUpperCase() !== CLEAR_CONFIRM_TEXT) {
      setClearError(`Type "${CLEAR_CONFIRM_TEXT}" to confirm.`)
      return
    }
    setClearBusy(true)
    setClearError(null)
    try {
      const { deleted, mediaDeleted } = await clearScreenSnapshots(familyId, deviceId)
      setStatusMsg(
        `Cleared ${deleted.toLocaleString()} screen snapshot${deleted === 1 ? '' : 's'} for ${selectedDevice?.childName ?? 'device'}${mediaDeleted > 0 ? ` (${mediaDeleted.toLocaleString()} image${mediaDeleted === 1 ? '' : 's'} removed from storage)` : ''}.`,
      )
      setSelectedIndex(null)
      cancelClear()
    } catch (e) {
      setClearError(e instanceof Error ? e.message : 'Failed to clear screen snapshots')
    } finally {
      setClearBusy(false)
    }
  }

  const gridItems = useMemo(() => visibleSnapshots, [visibleSnapshots])

  return (
    <section className="stack screen-snapshots-section">
      <div className="card screen-snapshots-hero">
        <div className="screen-snapshots-hero-head">
          <h3>Screen snapshots</h3>
          <span className={`pill ${capturing ? 'online' : 'offline'}`}>
            {capturing ? 'Capturing' : 'Idle'}
          </span>
        </div>
        <p className="muted">
          Periodic screenshots from your child&apos;s phone using Android Accessibility — no
          &quot;Start recording&quot; dialog. Requires Accessibility enabled on the child device
          (same permission as Typing safety / Event recorder). Auto-stops after 30 minutes.
          Retained up to 24 hours (max 200 per device).
        </p>
        {!accessibilityReady && (
          <p className="banner error-banner compact">
            Accessibility required on child — open <strong>Enable Protections</strong> on the child
            phone and turn on the SareChild accessibility service.
          </p>
        )}
      </div>

      {devices.length > 0 && (
        <div className="card">
          <h3>Device</h3>
          <div className="filter-row">
            {devices.map((d) => (
              <button
                key={d.id}
                type="button"
                className={deviceId === d.id ? 'chip active' : 'chip'}
                onClick={() => {
                  setDeviceId(d.id)
                  setSelectedIndex(null)
                  setDisplayCount(PAGE_SIZE)
                }}
              >
                {d.childName}
              </button>
            ))}
          </div>
          <div className="row gap screen-snapshots-controls">
            <button
              type="button"
              className={capturing ? 'btn danger' : 'btn primary'}
              disabled={busy || !accessibilityReady}
              onClick={() => void toggleCapture()}
            >
              {capturing ? 'Stop snapshots' : 'Start snapshots'}
            </button>
            <span className="muted small">
              Interval: 5s · Status: {capturing ? 'capturing' : 'idle'}
            </span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="eventrecorder-timeline-head">
          <h3>Recent snapshots</h3>
          {canClear && !clearOpen && (
            <button
              type="button"
              className="btn danger compact"
              disabled={busy || clearBusy}
              onClick={openClear}
            >
              Clear all snapshots
            </button>
          )}
        </div>
        <ClearAllConfirm
          open={clearOpen}
          title="Clear all screen snapshots"
          description={
            <>
              This permanently deletes every screen snapshot and its images for{' '}
              <strong>{selectedDevice?.childName ?? 'this device'}</strong>. This cannot be undone.
              New snapshots will still be captured if recording is active.
            </>
          }
          confirmText={clearConfirmText}
          onConfirmTextChange={setClearConfirmText}
          error={clearError}
          busy={clearBusy}
          onConfirm={() => void confirmClear()}
          onCancel={cancelClear}
          confirmLabel="Permanently clear snapshots"
        />
        {visibleSnapshots.length === 0 ? (
          <p className="muted">
            {capturing
              ? 'Waiting for the first snapshot…'
              : 'No snapshots yet. Tap Start snapshots above.'}
          </p>
        ) : (
          <>
            <div className="screen-snapshots-table-wrap desktop-only">
              <table className="screen-snapshots-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>App</th>
                    <th>Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSnapshots.map((snap, index) => {
                    const thumb = snap.thumbUrl || snap.imageUrl
                    return (
                      <tr
                        key={snap.id}
                        className="screen-snapshots-row"
                        onClick={() => openAt(index)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') openAt(index)
                        }}
                      >
                        <td>{relativeTime(snap.capturedAtMs)}</td>
                        <td>{snap.appLabel || snap.appPackage || '—'}</td>
                        <td>
                          {thumb ? (
                            <img
                              className="screen-snapshots-thumb"
                              src={thumb}
                              alt={snap.appLabel || 'Snapshot'}
                              loading="lazy"
                            />
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="screen-snapshots-grid mobile-only">
              {gridItems.map((snap, index) => {
                const thumb = snap.thumbUrl || snap.imageUrl
                return (
                  <button
                    key={snap.id}
                    type="button"
                    className="screen-snapshots-grid-item"
                    onClick={() => openAt(index)}
                  >
                    {thumb ? (
                      <img src={thumb} alt={snap.appLabel || 'Snapshot'} loading="lazy" />
                    ) : (
                      <span className="screen-snapshots-grid-placeholder">No preview</span>
                    )}
                    <span className="screen-snapshots-grid-meta">
                      {snap.appLabel || 'App'} · {relativeTime(snap.capturedAtMs)}
                    </span>
                  </button>
                )
              })}
            </div>

            {canLoadMore && (
              <button
                type="button"
                className="btn ghost compact"
                onClick={() => setDisplayCount((n) => n + PAGE_SIZE)}
              >
                Load more
              </button>
            )}
          </>
        )}
      </div>

      {selected && selectedIndex != null && (
        <div className="photos-lightbox screen-snapshots-lightbox" onClick={closeLightbox} role="presentation">
          <div className="photos-lightbox-inner screen-snapshots-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="photos-lightbox-close" onClick={closeLightbox} aria-label="Close">
              ×
            </button>
            {selectedIndex < visibleSnapshots.length - 1 && (
              <button
                type="button"
                className="screen-snapshots-nav screen-snapshots-nav-prev"
                onClick={showPrev}
                aria-label="Older snapshot"
              >
                ‹
              </button>
            )}
            {selectedIndex > 0 && (
              <button
                type="button"
                className="screen-snapshots-nav screen-snapshots-nav-next"
                onClick={showNext}
                aria-label="Newer snapshot"
              >
                ›
              </button>
            )}
            {(selected.imageUrl || selected.thumbUrl) && (
              <img
                src={selected.imageUrl || selected.thumbUrl || ''}
                alt={selected.appLabel || 'Screen snapshot'}
              />
            )}
            <p className="muted small screen-snapshots-lightbox-caption">
              {selected.appLabel || selected.appPackage || 'Unknown app'} ·{' '}
              {new Date(selected.capturedAtMs).toLocaleString()} · {selected.width}×{selected.height}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
