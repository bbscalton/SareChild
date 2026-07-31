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
export type TrialStatus = 'active' | 'at_risk' | 'purged'

export type TrialInfo = {
  plan: TrialPlan
  status: TrialStatus
  trialStartedAt: number
  trialEndsAt: number
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
}

export type SiteUptime = {
  id: string
  label: string
  url: string
  status: TcdCheckStatus
  message: string
  latencyMs?: number | null
}
