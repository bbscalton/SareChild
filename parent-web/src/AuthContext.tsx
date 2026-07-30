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
import type { TrialInfo } from './types'

type AuthContextValue = {
  user: User | null
  loading: boolean
  familyId: string | null
  trialInfo: TrialInfo | null
  refreshFamilyId: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [familyId, setFamilyId] = useState<string | null>(null)
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
          const id = await repo.getFamilyId()
          setFamilyId(id)
        } catch {
          setFamilyId(null)
        }
      } else {
        setFamilyId(null)
        setTrialInfo(null)
      }
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!user) return
    return repo.observeTrialInfo(user.uid, setTrialInfo)
  }, [user])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      familyId,
      trialInfo,
      refreshFamilyId,
      signIn: async (email, password) => {
        await repo.signIn(email, password)
      },
      signUp: async (email, password) => {
        await repo.signUp(email, password)
      },
      signInWithGoogle: async () => {
        await repo.signInWithGoogle()
      },
      signOut: async () => {
        await repo.signOut()
      },
    }),
    [user, loading, familyId, trialInfo],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
