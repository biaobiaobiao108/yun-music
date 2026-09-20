import { create } from 'zustand'
import { adminApi, login, logout, verifySession, type AdminConfig, type AdminData, type AdminStatus, type AdminUser, type Snapshot, type StorageItem } from './api'

export type AdminView = 'dashboard' | 'users' | 'storage' | 'data' | 'config' | 'logs' | 'snapshots' | 'about'

type AdminState = {
  authenticated: boolean
  checking: boolean
  busy: boolean
  view: AdminView
  users: AdminUser[]
  selectedUser: string
  status: AdminStatus | null
  config: AdminConfig | null
  data: AdminData | null
  storage: StorageItem[]
  storageFolder: 'cache' | 'music'
  snapshots: Snapshot[]
  logs: string[]
  error: string
  toast: string
  hydrate: () => Promise<void>
  signIn: (password: string) => Promise<void>
  signOut: () => Promise<void>
  setView: (view: AdminView) => void
  setSelectedUser: (user: string) => void
  loadView: (view?: AdminView) => Promise<void>
  notify: (message: string) => void
  clearToast: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

export const useAdminStore = create<AdminState>((set, get) => ({
  authenticated: false,
  checking: true,
  busy: false,
  view: 'dashboard',
  users: [],
  selectedUser: '',
  status: null,
  config: null,
  data: null,
  storage: [],
  storageFolder: 'cache',
  snapshots: [],
  logs: [],
  error: '',
  toast: '',
  hydrate: async () => {
    set({ checking: true, error: '' })
    try {
      const status = await verifySession()
      set({ authenticated: true, checking: false, status })
      await get().loadView('dashboard')
    } catch {
      set({ authenticated: false, checking: false })
    }
  },
  signIn: async (password) => {
    if (!password.trim()) throw new Error('请输入密码')
    set({ busy: true, error: '' })
    try {
      await login(password)
      const status = await verifySession()
      set({ authenticated: true, checking: false, status })
      await get().loadView('dashboard')
    } catch (error) {
      set({ authenticated: false, error: messageOf(error) })
      throw error
    } finally {
      set({ busy: false })
    }
  },
  signOut: async () => {
    await logout()
    set({ authenticated: false, users: [], data: null, config: null })
  },
  setView: (view) => {
    set({ view, error: '' })
    void get().loadView(view)
  },
  setSelectedUser: (selectedUser) => {
    set({ selectedUser })
    if (get().view === 'data' || get().view === 'storage' || get().view === 'snapshots') void get().loadView()
  },
  loadView: async (requestedView) => {
    const view = requestedView ?? get().view
    set({ busy: true, error: '' })
    try {
      if (view === 'dashboard') {
        const [status, users] = await Promise.all([adminApi.status(), adminApi.users()])
        set({ status, users })
      } else if (view === 'users') {
        set({ users: await adminApi.users() })
      } else if (view === 'data') {
        const user = get().selectedUser || get().users.find(item => item.name !== '_open')?.name || ''
        if (user) set({ selectedUser: user, data: await adminApi.userData(user) })
      } else if (view === 'storage') {
        const user = get().selectedUser || 'all'
        const result = await adminApi.cacheList(user)
        set({ storage: Array.isArray(result?.data) ? result.data : [] })
      } else if (view === 'config') {
        set({ config: await adminApi.config() })
      } else if (view === 'logs') {
        const result = await adminApi.logs('app')
        set({ logs: result.logs ?? result.lines ?? [] })
      } else if (view === 'snapshots') {
        const user = get().selectedUser || get().users.find(item => item.name !== '_open')?.name || ''
        if (user) set({ selectedUser: user, snapshots: await adminApi.snapshots(user) })
      }
    } catch (error) {
      const message = messageOf(error)
      set({ error: message, ...(message.includes('登录') ? { authenticated: false } : {}) })
    } finally {
      set({ busy: false })
    }
  },
  notify: (toast) => set({ toast }),
  clearToast: () => set({ toast: '' }),
}))
