import type { WhatsAppEvent, WhatsAppEventType } from '../types'

export type WhatsAppDisplayType = 'INCOMING' | 'OUTGOING' | 'CALL' | 'MEDIA' | 'UNKNOWN'

const CHROME_KEYWORDS = [
  'ask meta ai',
  'inbox filters',
  'communities',
  'start your community',
  'swipe down to reveal',
  'new status update',
  'status updates',
  'archived chats',
  'starred messages',
  'search chats',
  'linked devices',
  'broadcast lists',
  'disappearing messages',
  'view status',
]

const INBOX_MARKERS = ['inbox filters', 'communities', 'ask meta ai']

const MEDIA_TYPES: WhatsAppEventType[] = ['IMAGE', 'VIDEO', 'VOICE_NOTE', 'DOCUMENT']

const CALL_HINTS = [
  'voice call',
  'video call',
  'missed voice call',
  'missed video call',
  'calling',
  'call ended',
  'incoming voice call',
  'ongoing voice call',
]

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** True when [label] is WhatsApp's own "You" sender label (own bubble in a group chat, or a
 *  MessagingStyle notification's self-authored line) rather than a real contact — an
 *  unambiguous outgoing signal, independent of whatever `direction` got stored. */
function isSelfContact(label: string): boolean {
  return norm(label).replace(/[^a-z]/g, '') === 'you'
}

export function isChromePreview(text: string): boolean {
  const lower = norm(text)
  if (!lower) return false
  const inboxHits = INBOX_MARKERS.filter((m) => lower.includes(m)).length
  if (inboxHits >= 2) return true
  if (inboxHits >= 1 && lower.length > 180) return true
  if (lower.length > 100 && CHROME_KEYWORDS.some((k) => lower.includes(k))) {
    const lineCount = text.split(/\n/).filter((l) => l.trim()).length
    if (lineCount > 6) return true
  }
  return false
}

function isChromeLine(line: string): boolean {
  const lower = norm(line)
  if (lower.length <= 2) return true
  if (CHROME_KEYWORDS.some((k) => lower.includes(k))) return true
  return ['chats', 'updates', 'calls', 'communities', 'status', 'camera', 'search', 'settings'].includes(
    lower,
  )
}

function isTimestampLine(line: string): boolean {
  return (
    /^\d{1,2}:\d{2}(\s*[ap]m)?$/i.test(line.trim()) ||
    /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(line.trim())
  )
}

function mediaLabel(t: WhatsAppEventType): string {
  switch (t) {
    case 'IMAGE':
      return 'Photo'
    case 'VIDEO':
      return 'Video'
    case 'VOICE_NOTE':
      return 'Voice note'
    case 'DOCUMENT':
      return 'Document'
    default:
      return 'Media'
  }
}

/**
 * Message/call/media TYPE and "unknown contact" are different facts — an event from a contact
 * who isn't on the safe list is still an incoming message, outgoing message, or call, and
 * should be labeled as such. Use `!ev.contactSafe` (surfaced as a separate badge/filter, see
 * `WhatsAppEventsTable`) for the unknown-*contact* concept instead.
 *
 * `eventType === 'UNKNOWN_CONTACT'` is a legacy value written by older child app builds that
 * collapsed the real type into that enum on first sighting of a contact — recover the best
 * type we can from direction/preview instead of showing a meaningless "Unknown" type forever.
 */
export function displayType(ev: WhatsAppEvent): WhatsAppDisplayType {
  if (ev.eventType === 'CALL') return 'CALL'
  if (MEDIA_TYPES.includes(ev.eventType)) return 'MEDIA'
  if (isSelfContact(ev.contactLabel)) return 'OUTGOING'
  if (ev.eventType === 'UNKNOWN_CONTACT') {
    const preview = norm(ev.preview || '')
    if (CALL_HINTS.some((h) => preview.includes(h))) return 'CALL'
    return ev.direction === 'OUT' ? 'OUTGOING' : 'INCOMING'
  }
  return ev.direction === 'OUT' ? 'OUTGOING' : 'INCOMING'
}

export function displayTypeLabel(t: WhatsAppDisplayType): string {
  return t
}

export function formatWhatsAppDate(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function parseEventDisplay(ev: WhatsAppEvent): { name: string; message: string } {
  const label = (ev.contactLabel || 'Unknown contact').trim()
  const preview = (ev.preview || '').trim()

  if (MEDIA_TYPES.includes(ev.eventType)) {
    const body = preview && !isChromePreview(preview) ? preview : mediaLabel(ev.eventType)
    return { name: label, message: body }
  }

  if (ev.eventType === 'CALL') {
    const body =
      preview && !isChromePreview(preview)
        ? preview
        : CALL_HINTS.find((h) => norm(preview).includes(h)) || 'Call'
    return { name: label, message: body }
  }

  if (!preview || isChromePreview(preview)) {
    return { name: label, message: '' }
  }

  if (ev.source === 'notification' && preview.includes(' — ')) {
    const parts = preview.split(' — ').map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2) {
      const name = parts[0] || label
      const message = parts.slice(1).join(' — ')
      if (!isChromePreview(message)) return { name, message }
    }
  }

  if (preview.includes('\n')) {
    const lines = preview
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !isChromeLine(l) && !isTimestampLine(l))
    if (lines.length >= 2) {
      const name = lines[0].length <= 60 ? lines[0] : label
      const message = lines.slice(1).join(' ').trim()
      if (message && !isChromePreview(message)) return { name: name || label, message }
    }
  }

  if (label && preview.startsWith(label)) {
    const rest = preview.slice(label.length).replace(/^[·\-—:\s]+/, '').trim()
    if (rest && !isChromePreview(rest)) return { name: label, message: rest }
  }

  if (!isChromePreview(preview)) return { name: label, message: preview }
  return { name: label, message: '' }
}

/**
 * The "Unknown" chip means unknown *contacts* (not on the parent's safe list) — matching what
 * the parent actually wants to review — not an "untyped" event, which should now never occur
 * for new events (see `displayType`).
 */
export function eventMatchesTypeFilter(ev: WhatsAppEvent, filter: WhatsAppDisplayType | 'ALL'): boolean {
  if (filter === 'ALL') return true
  if (filter === 'UNKNOWN') return !ev.contactSafe
  return displayType(ev) === filter
}
