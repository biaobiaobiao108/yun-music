import { create } from 'zustand'
import { playerApi, type PlayerConfig } from '../api'
import { invalidateRequestCache, setUnauthorizedHandler } from '../data/request'
import { setSessionScope } from '../session'
import { writeString } from '../../../../shared/src/storage'
import { browserStorage, initialUserName } from './shared'
import { useCacheStore } from './cache'
import { useLibraryStore } from './library'
import { useMediaLibraryStore } from './media_library'
import { usePlaybackStore } from './playback'
import { useRecentStore } from './recent'
import { useSettingsStore } from './settings'
import { useSearchStore } from './search'
import { useLyricStore } from './lyric'
import { useCommentStore } from './comments'

// React StrictMode intentionally re-runs mount effects in development. Keep
// the initial session check single-flight so a second effect cannot reset the
// user-scoped stores after the first library hydration has completed.
let authHydrationPromise: Promise<void> | null = null
let unauthorizedSessionCheck: Promise<void> | null = null
let authStateRevision = 0

export type AuthState = {
  config: PlayerConfig | null
  playerAuthRequired: boolean
  playerAuthenticated: boolean
  userName: string | null
  userAuthenticated: boolean
  checking: boolean
  error: string
  hydrate: () => Promise<void>
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  userLogin: (username: string, password: string) => Promise<void>
  userLogout: () => Promise<void>
}

function resetUserScopedStores(): void {
  usePlaybackStore.getState().reset()
  useRecentStore.getState().reset()
  useLibraryStore.getState().reset()
  useMediaLibraryStore.getState().reset()
  useCacheStore.getState().reset()
  useSettingsStore.getState().reset()
  useSearchStore.getState().reset()
  useLyricStore.getState().reset()
  void useCommentStore.getState().load(null)
}

function refreshUserScopedStores(): void {
  useRecentStore.getState().hydrate()
  usePlaybackStore.getState().hydrate()
  void Promise.allSettled([
    useSettingsStore.getState().hydrate(),
    useLibraryStore.getState().hydrate({ force: true }),
    useMediaLibraryStore.getState().hydrate({ force: true }),
  ])
}

function clearUserSession(): void {
  authStateRevision += 1
  invalidateRequestCache()
  setSessionScope(null)
  resetUserScopedStores()
  writeString(browserStorage(), 'lx_user_name', '')
  useAuthStore.setState({ userName: null, userAuthenticated: false })
}

function reconcileUnauthorizedSessions(): Promise<void> {
  if (unauthorizedSessionCheck) return unauthorizedSessionCheck

  const state = useAuthStore.getState()
  if (state.checking || (!state.playerAuthenticated && !state.userAuthenticated)) return Promise.resolve()

  const revision = authStateRevision
  const check = (async () => {
    try {
      const [playerSession, userSession] = await Promise.all([
        state.playerAuthRequired && state.playerAuthenticated ? playerApi.verify() : Promise.resolve(null),
        state.userAuthenticated ? playerApi.userVerify() : Promise.resolve(null),
      ])

      if (revision !== authStateRevision) return

      if (playerSession && !playerSession.valid) {
        authStateRevision += 1
        useAuthStore.setState({ playerAuthenticated: false })
      }
      if (userSession && !userSession.valid) clearUserSession()
    } catch {
      // Keep the current state when the verification request itself fails.
    }
  })()

  unauthorizedSessionCheck = check
  const clearCheck = () => {
    if (unauthorizedSessionCheck === check) unauthorizedSessionCheck = null
  }
  void check.then(clearCheck, clearCheck)
  return check
}

export const useAuthStore = create<AuthState>((set, get) => ({
  config: null,
  playerAuthRequired: false,
  playerAuthenticated: false,
  userName: initialUserName(),
  userAuthenticated: false,
  checking: true,
  error: '',
  hydrate: () => {
    if (authHydrationPromise) return authHydrationPromise

    authStateRevision += 1
    const promise = (async () => {
      set({ checking: true, error: '' })
      try {
        const config = await playerApi.config()
        const [playerSession, userSession] = await Promise.all([playerApi.verify(), playerApi.userVerify()])
        const authenticatedUserName = userSession.valid ? userSession.username || get().userName : null
        authStateRevision += 1
        setSessionScope(authenticatedUserName)
        resetUserScopedStores()
        set({
          config,
          playerAuthRequired: Boolean(config['player.enableAuth']),
          playerAuthenticated: !config['player.enableAuth'] || playerSession.valid,
          userAuthenticated: userSession.valid,
          userName: authenticatedUserName,
          checking: false,
        })
        writeString(browserStorage(), 'lx_user_name', authenticatedUserName || '')
      } catch (error) {
        set({ checking: false, error: error instanceof Error ? error.message : '初始化失败，请刷新重试' })
      }
    })()

    authHydrationPromise = promise
    void promise.then(
      () => {
        if (authHydrationPromise === promise) authHydrationPromise = null
      },
      () => {
        if (authHydrationPromise === promise) authHydrationPromise = null
      },
    )
    return promise
  },
  login: async password => {
    await playerApi.login(password)
    authStateRevision += 1
    set({ playerAuthenticated: true, error: '' })
  },
  logout: async () => {
    try {
      await playerApi.logout()
    } catch {
      // The local session must still close when the server is unreachable.
    }
    authStateRevision += 1
    invalidateRequestCache()
    set({ playerAuthenticated: false })
  },
  userLogin: async (username, password) => {
    const result = await playerApi.userLogin(username, password)
    authStateRevision += 1
    invalidateRequestCache()
    setSessionScope(result.username)
    resetUserScopedStores()
    writeString(browserStorage(), 'lx_user_name', result.username)
    set({ userName: result.username, userAuthenticated: true })
    refreshUserScopedStores()
  },
  userLogout: async () => {
    try {
      await playerApi.userLogout()
    } catch {
      // Clear local user state even if the server session already expired.
    }
    clearUserSession()
  },
}))

// A 401 after the initial hydration means the server-side session was revoked
// or expired. Close the local gate instead of leaving the UI in a logged-in
// state where every subsequent request fails.
setUnauthorizedHandler(pathname => {
  if (pathname === '/api/user/login' || pathname === '/api/music/auth' || pathname === '/api/admin/verify') return
  const state = useAuthStore.getState()
  if (pathname.startsWith('/api/music/')) {
    void reconcileUnauthorizedSessions()
    return
  }
  if (pathname.startsWith('/api/user/') || pathname === '/api/users') {
    if (!state.userAuthenticated) return
    clearUserSession()
  }
})
