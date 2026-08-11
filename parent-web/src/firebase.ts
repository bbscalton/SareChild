import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { initializeFirestore } from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'

/** Vite only inlines literal `import.meta.env.VITE_*` — dynamic `import.meta.env[name]` stays undefined in production. */
function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`Missing required env: ${name}`)
  }
  return trimmed
}

const firebaseConfig = {
  apiKey: requireEnv(import.meta.env.VITE_FIREBASE_API_KEY, 'VITE_FIREBASE_API_KEY'),
  authDomain: requireEnv(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, 'VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: requireEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID, 'VITE_FIREBASE_PROJECT_ID'),
  storageBucket: requireEnv(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET, 'VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: requireEnv(
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
  ),
  appId: requireEnv(import.meta.env.VITE_FIREBASE_APP_ID, 'VITE_FIREBASE_APP_ID'),
  measurementId: (import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined)?.trim(),
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
// Edge / corporate proxies sometimes break WebChannel streaming; auto-detect long polling.
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
})
export const functions = getFunctions(app)

export const COL = {
  families: 'families',
  devices: 'devices',
  geofences: 'geofences',
  alerts: 'alerts',
  pairingCodes: 'pairingCodes',
  keywordLists: 'keywordLists',
  parentProfiles: 'parentProfiles',
  commands: 'commands',
  appEvents: 'appEvents',
  usageDaily: 'usageDaily',
  locationTrail: 'locationTrail',
  callSmsPreviews: 'callSmsPreviews',
  guardians: 'guardians',
  digests: 'digests',
  sosContacts: 'sosContacts',
  safeContacts: 'safeContacts',
  safetySettings: 'safetySettings',
  appLimits: 'appLimits',
  appBlockSchedules: 'appBlockSchedules',
  guardianInvites: 'guardianInvites',
  screenShareSchedules: 'screenShareSchedules',
  /** Legacy family-wide single thread — superseded by chatMessages nested under devices/{id}. */
  familyChat: 'familyChat',
  /** Per-device chat thread: families/{id}/devices/{deviceId}/chatMessages/{msgId}. */
  chatMessages: 'chatMessages',
  mapPlaces: 'mapPlaces',
  whatsappEvents: 'whatsappEvents',
  typingEvents: 'typingEvents',
  typingSafetySettings: 'typingSafetySettings',
  callRecordings: 'callRecordings',
  photos: 'photos',
  activityEvents: 'activityEvents',
  installedApps: 'installedApps',
  liveSessions: 'liveSessions',
  liveRecordings: 'liveRecordings',
  liveViewQuota: 'liveViewQuota',
  screenSnapshots: 'screenSnapshots',
  cameraSnapshots: 'cameraSnapshots',
} as const

export const WENT_DARK_AFTER_MS = 5 * 60 * 1000
