import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth'
import {
  addDoc,
  arrayRemove,
  arrayUnion,
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
  where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, COL, db, functions, WENT_DARK_AFTER_MS } from '../firebase'
import { isProjectAdmin } from './admin'
import { DEFAULT_KEYWORDS, generatePairingCode } from './helpers'
import { TOS_VERSION } from './legal'
import type {
  AdminParentAccountRow,
  AppBlockSchedule,
  AppLimit,
  CallSmsPreview,
  DeviceStatus,
  FamilyAlert,
  FamilyChatMessage,
  FamilySafetySettings,
  GeofenceZone,
  GuardianInfo,
  GuardianRole,
  LocationTrailSample,
  MapPlace,
  ParentProfileInfo,
  PlaceKind,
  SafeContact,
  SafetyCommand,
  SosContact,
  TcdCheck,
  TcdOverview,
  TcdReport,
  TrialInfo,
  TypingSafetyEvent,
  TypingSafetySettings,
  UsageDaily,
  WeeklyDigest,
  WhatsAppEvent,
  WhatsAppEventType,
  WhatsAppProtectionStatus,
  CallRecording,
  CallRecordingStatus,
  CallRecordingType,
  DevicePhoto,
  PhotoGalleryAccessLevel,
  PhotoGalleryStatus,
  EventRecorderStatus,
  LockScreenStatus,
  ActivityEvent,
  ActivityEventType,
} from '../types'
import { parseBatteryHistory, parseLocation, parseUsageApps } from '../types'

export const TRIAL_DAYS = 30

/**
 * Bootstrap fields for a brand-new parentProfiles/{uid} doc. `plan`/`status` are their
 * own small object (not spread across many booleans) so a later "paid" plan can reuse
 * the same shape (e.g. status stays "active", plan flips to "paid", trialEndsAt is
 * simply ignored) without a data-model migration.
 */
function newTrialFields(now: number) {
  return {
    plan: 'trial' as const,
    status: 'active' as const,
    trialStartedAt: now,
    trialEndsAt: now + TRIAL_DAYS * 24 * 60 * 60 * 1000,
    lastLoginAt: now,
    lastParentCheckInAt: now,
    lastActiveAt: now,
  }
}

function parseTrialInfo(data: Record<string, unknown> | undefined): TrialInfo | null {
  if (!data || data.plan == null) return null
  return {
    plan: (data.plan as TrialInfo['plan']) || 'trial',
    status: (data.status as TrialInfo['status']) || 'active',
    trialStartedAt: Number(data.trialStartedAt ?? 0),
    trialEndsAt: Number(data.trialEndsAt ?? 0),
    paidUntilMs: data.paidUntilMs == null ? null : Number(data.paidUntilMs),
    lastLoginAt: data.lastLoginAt == null ? null : Number(data.lastLoginAt),
    lastParentCheckInAt: data.lastParentCheckInAt == null ? null : Number(data.lastParentCheckInAt),
  }
}

function parseParentProfile(data: Record<string, unknown> | undefined): ParentProfileInfo {
  const familyId = (data?.familyId as string | undefined) ?? null
  return {
    familyId,
    ownedFamilyId: (data?.ownedFamilyId as string | undefined) ?? familyId,
    email: (data?.email as string | undefined) ?? '',
    createdAtMs: Number(data?.createdAtMs ?? 0),
    registeredAt: data?.registeredAt == null ? null : Number(data.registeredAt),
    tosAcceptedAt: data?.tosAcceptedAt == null ? null : Number(data.tosAcceptedAt),
    tosVersion: (data?.tosVersion as string | undefined) ?? null,
    privacyAcceptedAt: data?.privacyAcceptedAt == null ? null : Number(data.privacyAcceptedAt),
    lastLoginAt: data?.lastLoginAt == null ? null : Number(data.lastLoginAt),
    lastActiveAt: data?.lastActiveAt == null ? null : Number(data.lastActiveAt),
    trial: parseTrialInfo(data),
    adminBlocked: Boolean(data?.adminBlocked),
    accountStatus: (data?.status as string | undefined) ?? null,
  }
}

/** True when this uid is the family owner or has an explicit guardians/{uid} membership row. */
async function verifyFamilyAccess(uid: string, familyId: string): Promise<boolean> {
  const [guardianSnap, familySnap] = await Promise.all([
    getDoc(doc(db, COL.families, familyId, COL.guardians, uid)),
    getDoc(doc(db, COL.families, familyId)),
  ])
  if (guardianSnap.exists()) return true
  return familySnap.exists() && familySnap.data()?.parentUid === uid
}

type BootstrapExtras = {
  withLegal?: boolean
  preserve?: Record<string, unknown>
}

async function bootstrapNewOwnerFamily(
  uid: string,
  email: string,
  extras: BootstrapExtras = {},
): Promise<string> {
  const now = Date.now()
  const familyRef = doc(collection(db, COL.families))
  const legalFields = extras.withLegal
    ? {
        tosAcceptedAt: now,
        tosVersion: TOS_VERSION,
        privacyAcceptedAt: now,
      }
    : {}
  await setDoc(familyRef, {
    parentUid: uid,
    createdAtMs: now,
    parentEmail: email,
  })
  await setDoc(doc(db, COL.families, familyRef.id, COL.guardians, uid), {
    email,
    role: 'OWNER' satisfies GuardianRole,
    joinedAtMs: now,
  })
  await setDoc(
    doc(db, COL.parentProfiles, uid),
    {
      familyId: familyRef.id,
      ownedFamilyId: familyRef.id,
      email,
      createdAtMs: now,
      registeredAt: now,
      ...newTrialFields(now),
      ...legalFields,
      ...(extras.preserve ?? {}),
    },
    { merge: true },
  )
  return familyRef.id
}

/**
 * Ensures every signed-in parent has a private family they are allowed to access.
 * Repairs legacy/corrupt rows that pointed new accounts at another family's id.
 */
export async function ensureParentProfile(uid: string, email: string): Promise<string> {
  const profileRef = doc(db, COL.parentProfiles, uid)
  const profileSnap = await getDoc(profileRef)
  if (!profileSnap.exists()) {
    return bootstrapNewOwnerFamily(uid, email)
  }

  const data = profileSnap.data() ?? {}
  const familyId = data.familyId as string | undefined
  if (!familyId) {
    return bootstrapNewOwnerFamily(uid, email, {
      preserve: {
        tosAcceptedAt: data.tosAcceptedAt,
        tosVersion: data.tosVersion,
        privacyAcceptedAt: data.privacyAcceptedAt,
        plan: data.plan,
        status: data.status,
        trialStartedAt: data.trialStartedAt,
        trialEndsAt: data.trialEndsAt,
        registeredAt: data.registeredAt ?? data.createdAtMs,
      },
    })
  }

  const allowed = await verifyFamilyAccess(uid, familyId)
  if (!allowed) {
    console.warn('[SareChild] Repaired cross-tenant family link for', uid, 'away from', familyId)
    return bootstrapNewOwnerFamily(uid, email, {
      preserve: {
        tosAcceptedAt: data.tosAcceptedAt,
        tosVersion: data.tosVersion,
        privacyAcceptedAt: data.privacyAcceptedAt,
        plan: data.plan,
        status: data.status,
        trialStartedAt: data.trialStartedAt,
        trialEndsAt: data.trialEndsAt,
        registeredAt: data.registeredAt ?? data.createdAtMs,
      },
    })
  }

  if (!data.ownedFamilyId) {
    const ownedFamilyId =
      (await getDoc(doc(db, COL.families, familyId))).data()?.parentUid === uid ? familyId : null
    if (ownedFamilyId) {
      await setDoc(profileRef, { ownedFamilyId }, { merge: true })
    }
  }

  return familyId
}

export async function signUp(
  email: string,
  password: string,
  acceptLegal: boolean,
): Promise<string> {
  if (!acceptLegal) {
    throw new Error('You must accept the Terms of Service and Privacy Policy to register.')
  }
  const result = await createUserWithEmailAndPassword(auth, email, password)
  return bootstrapNewOwnerFamily(result.user.uid, email, { withLegal: true })
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password)
}

/**
 * Signs in (or signs up, on first use) with Google via a popup. New Google users get the same
 * family/guardian bootstrap as email signups; returning users simply resume their existing family.
 */
export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider()
  const result = await signInWithPopup(auth, provider)
  await ensureParentProfile(result.user.uid, result.user.email ?? '')
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth)
}

export async function getFamilyId(): Promise<string> {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Not signed in')
  const email = auth.currentUser?.email ?? ''
  return ensureParentProfile(uid, email)
}

export async function acceptTermsOfService(): Promise<void> {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Not signed in')
  const now = Date.now()
  await setDoc(
    doc(db, COL.parentProfiles, uid),
    {
      tosAcceptedAt: now,
      tosVersion: TOS_VERSION,
      privacyAcceptedAt: now,
      registeredAt: now,
    },
    { merge: true },
  )
}

export function observeParentProfile(
  uid: string,
  onData: (profile: ParentProfileInfo | null) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COL.parentProfiles, uid),
    (snap) => {
      if (!snap.exists()) {
        onData(null)
        return
      }
      onData(parseParentProfile(snap.data()))
    },
    (err) => onError?.(err),
  )
}

export function needsTermsAcceptance(profile: ParentProfileInfo | null): boolean {
  if (!profile) return true
  return profile.tosAcceptedAt == null || profile.tosVersion !== TOS_VERSION
}

// ---------- Trial subscription tracking ----------
// See functions/src/index.ts purgeInactiveTrials for the server-side purge rule that
// consumes lastLoginAt / lastParentCheckInAt, and the README "Trial model" section for
// the plain-language product rule.

export function observeTrialInfo(
  uid: string,
  onData: (info: TrialInfo | null) => void,
  onError?: (err: Error) => void,
): () => void {
  return observeParentProfile(uid, (profile) => onData(profile?.trial ?? null), onError)
}

const CHECKIN_THROTTLE_MS = 60 * 60 * 1000 // once per hour, per the product spec

/** Called once per sign-in / app open. Throttled client-side to avoid write spam. */
export async function recordLogin(uid: string): Promise<void> {
  const key = `sarechild:lastLoginWriteMs:${uid}`
  const last = Number(localStorage.getItem(key) ?? 0)
  const now = Date.now()
  if (now - last < CHECKIN_THROTTLE_MS) return
  localStorage.setItem(key, String(now))
  await setDoc(
    doc(db, COL.parentProfiles, uid),
    { lastLoginAt: now, lastActiveAt: now },
    { merge: true },
  ).catch(() => {
    // Best-effort — a purged account's profile write will be denied by rules; that's fine.
  })
}

/**
 * Called whenever the parent actively checks on their kids: opening the dashboard,
 * viewing a device, or viewing alerts. Throttled to once/hour so normal browsing
 * doesn't spam Firestore writes.
 */
export async function recordParentCheckIn(uid: string): Promise<void> {
  const key = `sarechild:lastCheckInWriteMs:${uid}`
  const last = Number(localStorage.getItem(key) ?? 0)
  const now = Date.now()
  if (now - last < CHECKIN_THROTTLE_MS) return
  localStorage.setItem(key, String(now))
  await setDoc(
    doc(db, COL.parentProfiles, uid),
    { lastParentCheckInAt: now, lastActiveAt: now },
    { merge: true },
  ).catch(() => {
    // Best-effort — see recordLogin.
  })
}

/**
 * Cascade-deletes a paired device: the device doc + its subcollections, every
 * family-level record tied to it (alerts, location trail, photos, WhatsApp
 * events, call recordings, commands, etc.), its R2/Storage media, and its
 * D1/KV edge cache rows. Runs server-side via the deletePairedDevice Cloud
 * Function (functions/src/deviceDelete.ts) — client-only Firestore delete
 * can't reach subcollections or object storage. Irreversible.
 */
export async function deletePairedDevice(
  familyId: string,
  deviceId: string,
): Promise<{ ok: boolean; deviceId: string; childName: string }> {
  const call = httpsCallable<
    { familyId: string; deviceId: string },
    { ok: boolean; deviceId: string; childName: string }
  >(functions, 'deletePairedDevice')
  const result = await call({ familyId, deviceId })
  return result.data
}

/** Redeem a reseller voucher onto the signed-in parent account. */
export async function redeemVoucher(code: string): Promise<{ planDays: number; paidUntilMs: number }> {
  const call = httpsCallable<
    { code: string },
    { ok: boolean; planDays: number; paidUntilMs: number }
  >(functions, 'redeemVoucher')
  const result = await call({ code: code.trim().toUpperCase() })
  return { planDays: result.data.planDays, paidUntilMs: result.data.paidUntilMs }
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

function parseWhatsAppProtection(raw: unknown): WhatsAppProtectionStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  return {
    enabled: Boolean(data.enabled),
    consent: Boolean(data.consent),
    notificationAccess: Boolean(data.notificationAccess),
    accessibilityAccess: Boolean(data.accessibilityAccess),
    outgoingCaptureReady: Boolean(data.outgoingCaptureReady),
    mediaPermission: Boolean(data.mediaPermission),
    lastEventAtMs: Number(data.lastEventAtMs ?? 0),
    updatedAtMs: Number(data.updatedAtMs ?? 0),
  }
}

function parseCallRecordingStatus(raw: unknown): CallRecordingStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  return {
    consent: Boolean(data.consent),
    enabled: Boolean(data.enabled),
    micPermission: Boolean(data.micPermission),
    phoneStatePermission: Boolean(data.phoneStatePermission),
    lastRecordingAtMs: Number(data.lastRecordingAtMs ?? 0),
    updatedAtMs: Number(data.updatedAtMs ?? 0),
  }
}

function parsePhotoGalleryStatus(raw: unknown): PhotoGalleryStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const accessRaw = String(data.accessLevel ?? 'NONE').toUpperCase()
  const accessLevel: PhotoGalleryAccessLevel =
    accessRaw === 'FULL' || accessRaw === 'PARTIAL' ? accessRaw : 'NONE'
  return {
    consent: Boolean(data.consent),
    permissionGranted: Boolean(data.permissionGranted),
    accessLevel,
    lastSyncAtMs: Number(data.lastSyncAtMs ?? 0),
    photoCount: Number(data.photoCount ?? 0),
    lastError: (data.lastError as string | null) ?? null,
  }
}

function parseEventRecorderStatus(raw: unknown): EventRecorderStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  return {
    consent: Boolean(data.consent),
    usageAccess: Boolean(data.usageAccess),
    accessibilityAccess: Boolean(data.accessibilityAccess),
    notificationAccess: Boolean(data.notificationAccess),
    lastSyncAtMs: Number(data.lastSyncAtMs ?? 0),
    eventCount24h: Number(data.eventCount24h ?? 0),
    screenOn: data.screenOn == null ? undefined : Boolean(data.screenOn),
    updatedAtMs: Number(data.updatedAtMs ?? 0),
  }
}

function parseLockScreenStatus(raw: unknown): LockScreenStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  return {
    deviceAdminActive: Boolean(data.deviceAdminActive),
    lastLockAtMs: Number(data.lastLockAtMs ?? 0),
    lastLockResult: (data.lastLockResult as string | null) ?? null,
    updatedAtMs: Number(data.updatedAtMs ?? 0),
  }
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
          whatsappMonitorConsent: Boolean(data.whatsappMonitorConsent),
          whatsappMediaPermission: Boolean(data.whatsappMediaPermission),
          lastWhatsAppEventAtMs: Number(data.lastWhatsAppEventAtMs ?? 0),
          whatsappProtection: parseWhatsAppProtection(data.whatsappProtection),
          callRecordingConsent: Boolean(data.callRecordingConsent),
          callRecordingEnabled: Boolean(data.callRecordingEnabled),
          lastCallRecordingAtMs: Number(data.lastCallRecordingAtMs ?? 0),
          callRecordingStatus: parseCallRecordingStatus(data.callRecordingStatus),
          photoGalleryConsent: Boolean(data.photoGalleryConsent),
          photoGalleryStatus: parsePhotoGalleryStatus(data.photoGalleryStatus),
          eventRecorderConsent: Boolean(data.eventRecorderConsent),
          eventRecorderStatus: parseEventRecorderStatus(data.eventRecorderStatus),
          lockScreenStatus: parseLockScreenStatus(data.lockScreenStatus),
          chatOnline: Boolean(data.chatOnline),
          chatLastSeenMs: Number(data.chatLastSeenMs ?? 0),
          offlineCallEnabled: Boolean(data.offlineCallEnabled),
          offlineCallNumber: (data.offlineCallNumber as string | null) ?? null,
          offlineCallMaxAttempts: Number(data.offlineCallMaxAttempts ?? 0),
          activeSession: (data.activeSession as string | null) ?? null,
          latestFrameUrl: (data.latestFrameUrl as string | null) ?? null,
          todayScreenMinutes: Number(data.todayScreenMinutes ?? 0),
          assignedGuardianUids: Array.isArray(data.assignedGuardianUids)
            ? (data.assignedGuardianUids as string[])
            : [],
          chatReads: (data.chatReads as Record<string, number> | undefined) ?? {},
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

// ---------------------------------------------------------------------------
// Map places (Home / School / Work / Custom pins for the Live Map control
// center). Kept as their own collection rather than reusing `geofences` so a
// parent can label a spot on the map without it also becoming an on-device
// enter/exit alert rule — those two concerns can still be linked manually by
// creating a geofence at the same coordinates.
// ---------------------------------------------------------------------------

export function observeMapPlaces(
  familyId: string,
  onData: (places: MapPlace[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, COL.families, familyId, COL.mapPlaces),
    (snap) => {
      const places = snap.docs.map((d) => {
        const data = d.data()
        const kind = (data.kind as string) || 'custom'
        return {
          id: d.id,
          name: (data.name as string) || 'Place',
          kind: (['home', 'school', 'work', 'custom'].includes(kind) ? kind : 'custom') as PlaceKind,
          lat: Number(data.lat ?? 0),
          lng: Number(data.lng ?? 0),
          radiusM: Number(data.radiusM ?? 100),
          createdAtMs: Number(data.createdAtMs ?? 0),
        } satisfies MapPlace
      })
      onData(places)
    },
    (err) => onError?.(err),
  )
}

export async function addMapPlace(
  familyId: string,
  place: Omit<MapPlace, 'id' | 'createdAtMs'>,
): Promise<void> {
  await addDoc(collection(db, COL.families, familyId, COL.mapPlaces), {
    name: place.name,
    kind: place.kind,
    lat: place.lat,
    lng: place.lng,
    radiusM: place.radiusM,
    createdAtMs: Date.now(),
  })
}

export async function updateMapPlace(
  familyId: string,
  placeId: string,
  patch: Partial<Omit<MapPlace, 'id' | 'createdAtMs'>>,
): Promise<void> {
  await updateDoc(doc(db, COL.families, familyId, COL.mapPlaces, placeId), { ...patch })
}

export async function deleteMapPlace(familyId: string, placeId: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.mapPlaces, placeId))
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
  | 'LOCK_SCREEN'
  | 'REQUEST_DEVICE_ADMIN'
  | 'REQUEST_WHATSAPP_PROTECTION'
  | 'REQUEST_CALL_RECORDING'
  | 'REQUEST_APP_INVENTORY'
  | 'REQUEST_PHOTO_ACCESS'
  | 'REQUEST_PHOTO_SYNC'
  | 'REQUEST_EVENT_RECORDER_ACCESS'
  | 'REQUEST_EVENT_RECORDER_SYNC'
  | 'START_LIVE_VIEW'
  | 'STOP_LIVE_VIEW'

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

/**
 * Live per-device location trail listener — used by the Live Map control center instead of
 * (or alongside) the shared family-wide `observeLocationTrail` above. That shared listener caps
 * at 300 samples *across every device in the family*, which starves a specific child's live
 * trail once a family has more than one or two paired devices (the classic "live view doesn't
 * clearly show movement" bug report: new points exist in Firestore, but this device's slice of
 * the shared 300-row window is too thin/stale to render a smooth trail). Requires a composite
 * index on (deviceId ASC, recordedAtMs DESC) — see firestore.indexes.json.
 */
export function observeLocationTrailForDevice(
  familyId: string,
  deviceId: string,
  onData: (rows: LocationTrailSample[]) => void,
  onError?: (err: Error) => void,
  maxSamples = 200,
): () => void {
  if (!deviceId) {
    onData([])
    return () => {}
  }
  const q = query(
    collection(db, COL.families, familyId, COL.locationTrail),
    where('deviceId', '==', deviceId),
    orderBy('recordedAtMs', 'desc'),
    limit(maxSamples),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs
        .map((d) => {
          const data = d.data()
          return {
            id: d.id,
            deviceId: (data.deviceId as string) || deviceId,
            location: parseLocation(data.location),
            batteryPercent: Number(data.batteryPercent ?? -1),
            charging: Boolean(data.charging),
            hadNetwork: data.hadNetwork !== false,
            recordedAtMs: Number(data.recordedAtMs ?? 0),
          } satisfies LocationTrailSample
        })
        .sort((a, b) => a.recordedAtMs - b.recordedAtMs)
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

/**
 * One-shot fetch of location trail samples across the *whole family* (not
 * filtered by device — the live listener above already caps at the most
 * recent 300 samples across every device, which is too shallow a window for
 * "playback last 24h" once a family has more than a device or two). Callers
 * filter by `deviceId` client-side, same pattern the live dashboard already
 * uses. Only a single range filter on `recordedAtMs` (matching the `orderBy`)
 * is used so this stays a single-field index Firestore creates automatically
 * — no composite index / `firestore.indexes.json` change needed.
 */
export async function fetchLocationTrailRange(
  familyId: string,
  fromMs: number,
  toMs: number,
  maxSamples = 4000,
): Promise<LocationTrailSample[]> {
  const q = query(
    collection(db, COL.families, familyId, COL.locationTrail),
    where('recordedAtMs', '>=', fromMs),
    where('recordedAtMs', '<=', toMs),
    orderBy('recordedAtMs', 'asc'),
    limit(maxSamples),
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => {
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
          message: (data.message as string) || 'Application has been blocked.',
          createdAtMs: Number(data.createdAtMs ?? 0),
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
    message: input.message?.trim() || 'Application has been blocked.',
    createdAtMs: input.createdAtMs || Date.now(),
  })
}

export async function updateAppBlockSchedule(
  familyId: string,
  id: string,
  patch: Partial<Omit<AppBlockSchedule, 'id'>>,
): Promise<void> {
  await updateDoc(doc(db, COL.families, familyId, COL.appBlockSchedules, id), { ...patch })
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

// ---------- WhatsApp protection section ----------

const WHATSAPP_EVENT_TYPES: WhatsAppEventType[] = [
  'MESSAGE',
  'CALL',
  'IMAGE',
  'VOICE_NOTE',
  'VIDEO',
  'DOCUMENT',
  'UNKNOWN_CONTACT',
]

export async function deleteWhatsAppEvents(familyId: string, ids: string[]): Promise<void> {
  await Promise.all(
    ids.map((id) => deleteDoc(doc(db, COL.families, familyId, COL.whatsappEvents, id))),
  )
}

function mapWhatsAppEventDoc(d: { id: string; data: () => Record<string, unknown> }): WhatsAppEvent {
  const data = d.data()
  const rawType = String(data.eventType ?? 'MESSAGE') as WhatsAppEventType
  return {
    id: d.id,
    deviceId: (data.deviceId as string) || '',
    eventType: WHATSAPP_EVENT_TYPES.includes(rawType) ? rawType : 'MESSAGE',
    contactLabel: (data.contactLabel as string) || 'Unknown contact',
    contactSafe: Boolean(data.contactSafe),
    direction: (data.direction as string) || 'IN',
    preview: (data.preview as string | null) ?? null,
    mediaUrl: (data.mediaUrl as string | null) ?? null,
    mediaType: (data.mediaType as string | null) ?? null,
    durationSec: data.durationSec == null ? null : Number(data.durationSec),
    riskScore: data.riskScore == null ? null : Number(data.riskScore),
    riskFlag: Boolean(data.riskFlag),
    source: (data.source as string) || 'notification',
    createdAtMs: Number(data.createdAtMs ?? 0),
  }
}

/** Family-wide snapshot (limit 100) — used for nav badge counts only. */
export function observeWhatsAppEvents(
  familyId: string,
  onData: (rows: WhatsAppEvent[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.whatsappEvents),
    orderBy('createdAtMs', 'desc'),
    limit(100),
  )
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => mapWhatsAppEventDoc(d))),
    (err) => onError?.(err),
  )
}

function isFirestoreIndexError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  if (e.code === 'failed-precondition') return true
  const msg = e.message ?? ''
  return /requires an index|index is currently building|index.*building/i.test(msg)
}

/** Device-scoped WhatsApp timeline — primary listener for the protection tab. */
export function observeWhatsAppEventsForDevice(
  familyId: string,
  deviceId: string,
  onData: (rows: WhatsAppEvent[]) => void,
  onError?: (err: Error) => void,
  onIndexFallback?: (active: boolean) => void,
): () => void {
  const col = collection(db, COL.families, familyId, COL.whatsappEvents)
  const qPrimary = query(col, where('deviceId', '==', deviceId), orderBy('createdAtMs', 'desc'), limit(300))
  const qFallback = query(col, orderBy('createdAtMs', 'desc'), limit(1000))

  let primaryUnsub: (() => void) | null = null
  let fallbackUnsub: (() => void) | null = null
  let retryTimer: ReturnType<typeof setInterval> | null = null
  let usingFallback = false

  const clearRetry = () => {
    if (retryTimer != null) {
      clearInterval(retryTimer)
      retryTimer = null
    }
  }

  const stopFallback = () => {
    fallbackUnsub?.()
    fallbackUnsub = null
    if (usingFallback) {
      usingFallback = false
      onIndexFallback?.(false)
    }
    clearRetry()
  }

  const startFallback = () => {
    if (usingFallback) return
    usingFallback = true
    onIndexFallback?.(true)
    primaryUnsub?.()
    primaryUnsub = null

    fallbackUnsub = onSnapshot(
      qFallback,
      (snap) => {
        const rows = snap.docs
          .map((d) => mapWhatsAppEventDoc(d))
          .filter((r) => r.deviceId === deviceId)
          .slice(0, 300)
        onData(rows)
      },
      (err) => {
        if (!isFirestoreIndexError(err)) onError?.(err as Error)
      },
    )

    retryTimer = setInterval(() => attachPrimary(true), 45_000)
  }

  const attachPrimary = (isRetry: boolean) => {
    if (primaryUnsub && !isRetry) return
    if (isRetry) {
      primaryUnsub?.()
      primaryUnsub = null
    }

    const unsub = onSnapshot(
      qPrimary,
      (snap) => {
        stopFallback()
        onData(snap.docs.map((d) => mapWhatsAppEventDoc(d)))
      },
      (err) => {
        unsub()
        if (isFirestoreIndexError(err)) {
          if (!isRetry) startFallback()
        } else {
          onError?.(err as Error)
        }
      },
    )
    primaryUnsub = unsub
  }

  attachPrimary(false)

  return () => {
    primaryUnsub?.()
    fallbackUnsub?.()
    clearRetry()
  }
}

// ---------- Call recording section (native Android — not Cordova) ----------

const CALL_RECORDING_TYPES: CallRecordingType[] = ['CELLULAR', 'VOIP_PARTIAL', 'MISSED']

export function observeCallRecordings(
  familyId: string,
  onData: (rows: CallRecording[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.callRecordings),
    orderBy('createdAtMs', 'desc'),
    limit(200),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        const rawType = String(data.callType ?? 'CELLULAR') as CallRecordingType
        return {
          id: d.id,
          deviceId: (data.deviceId as string) || '',
          callType: CALL_RECORDING_TYPES.includes(rawType) ? rawType : 'CELLULAR',
          direction: (data.direction as string) || 'UNKNOWN',
          numberMasked: (data.numberMasked as string | null) ?? null,
          contactLabel: (data.contactLabel as string | null) ?? null,
          packageName: (data.packageName as string | null) ?? null,
          durationSec: Number(data.durationSec ?? 0),
          audioUrl: (data.audioUrl as string | null) ?? null,
          audioCaptured: Boolean(data.audioCaptured),
          audioSourceNote: (data.audioSourceNote as string | null) ?? null,
          createdAtMs: Number(data.createdAtMs ?? 0),
        } satisfies CallRecording
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

/** Nested under families/{familyId}/devices/{deviceId}/photos — newest first. */
export function observeDevicePhotos(
  familyId: string,
  deviceId: string,
  onData: (rows: DevicePhoto[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.devices, deviceId, COL.photos),
    orderBy('takenAtMs', 'desc'),
    limit(500),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          mediaStoreId: Number(data.mediaStoreId ?? d.id),
          displayName: (data.displayName as string) || '',
          sizeBytes: Number(data.sizeBytes ?? 0),
          takenAtMs: Number(data.takenAtMs ?? 0),
          modifiedAtMs: Number(data.modifiedAtMs ?? 0),
          mimeType: (data.mimeType as string) || 'image/jpeg',
          width: Number(data.width ?? 0),
          height: Number(data.height ?? 0),
          syncedAtMs: Number(data.syncedAtMs ?? 0),
          thumbPath: (data.thumbPath as string | null) ?? null,
          thumbUrl: (data.thumbUrl as string | null) ?? null,
          fullPath: (data.fullPath as string | null) ?? null,
          fullUrl: (data.fullUrl as string | null) ?? null,
        } satisfies DevicePhoto
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export function observeActivityEvents(
  familyId: string,
  deviceId: string,
  onData: (rows: ActivityEvent[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.devices, deviceId, COL.activityEvents),
    orderBy('createdAtMs', 'desc'),
    limit(500),
  )
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          deviceId: (data.deviceId as string) || deviceId,
          type: (data.type as ActivityEventType) || 'APP_FOREGROUND',
          packageName: (data.packageName as string | null) ?? null,
          appLabel: (data.appLabel as string | null) ?? null,
          title: (data.title as string | null) ?? null,
          details: (data.details as string | null) ?? null,
          url: (data.url as string | null) ?? null,
          inferred: Boolean(data.inferred),
          startedAtMs: data.startedAtMs == null ? null : Number(data.startedAtMs),
          endedAtMs: data.endedAtMs == null ? null : Number(data.endedAtMs),
          durationMs: data.durationMs == null ? null : Number(data.durationMs),
          createdAtMs: Number(data.createdAtMs ?? 0),
        } satisfies ActivityEvent
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

// ---------- Typing safety / message shield ----------
//
// families/{familyId}/typingEvents: one row per debounced on-screen text settle in a
// monitored app on the child device (see child/monitoring/MessageMonitorAccessibilityService.kt).
// families/{familyId}/typingSafetySettings/default: parent-managed rules (custom prohibited
// words, always-monitor/whitelist app lists, 360 mode, auto-block threshold).

export function observeTypingSafetyEvents(
  familyId: string,
  onData: (rows: TypingSafetyEvent[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    collection(db, COL.families, familyId, COL.typingEvents),
    orderBy('createdAtMs', 'desc'),
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
          packageName: (data.packageName as string) || '',
          appLabel: (data.appLabel as string) || (data.packageName as string) || 'Unknown app',
          snippet: (data.snippet as string) || '',
          matchedWords: Array.isArray(data.matchedWords)
            ? (data.matchedWords as unknown[]).map((w) => String(w))
            : [],
          category: (data.category as string | null) ?? null,
          severity: (data.severity as string) || 'LOW',
          riskScore: Number(data.riskScore ?? 0),
          mode: (data.mode as string) || 'communication',
          reviewed: Boolean(data.reviewed),
          createdAtMs: Number(data.createdAtMs ?? 0),
        } satisfies TypingSafetyEvent
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export async function markTypingEventReviewed(familyId: string, id: string): Promise<void> {
  await updateDoc(doc(db, COL.families, familyId, COL.typingEvents, id), { reviewed: true })
}

/** Blocks an app on a device immediately — reuses the same all-day AppBlockSchedule enforcement
 *  loop as a parent-scheduled block, so no second on-device mechanism is needed. */
export async function blockAppFromTypingEvent(
  familyId: string,
  deviceId: string,
  packageName: string,
  label: string,
): Promise<void> {
  await addAppBlockSchedule(familyId, {
    packageName,
    label: label || packageName,
    deviceId,
    daysOfWeek: [],
    startMinute: 0,
    endMinute: 1439,
    active: true,
    message: 'Application has been blocked.',
    createdAtMs: Date.now(),
  })
}

export function observeInstalledApps(
  familyId: string,
  deviceId: string,
  onData: (rows: import('../types').InstalledApp[]) => void,
  onError?: (err: Error) => void,
): () => void {
  if (!deviceId) {
    onData([])
    return () => {}
  }
  return onSnapshot(
    collection(db, COL.families, familyId, COL.devices, deviceId, COL.installedApps),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          packageName: (data.packageName as string) || d.id,
          name: (data.name as string) || (data.packageName as string) || d.id,
          versionName: (data.versionName as string) || '',
          versionCode: Number(data.versionCode ?? 0),
          apkSizeBytes: Number(data.apkSizeBytes ?? 0),
          firstInstallTime: Number(data.firstInstallTime ?? 0),
          lastUpdateTime: Number(data.lastUpdateTime ?? 0),
          updatedAtMs: Number(data.updatedAtMs ?? 0),
          deviceId: (data.deviceId as string) || deviceId,
        } satisfies import('../types').InstalledApp
      })
      onData(rows.sort((a, b) => a.name.localeCompare(b.name)))
    },
    (err) => onError?.(err),
  )
}

export async function requestAppInventory(familyId: string, deviceId: string): Promise<string> {
  return createSafetyCommand(familyId, deviceId, 'REQUEST_APP_INVENTORY')
}

const DEFAULT_TYPING_SAFETY_SETTINGS: TypingSafetySettings = {
  prohibitedWords: [],
  alwaysMonitorPackages: [],
  whitelistPackages: [],
  mode360: false,
  autoBlockEnabled: false,
  autoBlockSeverity: 'HIGH',
}

export function observeTypingSafetySettings(
  familyId: string,
  onData: (settings: TypingSafetySettings) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COL.families, familyId, COL.typingSafetySettings, 'default'),
    (snap) => {
      const data = snap.data() || {}
      onData({
        prohibitedWords: Array.isArray(data.prohibitedWords)
          ? (data.prohibitedWords as unknown[]).map((w) => String(w))
          : [],
        alwaysMonitorPackages: Array.isArray(data.alwaysMonitorPackages)
          ? (data.alwaysMonitorPackages as unknown[]).map((w) => String(w))
          : [],
        whitelistPackages: Array.isArray(data.whitelistPackages)
          ? (data.whitelistPackages as unknown[]).map((w) => String(w))
          : [],
        mode360: Boolean(data.mode360),
        autoBlockEnabled: Boolean(data.autoBlockEnabled),
        autoBlockSeverity: (data.autoBlockSeverity as string) || 'HIGH',
      })
    },
    (err) => onError?.(err),
  )
}

async function typingSettingsDoc(familyId: string) {
  const ref = doc(db, COL.families, familyId, COL.typingSafetySettings, 'default')
  await setDoc(ref, DEFAULT_TYPING_SAFETY_SETTINGS, { merge: true })
  return ref
}

export async function addProhibitedWord(familyId: string, word: string): Promise<void> {
  const trimmed = word.trim().toLowerCase()
  if (!trimmed) return
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { prohibitedWords: arrayUnion(trimmed) })
}

export async function removeProhibitedWord(familyId: string, word: string): Promise<void> {
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { prohibitedWords: arrayRemove(word) })
}

export async function addAlwaysMonitorApp(familyId: string, packageName: string): Promise<void> {
  const trimmed = packageName.trim()
  if (!trimmed) return
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { alwaysMonitorPackages: arrayUnion(trimmed) })
}

export async function removeAlwaysMonitorApp(familyId: string, packageName: string): Promise<void> {
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { alwaysMonitorPackages: arrayRemove(packageName) })
}

export async function addTypingWhitelistApp(familyId: string, packageName: string): Promise<void> {
  const trimmed = packageName.trim()
  if (!trimmed) return
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { whitelistPackages: arrayUnion(trimmed) })
}

export async function removeTypingWhitelistApp(familyId: string, packageName: string): Promise<void> {
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { whitelistPackages: arrayRemove(packageName) })
}

export async function setTypingMode360(familyId: string, enabled: boolean): Promise<void> {
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { mode360: enabled })
}

export async function setTypingAutoBlock(
  familyId: string,
  enabled: boolean,
  severity: string,
): Promise<void> {
  const ref = await typingSettingsDoc(familyId)
  await updateDoc(ref, { autoBlockEnabled: enabled, autoBlockSeverity: severity })
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

  // Prefer Cloudflare Worker platform-health (no Firebase Blaze required).
  // Fallback order: VITE_PLATFORM_HEALTH_URL → R2 proxy /platform-health → legacy Functions URL.
  const r2Base = (import.meta.env.VITE_R2_MEDIA_PROXY_BASE_URL as string | undefined)?.trim()
  const platformHealthUrl =
    (import.meta.env.VITE_PLATFORM_HEALTH_URL as string | undefined)?.trim() ||
    (r2Base ? `${r2Base.replace(/\/$/, '')}/platform-health` : '') ||
    (import.meta.env.VITE_FUNCTIONS_HEALTH_URL as string | undefined)?.trim() ||
    ''

  if (!platformHealthUrl) {
    checks.push({
      id: 'platform-health',
      label: 'Platform backend health (Cloudflare)',
      status: 'warn',
      message: 'Set VITE_R2_MEDIA_PROXY_BASE_URL or VITE_PLATFORM_HEALTH_URL for backend health checks.',
    })
  } else {
    try {
      const started = performance.now()
      const response = await fetch(platformHealthUrl, { method: 'GET' })
      const latencyMs = Math.round(performance.now() - started)
      let detail = ''
      try {
        const body = (await response.json()) as {
          checks?: {
            firebase?: { status?: string; message?: string }
            r2?: { status?: string }
            d1?: { status?: string }
            kv?: { status?: string }
          }
          loadBalancing?: string
        }
        const firebaseMsg = body.checks?.firebase?.message
        const r2Status = body.checks?.r2?.status
        const d1Status = body.checks?.d1?.status
        const kvStatus = body.checks?.kv?.status
        if (firebaseMsg || r2Status || d1Status || kvStatus) {
          detail = ` R2=${r2Status || 'n/a'}; D1=${d1Status || 'n/a'}; KV=${kvStatus || 'n/a'}; Firebase=${firebaseMsg || 'n/a'}`
        }
        if (body.loadBalancing) detail += ` LB=${body.loadBalancing}`
      } catch {
        // non-JSON response is fine
      }
      checks.push({
        id: 'platform-health',
        label: 'Platform backend health (Cloudflare)',
        status: response.ok ? 'ok' : 'fail',
        message: response.ok
          ? `Cloudflare platform-health OK.${detail}`
          : `Platform health returned HTTP ${response.status}.${detail}`,
        latencyMs,
      })
    } catch (e) {
      checks.push({
        id: 'platform-health',
        label: 'Platform backend health (Cloudflare)',
        status: 'fail',
        message: e instanceof Error ? e.message : 'Failed to reach Cloudflare platform-health.',
      })
    }
  }

  return { generatedAtMs: now, checks }
}

function edgeBaseUrl(): string {
  return (
    (import.meta.env.VITE_R2_MEDIA_PROXY_BASE_URL as string | undefined)?.trim() ||
    'https://sarechild-media-proxy.neuereatec.workers.dev'
  ).replace(/\/$/, '')
}

async function syncFleetToEdge(familyId: string, overview: TcdOverview): Promise<void> {
  try {
    await fetch(`${edgeBaseUrl()}/edge/sync/fleet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        familyId,
        registeredDevices: overview.registeredDevices,
        onlineDevices: overview.onlineDevices,
        offlineDevices: overview.offlineDevices,
        guardians: overview.guardians,
        alertsLast24h: overview.alertsLast24h,
        criticalAlertsLast24h: overview.criticalAlertsLast24h,
        pendingCommands: overview.pendingCommands,
        latestHeartbeatMs: overview.latestHeartbeatMs,
        source: 'firebase',
      }),
    })
  } catch {
    // Edge sync is best-effort redundancy; never block TCD.
  }
}

async function loadFleetFromEdge(
  familyId: string,
): Promise<(TcdOverview & { source: string; latencyMs: number }) | null> {
  try {
    const started = performance.now()
    const res = await fetch(`${edgeBaseUrl()}/edge/fleet/${encodeURIComponent(familyId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok?: boolean
      source?: string
      latencyMs?: number
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
      latencyMs: body.latencyMs ?? Math.round(performance.now() - started),
    }
  } catch {
    return null
  }
}

export async function loadTcdOverview(familyId: string): Promise<TcdOverview> {
  // Prefer Cloudflare edge snapshot for speed; fall back to Firebase and refresh edge cache.
  const edge = await loadFleetFromEdge(familyId)
  if (edge && Date.now() - edge.generatedAtMs < 2 * 60 * 1000) {
    return {
      ...edge,
      edgeSource: edge.source,
      edgeLatencyMs: edge.latencyMs,
    }
  }

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

  const overview: TcdOverview = {
    generatedAtMs: now,
    registeredDevices,
    onlineDevices,
    offlineDevices,
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

// ---------- Per-device family chat ----------
// Every paired device has its own isolated thread at
// families/{fid}/devices/{deviceId}/chatMessages/{msgId}. The parent (family owner) can see
// every device's thread; guardians only see threads for devices the parent has assigned to them
// (see setGuardianAssignedToDevice + firestore.rules). This intentionally supersedes the old
// family-wide `familyChat` collection so pairing a second device never merges conversations.

function deviceChatCollectionRef(familyId: string, deviceId: string) {
  return collection(db, COL.families, familyId, COL.devices, deviceId, COL.chatMessages)
}

export function observeDeviceChat(
  familyId: string,
  deviceId: string,
  onData: (rows: FamilyChatMessage[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(deviceChatCollectionRef(familyId, deviceId), orderBy('createdAtMs', 'asc'), limit(300))
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          senderUid: (data.senderUid as string) || '',
          senderName: (data.senderName as string) || 'Family',
          senderRole: ((data.senderRole as FamilyChatMessage['senderRole']) || 'GUARDIAN'),
          deviceId: (data.deviceId as string | null) ?? deviceId,
          text: (data.text as string | null) ?? null,
          mediaUrl: (data.mediaUrl as string | null) ?? null,
          mediaPath: (data.mediaPath as string | null) ?? null,
          mediaType: (data.mediaType as FamilyChatMessage['mediaType']) ?? null,
          durationMs: data.durationMs == null ? null : Number(data.durationMs),
          createdAtMs: Number(data.createdAtMs ?? 0),
        } satisfies FamilyChatMessage
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

/** Lightweight per-device unread counter for the chat sidebar — counts recent messages from other
 *  participants created after this guardian/parent's last-read timestamp for that device. */
export function observeDeviceChatUnreadCount(
  familyId: string,
  deviceId: string,
  onCount: (count: number) => void,
  onError?: (err: Error) => void,
): () => void {
  const uid = auth.currentUser?.uid
  let lastRead = 0
  let messagesUnsub: (() => void) | null = null

  const attachMessagesListener = () => {
    messagesUnsub?.()
    const q = query(deviceChatCollectionRef(familyId, deviceId), orderBy('createdAtMs', 'desc'), limit(50))
    messagesUnsub = onSnapshot(
      q,
      (snap) => {
        const unread = snap.docs.filter((d) => {
          const data = d.data()
          const createdAt = Number(data.createdAtMs ?? 0)
          const sender = (data.senderUid as string) || ''
          return createdAt > lastRead && sender !== uid
        }).length
        onCount(unread)
      },
      (err) => onError?.(err),
    )
  }

  const deviceUnsub = onSnapshot(
    doc(db, COL.families, familyId, COL.devices, deviceId),
    (snap) => {
      const reads = (snap.get('chatReads') as Record<string, number> | undefined) ?? {}
      const newLastRead = Number(reads[uid || ''] ?? 0)
      if (newLastRead !== lastRead || !messagesUnsub) {
        lastRead = newLastRead
        attachMessagesListener()
      }
    },
    (err) => onError?.(err),
  )

  return () => {
    messagesUnsub?.()
    deviceUnsub()
  }
}

/** Records that this guardian/parent has seen [deviceId]'s thread up to now. */
export async function markDeviceChatRead(familyId: string, deviceId: string): Promise<void> {
  const uid = auth.currentUser?.uid
  if (!uid) return
  await updateDoc(doc(db, COL.families, familyId, COL.devices, deviceId), {
    [`chatReads.${uid}`]: Date.now(),
  }).catch(() => undefined)
}

/** Parent-editable allowlist controlling which guardians may see/participate in a device's chat
 *  thread — the family owner (parent) always sees every thread regardless of this list. */
export async function setGuardianAssignedToDevice(
  familyId: string,
  deviceId: string,
  guardianUid: string,
  assigned: boolean,
): Promise<void> {
  await setDoc(
    doc(db, COL.families, familyId, COL.devices, deviceId),
    { assignedGuardianUids: assigned ? arrayUnion(guardianUid) : arrayRemove(guardianUid) },
    { merge: true },
  )
}

export async function getMaxChatVideoSeconds(familyId: string): Promise<number> {
  const DEFAULT_MAX = 180
  const snap = await getDoc(doc(db, COL.families, familyId))
  const value = snap.get('maxChatVideoSeconds')
  return typeof value === 'number' && value > 0 ? value : DEFAULT_MAX
}

export async function sendDeviceChatMessage(
  familyId: string,
  deviceId: string,
  opts: {
    text?: string | null
    mediaUrl?: string | null
    mediaPath?: string | null
    mediaType?: string | null
    durationMs?: number | null
  },
): Promise<void> {
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('Not signed in')
  const name = auth.currentUser?.email || 'Guardian'
  await addDoc(deviceChatCollectionRef(familyId, deviceId), {
    senderUid: uid,
    senderName: name,
    senderRole: 'GUARDIAN',
    deviceId,
    text: opts.text?.trim() || null,
    mediaUrl: opts.mediaUrl ?? null,
    mediaPath: opts.mediaPath ?? null,
    mediaType: opts.mediaType ?? null,
    durationMs: opts.durationMs ?? null,
    createdAtMs: Date.now(),
  })
  await markDeviceChatRead(familyId, deviceId)
}

/** Uploads a chat attachment (image/voice note/video) via the R2 media proxy, mirroring the
 *  `families/{fid}/devices/{deviceId}/chat/...` path used by the Android apps. */
export async function uploadChatMedia(
  familyId: string,
  deviceId: string,
  blob: Blob,
  fileName: string,
): Promise<{ path: string; url: string }> {
  const base = (import.meta.env.VITE_R2_MEDIA_PROXY_BASE_URL as string | undefined)?.trim()
    || 'https://sarechild-media-proxy.neuereatec.workers.dev'
  const uid = auth.currentUser?.uid || 'guardian'
  const path = `families/${familyId}/devices/${deviceId}/chat/${Date.now()}_${uid}_${fileName}`
  const encodedPath = path.split('/').map((p) => encodeURIComponent(p)).join('/')
  const contentType = blob.type || 'application/octet-stream'
  const res = await fetch(`${base}/upload/${encodedPath}?contentType=${encodeURIComponent(contentType)}`, {
    method: 'PUT',
    body: blob,
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const body = (await res.json()) as { url?: string }
  const url = body.url || `${base}/${encodedPath}`
  return { path, url }
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

  const existingProfile = await getDoc(doc(db, COL.parentProfiles, uid))
  const ownedFamilyId = existingProfile.data()?.ownedFamilyId as string | undefined

  await setDoc(doc(db, COL.families, familyId, COL.guardians, uid), {
    email: email || (data.email as string) || '',
    role: 'CAREGIVER' satisfies GuardianRole,
    joinedAtMs: Date.now(),
  })
  await setDoc(
    doc(db, COL.parentProfiles, uid),
    {
      familyId,
      email: email || (data.email as string) || '',
      ...(ownedFamilyId ? { ownedFamilyId } : {}),
    },
    { merge: true },
  )
  await updateDoc(inviteRef, {
    claimed: true,
    claimedAtMs: Date.now(),
    claimedByUid: uid,
  })
  return familyId
}

/** Project-owner admin view of parent accounts (requires Firestore admin rule + signed-in admin). */
export async function loadAdminParentAccounts(): Promise<AdminParentAccountRow[]> {
  const user = auth.currentUser
  if (!user || !isProjectAdmin(user)) {
    throw new Error('Not authorized')
  }
  const snap = await getDocs(collection(db, COL.parentProfiles))
  const rows = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data()
      const familyId = (data.familyId as string | undefined) ?? null
      let deviceCount: number | null = null
      if (familyId) {
        try {
          const devices = await getDocs(collection(db, COL.families, familyId, COL.devices))
          deviceCount = devices.size
        } catch {
          deviceCount = null
        }
      }
      return {
        uid: d.id,
        email: (data.email as string | undefined) ?? '',
        familyId,
        ownedFamilyId: (data.ownedFamilyId as string | undefined) ?? familyId,
        registeredAt: data.registeredAt == null ? Number(data.createdAtMs ?? 0) || null : Number(data.registeredAt),
        lastActiveAt: data.lastActiveAt == null ? null : Number(data.lastActiveAt),
        lastLoginAt: data.lastLoginAt == null ? null : Number(data.lastLoginAt),
        deviceCount,
        plan: (data.plan as string | undefined) ?? null,
        status: (data.status as string | undefined) ?? null,
      } satisfies AdminParentAccountRow
    }),
  )
  return rows.sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))
}

// ---------- Live viewing (WebRTC + quota) ----------

export const LIVE_VIEW_DAILY_CREDITS = 10
export const LIVE_VIEW_MIN_MINUTES = 1
export const LIVE_VIEW_MAX_MINUTES = 5

function nextUtcMidnightMs(fromMs: number): number {
  const d = new Date(fromMs)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime()
}

export async function getLiveViewQuota(uid: string): Promise<import('../types').LiveViewQuota> {
  const ref = doc(db, COL.liveViewQuota, uid)
  const snap = await getDoc(ref)
  const now = Date.now()
  if (!snap.exists()) {
    const quota = {
      creditsRemaining: LIVE_VIEW_DAILY_CREDITS,
      dailyAllowance: LIVE_VIEW_DAILY_CREDITS,
      resetAtMs: nextUtcMidnightMs(now),
    }
    await setDoc(ref, quota)
    return quota
  }
  const data = snap.data()
  let creditsRemaining = Number(data.creditsRemaining ?? LIVE_VIEW_DAILY_CREDITS)
  let dailyAllowance = Number(data.dailyAllowance ?? LIVE_VIEW_DAILY_CREDITS)
  let resetAtMs = Number(data.resetAtMs ?? nextUtcMidnightMs(now))
  if (now >= resetAtMs) {
    creditsRemaining = dailyAllowance
    resetAtMs = nextUtcMidnightMs(now)
    await setDoc(ref, { creditsRemaining, dailyAllowance, resetAtMs }, { merge: true })
  }
  return { creditsRemaining, dailyAllowance, resetAtMs }
}

export function observeLiveViewQuota(
  uid: string,
  onData: (quota: import('../types').LiveViewQuota) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COL.liveViewQuota, uid),
    async (snap) => {
      const now = Date.now()
      if (!snap.exists()) {
        const quota = {
          creditsRemaining: LIVE_VIEW_DAILY_CREDITS,
          dailyAllowance: LIVE_VIEW_DAILY_CREDITS,
          resetAtMs: nextUtcMidnightMs(now),
        }
        await setDoc(doc(db, COL.liveViewQuota, uid), quota)
        onData(quota)
        return
      }
      const data = snap.data()
      let creditsRemaining = Number(data.creditsRemaining ?? LIVE_VIEW_DAILY_CREDITS)
      const dailyAllowance = Number(data.dailyAllowance ?? LIVE_VIEW_DAILY_CREDITS)
      let resetAtMs = Number(data.resetAtMs ?? nextUtcMidnightMs(now))
      if (now >= resetAtMs) {
        creditsRemaining = dailyAllowance
        resetAtMs = nextUtcMidnightMs(now)
        await setDoc(doc(db, COL.liveViewQuota, uid), { creditsRemaining, resetAtMs }, { merge: true })
      }
      onData({ creditsRemaining, dailyAllowance, resetAtMs })
    },
    (err) => onError?.(err),
  )
}

export type StartLiveViewParams = {
  familyId: string
  deviceId: string
  parentUid: string
  durationMinutes: number
  config: import('../types').LiveSessionConfig
}

export async function startLiveViewSession(params: StartLiveViewParams): Promise<{
  sessionId: string
  commandId: string
}> {
  const duration = Math.min(
    LIVE_VIEW_MAX_MINUTES,
    Math.max(LIVE_VIEW_MIN_MINUTES, params.durationMinutes),
  )
  const quota = await getLiveViewQuota(params.parentUid)
  if (quota.creditsRemaining < duration) {
    throw new Error(
      `Not enough daily credits (${quota.creditsRemaining} left, need ${duration}). Resets ${new Date(quota.resetAtMs).toLocaleString()}.`,
    )
  }

  const sessionRef = doc(collection(db, COL.families, params.familyId, COL.liveSessions))
  const commandRef = doc(collection(db, COL.families, params.familyId, COL.commands))
  const now = Date.now()

  await setDoc(sessionRef, {
    deviceId: params.deviceId,
    parentUid: params.parentUid,
    status: 'pending',
    config: params.config,
    durationMinutes: duration,
    creditsUsed: duration,
    createdAtMs: now,
    acceptedAtMs: null,
    startedAtMs: null,
    endsAtMs: null,
    endedAtMs: null,
    endReason: null,
    error: null,
    offer: null,
    answer: null,
    parentCandidates: [],
    childCandidates: [],
    commandId: commandRef.id,
  })

  await setDoc(commandRef, {
    type: 'START_LIVE_VIEW',
    status: 'PENDING',
    deviceId: params.deviceId,
    requestedAtMs: now,
    acceptedAtMs: null,
    completedAtMs: null,
    resultPath: null,
    resultUrl: null,
    error: null,
    durationMinutes: duration,
    liveSessionId: sessionRef.id,
    liveVideo: params.config.video,
    liveAudio: params.config.audio,
    liveScreen: params.config.screen,
    liveRecord: params.config.record,
    cameraFront: params.config.cameraFacing === 'front',
  })

  await setDoc(
    doc(db, COL.liveViewQuota, params.parentUid),
    { creditsRemaining: quota.creditsRemaining - duration },
    { merge: true },
  )

  return { sessionId: sessionRef.id, commandId: commandRef.id }
}

export async function updateLiveSession(
  familyId: string,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await setDoc(doc(db, COL.families, familyId, COL.liveSessions, sessionId), patch, { merge: true })
}

export async function addLiveSessionIceCandidate(
  familyId: string,
  sessionId: string,
  side: 'parent' | 'child',
  candidate: Record<string, unknown>,
): Promise<void> {
  const field = side === 'parent' ? 'parentCandidates' : 'childCandidates'
  await updateDoc(doc(db, COL.families, familyId, COL.liveSessions, sessionId), {
    [field]: arrayUnion(candidate),
  })
}

export function observeLiveSession(
  familyId: string,
  sessionId: string,
  onData: (session: import('../types').LiveSession) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, COL.families, familyId, COL.liveSessions, sessionId),
    (snap) => {
      if (!snap.exists()) return
      const d = snap.data()
      const cfg = (d.config as Record<string, unknown>) || {}
      onData({
        id: snap.id,
        deviceId: (d.deviceId as string) || '',
        parentUid: (d.parentUid as string) || '',
        status: ((d.status as string) || 'pending') as import('../types').LiveSessionStatus,
        config: {
          video: Boolean(cfg.video),
          audio: Boolean(cfg.audio),
          screen: Boolean(cfg.screen),
          cameraFacing: cfg.cameraFacing === 'front' ? 'front' : 'rear',
          record: Boolean(cfg.record),
        },
        durationMinutes: Number(d.durationMinutes ?? 1),
        creditsUsed: Number(d.creditsUsed ?? 0),
        createdAtMs: Number(d.createdAtMs ?? 0),
        acceptedAtMs: d.acceptedAtMs != null ? Number(d.acceptedAtMs) : null,
        startedAtMs: d.startedAtMs != null ? Number(d.startedAtMs) : null,
        endsAtMs: d.endsAtMs != null ? Number(d.endsAtMs) : null,
        endedAtMs: d.endedAtMs != null ? Number(d.endedAtMs) : null,
        endReason: (d.endReason as string) || null,
        error: (d.error as string) || null,
        offer: (d.offer as { type: string; sdp: string }) || null,
        answer: (d.answer as { type: string; sdp: string }) || null,
        parentCandidates: (d.parentCandidates as Array<Record<string, unknown>>) || [],
        childCandidates: (d.childCandidates as Array<Record<string, unknown>>) || [],
      })
    },
    (err) => onError?.(err),
  )
}

export function observeLiveRecordings(
  familyId: string,
  onData: (rows: import('../types').LiveRecording[]) => void,
  onError?: (err: Error) => void,
): () => void {
  return onSnapshot(
    query(
      collection(db, COL.families, familyId, COL.liveRecordings),
      orderBy('createdAtMs', 'desc'),
      limit(200),
    ),
    (snap) => {
      const rows = snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          sessionId: (data.sessionId as string) || '',
          deviceId: (data.deviceId as string) || '',
          status: ((data.status as string) || 'ready') as import('../types').LiveRecordingStatus,
          mediaUrl: (data.mediaUrl as string) || null,
          mediaPath: (data.mediaPath as string) || null,
          durationSec: Number(data.durationSec ?? 0),
          sizeBytes: Number(data.sizeBytes ?? 0),
          createdAtMs: Number(data.createdAtMs ?? 0),
        }
      })
      onData(rows)
    },
    (err) => onError?.(err),
  )
}

export async function deleteLiveRecording(familyId: string, recordingId: string): Promise<void> {
  await deleteDoc(doc(db, COL.families, familyId, COL.liveRecordings, recordingId))
}

export async function createLiveRecording(
  familyId: string,
  row: Omit<import('../types').LiveRecording, 'id'>,
): Promise<string> {
  const ref = await addDoc(collection(db, COL.families, familyId, COL.liveRecordings), {
    sessionId: row.sessionId,
    deviceId: row.deviceId,
    status: row.status,
    mediaUrl: row.mediaUrl,
    mediaPath: row.mediaPath,
    durationSec: row.durationSec,
    sizeBytes: row.sizeBytes,
    createdAtMs: row.createdAtMs,
  })
  return ref.id
}

export async function stopLiveViewSession(familyId: string, deviceId: string): Promise<void> {
  await createSafetyCommand(familyId, deviceId, 'STOP_LIVE_VIEW')
}

export async function uploadLiveRecordingBlob(
  familyId: string,
  deviceId: string,
  sessionId: string,
  blob: Blob,
): Promise<{ path: string; url: string }> {
  const base = (import.meta.env.VITE_R2_MEDIA_PROXY_BASE_URL as string | undefined)?.trim()
    || 'https://sarechild-media-proxy.neuereatec.workers.dev'
  const path = `families/${familyId}/devices/${deviceId}/liveRecordings/${sessionId}_${Date.now()}.webm`
  const encodedPath = path.split('/').map((p) => encodeURIComponent(p)).join('/')
  const res = await fetch(`${base}/upload/${encodedPath}?contentType=${encodeURIComponent(blob.type || 'video/webm')}`, {
    method: 'PUT',
    body: blob,
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const body = (await res.json()) as { url?: string }
  const url = body.url || `${base}/${encodedPath}`
  return { path, url }
}
