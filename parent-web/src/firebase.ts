import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
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
} as const

export const WENT_DARK_AFTER_MS = 5 * 60 * 1000
