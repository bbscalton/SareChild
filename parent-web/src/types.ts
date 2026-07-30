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

export type CallSmsPreview = {
  id: string
  kind: string
  direction: string
  addressMasked: string
  snippet?: string | null
  atMs: number
  deviceId: string
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
