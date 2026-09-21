import { create } from 'zustand'
import { playerApi, type PlayerConfig } from '../api'
import { invalidateRequestCache } from '../data/request'
import { setSessionScope } from '../session'
import { writeString } from '../../../../shared/src/storage'
import { browserStorage, initialUserName } from './shared'
import { useCacheStore } from './cache'
import { useLibraryStore } from './library'
import { useMediaLibraryStore } from './media_library'
import { usePlaybackStore } from './playback'
import { useRecentStore } from './recent'
import { useSettingsStore } from './settings'

// React StrictMode intentionally re-runs mount effects in development. Keep
// the initial session check single-flight so a second effect cannot reset the
// user-scoped stores after the first library hydration has completed.
let authHydrationPromise: Promise<void> | null = null

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

    const promise = (async () => {
      set({ checking: true, error: '' })
      try {
        const config = await playerApi.config()
        const [playerSession, userSession] = await Promise.all([playerApi.verify(), playerApi.userVerify()])
        const authenticatedUserName = userSession.valid ? (userSession.username || get().userName) : null
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
      () => { if (authHydrationPromise === promise) authHydrationPromise = null },
      () => { if (authHydrationPromise === promise) authHydrationPromise = null },
    )
    return promise
  },
  login: async password => {
    await playerApi.login(password)
    set({ playerAuthenticated: true, error: '' })
  },
  logout: async () => {
    await playerApi.logout()
    invalidateRequestCache()
    set({ playerAuthenticated: false })
  },
  userLogin: async (username, password) => {
    const result = await playerApi.userLogin(username, password)
    invalidateRequestCache()
    setSessionScope(result.username)
    resetUserScopedStores()
    writeString(browserStorage(), 'lx_user_name', result.username)
    set({ userName: result.username, userAuthenticated: true })
    refreshUserScopedStores()
  },
  userLogout: async () => {
    await playerApi.userLogout()
    invalidateRequestCache()
    setSessionScope(null)
    resetUserScopedStores()
    writeString(browserStorage(), 'lx_user_name', '')
    set({ userName: null, userAuthenticated: false })
  },
}))
