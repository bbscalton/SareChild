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

type AuthContextValue = {
  user: User | null
  loading: boolean
  familyId: string | null
  refreshFamilyId: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [familyId, setFamilyId] = useState<string | null>(null)

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
        try {
          await repo.ensureKeywordListSeeded()
          const id = await repo.getFamilyId()
          setFamilyId(id)
        } catch {
          setFamilyId(null)
        }
      } else {
        setFamilyId(null)
      }
      setLoading(false)
    })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      familyId,
      refreshFamilyId,
      signIn: async (email, password) => {
        await repo.signIn(email, password)
      },
      signUp: async (email, password) => {
        await repo.signUp(email, password)
      },
      signOut: async () => {
        await repo.signOut()
      },
    }),
    [user, loading, familyId],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
