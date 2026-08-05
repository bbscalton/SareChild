import { httpsCallable } from 'firebase/functions'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, functions, COL } from '../tcd/firebase'

function requireFunctions() {
  if (!functions) throw new Error('Firebase Functions not configured')
  return functions
}

function callable<TReq, TRes>(name: string) {
  return httpsCallable<TReq, TRes>(requireFunctions(), name)
}

export type PlanDays = 15 | 30 | 90

export type ResellerPricing = {
  plans: Record<
    string,
    {
      days: number
      retailGyd: number
      label: string
    }
  >
  gydPerUsd: number
  xcdPerUsd: number
  wholesaleGydPerCreditDay: number
}

export type ParentAccountView = {
  uid: string
  email: string
  plan: string
  status: string
  adminBlocked: boolean
  trialStartedAt: number
  trialEndsAt: number
  paidUntilMs: number | null
  hasPaidAccess: boolean
  subscriptionSource: string | null
  familyId: string | null
  lastLoginAt: number | null
}

export type ResellerDashboard = {
  reseller: {
    uid: string
    email: string
    displayName: string
    creditBalance: number
    status: string
  }
  pricing: ResellerPricing
  ledger: Array<{
    id: string
    delta: number
    balanceAfter: number
    reason: string
    createdAtMs: number
    meta?: Record<string, unknown>
  }>
  vouchers: Array<{
    code: string
    planDays: number
    expiresAtMs: number
    status: string
    createdAtMs: number
  }>
}

export async function getOwnResellerDoc(): Promise<{ status: string; creditBalance: number } | null> {
  if (!auth?.currentUser || !db) return null
  const snap = await getDoc(doc(db, 'resellers', auth.currentUser.uid))
  if (!snap.exists()) return null
  const data = snap.data()
  return {
    status: String(data.status ?? 'pending'),
    creditBalance: Number(data.creditBalance ?? 0),
  }
}

export async function fetchDashboard(): Promise<ResellerDashboard> {
  const fn = callable<Record<string, never>, { ok: boolean } & ResellerDashboard>('resellerGetDashboard')
  const res = await fn({})
  return res.data
}

export async function lookupParent(email: string): Promise<ParentAccountView> {
  const fn = callable<{ email: string }, { ok: boolean; account: ParentAccountView }>('resellerLookupParent')
  const res = await fn({ email })
  return res.data.account
}

export async function activateParent(email: string, planDays: PlanDays) {
  const fn = callable<
    { email: string; planDays: number },
    { ok: boolean; creditBalance: number; account: ParentAccountView }
  >('resellerActivateParent')
  return (await fn({ email, planDays })).data
}

export async function createVoucher(planDays: PlanDays, redeemWithinDays: 30 | 60 | 90) {
  const fn = callable<
    { planDays: number; redeemWithinDays: number },
    { ok: boolean; creditBalance: number; voucher: { code: string; planDays: number; expiresAtMs: number; status: string } }
  >('resellerCreateVoucher')
  return (await fn({ planDays, redeemWithinDays })).data
}

export async function voidVoucher(code: string) {
  const fn = callable<{ code: string }, { ok: boolean; creditBalance: number; refunded: number }>('resellerVoidVoucher')
  return (await fn({ code })).data
}

export function formatMoney(gyd: number, pricing: ResellerPricing) {
  const usd = gyd / (pricing.gydPerUsd || 209)
  const xcd = usd * (pricing.xcdPerUsd || 2.7)
  return {
    gyd: `G$${gyd.toLocaleString()}`,
    usd: `US$${usd.toFixed(2)}`,
    xcd: `EC$${xcd.toFixed(2)}`,
  }
}

export { COL }
