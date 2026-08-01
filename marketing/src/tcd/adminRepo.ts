import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { auth, COL, db } from './firebase'
import type {
  AdminFeatureConfig,
  AdminParentAccountRow,
  FeatureKey,
  LiveViewQuotaAdmin,
} from './types'

function requireDb() {
  if (!db) throw new Error('Firebase is not configured for this build.')
  return db
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
  await updateDoc(doc(database, COL.parentProfiles, uid), {
    status: 'blocked',
    adminBlocked: true,
    blockedAtMs: now,
    blockedReason: reason?.trim() || 'Blocked by project administrator',
    blockedBy: auth?.currentUser?.email ?? 'admin',
  })
}

export async function unblockAccount(uid: string): Promise<void> {
  const database = requireDb()
  const ref = doc(database, COL.parentProfiles, uid)
  const snap = await getDoc(ref)
  const prevStatus = snap.data()?.status as string | undefined
  await updateDoc(ref, {
    status: prevStatus === 'blocked' ? 'active' : prevStatus ?? 'active',
    adminBlocked: false,
    blockedAtMs: null,
    blockedReason: null,
    blockedBy: null,
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
