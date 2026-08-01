import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './firebase'
import * as repo from './lib/parentRepo'
import type { ParentProfileInfo, TrialInfo } from './types'

type AuthContextValue = {
  user: User | null
  loading: boolean
  familyId: string | null
  parentProfile: ParentProfileInfo | null
  trialInfo: TrialInfo | null
  needsTerms: boolean
  refreshFamilyId: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, acceptLegal: boolean) => Promise<void>
  signInWithGoogle: () => Promise<void>
  acceptTerms: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [familyId, setFamilyId] = useState<string | null>(null)
  const [parentProfile, setParentProfile] = useState<ParentProfileInfo | null>(null)
  const [trialInfo, setTrialInfo] = useState<TrialInfo | null>(null)

  const refreshFamilyId = async () => {
    if (!auth.currentUser) {
      setFamilyId(null)
      return
    }
    const id = await repo.getFamilyId()
    setFamilyId(id)
  }

  useEffect(() => {
    return onAuthStateChanged(auth, async (next) => {
      setUser(next)
      if (next) {
        void repo.recordLogin(next.uid)
        try {
          await repo.ensureKeywordListSeeded()
          const id = await repo.ensureParentProfile(next.uid, next.email ?? '')
          setFamilyId(id)
        } catch {
          setFamilyId(null)
        }
      } else {
        setFamilyId(null)
        setParentProfile(null)
        setTrialInfo(null)
      }
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!user) return
    return repo.observeParentProfile(
      user.uid,
      (profile) => {
        if (profile?.adminBlocked || profile?.accountStatus === 'blocked' || profile?.trial?.status === 'blocked') {
          void repo.signOut()
          return
        }
        setParentProfile(profile)
        setTrialInfo(profile?.trial ?? null)
        if (profile?.familyId) setFamilyId(profile.familyId)
      },
      () => {
        setParentProfile(null)
        setTrialInfo(null)
      },
    )
  }, [user])

  const needsTerms = repo.needsTermsAcceptance(parentProfile)

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      familyId,
      parentProfile,
      trialInfo,
      needsTerms,
      refreshFamilyId,
      signIn: async (email, password) => {
        await repo.signIn(email, password)
        const uid = auth.currentUser?.uid
        if (uid) {
          await repo.ensureParentProfile(uid, email)
        }
      },
      signUp: async (email, password, acceptLegal) => {
        await repo.signUp(email, password, acceptLegal)
      },
      signInWithGoogle: async () => {
        await repo.signInWithGoogle()
      },
      acceptTerms: async () => {
        await repo.acceptTermsOfService()
      },
      signOut: async () => {
        await repo.signOut()
      },
    }),
    [user, loading, familyId, parentProfile, trialInfo, needsTerms],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
