/** WebRTC helpers for parent-side live viewing (viewer / offerer). */

export type IceServerConfig = RTCIceServer

export function buildIceServers(): IceServerConfig[] {
  const servers: IceServerConfig[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ]
  const turnUrl = (import.meta.env.VITE_TURN_URL as string | undefined)?.trim()
  const turnUser = (import.meta.env.VITE_TURN_USERNAME as string | undefined)?.trim()
  const turnCred = (import.meta.env.VITE_TURN_CREDENTIAL as string | undefined)?.trim()
  if (turnUrl && turnUser && turnCred) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred })
  }
  return servers
}

export type SessionDescriptionPayload = {
  type: RTCSdpType
  sdp: string
}

export type IceCandidatePayload = {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
  atMs?: number
}

export function toSessionDescriptionPayload(desc: RTCSessionDescriptionInit): SessionDescriptionPayload {
  return { type: desc.type as RTCSdpType, sdp: desc.sdp ?? '' }
}

export function toIceCandidatePayload(candidate: RTCIceCandidate): IceCandidatePayload {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    atMs: Date.now(),
  }
}

export async function createViewerPeerConnection(
  onTrack: (stream: MediaStream) => void,
  onIceCandidate: (candidate: IceCandidatePayload) => void,
): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({ iceServers: buildIceServers() })
  pc.ontrack = (ev) => {
    if (ev.streams[0]) onTrack(ev.streams[0])
  }
  pc.onicecandidate = (ev) => {
    if (ev.candidate) onIceCandidate(toIceCandidatePayload(ev.candidate))
  }
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  return pc
}

export async function createOffer(pc: RTCPeerConnection): Promise<SessionDescriptionPayload> {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  return toSessionDescriptionPayload(offer)
}

export async function applyAnswer(pc: RTCPeerConnection, answer: SessionDescriptionPayload): Promise<void> {
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

export async function addRemoteIceCandidate(
  pc: RTCPeerConnection,
  payload: IceCandidatePayload,
): Promise<void> {
  if (!payload.candidate) return
  await pc.addIceCandidate(
    new RTCIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid ?? undefined,
      sdpMLineIndex: payload.sdpMLineIndex ?? undefined,
    }),
  )
}

/** Record remote MediaStream in browser; returns WebM blob on stop. */
export function startStreamRecorder(stream: MediaStream): {
  stop: () => Promise<Blob>
} {
  const chunks: BlobPart[] = []
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: mime })
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data)
  }
  recorder.start(1000)
  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: mime }))
        recorder.stop()
      }),
  }
}
