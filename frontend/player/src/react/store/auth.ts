import { create } from 'zustand'
import { playerApi, type PlayerConfig } from '../api'
import { invalidateRequestCache } from '../data/request'
import { writeString } from '../../../../shared/src/storage'
import { browserStorage, initialUserName } from './shared'

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

export const useAuthStore = create<AuthState>((set, get) => ({
  config: null,
  playerAuthRequired: false,
  playerAuthenticated: false,
  userName: initialUserName(),
  userAuthenticated: false,
  checking: true,
  error: '',
  hydrate: async () => {
    set({ checking: true, error: '' })
    try {
      const config = await playerApi.config()
      const [playerSession, userSession] = await Promise.all([playerApi.verify(), playerApi.userVerify()])
      const authenticatedUserName = userSession.valid ? (userSession.username || get().userName) : null
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
    writeString(browserStorage(), 'lx_user_name', result.username)
    set({ userName: result.username, userAuthenticated: true })
  },
  userLogout: async () => {
    await playerApi.userLogout()
    invalidateRequestCache()
    writeString(browserStorage(), 'lx_user_name', '')
    set({ userName: null, userAuthenticated: false })
  },
}))
