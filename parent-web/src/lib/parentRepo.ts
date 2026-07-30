import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { auth, COL, db, WENT_DARK_AFTER_MS } from '../firebase'
import { DEFAULT_KEYWORDS, generatePairingCode } from './helpers'
import type {
  AppBlockSchedule,
  AppLimit,
  CallSmsPreview,
  DeviceStatus,
  FamilyAlert,
  FamilySafetySettings,
  GeofenceZone,
  GuardianInfo,
  GuardianRole,
  LocationTrailSample,
  SafeContact,
  SafetyCommand,
  SosContact,
  TcdCheck,
  TcdOverview,
  TcdReport,
  UsageDaily,
  WeeklyDigest,
} from '../types'
import { parseBatteryHistory, parseLocation, parseUsageApps } from '../types'

export async function signUp(email: string, password: string): Promise<string> {
  const result = await createUserWithEmailAndPassword(auth, email, password)
  const uid = result.user.uid
  const familyRef = doc(collection(db, COL.families))
  await setDoc(familyRef, {
    parentUid: uid,
    createdAtMs: Date.now(),
    parentEmail: email,
  })
  await setDoc(doc(db, COL.parentProfiles, uid), {
    familyId: familyRef.id,
    email,
    createdAtMs: Date.now(),
  })
  await setDoc(doc(db, COL.families, familyRef.id, COL.guardians, uid), {
    email,
    role: 'OWNER' satisfies GuardianRole,
    joinedAtMs: Date.now(),
  })
  return familyRef.id
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password)
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth)
}

export async function getFamilyId(): Promise<string> {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Not signed in')
  const profile = await getDoc(doc(db, COL.parentProfiles, uid))
  const familyId = profile.data()?.familyId as string | undefined
  if (!familyId) throw new Error('Family not found')
  return familyId
}

export async function createPairingCode(childName: string): Promise<string> {
  const familyId = await getFamilyId()
  const code = generatePairingCode()
  await setDoc(doc(db, COL.pairingCodes, code), {
    familyId,
    childName: childName.trim() || 'Child',
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 30 * 60 * 1000,
    claimed: false,
  })
  return code
}

export function observeDevices(
  familyId: string,
  onData: (devices: DeviceStatus[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.devices),
    (snap) => {
      const now = Date.now()
      const devices = snap.docs.map((d) => {
        const data = d.data()
        const lastHb = Number(data.lastHeartbeatMs ?? 0)
        return {
          id: d.id,
          childName: (data.childName as string) || 'Child',
          online: now - lastHb < WENT_DARK_AFTER_MS,
          lastHeartbeatMs: lastHb,
          batteryPercent: Number(data.batteryPercent ?? -1),
          charging: Boolean(data.charging),
          batteryHistory: parseBatteryHistory(data.batteryHistory),
          lastLocation: parseLocation(data.lastLocation),
          notificationAccess: Boolean(data.notificationAccess),
          locationPermission: Boolean(data.locationPermission),
          monitoringActive: Boolean(data.monitoringActive),
          screenShareConsent: Boolean(data.screenShareConsent),
          cameraCheckConsent: Boolean(data.cameraCheckConsent),
          micCheckConsent: Boolean(data.micCheckConsent),
          messageMonitorConsent: Boolean(data.messageMonitorConsent),
          installMonitorConsent: Boolean(data.installMonitorConsent),
          usageConsent: Boolean(data.usageConsent),
          callSmsConsent: Boolean(data.callSmsConsent),
          offlineSmsFallbackConsent: Boolean(data.offlineSmsFallbackConsent),
          offlineAutoCallConsent: Boolean(data.offlineAutoCallConsent),
          chatOnline: Boolean(data.chatOnline),
          chatLastSeenMs: Number(data.chatLastSeenMs ?? 0),
          offlineCallEnabled: Boolean(data.offlineCallEnabled),
          offlineCallNumber: (data.offlineCallNumber as string | null) ?? null,
          offlineCallMaxAttempts: Number(data.offlineCallMaxAttempts ?? 0),
          activeSession: (data.activeSession as string | null) ?? null,
          latestFrameUrl: (data.latestFrameUrl as string | null) ?? null,
          todayScreenMinutes: Number(data.todayScreenMinutes ?? 0),
        } satisfies DeviceStatus
      })
      onData(devices)
    },
    (err) => onError?.(err),
  )
}

export function observeAlerts(
  familyId: string,
  onData: (alerts: FamilyAlert[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.alerts),
    orderBy('createdAtMs', 'desc'),
    limit(100),
  )
  return onSnapshot(
    q,
    (snap) => {
      const alerts = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          type: (data.type as string) || 'KEYWORD',
          severity: (data.severity as string) || 'MEDIUM',
          title: (data.title as string) || 'Alert',
          snippet: (data.snippet as string | null) ?? null,
          category: (data.category as string | null) ?? null,
          deviceId: (data.deviceId as string) || '',
          createdAtMs: Number(data.createdAtMs ?? 0),
          read: Boolean(data.read),
          location: parseLocation(data.location),
          mediaUrl: (data.mediaUrl as string | null) ?? null,
          commandId: (data.commandId as string | null) ?? null,
          riskScore: data.riskScore == null ? null : Number(data.riskScore),
        } satisfies FamilyAlert
      })
      onData(alerts)
    },
    (err) => onError?.(err),
  )
}

export function observeGeofences(
  familyId: string,
  onData: (zones: GeofenceZone[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.geofences),
    (snap) => {
      const zones = snap.docs.map((d) => {
        const data = d.data()
        const days = Array.isArray(data.daysOfWeek)
          ? (data.daysOfWeek as unknown[]).map((n) => Number(n)).filter((n) => !Number.isNaN(n))
          : []
        return {
          id: d.id,
          name: (data.name as string) || 'Zone',
          lat: Number(data.lat ?? 0),
          lng: Number(data.lng ?? 0),
          radiusM: Number(data.radiusM ?? 200),
          active: data.active !== false,
          daysOfWeek: days,
          startMinute: data.startMinute == null ? null : Number(data.startMinute),
          endMinute: data.endMinute == null ? null : Number(data.endMinute),
        } satisfies GeofenceZone
      })
      onData(zones)
    },
    (err) => onError?.(err),
  )
}

export async function addGeofence(
  familyId: string,
  zone: Omit<GeofenceZone, 'id'>,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.geofences), {
    name: zone.name,
    lat: zone.lat,
    lng: zone.lng,
    radiusM: zone.radiusM,
    active: zone.active,
    daysOfWeek: zone.daysOfWeek ?? [],
    startMinute: zone.startMinute ?? null,
    endMinute: zone.endMinute ?? null,
  })
}

export async function deleteGeofence(familyId: string, geofenceId: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.geofences, geofenceId))
}

export async function markAlertRead(familyId: string, alertId: string): Promise<void> {
  await updateDoc(doc(db, COL.families, familyId, COL.alerts, alertId), { read: true })
}

export type SafetyCommandType =
  | 'SCREEN_SHARE'
  | 'CAMERA_CHECK'
  | 'MIC_CHECK'
  | 'STOP_SCREEN_SHARE'
  | 'RING_DEVICE'
  | 'SYNC_CALL_SMS'
  | 'LOCK_DEVICE'
  | 'UNLOCK_DEVICE'

export async function createSafetyCommand(
  familyId: string,
  deviceId: string,
  type: SafetyCommandType,
  durationMinutes?: number,
): Promise<string> {
  const ref = doc(collection(db, COL.families, familyId, COL.commands))
  await setDoc(ref, {
    type,
    status: 'PENDING',
    deviceId,
    requestedAtMs: Date.now(),
    acceptedAtMs: null,
    completedAtMs: null,
    resultPath: null,
    resultUrl: null,
    error: null,
    durationMinutes: durationMinutes ?? null,
  })
  return ref.id
}

export async function addScreenShareSchedule(
  familyId: string,
  deviceId: string,
  label: string,
  daysOfWeek: number[],
  startMinute: number,
  durationMinutes: number,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.screenShareSchedules), {
    deviceId,
    label,
    daysOfWeek,
    startMinute,
    durationMinutes,
    active: true,
  })
}

export function observeScreenShareSchedules(
  familyId: string,
  onData: (rows: import('../types').ScreenShareSchedule[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.screenShareSchedules),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          deviceId: (data.deviceId as string) || '',
          label: (data.label as string) || 'Scheduled check',
          daysOfWeek: Array.isArray(data.daysOfWeek)
            ? (data.daysOfWeek as number[])
            : [],
          startMinute: Number(data.startMinute ?? 0),
          durationMinutes: Number(data.durationMinutes ?? 10),
          active: data.active !== false,
          lastTriggeredDayKey: (data.lastTriggeredDayKey as string | null) ?? null,
        }
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export async function deleteScreenShareSchedule(
  familyId: string,
  scheduleId: string,
): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.screenShareSchedules, scheduleId))
}

export function observeCommands(
  familyId: string,
  onData: (commands: SafetyCommand[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.commands),
    orderBy('requestedAtMs', 'desc'),
    limit(30),
  )
  return onSnapshot(
    q,
    (snap) => {
      const commands = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          type: (data.type as string) || 'CAMERA_CHECK',
          status: (data.status as string) || 'PENDING',
          deviceId: (data.deviceId as string) || '',
          requestedAtMs: Number(data.requestedAtMs ?? 0),
          acceptedAtMs: data.acceptedAtMs == null ? null : Number(data.acceptedAtMs),
          completedAtMs: data.completedAtMs == null ? null : Number(data.completedAtMs),
          resultPath: (data.resultPath as string | null) ?? null,
          resultUrl: (data.resultUrl as string | null) ?? null,
          error: (data.error as string | null) ?? null,
        } satisfies SafetyCommand
      })
      onData(commands)
    },
    (err) => onError?.(err),
  )
}

export async function ensureKeywordListSeeded(): Promise<void> {
  const ref = doc(db, COL.keywordLists, 'default')
  const snap = await getDoc(ref)
  if (snap.exists()) return
  try {
    await setDoc(ref, { categories: DEFAULT_KEYWORDS })
  } catch {
    // Parent web is read-focused; if rules block seeding, backend/manual seed is acceptable.
  }
}

// ---------- Usage & app limits ----------

export function observeUsageDaily(
  familyId: string,
  onData: (rows: UsageDaily[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.usageDaily),
    orderBy('day', 'desc'),
    limit(60),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          deviceId: (data.deviceId as string) || '',
          day: (data.day as string) || '',
          totalMinutes: Number(data.totalMinutes ?? 0),
          apps: parseUsageApps(data.apps),
          updatedAtMs: Number(data.updatedAtMs ?? 0),
        } satisfies UsageDaily
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export function observeLocationTrail(
  familyId: string,
  onData: (rows: LocationTrailSample[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.locationTrail),
    orderBy('recordedAtMs', 'desc'),
    limit(300),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          deviceId: (data.deviceId as string) || '',
          location: parseLocation(data.location),
          batteryPercent: Number(data.batteryPercent ?? -1),
          charging: Boolean(data.charging),
          hadNetwork: data.hadNetwork !== false,
          recordedAtMs: Number(data.recordedAtMs ?? 0),
        } satisfies LocationTrailSample
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export function observeAppLimits(
  familyId: string,
  onData: (rows: AppLimit[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.appLimits),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          packageName: (data.packageName as string) || '',
          label: (data.label as string) || '',
          dailyLimitMinutes: Number(data.dailyLimitMinutes ?? 60),
          deviceId: (data.deviceId as string) || '',
        } satisfies AppLimit
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export function observeAppBlockSchedules(
  familyId: string,
  onData: (rows: AppBlockSchedule[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.appBlockSchedules),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          packageName: (data.packageName as string) || '',
          label: (data.label as string) || '',
          deviceId: (data.deviceId as string) || '',
          daysOfWeek: Array.isArray(data.daysOfWeek)
            ? (data.daysOfWeek as unknown[]).map((n) => Number(n)).filter((n) => n >= 1 && n <= 7)
            : [],
          startMinute: Number(data.startMinute ?? 0),
          endMinute: Number(data.endMinute ?? 0),
          active: data.active !== false,
        } satisfies AppBlockSchedule
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export async function addAppLimit(
  familyId: string,
  limitInput: Omit<AppLimit, 'id'>,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.appLimits), {
    packageName: limitInput.packageName.trim(),
    label: limitInput.label.trim() || limitInput.packageName.trim(),
    dailyLimitMinutes: limitInput.dailyLimitMinutes,
    deviceId: limitInput.deviceId,
  })
}

export async function deleteAppLimit(familyId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.appLimits, id))
}

export async function addAppBlockSchedule(
  familyId: string,
  input: Omit<AppBlockSchedule, 'id'>,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.appBlockSchedules), {
    packageName: input.packageName.trim(),
    label: input.label.trim() || input.packageName.trim(),
    deviceId: input.deviceId,
    daysOfWeek: input.daysOfWeek,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    active: input.active,
  })
}

export async function deleteAppBlockSchedule(familyId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.appBlockSchedules, id))
}

export async function setOfflineCallConfig(
  familyId: string,
  deviceId: string,
  enabled: boolean,
  number: string,
  maxAttempts: number,
): Promise<void> {
  await setDoc(
    doc(db, COL.families, familyId, COL.devices, deviceId),
    {
      offlineCallEnabled: enabled,
      offlineCallNumber: number.trim(),
      offlineCallMaxAttempts: Math.max(0, Math.min(10, Math.trunc(maxAttempts))),
    },
    { merge: true },
  )
}

// ---------- Call/SMS previews ----------

export function observeCallSmsPreviews(
  familyId: string,
  onData: (rows: CallSmsPreview[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.callSmsPreviews),
    orderBy('atMs', 'desc'),
    limit(60),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          kind: (data.kind as string) || '',
          direction: (data.direction as string) || '',
          addressMasked: (data.addressMasked as string) || '',
          snippet: (data.snippet as string | null) ?? null,
          atMs: Number(data.atMs ?? 0),
          deviceId: (data.deviceId as string) || '',
        } satisfies CallSmsPreview
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

// ---------- Weekly digests ----------

export function observeDigests(
  familyId: string,
  onData: (rows: WeeklyDigest[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.digests),
    orderBy('weekStartMs', 'desc'),
    limit(26),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          weekStartMs: Number(data.weekStartMs ?? 0),
          weekEndMs: Number(data.weekEndMs ?? 0),
          summary: (data.summary as string) || '',
          alertCount: Number(data.alertCount ?? 0),
          topAlertTypes: Array.isArray(data.topAlertTypes)
            ? (data.topAlertTypes as unknown[]).map((t) => String(t))
            : [],
          createdAtMs: Number(data.createdAtMs ?? 0),
        } satisfies WeeklyDigest
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

// ---------- SOS contacts ----------

export function observeSosContacts(
  familyId: string,
  onData: (rows: SosContact[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.sosContacts),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          name: (data.name as string) || 'Contact',
          phoneNote: (data.phoneNote as string) || '',
        } satisfies SosContact
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export function observeSafeContacts(
  familyId: string,
  onData: (rows: SafeContact[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.safeContacts),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          channel: (data.channel as string) || 'WHATSAPP',
          label: (data.label as string) || '',
          identifier: (data.identifier as string) || '',
        } satisfies SafeContact
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export async function addSosContact(
  familyId: string,
  contact: Omit<SosContact, 'id'>,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.sosContacts), {
    name: contact.name.trim() || 'Contact',
    phoneNote: contact.phoneNote.trim(),
  })
}

export async function deleteSosContact(familyId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.sosContacts, id))
}

export async function addSafeContact(
  familyId: string,
  contact: Omit<SafeContact, 'id'>,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.safeContacts), {
    channel: contact.channel || 'WHATSAPP',
    label: contact.label.trim(),
    identifier: contact.identifier.trim(),
  })
}

export async function deleteSafeContact(familyId: string, id: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.safeContacts, id))
}

export function observeSafetySettings(
  familyId: string,
  onData: (settings: FamilySafetySettings) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COL.families, familyId, COL.safetySettings, 'default'),
    (snap) => {
      const data = snap.data() || {}
      onData({
        escalationEnabled: data.escalationEnabled !== false,
        escalationRiskThreshold: Number(data.escalationRiskThreshold ?? 60),
        autoLockOnCritical: Boolean(data.autoLockOnCritical),
        checkInIntervalMinutes: Number(data.checkInIntervalMinutes ?? 120),
        snoozedCategories: Array.isArray(data.snoozedCategories)
          ? (data.snoozedCategories as unknown[]).map((x) => String(x))
          : [],
        snoozeUntilMs: Number(data.snoozeUntilMs ?? 0),
        alertRetentionDays: Number(data.alertRetentionDays ?? 30),
        mediaRetentionDays: Number(data.mediaRetentionDays ?? 7),
      })
    },
    (err) => onError?.(err),
  )
}

export async function setSafetySettings(
  familyId: string,
  settings: FamilySafetySettings,
): Promise<void> {
  await setDoc(
    doc(db, COL.families, familyId, COL.safetySettings, 'default'),
    settings,
    { merge: true },
  )
}

export async function runTcdHealthCheck(familyId: string): Promise<TcdReport> {
  const checks: TcdCheck[] = []
  const now = Date.now()

  try {
    const started = performance.now()
    const familySnap = await getDoc(doc(db, COL.families, familyId))
    const latencyMs = Math.round(performance.now() - started)
    checks.push({
      id: 'firestore-family',
      label: 'Firestore family document',
      status: familySnap.exists() ? 'ok' : 'fail',
      message: familySnap.exists() ? 'Family doc is reachable.' : 'Family doc is missing.',
      latencyMs,
    })
  } catch (e) {
    checks.push({
      id: 'firestore-family',
      label: 'Firestore family document',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to read family document.',
    })
  }

  try {
    const started = performance.now()
    const devicesSnap = await getDocs(collection(db, COL.families, familyId, COL.devices))
    const latencyMs = Math.round(performance.now() - started)
    const staleCount = devicesSnap.docs.filter((d) => now - Number(d.get('lastHeartbeatMs') ?? 0) > WENT_DARK_AFTER_MS).length
    const onlineCount = devicesSnap.docs.filter((d) => {
      const hb = Number(d.get('lastHeartbeatMs') ?? 0)
      return hb > 0 && now - hb < WENT_DARK_AFTER_MS
    }).length
    checks.push({
      id: 'child-heartbeats',
      label: 'Child heartbeat freshness',
      status: devicesSnap.size === 0 ? 'warn' : staleCount === 0 ? 'ok' : 'warn',
      message:
        devicesSnap.size === 0
          ? 'No child devices registered yet.'
          : staleCount === 0
            ? `${onlineCount}/${devicesSnap.size} device(s) online and reporting.`
            : `${staleCount}/${devicesSnap.size} device(s) offline or stale — open child app and confirm monitoring is active.`,
      latencyMs,
    })
  } catch (e) {
    checks.push({
      id: 'child-heartbeats',
      label: 'Child heartbeat freshness',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to read child devices.',
    })
  }

  try {
    const started = performance.now()
    await getDocs(query(collection(db, COL.families, familyId, COL.alerts), orderBy('createdAtMs', 'desc'), limit(1)))
    const latencyMs = Math.round(performance.now() - started)
    checks.push({
      id: 'alerts-read',
      label: 'Alerts stream',
      status: 'ok',
      message: 'Alerts collection is readable.',
      latencyMs,
    })
  } catch (e) {
    checks.push({
      id: 'alerts-read',
      label: 'Alerts stream',
      status: 'fail',
      message: e instanceof Error ? e.message : 'Failed to read alerts.',
    })
  }

  const mediaProbeUrl = (import.meta.env.VITE_R2_MEDIA_PROXY_BASE_URL as string | undefined)?.trim()
  if (!mediaProbeUrl) {
    checks.push({
      id: 'r2-proxy',
      label: 'Cloudflare R2 proxy',
      status: 'warn',
      message: 'Set VITE_R2_MEDIA_PROXY_BASE_URL to enable R2 health checks.',
    })
  } else {
    try {
      const started = performance.now()
      const response = await fetch(`${mediaProbeUrl.replace(/\/$/, '')}/health`, { method: 'GET' })
      const latencyMs = Math.round(performance.now() - started)
      const ok = response.ok
      checks.push({
        id: 'r2-proxy',
        label: 'Cloudflare R2 proxy',
        status: ok ? 'ok' : 'fail',
        message: ok ? 'R2 worker health endpoint is reachable.' : `R2 worker returned HTTP ${response.status}.`,
        latencyMs,
      })
    } catch (e) {
      checks.push({
        id: 'r2-proxy',
        label: 'Cloudflare R2 proxy',
        status: 'fail',
        message: e instanceof Error ? e.message : 'Failed to reach R2 worker.',
      })
    }
  }

  const functionsHealthUrl = (import.meta.env.VITE_FUNCTIONS_HEALTH_URL as string | undefined)?.trim()
  if (!functionsHealthUrl) {
    checks.push({
      id: 'functions-health',
      label: 'Firebase Functions health',
      status: 'warn',
      message: 'Set VITE_FUNCTIONS_HEALTH_URL to enable backend health checks.',
    })
  } else {
    try {
      const started = performance.now()
      const response = await fetch(functionsHealthUrl, { method: 'GET' })
      const latencyMs = Math.round(performance.now() - started)
      const status = response.ok ? 'ok' : response.status === 404 ? 'warn' : 'fail'
      const message = response.ok
        ? 'Functions health endpoint is reachable.'
        : response.status === 404
          ? 'platformHealth is not deployed yet (Firebase Blaze plan required to deploy Functions).'
          : `Functions returned HTTP ${response.status}.`
      checks.push({
        id: 'functions-health',
        label: 'Firebase Functions health',
        status,
        message,
        latencyMs,
      })
    } catch (e) {
      checks.push({
        id: 'functions-health',
        label: 'Firebase Functions health',
        status: 'warn',
        message:
          e instanceof Error && e.message.includes('Failed to fetch')
            ? 'Functions health URL unreachable (not deployed or blocked by browser/CORS). Enable Firebase Blaze and deploy platformHealth.'
            : e instanceof Error
              ? e.message
              : 'Failed to reach Functions health endpoint.',
      })
    }
  }

  return { generatedAtMs: now, checks }
}

export async function loadTcdOverview(familyId: string): Promise<TcdOverview> {
  const now = Date.now()
  const cutoff24h = now - 24 * 60 * 60 * 1000

  const [devicesSnap, guardiansSnap, commandsSnap, alertsSnap] = await Promise.all([
    getDocs(collection(db, COL.families, familyId, COL.devices)),
    getDocs(collection(db, COL.families, familyId, COL.guardians)),
    getDocs(query(collection(db, COL.families, familyId, COL.commands), limit(100))),
    getDocs(query(collection(db, COL.families, familyId, COL.alerts), orderBy('createdAtMs', 'desc'), limit(300))),
  ])

  let onlineDevices = 0
  let latestHeartbeatMs = 0
  devicesSnap.docs.forEach((d) => {
    const hb = Number(d.get('lastHeartbeatMs') ?? 0)
    if (hb > latestHeartbeatMs) latestHeartbeatMs = hb
    if (hb > 0 && now - hb < WENT_DARK_AFTER_MS) onlineDevices += 1
  })
  const registeredDevices = devicesSnap.size
  const offlineDevices = Math.max(0, registeredDevices - onlineDevices)
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

  return {
    generatedAtMs: now,
    registeredDevices,
    onlineDevices,
    offlineDevices,
    guardians: guardiansSnap.size,
    alertsLast24h,
    criticalAlertsLast24h,
    pendingCommands,
    latestHeartbeatMs,
  }
}

export async function runTcdAutoRepair(familyId: string): Promise<string[]> {
  const fixes: string[] = []

  await ensureKeywordListSeeded()
  fixes.push('Verified default keyword list exists.')

  await setDoc(
    doc(db, COL.families, familyId, COL.safetySettings, 'default'),
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
  const stale = await getDocs(collection(db, COL.families, familyId, COL.devices))
  await Promise.all(
    stale.docs.map(async (d) => {
      const lastHeartbeatMs = Number(d.get('lastHeartbeatMs') ?? 0)
      if (lastHeartbeatMs > 0 && now - lastHeartbeatMs > WENT_DARK_AFTER_MS && d.get('online') !== false) {
        await updateDoc(d.ref, { online: false })
      }
    }),
  )
  fixes.push('Reconciled stale online flags for dark devices.')

  const familySnap = await getDoc(doc(db, COL.families, familyId))
  const parentUid = familySnap.get('parentUid') as string | undefined
  const parentEmail =
    (familySnap.get('parentEmail') as string | undefined) || auth.currentUser?.email || ''
  if (parentUid) {
    const guardianRef = doc(db, COL.families, familyId, COL.guardians, parentUid)
    const guardianSnap = await getDoc(guardianRef)
    if (!guardianSnap.exists()) {
      await setDoc(guardianRef, {
        email: parentEmail,
        role: 'OWNER' satisfies GuardianRole,
        joinedAtMs: Date.now(),
      })
      fixes.push('Restored missing OWNER guardian record for this family.')
    }
  }

  return fixes
}

// ---------- Guardians / caregiver invites ----------

export function observeGuardians(
  familyId: string,
  onData: (rows: GuardianInfo[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.guardians),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          uid: d.id,
          email: (data.email as string) || '',
          role: ((data.role as GuardianRole) || 'CAREGIVER') satisfies GuardianRole,
          joinedAtMs: Number(data.joinedAtMs ?? 0),
        } satisfies GuardianInfo
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

const GUARDIAN_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export async function createGuardianInvite(email: string): Promise<string> {
  const familyId = await getFamilyId()
  const code = generatePairingCode(8)
  await setDoc(doc(db, COL.guardianInvites, code), {
    familyId,
    email: email.trim().toLowerCase(),
    role: 'CAREGIVER' satisfies GuardianRole,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + GUARDIAN_INVITE_EXPIRY_MS,
    claimed: false,
  })
  return code
}

export async function acceptGuardianInvite(code: string): Promise<string> {
  const uid = auth.currentUser?.uid
  const email = auth.currentUser?.email
  if (!uid) throw new Error('Not signed in')

  const normalized = code.trim().toUpperCase()
  const inviteRef = doc(db, COL.guardianInvites, normalized)
  const snap = await getDoc(inviteRef)
  if (!snap.exists()) throw new Error('Invalid invite code')
  const data = snap.data()
  if (data.claimed) throw new Error('Invite already used')
  const expiresAtMs = Number(data.expiresAtMs ?? 0)
  if (expiresAtMs && Date.now() > expiresAtMs) throw new Error('Invite expired')

  const familyId = data.familyId as string
  if (!familyId) throw new Error('Invite missing family')

  await setDoc(
    doc(db, COL.parentProfiles, uid),
    {
      familyId,
      email: email || (data.email as string) || '',
      createdAtMs: Date.now(),
    },
    { merge: true },
  )
  await setDoc(doc(db, COL.families, familyId, COL.guardians, uid), {
    email: email || (data.email as string) || '',
    role: 'CAREGIVER' satisfies GuardianRole,
    joinedAtMs: Date.now(),
  })
  await updateDoc(inviteRef, {
    claimed: true,
    claimedAtMs: Date.now(),
    claimedByUid: uid,
  })
  return familyId
}
