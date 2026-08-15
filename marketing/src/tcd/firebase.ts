import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

// Standalone Firebase client for the Pages-hosted TCD console — same project as
// parent-web, but its own `initializeApp` call since this bundle never loads
// parent-web's code. Values come from GitHub Actions secrets at build time
// (see .github/workflows/deploy-marketing-pages.yml), the same secrets already
// used by the parent-web Firebase Hosting build.
function readEnv(name: string): string {
  return ((import.meta.env as Record<string, string | undefined>)[name] ?? '').trim()
}

export const FIREBASE_CONFIGURED = Boolean(readEnv('VITE_FIREBASE_API_KEY') && readEnv('VITE_FIREBASE_PROJECT_ID'))

const firebaseConfig = {
  apiKey: readEnv('VITE_FIREBASE_API_KEY'),
  authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: readEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: readEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: readEnv('VITE_FIREBASE_APP_ID'),
  measurementId: readEnv('VITE_FIREBASE_MEASUREMENT_ID') || undefined,
}

export const app = FIREBASE_CONFIGURED ? initializeApp(firebaseConfig) : null
export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null
export const functions = app ? getFunctions(app, 'us-central1') : null

if (functions && import.meta.env.DEV && readEnv('VITE_FUNCTIONS_EMULATOR') === '1') {
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
}

export const COL = {
  families: 'families',
  devices: 'devices',
  alerts: 'alerts',
  guardians: 'guardians',
  commands: 'commands',
  parentProfiles: 'parentProfiles',
  pairingCodes: 'pairingCodes',
  guardianInvites: 'guardianInvites',
  familyChat: 'familyChat',
  safetySettings: 'safetySettings',
  keywordLists: 'keywordLists',
  liveViewQuota: 'liveViewQuota',
  adminConfig: 'adminConfig',
  adminFeatureOverrides: 'adminFeatureOverrides',
  adminAuditLogs: 'adminAuditLogs',
} as const

export const WENT_DARK_AFTER_MS = 5 * 60 * 1000
export const R2_BASE_URL = readEnv('VITE_R2_MEDIA_PROXY_BASE_URL') || 'https://sarechild-media-proxy.neuereatec.workers.dev'
export const PLATFORM_HEALTH_URL =
  readEnv('VITE_PLATFORM_HEALTH_URL') || `${R2_BASE_URL.replace(/\/$/, '')}/platform-health`
export const FUNCTIONS_HEALTH_URL =
  readEnv('VITE_FUNCTIONS_HEALTH_URL') ||
  'https://us-central1-safechild-f34ac.cloudfunctions.net/platformHealth'
export const FIREBASE_CONSOLE_URL =
  readEnv('VITE_FIREBASE_CONSOLE_URL') || 'https://console.firebase.google.com/project/safechild-f34ac'
export const FIREBASE_AUTH_CONSOLE_URL = `${FIREBASE_CONSOLE_URL}/authentication/users`
export const FIREBASE_FIRESTORE_CONSOLE_URL = `${FIREBASE_CONSOLE_URL}/firestore`
export const FIREBASE_FUNCTIONS_CONSOLE_URL = `${FIREBASE_CONSOLE_URL}/functions`
export const PARENT_WEB_URL = readEnv('VITE_PARENT_WEB_URL') || 'https://safechild-f34ac.web.app/'
export const MARKETING_URL = readEnv('VITE_MARKETING_URL') || 'https://bbscalton.github.io/SareChild/'
export const TCD_URL = readEnv('VITE_TCD_URL') || `${MARKETING_URL.replace(/\/?$/, '/')}tcd.html`
export const GITHUB_REPO_URL = readEnv('VITE_GITHUB_REPO_URL') || 'https://github.com/bbscalton/SareChild'
