import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

function requireEnv(name: string): string {
  const value = (import.meta.env[name] as string | undefined)?.trim()
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }
  return value
}

const firebaseConfig = {
  apiKey: requireEnv('VITE_FIREBASE_API_KEY'),
  authDomain: requireEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: requireEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: requireEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: requireEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: requireEnv('VITE_FIREBASE_APP_ID'),
  measurementId: (import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined)?.trim(),
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)

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
  familyChat: 'familyChat',
  mapPlaces: 'mapPlaces',
  whatsappEvents: 'whatsappEvents',
  typingEvents: 'typingEvents',
  typingSafetySettings: 'typingSafetySettings',
  callRecordings: 'callRecordings',
  photos: 'photos',
  installedApps: 'installedApps',
  liveSessions: 'liveSessions',
  liveRecordings: 'liveRecordings',
  liveViewQuota: 'liveViewQuota',
} as const

export const WENT_DARK_AFTER_MS = 5 * 60 * 1000
