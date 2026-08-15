import {
  addDoc,
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
  type Unsubscribe,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, COL, db, functions } from './firebase'
import { ADMIN_EMAIL } from './admin'
import type {
  AdminAuditLogEntry,
  AdminFeatureConfig,
  AdminParentAccountRow,
  FeatureKey,
  LiveViewQuotaAdmin,
} from './types'

function requireDb() {
  if (!db) throw new Error('Firebase is not configured for this build.')
  return db
}

function requireFunctions() {
  if (!functions) throw new Error('Firebase Functions is not configured for this build.')
  return functions
}

async function writeClientAuditLog(entry: {
  action: string
  targetUid: string
  targetEmail?: string | null
  detail?: string
}): Promise<void> {
  const database = requireDb()
  await addDoc(collection(database, COL.adminAuditLogs), {
    ...entry,
    adminEmail: auth?.currentUser?.email ?? ADMIN_EMAIL,
    atMs: Date.now(),
  })
}

function callable<TReq, TRes>(name: string, timeout = 70_000) {
  return httpsCallable<TReq, TRes>(requireFunctions(), name, { timeout })
}

const DEFAULT_FEATURES: Record<FeatureKey, boolean> = {
  whatsappProtection: true,
  typingSafety: true,
  callRecording: true,
  liveViewing: true,
  appsBlocking: true,
  mapsLiveMap: true,
  chat: true,
  screenShare: true,
  trialPurge: true,
}

const DEFAULT_LIVE_VIEW = {
  defaultDailyCredits: 10,
  maxSessionMinutes: 5,
}

const DEFAULT_RETENTION_DAYS = 2
const DEFAULT_MAX_CHAT_VIDEO_SECONDS = 180

function nextUtcMidnightMs(fromMs: number): number {
  const d = new Date(fromMs)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime()
}

function parseAccountRow(uid: string, data: Record<string, unknown>): AdminParentAccountRow {
  return {
    uid,
    email: (data.email as string | undefined) ?? '',
    familyId: (data.familyId as string | undefined) ?? null,
    registeredAt: data.registeredAt == null ? Number(data.createdAtMs ?? 0) || null : Number(data.registeredAt),
    lastActiveAt: data.lastActiveAt == null ? null : Number(data.lastActiveAt),
    lastLoginAt: data.lastLoginAt == null ? null : Number(data.lastLoginAt),
    plan: (data.plan as string | undefined) ?? null,
    status: (data.status as string | undefined) ?? null,
    adminBlocked: Boolean(data.adminBlocked),
    trialEndsAt: data.trialEndsAt == null ? null : Number(data.trialEndsAt),
    deviceCount: null,
  }
}

async function attachDeviceCounts(rows: AdminParentAccountRow[]): Promise<AdminParentAccountRow[]> {
  const database = requireDb()
  return Promise.all(
    rows.map(async (row) => {
      if (!row.familyId) return row
      try {
        const devices = await getDocs(collection(database, COL.families, row.familyId, COL.devices))
        return { ...row, deviceCount: devices.size }
      } catch {
        return { ...row, deviceCount: null }
      }
    }),
  )
}

export function observeAdminAccounts(onData: (rows: AdminParentAccountRow[]) => void, onError?: (err: Error) => void): Unsubscribe {
  const database = requireDb()
  return onSnapshot(
    collection(database, COL.parentProfiles),
    (snap) => {
      void (async () => {
        const base = snap.docs.map((d) => parseAccountRow(d.id, d.data() as Record<string, unknown>))
        const rows = await attachDeviceCounts(base)
        rows.sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))
        onData(rows)
      })().catch((e) => onError?.(e instanceof Error ? e : new Error(String(e))))
    },
    (err) => onError?.(err),
  )
}

export async function blockAccount(uid: string, reason?: string): Promise<void> {
  const database = requireDb()
  const now = Date.now()
  const snap = await getDoc(doc(database, COL.parentProfiles, uid))
  const email = (snap.data()?.email as string | undefined) ?? ''
  await updateDoc(doc(database, COL.parentProfiles, uid), {
    status: 'blocked',
    adminBlocked: true,
    blockedAtMs: now,
    blockedReason: reason?.trim() || 'Blocked by project administrator',
    blockedBy: auth?.currentUser?.email ?? 'admin',
  })
  await writeClientAuditLog({
    action: 'block_account',
    targetUid: uid,
    targetEmail: email,
    detail: reason?.trim() || 'Blocked by project administrator',
  })
}

export async function unblockAccount(uid: string): Promise<void> {
  const database = requireDb()
  const ref = doc(database, COL.parentProfiles, uid)
  const snap = await getDoc(ref)
  const prevStatus = snap.data()?.status as string | undefined
  const email = (snap.data()?.email as string | undefined) ?? ''
  await updateDoc(ref, {
    status: prevStatus === 'blocked' ? 'active' : prevStatus ?? 'active',
    adminBlocked: false,
    blockedAtMs: null,
    blockedReason: null,
    blockedBy: null,
  })
  await writeClientAuditLog({
    action: 'unblock_account',
    targetUid: uid,
    targetEmail: email,
  })
}

export async function grantLiveViewCredits(
  uid: string,
  opts: { addCredits?: number; setCredits?: number; bonusCredits?: number },
): Promise<void> {
  const database = requireDb()
  const ref = doc(database, COL.liveViewQuota, uid)
  const snap = await getDoc(ref)
  const now = Date.now()
  const resetAtMs = nextUtcMidnightMs(now)
  const dailyAllowance = DEFAULT_LIVE_VIEW.defaultDailyCredits

  if (!snap.exists()) {
    const credits = opts.setCredits ?? opts.addCredits ?? dailyAllowance
    await setDoc(ref, {
      creditsRemaining: credits,
      dailyAllowance,
      resetAtMs,
      bonusCredits: opts.bonusCredits ?? 0,
      grantedByAdminAtMs: now,
    })
    return
  }

  const data = snap.data() ?? {}
  const current = Number(data.creditsRemaining ?? dailyAllowance)
  const bonus = Number(data.bonusCredits ?? 0)
  let creditsRemaining = current
  if (opts.setCredits != null) creditsRemaining = opts.setCredits
  else if (opts.addCredits != null) creditsRemaining = current + opts.addCredits

  await setDoc(
    ref,
    {
      creditsRemaining,
      dailyAllowance: Number(data.dailyAllowance ?? dailyAllowance),
      resetAtMs: Number(data.resetAtMs ?? resetAtMs),
      bonusCredits: opts.bonusCredits != null ? bonus + opts.bonusCredits : bonus,
      grantedByAdminAtMs: now,
    },
    { merge: true },
  )
  await writeClientAuditLog({
    action: 'grant_credits',
    targetUid: uid,
    detail: JSON.stringify(opts),
  })
}

export async function loadLiveViewQuota(uid: string): Promise<LiveViewQuotaAdmin | null> {
  const database = requireDb()
  const snap = await getDoc(doc(database, COL.liveViewQuota, uid))
  if (!snap.exists()) return null
  const data = snap.data()
  return {
    creditsRemaining: Number(data.creditsRemaining ?? 0),
    dailyAllowance: Number(data.dailyAllowance ?? DEFAULT_LIVE_VIEW.defaultDailyCredits),
    resetAtMs: Number(data.resetAtMs ?? 0),
    bonusCredits: Number(data.bonusCredits ?? 0),
  }
}

export function observeAdminFeatures(onData: (config: AdminFeatureConfig) => void, onError?: (err: Error) => void): Unsubscribe {
  const database = requireDb()
  return onSnapshot(
    doc(database, COL.adminConfig, 'features'),
    (snap) => {
      const data = snap.data()
      onData({
        global: { ...DEFAULT_FEATURES, ...(data?.global as Record<FeatureKey, boolean> | undefined) },
        liveView: {
          defaultDailyCredits: Number(data?.liveView?.defaultDailyCredits ?? DEFAULT_LIVE_VIEW.defaultDailyCredits),
          maxSessionMinutes: Number(data?.liveView?.maxSessionMinutes ?? DEFAULT_LIVE_VIEW.maxSessionMinutes),
        },
        defaultRetentionDays: Number(data?.defaultRetentionDays ?? DEFAULT_RETENTION_DAYS),
        defaultMaxChatVideoSeconds: Number(data?.defaultMaxChatVideoSeconds ?? DEFAULT_MAX_CHAT_VIDEO_SECONDS),
        updatedAtMs: Number(data?.updatedAtMs ?? 0),
        updatedBy: (data?.updatedBy as string | undefined) ?? null,
      })
    },
    (err) => onError?.(err),
  )
}

export async function saveAdminFeatures(config: AdminFeatureConfig): Promise<void> {
  const database = requireDb()
  await setDoc(doc(database, COL.adminConfig, 'features'), {
    global: config.global,
    liveView: config.liveView,
    defaultRetentionDays: config.defaultRetentionDays,
    defaultMaxChatVideoSeconds: config.defaultMaxChatVideoSeconds,
    updatedAtMs: Date.now(),
    updatedBy: auth?.currentUser?.email ?? 'admin',
  })
}

export async function loadFeatureOverrides(uid: string): Promise<Partial<Record<FeatureKey, boolean>>> {
  const database = requireDb()
  const snap = await getDoc(doc(database, COL.adminFeatureOverrides, uid))
  if (!snap.exists()) return {}
  return (snap.data()?.overrides as Partial<Record<FeatureKey, boolean>>) ?? {}
}

export async function saveFeatureOverrides(uid: string, overrides: Partial<Record<FeatureKey, boolean>>): Promise<void> {
  const database = requireDb()
  await setDoc(doc(database, COL.adminFeatureOverrides, uid), {
    overrides,
    updatedAtMs: Date.now(),
    updatedBy: auth?.currentUser?.email ?? 'admin',
  })
}

export async function runPlatformAutoRepair(): Promise<string[]> {
  const database = requireDb()
  const fixes: string[] = []
  const profiles = await getDocs(collection(database, COL.parentProfiles))

  for (const profileDoc of profiles.docs) {
    const data = profileDoc.data()
    const uid = profileDoc.id
    const familyId = data.familyId as string | undefined

    if (data.adminBlocked === true && data.status !== 'blocked') {
      await updateDoc(profileDoc.ref, { status: 'blocked' })
      fixes.push(`Synced blocked status for ${data.email || uid}.`)
    }
    if (data.status === 'blocked' && data.adminBlocked !== true) {
      await updateDoc(profileDoc.ref, { adminBlocked: true })
      fixes.push(`Set adminBlocked flag for ${data.email || uid}.`)
    }

    const quotaRef = doc(database, COL.liveViewQuota, uid)
    const quotaSnap = await getDoc(quotaRef)
    if (!quotaSnap.exists()) {
      const now = Date.now()
      await setDoc(quotaRef, {
        creditsRemaining: DEFAULT_LIVE_VIEW.defaultDailyCredits,
        dailyAllowance: DEFAULT_LIVE_VIEW.defaultDailyCredits,
        resetAtMs: nextUtcMidnightMs(now),
        bonusCredits: 0,
      })
      fixes.push(`Created missing liveViewQuota for ${data.email || uid}.`)
    }

    if (familyId) {
      const familySnap = await getDoc(doc(database, COL.families, familyId))
      const parentUid = familySnap.get('parentUid') as string | undefined
      const parentEmail = (familySnap.get('parentEmail') as string | undefined) || (data.email as string | undefined) || ''
      if (parentUid) {
        const guardianRef = doc(database, COL.families, familyId, COL.guardians, parentUid)
        const guardianSnap = await getDoc(guardianRef)
        if (!guardianSnap.exists()) {
          await setDoc(guardianRef, { email: parentEmail, role: 'OWNER', joinedAtMs: Date.now() })
          fixes.push(`Restored OWNER guardian for family ${familyId}.`)
        }
      }
    }
  }

  if (fixes.length === 0) fixes.push('No platform-wide repairs needed.')
  return fixes
}

export function observeAdminAuditLogs(
  onData: (rows: AdminAuditLogEntry[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const database = requireDb()
  const q = query(collection(database, COL.adminAuditLogs), orderBy('atMs', 'desc'), limit(100))
  return onSnapshot(
    q,
    (snap) => {
      onData(
        snap.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            action: String(data.action ?? ''),
            adminEmail: String(data.adminEmail ?? ''),
            targetUid: String(data.targetUid ?? ''),
            targetEmail: (data.targetEmail as string | undefined) ?? null,
            detail: (data.detail as string | undefined) ?? undefined,
            atMs: Number(data.atMs ?? 0),
          }
        }),
      )
    },
    (err) => onError?.(err),
  )
}

export async function adminWipeUser(uid: string, selfConfirm = false): Promise<{ newFamilyId: string }> {
  const res = await callable<{ uid: string; selfConfirm?: boolean }, { newFamilyId: string }>('adminWipeUser')({
    uid,
    selfConfirm,
  })
  return res.data
}

export async function adminDeleteUser(uid: string, selfConfirm = false): Promise<void> {
  await callable<{ uid: string; selfConfirm?: boolean }, { ok: boolean }>('adminDeleteUser')({
    uid,
    selfConfirm,
  })
}

export async function adminRevokeSessions(uid: string): Promise<void> {
  await callable<{ uid: string }, { ok: boolean }>('adminRevokeSessions')({ uid })
}

export async function adminAdjustTrial(
  uid: string,
  patch: { plan?: 'trial' | 'paid'; status?: 'active' | 'at_risk' | 'blocked'; extendDays?: number },
): Promise<void> {
  await callable('adminAdjustTrial')({ uid, ...patch })
}

export async function adminTriggerPurgeRetention(): Promise<{
  familiesScanned: number
  docsDeleted: number
  mediaDeleted: number
}> {
  const res = await callable<
    object,
    { familiesScanned: number; docsDeleted: number; mediaDeleted: number }
  >('adminTriggerPurgeRetention')({})
  return res.data
}

export async function loadFamilyRetentionDays(familyId: string): Promise<number> {
  const database = requireDb()
  const snap = await getDoc(doc(database, COL.families, familyId))
  const familyDays = snap.get('retentionDays')
  if (familyDays != null && Number.isFinite(Number(familyDays))) {
    return Math.min(90, Math.max(2, Number(familyDays)))
  }
  const configSnap = await getDoc(doc(database, COL.adminConfig, 'features'))
  const globalDefault = Number(configSnap.get('defaultRetentionDays') ?? DEFAULT_RETENTION_DAYS)
  return Math.min(90, Math.max(2, globalDefault))
}

export async function adminSetRetention(uid: string, retentionDays: number): Promise<{ familyId: string; retentionDays: number }> {
  const res = await callable<{ uid: string; retentionDays: number }, { familyId: string; retentionDays: number }>(
    'adminSetRetention',
  )({ uid, retentionDays })
  return res.data
}

export async function loadFamilyMaxChatVideoSeconds(familyId: string): Promise<number> {
  const database = requireDb()
  const snap = await getDoc(doc(database, COL.families, familyId))
  const familySeconds = snap.get('maxChatVideoSeconds')
  if (familySeconds != null && Number.isFinite(Number(familySeconds))) {
    return Math.min(600, Math.max(30, Number(familySeconds)))
  }
  const configSnap = await getDoc(doc(database, COL.adminConfig, 'features'))
  const globalDefault = Number(configSnap.get('defaultMaxChatVideoSeconds') ?? DEFAULT_MAX_CHAT_VIDEO_SECONDS)
  return Math.min(600, Math.max(30, globalDefault))
}

export async function adminSetChatVideoLimit(
  uid: string,
  maxChatVideoSeconds: number,
): Promise<{ familyId: string; maxChatVideoSeconds: number }> {
  const res = await callable<{ uid: string; maxChatVideoSeconds: number }, { familyId: string; maxChatVideoSeconds: number }>(
    'adminSetChatVideoLimit',
  )({ uid, maxChatVideoSeconds })
  return res.data
}

export async function adminTriggerPurgeTrials(): Promise<{ warned: number; purged: number; scanned: number }> {
  const res = await callable<object, { warned: number; purged: number; scanned: number }>('adminTriggerPurgeTrials')({})
  return res.data
}

export async function adminRepairOrphans(): Promise<string[]> {
  const res = await callable<object, { fixes: string[] }>('adminRepairOrphans')({})
  return res.data.fixes
}

export async function adminRepairCrossTenantGuardians(): Promise<string[]> {
  const res = await callable<object, { fixes: string[] }>('adminRepairCrossTenantGuardians')({})
  return res.data.fixes
}

export async function adminResetAccountFamilyIsolation(email: string): Promise<string[]> {
  const res = await callable<{ email: string }, { fixes: string[] }>('adminResetAccountFamilyIsolation')({
    email,
  })
  return res.data.fixes
}

export async function adminSendTestFcm(familyId: string, deviceId: string): Promise<{ successCount: number }> {
  const res = await callable<{ familyId: string; deviceId: string }, { successCount: number }>('adminSendTestFcm')({
    familyId,
    deviceId,
  })
  return res.data
}

function callableErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = String((e as { code?: string }).code ?? '')
    const message = String((e as { message?: string }).message ?? fallback)
    const details = (e as { details?: unknown }).details
    const extra = typeof details === 'string' ? details : details != null ? JSON.stringify(details) : ''
    return [code, message, extra].filter(Boolean).join(' — ')
  }
  return e instanceof Error ? e.message : fallback
}

export async function adminGetStorageDump(): Promise<import('./types').StorageDump> {
  try {
    const res = await callable<object, import('./types').StorageDump>('adminGetStorageDump', 120_000)({})
    return res.data
  } catch (e) {
    throw new Error(callableErrorMessage(e, 'Storage dump failed'))
  }
}

export async function adminGetInfraStatus(): Promise<import('./types').InfraStatus> {
  try {
    const res = await callable<object, import('./types').InfraStatus>('adminGetInfraStatus', 20_000)({})
    return res.data
  } catch (e) {
    throw new Error(callableErrorMessage(e, 'Infra status failed'))
  }
}

export async function adminSetStorageLimits(payload: {
  globalBytesMax?: number
  defaultAccountBytesMax?: number
  featureBytesMax?: Record<string, number>
  familyId?: string
  accountBytesMax?: number | null
}): Promise<unknown> {
  const res = await callable<typeof payload, unknown>('adminSetStorageLimits')(payload)
  return res.data
}

export async function adminClearStorage(payload: {
  scope: 'feature' | 'account' | 'platform' | 'pc-store'
  familyId?: string
  feature?: string
  confirm?: string
}): Promise<{ docs: number; media: number; families?: number; deletedBytes?: number; storePath?: string }> {
  const res = await callable<
    typeof payload,
    { docs: number; media: number; families?: number; deletedBytes?: number; storePath?: string }
  >('adminClearStorage')(payload)
  return res.data
}

export async function adminManagePcStorage(action: 'health' | 'list' | 'clear', confirm?: string) {
  const res = await callable<
    { action: string; confirm?: string },
    {
      ok?: boolean
      files?: Array<{ path: string; bytes: number; mtimeMs: number }>
      storeBytes?: number
      storeFiles?: number
      storePath?: string
      deletedFiles?: number
      deletedBytes?: number
      reachable?: boolean
      error?: string | null
      diskUsedBytes?: number
      diskTotalBytes?: number
    }
  >('adminManagePcStorage')({ action, confirm })
  return res.data
}

export async function adminFactoryResetAccount(familyId: string, confirm: string): Promise<{ familyId: string }> {
  const res = await callable<{ familyId: string; confirm: string }, { familyId: string }>('adminFactoryResetAccount')({
    familyId,
    confirm,
  })
  return res.data
}

export function exportAccountsCsv(accounts: AdminParentAccountRow[]): string {
  const header = [
    'uid',
    'email',
    'familyId',
    'registeredAt',
    'lastActiveAt',
    'plan',
    'status',
    'adminBlocked',
    'trialEndsAt',
    'deviceCount',
  ]
  const rows = accounts.map((a) =>
    [
      a.uid,
      a.email,
      a.familyId ?? '',
      a.registeredAt ?? '',
      a.lastActiveAt ?? '',
      a.plan ?? '',
      a.status ?? '',
      a.adminBlocked ? 'yes' : 'no',
      a.trialEndsAt ?? '',
      a.deviceCount ?? '',
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  )
  return [header.join(','), ...rows].join('\n')
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function isSelfAdminAccount(email: string, adminEmail: string | null | undefined): boolean {
  return email.trim().toLowerCase() === (adminEmail ?? ADMIN_EMAIL).trim().toLowerCase()
}

// ---------- Reseller program (TCD) ----------

export type ResellerRow = {
  uid: string
  email: string
  displayName?: string
  status: string
  creditBalance: number
  createdAtMs?: number
  activatedAtMs?: number
  notes?: string
}

export type ResellerLedgerEntry = {
  id: string
  resellerUid: string
  delta: number
  balanceAfter: number
  reason: string
  createdAtMs: number
  meta?: Record<string, unknown>
}

export async function listResellers(): Promise<ResellerRow[]> {
  const fn = callable<Record<string, never>, { ok: boolean; resellers: ResellerRow[] }>('adminListResellers')
  const res = await fn({})
  return (res.data.resellers ?? []).map((r) => ({
    ...r,
    creditBalance: Number(r.creditBalance ?? 0),
    status: String(r.status ?? 'pending'),
    email: String(r.email ?? ''),
  }))
}

export async function setResellerStatus(opts: {
  email?: string
  uid?: string
  status: 'pending' | 'active' | 'suspended'
  displayName?: string
  notes?: string
}): Promise<{ uid: string; email: string; status: string }> {
  const fn = callable<typeof opts, { ok: boolean; uid: string; email: string; status: string }>(
    'adminSetResellerStatus',
  )
  const res = await fn(opts)
  return res.data
}

export async function topUpResellerCredits(uid: string, amount: number, note?: string): Promise<number> {
  const fn = callable<{ uid: string; amount: number; note?: string }, { ok: boolean; creditBalance: number }>(
    'adminTopUpResellerCredits',
  )
  const res = await fn({ uid, amount, note })
  return Number(res.data.creditBalance)
}

export async function getResellerLedger(uid: string): Promise<ResellerLedgerEntry[]> {
  const fn = callable<{ uid: string }, { ok: boolean; entries: ResellerLedgerEntry[] }>('adminGetResellerLedger')
  const res = await fn({ uid })
  return res.data.entries ?? []
}

export async function saveResellerPricing(pricing: Record<string, unknown>): Promise<void> {
  const fn = callable<{ pricing: Record<string, unknown> }, { ok: boolean }>('adminSaveResellerPricing')
  await fn({ pricing })
}

export type ResellerApplicationRow = {
  id: string
  name?: string
  email?: string
  phone?: string
  country?: string
  businessType?: string | null
  message?: string | null
  status?: string
  createdAtMs?: number
}

export async function listResellerApplications(): Promise<ResellerApplicationRow[]> {
  const fn = callable<Record<string, never>, { ok: boolean; applications: ResellerApplicationRow[] }>(
    'adminListResellerApplications',
  )
  const res = await fn({})
  return res.data.applications ?? []
}
