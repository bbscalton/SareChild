import type { User } from 'firebase/auth'

const ADMIN_EMAILS = (
  (import.meta.env.VITE_ADMIN_EMAILS as string | undefined) ?? 'neuereatec@gmail.com'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const ADMIN_UIDS = ((import.meta.env.VITE_ADMIN_UIDS as string | undefined) ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function isProjectAdmin(user: User | null | undefined): boolean {
  if (!user) return false
  if (ADMIN_UIDS.includes(user.uid)) return true
  const email = user.email?.trim().toLowerCase()
  return Boolean(email && ADMIN_EMAILS.includes(email))
}
