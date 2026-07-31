// Turns the technical AlertType/AlertSeverity enums (shared with the Android apps)
// into plain-language labels, icons, and colors for a parent who has never seen
// the underlying data model. Mirrors parent/DashboardActivity.kt's icon/label maps
// so alerts read the same way across Android and web.

export type SeverityTone = 'critical' | 'high' | 'medium' | 'low'

export function severityTone(severity: string): SeverityTone {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
      return 'high'
    case 'LOW':
      return 'low'
    default:
      return 'medium'
  }
}

/** A tiny inline emoji-style glyph — avoids pulling in an icon font/library for the web app. */
export function alertIcon(type: string): string {
  switch (type) {
    case 'SOS':
      return '🆘'
    case 'GEOFENCE_ENTER':
    case 'GEOFENCE_EXIT':
      return '📍'
    case 'LOW_BATTERY':
      return '🔋'
    case 'WENT_DARK':
      return '📶'
    case 'TAMPER':
    case 'PERMISSION_REVOKED':
    case 'DEVICE_LOCKED':
    case 'DEVICE_UNLOCKED':
    case 'SCREEN_SHARE':
    case 'CAMERA_CHECK':
    case 'MIC_CHECK':
    case 'RING_DEVICE':
      return '🛡️'
    case 'KEYWORD':
    case 'MESSAGE_PREVIEW':
    case 'UNIDENTIFIED_CONTACT':
      return '💬'
    case 'WHATSAPP_MEDIA':
      return '📷'
    case 'WHATSAPP_CALL':
      return '📞'
    case 'APP_INSTALL':
    case 'APP_UNINSTALL':
    case 'USAGE_LIMIT':
    case 'APP_BLOCKED':
      return '📱'
    default:
      return 'ℹ️'
  }
}

export function alertCategoryLabel(type: string): string {
  switch (type) {
    case 'SOS':
      return 'Emergency SOS'
    case 'GEOFENCE_ENTER':
    case 'GEOFENCE_EXIT':
      return 'Safe zone'
    case 'LOW_BATTERY':
      return 'Battery'
    case 'WENT_DARK':
      return 'Connection'
    case 'TAMPER':
    case 'PERMISSION_REVOKED':
      return 'Device tampering'
    case 'SCREEN_SHARE':
    case 'CAMERA_CHECK':
    case 'MIC_CHECK':
    case 'RING_DEVICE':
    case 'DEVICE_LOCKED':
    case 'DEVICE_UNLOCKED':
      return 'Safety check'
    case 'KEYWORD':
    case 'MESSAGE_PREVIEW':
    case 'UNIDENTIFIED_CONTACT':
      return 'Message safety'
    case 'WHATSAPP_MEDIA':
    case 'WHATSAPP_CALL':
      return 'WhatsApp'
    case 'APP_INSTALL':
    case 'APP_UNINSTALL':
      return 'App activity'
    case 'USAGE_LIMIT':
    case 'APP_BLOCKED':
      return 'Screen time'
    case 'CHECK_IN':
      return 'Check-in'
    default:
      return 'Update'
  }
}

/** "3m ago" / "2h ago" / "5d ago" style relative time, falling back to a date past a week. */
export function relativeTime(atMs: number): string {
  if (!atMs) return 'unknown time'
  const diffMs = Date.now() - atMs
  if (diffMs < 0) return 'just now'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diffMs < minute) return 'just now'
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`
  return new Date(atMs).toLocaleDateString()
}
