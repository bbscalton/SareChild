import { useEffect, useMemo, useState } from 'react'
import type { CameraSnapshot, DeviceStatus } from '../types'
import {
  clearCameraSnapshots,
  isIgnorableFirestoreListenerError,
  observeCameraSnapshots,
  startCameraSnapshots,
  stopCameraSnapshots,
  type CameraSnapshotMode,
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

function facingLabel(facing: string): string {
  if (facing === 'front') return 'Front'
  if (facing === 'back') return 'Back'
  return facing
}

export function CameraSnapshotsSection({
  familyId,
  devices,
  busy,
  setBusy,
  setStatusMsg,
  setError,
}: Props) {
  const [deviceId, setDeviceId] = useState('')
  const [snapshots, setSnapshots] = useState<CameraSnapshot[]>([])
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [cameraMode, setCameraMode] = useState<CameraSnapshotMode>('back')
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
    return observeCameraSnapshots(
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
  const status = selectedDevice?.cameraSnapshotStatus
  const cameraReady = Boolean(
    status?.cameraPermission ?? selectedDevice?.cameraPermission ?? selectedDevice?.cameraCheckConsent,
  )
  const remoteCapturing = Boolean(selectedDevice?.cameraSnapshotsActive || status?.active)
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
        await stopCameraSnapshots(familyId, deviceId)
        setStatusMsg('Stopped camera snapshots.')
      } else {
        setCaptureOverride(true)
        await startCameraSnapshots(familyId, deviceId, cameraMode)
        setStatusMsg('Camera snapshots started — first image in ~5 seconds.')
      }
    } catch (e) {
      setCaptureOverride(null)
      setError(e instanceof Error ? e.message : 'Could not toggle camera snapshots')
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
      const { deleted, mediaDeleted } = await clearCameraSnapshots(familyId, deviceId)
      setStatusMsg(
        `Cleared ${deleted.toLocaleString()} camera snapshot${deleted === 1 ? '' : 's'} for ${selectedDevice?.childName ?? 'device'}${mediaDeleted > 0 ? ` (${mediaDeleted.toLocaleString()} image${mediaDeleted === 1 ? '' : 's'} removed from storage)` : ''}.`,
      )
      setSelectedIndex(null)
      cancelClear()
    } catch (e) {
      setClearError(e instanceof Error ? e.message : 'Failed to clear camera snapshots')
    } finally {
      setClearBusy(false)
    }
  }

  const gridItems = useMemo(() => visibleSnapshots, [visibleSnapshots])

  return (
    <section className="stack screen-snapshots-section">
      <div className="card screen-snapshots-hero">
        <div className="screen-snapshots-hero-head">
          <h3>Camera snapshots</h3>
          <span className={`pill ${capturing ? 'online' : 'offline'}`}>
            {capturing ? 'Capturing' : 'Idle'}
          </span>
        </div>
        <p className="muted">
          Periodic still photos from your child&apos;s front or back camera every 5 seconds.
          Requires Camera permission on the child device (same as live view / camera safety check).
          Auto-stops after 30 minutes. Retained up to 24 hours (max 200 per device).
        </p>
        {!cameraReady && (
          <p className="banner error-banner compact">
            Camera permission required on child — open <strong>Enable Protections</strong> on the
            child phone and allow Camera access.
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
            <label className="muted small">
              Camera
              <select
                className="input compact"
                value={cameraMode}
                disabled={capturing || busy}
                onChange={(e) => setCameraMode(e.target.value as CameraSnapshotMode)}
              >
                <option value="front">Front</option>
                <option value="back">Back</option>
                <option value="both">Both</option>
              </select>
            </label>
            <button
              type="button"
              className={capturing ? 'btn danger' : 'btn primary'}
              disabled={busy || !cameraReady}
              onClick={() => void toggleCapture()}
            >
              {capturing ? 'Stop snapshots' : 'Start snapshots'}
            </button>
            <span className="muted small">
              Interval: 5s · Mode: {status?.cameras ?? cameraMode} · Status:{' '}
              {capturing ? 'capturing' : 'idle'}
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
              Clear all camera snapshots
            </button>
          )}
        </div>
        <ClearAllConfirm
          open={clearOpen}
          title="Clear all camera snapshots"
          description={
            <>
              This permanently deletes every camera snapshot and its images for{' '}
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
              : 'No snapshots yet. Choose a camera and tap Start snapshots above.'}
          </p>
        ) : (
          <>
            <div className="screen-snapshots-table-wrap desktop-only">
              <table className="screen-snapshots-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Camera</th>
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
                        <td>{facingLabel(snap.cameraFacing)}</td>
                        <td>
                          {thumb ? (
                            <img
                              className="screen-snapshots-thumb"
                              src={thumb}
                              alt={facingLabel(snap.cameraFacing)}
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
                      <img src={thumb} alt={facingLabel(snap.cameraFacing)} loading="lazy" />
                    ) : (
                      <span className="screen-snapshots-grid-placeholder">No preview</span>
                    )}
                    <span className="screen-snapshots-grid-meta">
                      {facingLabel(snap.cameraFacing)} · {relativeTime(snap.capturedAtMs)}
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
        <div
          className="photos-lightbox screen-snapshots-lightbox"
          onClick={closeLightbox}
          role="presentation"
        >
          <div
            className="photos-lightbox-inner screen-snapshots-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="photos-lightbox-close"
              onClick={closeLightbox}
              aria-label="Close"
            >
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
                alt={facingLabel(selected.cameraFacing)}
              />
            )}
            <p className="muted small screen-snapshots-lightbox-caption">
              {facingLabel(selected.cameraFacing)} ·{' '}
              {new Date(selected.capturedAtMs).toLocaleString()} · {selected.width}×{selected.height}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
