import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { auth, COL, db, FIREBASE_CONFIGURED } from './firebase'
import { isProjectAdmin } from './admin'
import type { TrialInfo } from './types'

type AuthContextValue = {
  configured: boolean
  user: User | null
  loading: boolean
  isAdmin: boolean
  blockedMessage: string | null
  familyId: string | null
  trialInfo: TrialInfo | null
  refreshFamilyId: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [familyId, setFamilyId] = useState<string | null>(null)
  const [trialInfo, setTrialInfo] = useState<TrialInfo | null>(null)
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)

  const isAdmin = isProjectAdmin(user)

  const refreshFamilyId = async () => {
    if (!auth?.currentUser || !db) {
      setFamilyId(null)
      return
    }
    const snap = await getDoc(doc(db, COL.parentProfiles, auth.currentUser.uid))
    setFamilyId((snap.data()?.familyId as string | undefined) ?? null)
  }

  useEffect(() => {
    if (!FIREBASE_CONFIGURED || !auth) {
      setLoading(false)
      return
    }
    return onAuthStateChanged(auth, async (next) => {
      setUser(next)
      if (next) {
        await refreshFamilyId().catch(() => setFamilyId(null))
      } else {
        setFamilyId(null)
        setTrialInfo(null)
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!user || !db) return
    return onSnapshot(doc(db, COL.parentProfiles, user.uid), (snap) => {
      const data = snap.data()
      if (data?.status === 'blocked' || data?.adminBlocked === true) {
        setBlockedMessage(
          (data.blockedReason as string | undefined) ||
            'Your SareChild account has been suspended by the project administrator.',
        )
        if (auth) void firebaseSignOut(auth)
        return
      }
      if (!data || data.plan == null) {
        setTrialInfo(null)
        return
      }
      setTrialInfo({
        plan: (data.plan as TrialInfo['plan']) || 'trial',
        status: (data.status as TrialInfo['status']) || 'active',
        trialStartedAt: Number(data.trialStartedAt ?? 0),
        trialEndsAt: Number(data.trialEndsAt ?? 0),
        paidUntilMs: data.paidUntilMs == null ? null : Number(data.paidUntilMs),
        lastLoginAt: data.lastLoginAt == null ? null : Number(data.lastLoginAt),
        lastParentCheckInAt: data.lastParentCheckInAt == null ? null : Number(data.lastParentCheckInAt),
      })
    })
  }, [user])

  const value = useMemo<AuthContextValue>(
    () => ({
      configured: FIREBASE_CONFIGURED,
      user,
      loading,
      isAdmin,
      blockedMessage,
      familyId,
      trialInfo,
      refreshFamilyId,
      signIn: async (email, password) => {
        if (!auth) throw new Error('Firebase is not configured for this build.')
        await signInWithEmailAndPassword(auth, email, password)
      },
      signInWithGoogle: async () => {
        if (!auth) throw new Error('Firebase is not configured for this build.')
        await signInWithPopup(auth, new GoogleAuthProvider())
      },
      signOut: async () => {
        if (!auth) return
        await firebaseSignOut(auth)
      },
    }),
    [user, loading, isAdmin, blockedMessage, familyId, trialInfo],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
