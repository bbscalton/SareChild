export type TcdCheckStatus = 'ok' | 'warn' | 'fail'

export type TcdCheck = {
  id: string
  label: string
  group: 'platform' | 'fleet' | 'uptime'
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
  edgeSource?: string | null
  edgeLatencyMs?: number | null
}

export type DeviceStatus = {
  id: string
  childName: string
  lastHeartbeatMs: number
  batteryPercent: number
  chatOnline: boolean
  chatLastSeenMs: number
  monitoringActive: boolean
  childAppVersionName?: string | null
  childAppVersionCode?: number | null
  callRecordingStatus?: string | null
  callRecordingEnabled?: boolean
  screenSnapshotsActive?: boolean
  cameraSnapshotsActive?: boolean
  whatsappProtectionEnabled?: boolean
  accessibilityAccess?: boolean | null
  uninstallProtectionStatus?: string | null
  uninstallProtectionEnabled?: boolean
}

export type ApkVersionManifest = {
  id: 'child' | 'parent'
  label: string
  versionName: string | null
  versionCode: number | null
  apkUrl: string | null
  releasedAt: string | null
  changelog: string | null
  status: TcdCheckStatus
  message: string
}

export type FeatureHealthCard = {
  id: string
  label: string
  status: TcdCheckStatus
  detail: string
}

export type PlatformPulse = {
  accountsTotal: number
  accountsActive: number
  accountsBlocked: number
  accountsTrial: number
  accountsPaid: number
  devicesKnown: number
}

export type FamilyAlert = {
  id: string
  severity: string
  title: string
  createdAtMs: number
  read: boolean
}

export type GuardianInfo = {
  uid: string
  email: string
  role: string
  joinedAtMs: number
}

export type SafetyCommand = {
  id: string
  status: string
  type: string
  requestedAtMs: number
}

export type TrialPlan = 'trial' | 'paid'
export type TrialStatus = 'active' | 'at_risk' | 'purged' | 'blocked'

export type TrialInfo = {
  plan: TrialPlan
  status: TrialStatus
  trialStartedAt: number
  trialEndsAt: number
  paidUntilMs: number | null
  lastLoginAt: number | null
  lastParentCheckInAt: number | null
}

export type PairingStats = {
  pending: number
  expired: number
  claimed: number
}

export type GuardianInviteStats = {
  pending: number
  expired: number
}

export type ChatActivity = {
  lastMessageAtMs: number | null
  lastSenderRole: string | null
}

export type ApkHealth = {
  id: 'parent-apk' | 'child-apk'
  label: string
  status: TcdCheckStatus
  message: string
  latencyMs?: number | null
  sizeBytes?: number | null
  versionName?: string | null
  versionCode?: number | null
}

export type SiteUptime = {
  id: string
  label: string
  url: string
  status: TcdCheckStatus
  message: string
  latencyMs?: number | null
}

// ---------- Admin control plane ----------

export const FEATURE_KEYS = [
  'whatsappProtection',
  'typingSafety',
  'callRecording',
  'liveViewing',
  'appsBlocking',
  'mapsLiveMap',
  'chat',
  'screenShare',
  'trialPurge',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  whatsappProtection: 'WhatsApp protection',
  typingSafety: 'Typing safety',
  callRecording: 'Call recording',
  liveViewing: 'Live viewing',
  appsBlocking: 'Apps blocking',
  mapsLiveMap: 'Maps / live map',
  chat: 'Family chat',
  screenShare: 'Screen share',
  trialPurge: 'Trial purge job',
}

export type AdminFeatureConfig = {
  global: Record<FeatureKey, boolean>
  liveView: {
    defaultDailyCredits: number
    maxSessionMinutes: number
  }
  /** Global default operational data retention (days) when family has no override. */
  defaultRetentionDays: number
  /** Global default chat video-note length cap (seconds) when family has no override. */
  defaultMaxChatVideoSeconds: number
  updatedAtMs: number
  updatedBy: string | null
}

export type AdminParentAccountRow = {
  uid: string
  email: string
  familyId: string | null
  registeredAt: number | null
  lastActiveAt: number | null
  lastLoginAt: number | null
  plan: string | null
  status: string | null
  adminBlocked: boolean
  trialEndsAt: number | null
  deviceCount: number | null
}

export type LiveViewQuotaAdmin = {
  creditsRemaining: number
  dailyAllowance: number
  resetAtMs: number
  bonusCredits: number
}

export type ArchNode = {
  id: string
  label: string
  group: 'client' | 'firebase' | 'edge' | 'hosting' | 'external'
  status: TcdCheckStatus
  detail?: string
  url?: string
}

export type PlatformFault = {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  source: string
}

export type TcdTab = 'overview' | 'accounts' | 'resellers' | 'features' | 'storage' | 'architecture' | 'system'

export type AdminAuditLogEntry = {
  id: string
  action: string
  adminEmail: string
  targetUid: string
  targetEmail?: string | null
  detail?: string
  atMs: number
}

export type AdminAccountAction = 'reset' | 'delete' | 'trial' | 'revoke' | null

export type StorageFeatureUsage = {
  docs: number
  estimatedBytes: number
  r2Bytes: number
  r2Objects: number
}

export type StorageFeatureRow = StorageFeatureUsage & {
  id: string
  label: string
  limitBytes: number
}

export type StorageAccountRow = {
  familyId: string
  parentUid: string | null
  email: string
  childNames: string[]
  deviceCount: number
  firestoreDocs: number
  r2Bytes: number
  r2Objects: number
  estimatedFirestoreBytes: number
  usedBytes: number
  accountBytesMax: number
  overLimit: boolean
  storageBlocked: boolean
  features: Record<string, StorageFeatureUsage>
}

export type StorageDump = {
  takenAtMs: number
  limits: {
    globalBytesMax: number
    defaultAccountBytesMax: number
    featureBytesMax: Record<string, number>
    updatedAtMs: number
    updatedBy: string | null
  }
  backends: {
    r2: {
      reachable: boolean
      error?: string
      bytes: number
      objects: number
      truncated: boolean
      otherBytes: number
      bucket: string
    }
    firestore: { docs: number; estimatedBytes: number; families: number }
    firebaseStorage: { bytes: number; objects: number; truncated: boolean }
    d1: Record<string, number>
    kv: { note: string }
  }
  features: StorageFeatureRow[]
  accounts: StorageAccountRow[]
  totals: {
    usedBytes: number
    r2Bytes: number
    firebaseStorageBytes: number
    accountCount: number
    overLimitCount: number
  }
}

export type InfraProbe = { ok: boolean; status: number | null; latencyMs: number; body?: unknown }

export type InfraStatus = {
  takenAtMs: number
  droplet: {
    provider: string
    host: string
    roles: Array<{ id: string; label: string; detail: string }>
    probes: {
      opsHealth: InfraProbe
      staging: InfraProbe
      turn3478: { ok: boolean; latencyMs: number }
    }
    digitalocean: Record<string, unknown>
    agentInstalled: boolean
    installHint: string
    docs: string
    consoleUrl: string
  }
  cloudflare: { r2Bucket: string; worker: string; d1: string }
  firebase: { projectId: string; storageBucket: string }
}
