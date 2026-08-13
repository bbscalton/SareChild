import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { FIREBASE_CONFIGURED, functions } from './tcd/firebase'

export type ResellerApplicationPayload = {
  name: string
  email: string
  phone: string
  country: string
  businessType?: string
  message?: string
}

export async function submitResellerApplication(
  payload: ResellerApplicationPayload,
): Promise<{ ok: boolean; applicationId: string }> {
  if (!FIREBASE_CONFIGURED || !functions) {
    throw new Error('Registration is temporarily unavailable. Please try again later.')
  }
  const fn = httpsCallable<ResellerApplicationPayload, { ok: boolean; applicationId: string }>(
    functions,
    'resellerApply',
  )
  const res = await fn(payload)
  return res.data
}

export function applyErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    if (err.code === 'functions/already-exists') {
      return 'We already received an application from this email today. We will be in touch soon.'
    }
    if (err.code === 'functions/invalid-argument') {
      return err.message.replace(/^.*?:\s*/, '') || err.message
    }
    return err.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}
