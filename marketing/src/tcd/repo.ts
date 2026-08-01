import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { auth, COL, db, FUNCTIONS_HEALTH_URL, MARKETING_URL, PARENT_WEB_URL, PLATFORM_HEALTH_URL, R2_BASE_URL, TCD_URL, WENT_DARK_AFTER_MS } from './firebase'
import type {
  ApkHealth,
  ChatActivity,
  DeviceStatus,
  FamilyAlert,
  GuardianInfo,
  GuardianInviteStats,
  PairingStats,
  SafetyCommand,
  SiteUptime,
  TcdCheck,
  TcdOverview,
  TcdReport,
} from './types'

function requireDb() {
  if (!db) throw new Error('Firebase is not configured for this build.')
  return db
}

export async function getFamilyId(): Promise<string> {
  const uid = auth?.currentUser?.uid
  if (!uid) throw new Error('Not signed in')
  const snap = await getDoc(doc(requireDb(), COL.parentProfiles, uid))
  const familyId = snap.data()?.familyId as string | undefined
  if (!familyId) throw new Error('Family not found for this account')
  return familyId
}

// ---------- Live listeners (fleet card updates without polling) ----------

export function observeDevices(familyId: string, onData: (rows: DeviceStatus[]) => void): () => void {
  return onSnapshot(collection(requireDb(), COL.families, familyId, COL.devices), (snap) => {
    onData(
      snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          childName: (data.childName as string) || 'Child',
          lastHeartbeatMs: Number(data.lastHeartbeatMs ?? 0),
          batteryPercent: Number(data.batteryPercent ?? -1),
          chatOnline: Boolean(data.chatOnline),
          chatLastSeenMs: Number(data.chatLastSeenMs ?? 0),
          monitoringActive: Boolean(data.monitoringActive),
        } satisfies DeviceStatus
      }),
    )
  })
}

export function observeAlerts(familyId: string, onData: (rows: FamilyAlert[]) => void): () => void {
  const q = query(collection(requireDb(), COL.families, familyId, COL.alerts), orderBy('createdAtMs', 'desc'), limit(100))
  return onSnapshot(q, (snap) => {
    onData(
      snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          severity: (data.severity as string) || 'MEDIUM',
          title: (data.title as string) || 'Alert',
          createdAtMs: Number(data.createdAtMs ?? 0),
          read: Boolean(data.read),
        } satisfies FamilyAlert
      }),
    )
  })
}

export function observeGuardians(familyId: string, onData: (rows: GuardianInfo[]) => void): () => void {
  return onSnapshot(collection(requireDb(), COL.families, familyId, COL.guardians), (snap) => {
    onData(
      snap.docs.map((d) => {
        const data = d.data()
        return {
          uid: d.id,
          email: (data.email as string) || '',
          role: (data.role as string) || 'CAREGIVER',
          joinedAtMs: Number(data.joinedAtMs ?? 0),
        } satisfies GuardianInfo
      }),
    )
  })
}

export function observeCommands(familyId: string, onData: (rows: SafetyCommand[]) => void): () => void {
  const q = query(collection(requireDb(), COL.families, familyId, COL.commands), orderBy('requestedAtMs', 'desc'), limit(30))
  return onSnapshot(q, (snap) => {
    onData(
      snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          status: (data.status as string) || 'PENDING',
          type: (data.type as string) || '',
          requestedAtMs: Number(data.requestedAtMs ?? 0),
        } satisfies SafetyCommand
      }),
    )
  })
}

// ---------- Deep health checks (button-triggered + auto-refresh) ----------

export async function runTcdHealthCheck(familyId: string): Promise<TcdReport> {
  const checks: TcdCheck[] = []
  const now = Date.now()
  const database = requireDb()

  try {
    const started = performance.now()
    const familySnap = await getDoc(doc(database, COL.families, familyId))
    checks.push({
      id: 'firestore-family',
      label: 'Firestore family document',
      group: 'platform',
      status: familySnap.exists() ? 'ok' : 'fail',
      message: familySnap.exists() ? 'Family document is reachable.' : 'Family document is missing.',
      latencyMs: Math.round(performance.now() - started),
    })
  } catch (e) {
    checks.push({
      id: 'firestore-family',
      label: 'Firestore family document',
      group: 'platform',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to read family document.',
    })
  }

  try {
    const started = performance.now()
    await getDocs(query(collection(database, COL.families, familyId, COL.alerts), orderBy('createdAtMs', 'desc'), limit(1)))
    checks.push({
      id: 'alerts-read',
      label: 'Alerts stream',
      group: 'platform',
      status: 'ok',
      message: 'Alerts collection is readable.',
      latencyMs: Math.round(performance.now() - started),
    })
  } catch (e) {
    checks.push({
      id: 'alerts-read',
      label: 'Alerts stream',
      group: 'platform',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to read alerts.',
    })
  }

  const apiKey = (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined)?.trim()
  if (apiKey) {
    try {
      const started = performance.now()
      const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`)
      const latencyMs = Math.round(performance.now() - started)
      const ok = res.status === 200 || res.status === 400 || res.status === 403
      checks.push({
        id: 'firebase-auth',
        label: 'Firebase Authentication',
        group: 'platform',
        status: ok ? 'ok' : 'fail',
        message: ok ? `Auth API reachable (HTTP ${res.status}).` : `Auth API returned HTTP ${res.status}.`,
        latencyMs,
      })
    } catch (e) {
      checks.push({
        id: 'firebase-auth',
        label: 'Firebase Authentication',
        group: 'platform',
        status: 'fail',
        message: e instanceof Error ? e.message : 'Failed to reach Firebase Authentication.',
      })
    }
  }

  try {
    const started = performance.now()
    const res = await fetch(`${R2_BASE_URL.replace(/\/$/, '')}/health`)
    const latencyMs = Math.round(performance.now() - started)
    checks.push({
      id: 'r2-proxy',
      label: 'Cloudflare R2 proxy',
      group: 'platform',
      status: res.ok ? 'ok' : 'fail',
      message: res.ok ? 'R2 worker health endpoint is reachable.' : `R2 worker returned HTTP ${res.status}.`,
      latencyMs,
    })
  } catch (e) {
    checks.push({
      id: 'r2-proxy',
      label: 'Cloudflare R2 proxy',
      group: 'platform',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to reach R2 worker.',
    })
  }

  try {
    const started = performance.now()
    const res = await fetch(PLATFORM_HEALTH_URL || FUNCTIONS_HEALTH_URL)
    const latencyMs = Math.round(performance.now() - started)
    let body: {
      ok?: boolean
      checks?: {
        cloudflareWorker?: { status?: string; message?: string }
        r2?: { status?: string; message?: string }
        d1?: { status?: string; message?: string }
        kv?: { status?: string; message?: string }
        firebase?: { status?: string; message?: string }
      }
    } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      // non-JSON is fine
    }
    const workerStatus = body.checks?.cloudflareWorker?.status
    const r2Status = body.checks?.r2?.status
    const d1Status = body.checks?.d1?.status
    const kvStatus = body.checks?.kv?.status
    const detail = ` R2=${r2Status || 'n/a'} · D1=${d1Status || 'n/a'} · KV=${kvStatus || 'n/a'}`
    const edgeHealthy =
      res.ok ||
      (workerStatus === 'ok' && r2Status === 'ok' && d1Status === 'ok' && kvStatus !== 'fail')
    checks.push({
      id: 'platform-health',
      label: 'Platform backend (Cloudflare edge)',
      group: 'platform',
      status: edgeHealthy ? (kvStatus === 'warn' ? 'warn' : 'ok') : 'fail',
      message: edgeHealthy
        ? `Edge platform healthy.${detail}`
        : `Platform health returned HTTP ${res.status}.${detail}`,
      latencyMs,
    })
  } catch (e) {
    checks.push({
      id: 'platform-health',
      label: 'Platform backend (Cloudflare edge)',
      group: 'platform',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to reach Cloudflare platform health.',
    })
  }

  if (FUNCTIONS_HEALTH_URL) {
    try {
      const started = performance.now()
      const res = await fetch(FUNCTIONS_HEALTH_URL)
      checks.push({
        id: 'functions-health',
        label: 'Cloud Functions',
        group: 'platform',
        status: res.ok ? 'ok' : 'warn',
        message: res.ok ? 'Functions health endpoint reachable.' : `Functions health HTTP ${res.status} (optional Blaze endpoint).`,
        latencyMs: Math.round(performance.now() - started),
      })
    } catch (e) {
      checks.push({
        id: 'functions-health',
        label: 'Cloud Functions',
        group: 'platform',
        status: 'warn',
        message: e instanceof Error ? e.message : 'Functions health unreachable (optional).',
      })
    }
  } else {
    checks.push({
      id: 'functions-health',
      label: 'Cloud Functions',
      group: 'platform',
      status: 'ok',
      message: 'Functions health probe not configured; Cloudflare edge is primary.',
    })
  }

  try {
    const started = performance.now()
    await fetch('https://maps.googleapis.com/maps/api/js', { method: 'GET', mode: 'no-cors', cache: 'no-store' })
    checks.push({
      id: 'google-maps',
      label: 'Google Maps platform',
      group: 'platform',
      status: 'ok',
      message: 'Maps JS API endpoint reachable.',
      latencyMs: Math.round(performance.now() - started),
    })
  } catch (e) {
    checks.push({
      id: 'google-maps',
      label: 'Google Maps platform',
      group: 'platform',
      status: 'warn',
      message: e instanceof Error ? e.message : 'Maps endpoint probe failed.',
    })
  }

  try {
    const started = performance.now()
    const devicesSnap = await getDocs(collection(database, COL.families, familyId, COL.devices))
    const staleCount = devicesSnap.docs.filter((d) => now - Number(d.get('lastHeartbeatMs') ?? 0) > WENT_DARK_AFTER_MS).length
    checks.push({
      id: 'child-heartbeats',
      label: 'Child heartbeat freshness',
      group: 'fleet',
      status: devicesSnap.size === 0 ? 'warn' : staleCount === 0 ? 'ok' : 'warn',
      message:
        devicesSnap.size === 0
          ? 'No child devices registered yet.'
          : staleCount === 0
            ? `${devicesSnap.size}/${devicesSnap.size} device(s) online and reporting.`
            : `${staleCount}/${devicesSnap.size} device(s) offline or stale.`,
      latencyMs: Math.round(performance.now() - started),
    })
  } catch (e) {
    checks.push({
      id: 'child-heartbeats',
      label: 'Child heartbeat freshness',
      group: 'fleet',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to read child devices.',
    })
  }

  return { generatedAtMs: now, checks }
}

// ---------- Fleet overview (edge-first, Firestore fallback) ----------

function edgeBaseUrl(): string {
  return R2_BASE_URL.replace(/\/$/, '')
}

async function syncFleetToEdge(familyId: string, overview: TcdOverview): Promise<void> {
  try {
    await fetch(`${edgeBaseUrl()}/edge/sync/fleet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ familyId, ...overview, source: 'firebase' }),
    })
  } catch {
    // Edge sync is best-effort redundancy.
  }
}

async function loadFleetFromEdge(familyId: string): Promise<(TcdOverview & { source: string; latencyMs: number }) | null> {
  try {
    const started = performance.now()
    const res = await fetch(`${edgeBaseUrl()}/edge/fleet/${encodeURIComponent(familyId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok?: boolean
      source?: string
      snapshot?: {
        registeredDevices: number
        onlineDevices: number
        offlineDevices: number
        guardians: number
        alertsLast24h: number
        criticalAlertsLast24h: number
        pendingCommands: number
        latestHeartbeatMs: number
        updatedAtMs: number
      }
    }
    if (!body.ok || !body.snapshot) return null
    return {
      generatedAtMs: body.snapshot.updatedAtMs || Date.now(),
      registeredDevices: body.snapshot.registeredDevices,
      onlineDevices: body.snapshot.onlineDevices,
      offlineDevices: body.snapshot.offlineDevices,
      guardians: body.snapshot.guardians,
      alertsLast24h: body.snapshot.alertsLast24h,
      criticalAlertsLast24h: body.snapshot.criticalAlertsLast24h,
      pendingCommands: body.snapshot.pendingCommands,
      latestHeartbeatMs: body.snapshot.latestHeartbeatMs,
      source: body.source || 'edge',
      latencyMs: Math.round(performance.now() - started),
    }
  } catch {
    return null
  }
}

export async function loadTcdOverview(familyId: string): Promise<TcdOverview> {
  const edge = await loadFleetFromEdge(familyId)
  if (edge && Date.now() - edge.generatedAtMs < 2 * 60 * 1000) {
    return { ...edge, edgeSource: edge.source, edgeLatencyMs: edge.latencyMs }
  }

  const database = requireDb()
  const now = Date.now()
  const cutoff24h = now - 24 * 60 * 60 * 1000

  const [devicesSnap, guardiansSnap, commandsSnap, alertsSnap] = await Promise.all([
    getDocs(collection(database, COL.families, familyId, COL.devices)),
    getDocs(collection(database, COL.families, familyId, COL.guardians)),
    getDocs(query(collection(database, COL.families, familyId, COL.commands), limit(100))),
    getDocs(query(collection(database, COL.families, familyId, COL.alerts), orderBy('createdAtMs', 'desc'), limit(300))),
  ])

  let onlineDevices = 0
  let latestHeartbeatMs = 0
  devicesSnap.docs.forEach((d) => {
    const hb = Number(d.get('lastHeartbeatMs') ?? 0)
    if (hb > latestHeartbeatMs) latestHeartbeatMs = hb
    if (hb > 0 && now - hb < WENT_DARK_AFTER_MS) onlineDevices += 1
  })
  const registeredDevices = devicesSnap.size
  const pendingCommands = commandsSnap.docs.filter((d) => String(d.get('status') ?? '') === 'PENDING').length

  let alertsLast24h = 0
  let criticalAlertsLast24h = 0
  alertsSnap.docs.forEach((d) => {
    const created = Number(d.get('createdAtMs') ?? 0)
    if (created >= cutoff24h) {
      alertsLast24h += 1
      if (String(d.get('severity') ?? '').toUpperCase() === 'CRITICAL') criticalAlertsLast24h += 1
    }
  })

  const overview: TcdOverview = {
    generatedAtMs: now,
    registeredDevices,
    onlineDevices,
    offlineDevices: Math.max(0, registeredDevices - onlineDevices),
    guardians: guardiansSnap.size,
    alertsLast24h,
    criticalAlertsLast24h,
    pendingCommands,
    latestHeartbeatMs,
    edgeSource: 'firebase',
    edgeLatencyMs: null,
  }
  void syncFleetToEdge(familyId, overview)
  return overview
}

// ---------- Auto-repair ----------

export async function runTcdAutoRepair(familyId: string): Promise<string[]> {
  const database = requireDb()
  const fixes: string[] = []

  await setDoc(
    doc(database, COL.families, familyId, COL.safetySettings, 'default'),
    {
      escalationEnabled: true,
      escalationRiskThreshold: 60,
      autoLockOnCritical: false,
      checkInIntervalMinutes: 120,
      snoozedCategories: [],
      snoozeUntilMs: 0,
      alertRetentionDays: 30,
      mediaRetentionDays: 7,
    },
    { merge: true },
  )
  fixes.push('Applied missing default safety settings.')

  const now = Date.now()
  const devicesSnap = await getDocs(collection(database, COL.families, familyId, COL.devices))
  await Promise.all(
    devicesSnap.docs.map(async (d) => {
      const lastHeartbeatMs = Number(d.get('lastHeartbeatMs') ?? 0)
      if (lastHeartbeatMs > 0 && now - lastHeartbeatMs > WENT_DARK_AFTER_MS && d.get('online') !== false) {
        await updateDoc(d.ref, { online: false })
      }
    }),
  )
  fixes.push('Reconciled stale online flags for dark devices.')

  const familySnap = await getDoc(doc(database, COL.families, familyId))
  const parentUid = familySnap.get('parentUid') as string | undefined
  const parentEmail = (familySnap.get('parentEmail') as string | undefined) || auth?.currentUser?.email || ''
  if (parentUid) {
    const guardianRef = doc(database, COL.families, familyId, COL.guardians, parentUid)
    const guardianSnap = await getDoc(guardianRef)
    if (!guardianSnap.exists()) {
      await setDoc(guardianRef, { email: parentEmail, role: 'OWNER', joinedAtMs: Date.now() })
      fixes.push('Restored missing OWNER guardian record.')
    }
  }

  return fixes
}

// ---------- New: pairing / invite / chat operational stats ----------

export async function loadPairingStats(familyId: string): Promise<PairingStats> {
  const database = requireDb()
  const now = Date.now()
  try {
    const snap = await getDocs(query(collection(database, COL.pairingCodes), where('familyId', '==', familyId)))
    let pending = 0
    let expired = 0
    let claimed = 0
    snap.docs.forEach((d) => {
      const data = d.data()
      if (data.claimed) {
        claimed += 1
        return
      }
      if (Number(data.expiresAtMs ?? 0) < now) expired += 1
      else pending += 1
    })
    return { pending, expired, claimed }
  } catch {
    return { pending: 0, expired: 0, claimed: 0 }
  }
}

export async function loadGuardianInviteStats(familyId: string): Promise<GuardianInviteStats> {
  const database = requireDb()
  const now = Date.now()
  try {
    const snap = await getDocs(
      query(collection(database, COL.guardianInvites), where('familyId', '==', familyId), where('claimed', '==', false)),
    )
    let pending = 0
    let expired = 0
    snap.docs.forEach((d) => {
      if (Number(d.data().expiresAtMs ?? 0) < now) expired += 1
      else pending += 1
    })
    return { pending, expired }
  } catch {
    return { pending: 0, expired: 0 }
  }
}

export async function loadChatActivity(familyId: string): Promise<ChatActivity> {
  const database = requireDb()
  try {
    const snap = await getDocs(
      query(collection(database, COL.families, familyId, COL.familyChat), orderBy('createdAtMs', 'desc'), limit(1)),
    )
    const d = snap.docs[0]
    if (!d) return { lastMessageAtMs: null, lastSenderRole: null }
    const data = d.data()
    return {
      lastMessageAtMs: Number(data.createdAtMs ?? 0) || null,
      lastSenderRole: (data.senderRole as string | undefined) ?? null,
    }
  } catch {
    return { lastMessageAtMs: null, lastSenderRole: null }
  }
}

// ---------- New: APK download endpoint health ----------

async function probeApk(id: ApkHealth['id'], label: string, filename: string): Promise<ApkHealth> {
  const url = `${R2_BASE_URL.replace(/\/$/, '')}/downloads/${filename}`
  const controller = new AbortController()
  try {
    const started = performance.now()
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    const latencyMs = Math.round(performance.now() - started)
    const sizeBytes = Number(res.headers.get('content-length') ?? 0) || null
    controller.abort()
    return {
      id,
      label,
      status: res.ok ? 'ok' : 'fail',
      message: res.ok ? 'Download endpoint is reachable.' : `Returned HTTP ${res.status}.`,
      latencyMs,
      sizeBytes,
    }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    if (aborted) {
      return { id, label, status: 'ok', message: 'Download endpoint is reachable.', latencyMs: null, sizeBytes: null }
    }
    return {
      id,
      label,
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to reach download endpoint.',
      latencyMs: null,
      sizeBytes: null,
    }
  }
}

export async function loadApkHealth(): Promise<ApkHealth[]> {
  return Promise.all([
    probeApk('parent-apk', 'Parent app APK', 'parent.apk'),
    probeApk('child-apk', 'Child app APK', 'child.apk'),
  ])
}

// ---------- New: marketing / parent-web uptime (opaque no-cors reachability) ----------

async function probeSite(id: string, label: string, url: string): Promise<SiteUptime> {
  try {
    const started = performance.now()
    // Cross-origin pages don't send CORS headers for a plain document fetch, so we
    // can't read status — a resolved (even opaque) response means the network path,
    // DNS, and TLS handshake all succeeded, which is what "is it up" needs here.
    await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
    return { id, label, url, status: 'ok', message: 'Reachable.', latencyMs: Math.round(performance.now() - started) }
  } catch (e) {
    return {
      id,
      label,
      url,
      status: 'fail',
      message: e instanceof Error ? e.message : 'Unreachable.',
      latencyMs: null,
    }
  }
}

export async function loadSiteUptime(): Promise<SiteUptime[]> {
  return Promise.all([
    probeSite('marketing-site', 'Marketing site (GitHub Pages)', MARKETING_URL),
    probeSite('tcd-page', 'TCD console (GitHub Pages)', TCD_URL),
    probeSite('parent-web', 'Parent web (Firebase Hosting)', PARENT_WEB_URL),
  ])
}
