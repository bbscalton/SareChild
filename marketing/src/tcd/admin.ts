import type { User } from 'firebase/auth'

const ADMIN_EMAIL = 'neuereatec@gmail.com'

export { ADMIN_EMAIL }

export function isProjectAdmin(user: User | null | undefined): boolean {
  if (!user) return false
  return user.email?.trim().toLowerCase() === ADMIN_EMAIL
}
