export type LatLngPoint = {
  lat: number
  lng: number
  accuracyM?: number | null
  updatedAtMs?: number
}

export type BatterySample = {
  percent: number
  charging: boolean
  atMs: number
}

export type WhatsAppProtectionStatus = {
  enabled: boolean
  consent: boolean
  notificationAccess: boolean
  accessibilityAccess: boolean
  mediaPermission: boolean
  lastEventAtMs: number
  updatedAtMs: number
}

export type CallRecordingStatus = {
  consent: boolean
  enabled: boolean
  micPermission: boolean
  phoneStatePermission: boolean
  lastRecordingAtMs: number
  updatedAtMs: number
}

export type CallRecordingType = 'CELLULAR' | 'VOIP_PARTIAL' | 'MISSED'

export type CallRecording = {
  id: string
  deviceId: string
  callType: CallRecordingType
  direction: string
  numberMasked: string | null
  contactLabel: string | null
  packageName: string | null
  durationSec: number
  audioUrl: string | null
  audioCaptured: boolean
  audioSourceNote: string | null
  createdAtMs: number
}

export type DeviceStatus = {
  id: string
  childName: string
  online: boolean
  lastHeartbeatMs: number
  batteryPercent: number
  charging: boolean
  batteryHistory: BatterySample[]
  lastLocation: LatLngPoint | null
  notificationAccess: boolean
  locationPermission: boolean
  monitoringActive: boolean
  screenShareConsent: boolean
  cameraCheckConsent: boolean
  micCheckConsent: boolean
  messageMonitorConsent: boolean
  installMonitorConsent: boolean
  usageConsent: boolean
  callSmsConsent: boolean
  offlineSmsFallbackConsent: boolean
  offlineAutoCallConsent: boolean
  whatsappMonitorConsent: boolean
  whatsappMediaPermission: boolean
  lastWhatsAppEventAtMs: number
  whatsappProtection: WhatsAppProtectionStatus | null
  callRecordingConsent: boolean
  callRecordingEnabled: boolean
  lastCallRecordingAtMs: number
  callRecordingStatus: CallRecordingStatus | null
  chatOnline: boolean
  chatLastSeenMs: number
  offlineCallEnabled: boolean
  offlineCallNumber: string | null
  offlineCallMaxAttempts: number
  activeSession: string | null
  latestFrameUrl: string | null
  todayScreenMinutes: number
}

export type FamilyAlert = {
  id: string
  type: string
  severity: string
  title: string
  snippet?: string | null
  category?: string | null
  deviceId: string
  createdAtMs: number
  read: boolean
  location?: LatLngPoint | null
  mediaUrl?: string | null
  commandId?: string | null
  riskScore?: number | null
}

export type SafetyCommand = {
  id: string
  type: string
  status: string
  deviceId: string
  requestedAtMs: number
  acceptedAtMs?: number | null
  completedAtMs?: number | null
  resultPath?: string | null
  resultUrl?: string | null
  error?: string | null
  durationMinutes?: number | null
}

export type ScreenShareSchedule = {
  id: string
  deviceId: string
  label: string
  daysOfWeek: number[]
  startMinute: number
  durationMinutes: number
  active: boolean
  lastTriggeredDayKey?: string | null
}

export type GeofenceZone = {
  id: string
  name: string
  lat: number
  lng: number
  radiusM: number
  active: boolean
  /** Calendar.SUNDAY=1 … SATURDAY=7; empty = always active */
  daysOfWeek: number[]
  /** Minutes from midnight local; null = always */
  startMinute: number | null
  endMinute: number | null
}

export type SosContact = {
  id: string
  name: string
  phoneNote: string
}

export type SafeContact = {
  id: string
  channel: string
  label: string
  identifier: string
}

export type AppLimit = {
  id: string
  packageName: string
  label: string
  dailyLimitMinutes: number
  deviceId: string
}

export type AppBlockSchedule = {
  id: string
  packageName: string
  label: string
  deviceId: string
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  active: boolean
  message: string
  createdAtMs: number
}

export type InstalledApp = {
  id: string
  packageName: string
  name: string
  versionName: string
  versionCode: number
  apkSizeBytes: number
  firstInstallTime: number
  lastUpdateTime: number
  updatedAtMs: number
  deviceId: string
}

export type UsageAppEntry = {
  packageName: string
  label: string
  minutes: number
}

export type UsageDaily = {
  id: string
  deviceId: string
  day: string
  totalMinutes: number
  apps: UsageAppEntry[]
  updatedAtMs: number
}

export type LocationTrailSample = {
  id: string
  deviceId: string
  location: LatLngPoint | null
  batteryPercent: number
  charging: boolean
  hadNetwork: boolean
  recordedAtMs: number
}

export type PlaceKind = 'home' | 'school' | 'work' | 'custom'

// Parent-authored points of interest shown on the Live Map control center
// (distinct from `GeofenceZone`, which drives on-device enter/exit alerting —
// a place can optionally be promoted to a geofence, but not every place needs
// one, e.g. "grandma's house" that a parent just wants labeled on the map).
export type MapPlace = {
  id: string
  name: string
  kind: PlaceKind
  lat: number
  lng: number
  radiusM: number
  createdAtMs: number
}

export type CallSmsPreview = {
  id: string
  kind: string
  direction: string
  addressMasked: string
  snippet?: string | null
  atMs: number
  deviceId: string
}

// ---------------------------------------------------------------------------
// WhatsApp protection section (families/{familyId}/whatsappEvents). Written by the child app
// from notification text, on-screen accessibility text, and MediaStore metadata for files
// under a WhatsApp media folder — never from WhatsApp's (encrypted) chat database. See
// child/monitoring/WhatsAppMonitor.kt for the full whitelist/alerting rules this mirrors.
// ---------------------------------------------------------------------------

export type WhatsAppEventType =
  | 'MESSAGE'
  | 'CALL'
  | 'IMAGE'
  | 'VOICE_NOTE'
  | 'VIDEO'
  | 'DOCUMENT'
  | 'UNKNOWN_CONTACT'

export type WhatsAppEvent = {
  id: string
  deviceId: string
  eventType: WhatsAppEventType
  contactLabel: string
  contactSafe: boolean
  direction: string
  preview?: string | null
  mediaUrl?: string | null
  mediaType?: string | null
  durationSec?: number | null
  riskScore?: number | null
  riskFlag: boolean
  source: string
  createdAtMs: number
}

export type TrialPlan = 'trial' | 'paid'
export type TrialStatus = 'active' | 'at_risk' | 'purged' | 'blocked'

// Mirrors parentProfiles/{uid} trial fields (see functions/src/index.ts
// purgeInactiveTrials for the server-side rules that consume these). Kept as its own
// type — separate from any future PaidPlanInfo — so billing fields can be added later
// without touching every call site that only cares about trial status today.
export type TrialInfo = {
  plan: TrialPlan
  status: TrialStatus
  trialStartedAt: number
  trialEndsAt: number
  lastLoginAt: number | null
  lastParentCheckInAt: number | null
}

/** Mirrors parentProfiles/{uid} fields used for registration, legal acceptance, and admin views. */
export type ParentProfileInfo = {
  familyId: string | null
  ownedFamilyId: string | null
  email: string
  createdAtMs: number
  registeredAt: number | null
  tosAcceptedAt: number | null
  tosVersion: string | null
  privacyAcceptedAt: number | null
  lastLoginAt: number | null
  lastActiveAt: number | null
  trial: TrialInfo | null
  adminBlocked: boolean
  accountStatus: string | null
}

export type AdminParentAccountRow = {
  uid: string
  email: string
  familyId: string | null
  ownedFamilyId: string | null
  registeredAt: number | null
  lastActiveAt: number | null
  lastLoginAt: number | null
  deviceCount: number | null
  plan: string | null
  status: string | null
}

// ---------------------------------------------------------------------------
// Typing safety / message shield section (families/{familyId}/typingEvents +
// .../typingSafetySettings). Written by the child app from on-screen text exposed via
// Android's Accessibility API (never password/PIN fields, never an app's encrypted
// database) — see child/monitoring/MessageMonitorAccessibilityService.kt.
// ---------------------------------------------------------------------------

export type TypingSafetyEvent = {
  id: string
  deviceId: string
  packageName: string
  appLabel: string
  snippet: string
  matchedWords: string[]
  category?: string | null
  severity: string
  riskScore: number
  mode: string
  reviewed: boolean
  createdAtMs: number
}

export type TypingSafetySettings = {
  prohibitedWords: string[]
  alwaysMonitorPackages: string[]
  whitelistPackages: string[]
  mode360: boolean
  autoBlockEnabled: boolean
  autoBlockSeverity: string
}

export type GuardianRole = 'OWNER' | 'CAREGIVER'

export type GuardianInfo = {
  uid: string
  email: string
  role: GuardianRole
  joinedAtMs: number
}

export type GuardianInvite = {
  code: string
  familyId: string
  email: string
  role: GuardianRole
  createdAtMs: number
  expiresAtMs: number
  claimed: boolean
}

export type FamilyChatMessage = {
  id: string
  senderUid: string
  senderName: string
  senderRole: 'GUARDIAN' | 'CHILD'
  deviceId?: string | null
  text?: string | null
  mediaUrl?: string | null
  mediaType?: string | null
  createdAtMs: number
}

export type WeeklyDigest = {
  id: string
  weekStartMs: number
  weekEndMs: number
  summary: string
  alertCount: number
  topAlertTypes: string[]
  createdAtMs: number
}

export type FamilySafetySettings = {
  escalationEnabled: boolean
  escalationRiskThreshold: number
  autoLockOnCritical: boolean
  checkInIntervalMinutes: number
  snoozedCategories: string[]
  snoozeUntilMs: number
  alertRetentionDays: number
  mediaRetentionDays: number
}

export type TcdCheckStatus = 'ok' | 'warn' | 'fail'

export type TcdCheck = {
  id: string
  label: string
  status: TcdCheckStatus
  message: string
  latencyMs?: number | null
}

export type TcdReport = {
  generatedAtMs: number
  checks: TcdCheck[]
}

export type TcdOverview = {
  generatedAtMs: number
  registeredDevices: number
  onlineDevices: number
  offlineDevices: number
  guardians: number
  alertsLast24h: number
  criticalAlertsLast24h: number
  pendingCommands: number
  latestHeartbeatMs: number
  /** firebase | kv | d1 | edge-device-sync | hybrid */
  edgeSource?: string | null
  edgeLatencyMs?: number | null
}

export function parseLocation(raw: unknown): LatLngPoint | null {
  if (!raw || typeof raw !== 'object') return null
  const map = raw as Record<string, unknown>
  const lat = Number(map.lat)
  const lng = Number(map.lng)
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null
  return {
    lat,
    lng,
    accuracyM: map.accuracyM == null ? null : Number(map.accuracyM),
    updatedAtMs: map.updatedAtMs == null ? undefined : Number(map.updatedAtMs),
  }
}

export function parseBatteryHistory(raw: unknown): BatterySample[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const map = item as Record<string, unknown>
      return {
        percent: Number(map.percent ?? -1),
        charging: Boolean(map.charging),
        atMs: Number(map.atMs ?? 0),
      } satisfies BatterySample
    })
    .filter((s): s is BatterySample => s !== null)
}

export function parseUsageApps(raw: unknown): UsageAppEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const map = item as Record<string, unknown>
      return {
        packageName: (map.packageName as string) || '',
        label: (map.label as string) || '',
        minutes: Number(map.minutes ?? 0),
      } satisfies UsageAppEntry
    })
    .filter((a): a is UsageAppEntry => a !== null)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?.*)?$/i
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|aac)(\?.*)?$/i

export function mediaKind(url: string): 'image' | 'audio' | 'other' {
  if (IMAGE_EXT.test(url)) return 'image'
  if (AUDIO_EXT.test(url)) return 'audio'
  return 'other'
}

export type LiveViewQuota = {
  creditsRemaining: number
  dailyAllowance: number
  resetAtMs: number
}

export type LiveSessionStatus =
  | 'pending'
  | 'accepted'
  | 'connecting'
  | 'active'
  | 'ended'
  | 'failed'
  | 'declined'

export type LiveSessionConfig = {
  video: boolean
  audio: boolean
  screen: boolean
  cameraFacing: 'front' | 'rear'
  record: boolean
}

export type LiveSession = {
  id: string
  deviceId: string
  parentUid: string
  status: LiveSessionStatus
  config: LiveSessionConfig
  durationMinutes: number
  creditsUsed: number
  createdAtMs: number
  acceptedAtMs: number | null
  startedAtMs: number | null
  endsAtMs: number | null
  endedAtMs: number | null
  endReason: string | null
  error: string | null
  offer: { type: string; sdp: string } | null
  answer: { type: string; sdp: string } | null
  parentCandidates: Array<Record<string, unknown>>
  childCandidates: Array<Record<string, unknown>>
}

export type LiveRecordingStatus = 'uploading' | 'ready' | 'failed'

export type LiveRecording = {
  id: string
  sessionId: string
  deviceId: string
  status: LiveRecordingStatus
  mediaUrl: string | null
  mediaPath: string | null
  durationSec: number
  sizeBytes: number
  createdAtMs: number
}
