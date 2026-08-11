import { useEffect, useMemo, useRef, useState } from 'react'
import * as repo from '../lib/parentRepo'
import {
  addRemoteIceCandidate,
  applyAnswer,
  createOffer,
  createViewerPeerConnection,
  startStreamRecorder,
  type IceCandidatePayload,
} from '../lib/webrtc'
import type { DeviceStatus, LiveRecording, LiveSession, LiveViewQuota } from '../types'

type Tab = 'live' | 'record'

type TileKey = 'video' | 'audio' | 'screen'

type Props = {
  familyId: string
  parentUid: string
  devices: DeviceStatus[]
  quota: LiveViewQuota | null
  recordings: LiveRecording[]
  onError: (msg: string | null) => void
  onStatus: (msg: string | null) => void
}

const DURATION_OPTIONS = [1, 2, 3, 4, 5] as const

export function LiveViewingSection({
  familyId,
  parentUid,
  devices,
  quota,
  recordings,
  onError,
  onStatus,
}: Props) {
  const [tab, setTab] = useState<Tab>('live')
  const [deviceId, setDeviceId] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(1)
  const [tiles, setTiles] = useState<Record<TileKey, boolean>>({
    video: true,
    audio: false,
    screen: false,
  })
  const [cameraFacing, setCameraFacing] = useState<'rear' | 'front'>('rear')
  const [audioSource, setAudioSource] = useState<'none' | 'mic'>('none')
  const [recordEnabled, setRecordEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeSession, setActiveSession] = useState<LiveSession | null>(null)
  const [countdownSec, setCountdownSec] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const pageSize = 10

  const videoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const recorderRef = useRef<{ stop: () => Promise<Blob> } | null>(null)
  const appliedChildCandidates = useRef<Set<string>>(new Set())
  const pendingChildCandidates = useRef<IceCandidatePayload[]>([])
  const signalingChainRef = useRef<Promise<void>>(Promise.resolve())
  const sessionUnsubRef = useRef<(() => void) | null>(null)
  const teardownInProgressRef = useRef(false)

  useEffect(() => {
    if (devices.length && !deviceId) setDeviceId(devices[0]!.id)
  }, [devices, deviceId])

  useEffect(() => {
    setTiles((t) => ({ ...t, audio: audioSource === 'mic' }))
  }, [audioSource])

  const resetHours = useMemo(() => {
    if (!quota) return '—'
    const ms = Math.max(0, quota.resetAtMs - Date.now())
    return `${Math.ceil(ms / (60 * 60 * 1000))} hours`
  }, [quota])

  const filteredRecordings = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return recordings
    return recordings.filter((r) => {
      const date = new Date(r.createdAtMs).toLocaleString().toLowerCase()
      return date.includes(q) || r.status.toLowerCase().includes(q) || r.deviceId.includes(q)
    })
  }, [recordings, search])

  const pageRows = filteredRecordings.slice(page * pageSize, (page + 1) * pageSize)
  const pageCount = Math.max(1, Math.ceil(filteredRecordings.length / pageSize))

  useEffect(() => {
    if (!activeSession?.endsAtMs) {
      setCountdownSec(null)
      return
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((activeSession.endsAtMs! - Date.now()) / 1000))
      setCountdownSec(left)
      if (left <= 0) void teardownSession('Session ended')
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [activeSession?.endsAtMs, activeSession?.id])

  async function teardownSession(reason: string) {
    if (teardownInProgressRef.current) return
    teardownInProgressRef.current = true

    const session = activeSession
    sessionUnsubRef.current?.()
    sessionUnsubRef.current = null
    signalingChainRef.current = Promise.resolve()
    appliedChildCandidates.current.clear()
    pendingChildCandidates.current = []

    if (recorderRef.current && session?.config.record) {
      try {
        const blob = await recorderRef.current.stop()
        const { path, url } = await repo.uploadLiveRecordingBlob(
          familyId,
          session.deviceId,
          session.id,
          blob,
        )
        await repo.createLiveRecording(familyId, {
          sessionId: session.id,
          deviceId: session.deviceId,
          status: 'ready',
          mediaUrl: url,
          mediaPath: path,
          durationSec: session.durationMinutes * 60,
          sizeBytes: blob.size,
          createdAtMs: Date.now(),
        })
        onStatus('Recording saved to Record tab.')
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Recording upload failed')
      }
    }
    recorderRef.current = null

    const pc = pcRef.current
    pcRef.current = null
    pc?.close()
    if (videoRef.current) videoRef.current.srcObject = null

    if (session && session.status !== 'ended') {
      try {
        await repo.stopLiveViewSession(familyId, session.deviceId)
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Failed to stop child live view')
      }
      await repo.updateLiveSession(familyId, session.id, {
        status: 'ended',
        endedAtMs: Date.now(),
        endReason: reason,
      })
    }

    setActiveSession(null)
    setCountdownSec(null)
    teardownInProgressRef.current = false
  }

  async function applyQueuedChildCandidates(pc: RTCPeerConnection) {
    if (!pc.remoteDescription) return
    const queued = pendingChildCandidates.current.splice(0)
    for (const raw of queued) {
      const key = String(raw.candidate ?? '')
      if (!key || appliedChildCandidates.current.has(key)) continue
      appliedChildCandidates.current.add(key)
      await addRemoteIceCandidate(pc, raw)
    }
  }

  async function ingestChildCandidates(pc: RTCPeerConnection, candidates: IceCandidatePayload[]) {
    for (const raw of candidates) {
      const key = String(raw.candidate ?? '')
      if (!key || appliedChildCandidates.current.has(key)) continue
      if (!pc.remoteDescription) {
        pendingChildCandidates.current.push(raw)
        continue
      }
      appliedChildCandidates.current.add(key)
      await addRemoteIceCandidate(pc, raw)
    }
  }

  async function connectWebRtc(sessionId: string) {
    appliedChildCandidates.current.clear()
    pendingChildCandidates.current = []
    signalingChainRef.current = Promise.resolve()
    const pc = await createViewerPeerConnection(
      (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => undefined)
        }
        if (recordEnabled) {
          recorderRef.current = startStreamRecorder(stream)
        }
      },
      (candidate: IceCandidatePayload) => {
        void repo.addLiveSessionIceCandidate(familyId, sessionId, 'parent', candidate)
      },
    )
    pcRef.current = pc

    sessionUnsubRef.current = repo.observeLiveSession(familyId, sessionId, (session) => {
      setActiveSession(session)
      signalingChainRef.current = signalingChainRef.current
        .then(async () => {
          if (session.answer && pc.remoteDescription == null) {
            await applyAnswer(pc, {
              type: session.answer.type as RTCSdpType,
              sdp: session.answer.sdp,
            })
            await applyQueuedChildCandidates(pc)
          }
          await ingestChildCandidates(pc, session.childCandidates as IceCandidatePayload[])
          if (session.status === 'ended' || session.status === 'failed' || session.status === 'declined') {
            await teardownSession(session.endReason || session.error || session.status)
          }
        })
        .catch((e) => {
          onError(e instanceof Error ? e.message : 'Live view signaling failed')
        })
    })

    const offer = await createOffer(pc)
    await repo.updateLiveSession(familyId, sessionId, { offer, status: 'connecting' })
  }

  async function handleStart() {
    if (!deviceId) {
      onError('Select a child device first.')
      return
    }
    if (!tiles.video && !tiles.audio && !tiles.screen) {
      onError('Enable at least one of VIDEO, AUDIO, or SCREEN.')
      return
    }
    if (tiles.screen && (tiles.video || tiles.audio)) {
      onError('SCREEN mode runs alone — turn off VIDEO/AUDIO or disable SCREEN.')
      return
    }
    setBusy(true)
    onError(null)
    try {
      const { sessionId } = await repo.startLiveViewSession({
        familyId,
        deviceId,
        parentUid,
        durationMinutes,
        config: {
          video: tiles.video && !tiles.screen,
          audio: tiles.audio,
          screen: tiles.screen,
          cameraFacing,
          record: recordEnabled,
        },
      })
      onStatus('Waiting for child to accept…')
      await connectWebRtc(sessionId)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not start live view')
    } finally {
      setBusy(false)
    }
  }

  function toggleTile(key: TileKey) {
    setTiles((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      if (key === 'screen' && next.screen) {
        next.video = false
        next.audio = false
        setAudioSource('none')
      }
      if ((key === 'video' || key === 'audio') && (next.video || next.audio)) {
        next.screen = false
      }
      return next
    })
  }

  const creditsRemaining = quota?.creditsRemaining ?? repo.LIVE_VIEW_DAILY_CREDITS
  const dailyAllowance = quota?.dailyAllowance ?? repo.LIVE_VIEW_DAILY_CREDITS

  return (
    <section className="stack liveview-section">
      <div className="liveview-header">
        <h2 className="liveview-title">LIVE VIEWING</h2>
        <div className="filter-row">
          <button
            type="button"
            className={tab === 'live' ? 'chip active' : 'chip'}
            onClick={() => setTab('live')}
          >
            Live
          </button>
          <button
            type="button"
            className={tab === 'record' ? 'chip active' : 'chip'}
            onClick={() => setTab('record')}
          >
            Record
          </button>
        </div>
      </div>

      {tab === 'live' && (
        <>
          <div className="card liveview-quota-banner">
            <p>
              You have <strong>{creditsRemaining}</strong> credits out of{' '}
              <strong>{dailyAllowance}</strong> daily (1 credit = 1 minute). Reset in{' '}
              <strong>{resetHours}</strong>. A session lasts up to{' '}
              <strong>{durationMinutes}</strong> minute{durationMinutes === 1 ? '' : 's'} and
              costs <strong>{durationMinutes}</strong> credit{durationMinutes === 1 ? '' : 's'}.
            </p>
          </div>

          {devices.length === 0 ? (
            <div className="card">
              <p className="muted">Pair a child device first.</p>
            </div>
          ) : (
            <div className="card form-card liveview-config">
              <label>
                Child device
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.childName}
                    </option>
                  ))}
                </select>
              </label>

              <div className="liveview-tiles">
                {(['video', 'audio', 'screen'] as TileKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={tiles[key] ? 'liveview-tile active' : 'liveview-tile'}
                    onClick={() => toggleTile(key)}
                  >
                    {key.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="liveview-row">
                <label>
                  Camera source
                  <select
                    value={cameraFacing}
                    disabled={!tiles.video || tiles.screen}
                    onChange={(e) => setCameraFacing(e.target.value as 'rear' | 'front')}
                  >
                    <option value="rear">Rear camera</option>
                    <option value="front">Front camera</option>
                  </select>
                </label>
                <label>
                  Audio source
                  <select
                    value={audioSource}
                    disabled={tiles.screen}
                    onChange={(e) => setAudioSource(e.target.value as 'none' | 'mic')}
                  >
                    <option value="none">No sound</option>
                    <option value="mic">Microphone</option>
                  </select>
                </label>
              </div>

              <label>
                Session duration
                <select
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  disabled={!!activeSession}
                >
                  {DURATION_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} minute{m === 1 ? '' : 's'} ({m} credit{m === 1 ? '' : 's'})
                    </option>
                  ))}
                </select>
              </label>

              <label className="liveview-toggle-row">
                <span>Record session</span>
                <input
                  type="checkbox"
                  checked={recordEnabled}
                  disabled={!!activeSession}
                  onChange={(e) => setRecordEnabled(e.target.checked)}
                />
              </label>

              <div className="btn-row">
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || !!activeSession || creditsRemaining < durationMinutes}
                  onClick={() => void handleStart()}
                >
                  START
                </button>
                {activeSession && (
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => void teardownSession('Stopped by parent')}
                  >
                    STOP
                  </button>
                )}
              </div>

              {creditsRemaining < durationMinutes && (
                <p className="muted small">Not enough credits for this duration.</p>
              )}
            </div>
          )}

          {(activeSession || countdownSec != null) && (
            <div className="card liveview-player-card">
              <div className="liveview-player-head">
                <span className={`pill ${activeSession?.status === 'active' ? 'online' : 'offline'}`}>
                  {activeSession?.status ?? 'connecting'}
                </span>
                {countdownSec != null && (
                  <span className="liveview-countdown">
                    {Math.floor(countdownSec / 60)}:{String(countdownSec % 60).padStart(2, '0')}
                  </span>
                )}
              </div>
              <video ref={videoRef} className="liveview-video" playsInline autoPlay muted={false} />
              <p className="muted small">
                WebRTC via STUN + TURN (coturn at 107.170.15.179). Set VITE_TURN_* in .env if
                video stays blank.
              </p>
            </div>
          )}
        </>
      )}

      {tab === 'record' && (
        <div className="card wa-table-card">
          <div className="wa-table-toolbar">
            <input
              type="search"
              placeholder="Search recordings…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
            <button className="btn ghost compact" type="button" onClick={() => setPage(0)}>
              Refresh
            </button>
          </div>
          <table className="wa-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Data</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No recordings yet — start a live session with Record enabled.
                  </td>
                </tr>
              ) : (
                pageRows.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.createdAtMs).toLocaleString()}</td>
                    <td>{r.status === 'ready' ? 'Ready' : r.status}</td>
                    <td>
                      {r.mediaUrl ? (
                        <a href={r.mediaUrl} target="_blank" rel="noreferrer">
                          Play / download
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        className="btn ghost compact"
                        type="button"
                        onClick={() => void repo.deleteLiveRecording(familyId, r.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="wa-table-pagination">
            <button
              className="btn ghost compact"
              type="button"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span className="muted small">
              Page {page + 1} / {pageCount}
            </span>
            <button
              className="btn ghost compact"
              type="button"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
