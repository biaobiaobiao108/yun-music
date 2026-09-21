import { create } from 'zustand'
import { adminApi, login, logout, verifySession, type AdminConfig, type AdminCustomSource, type AdminData, type AdminStatus, type AdminUser, type CustomSourceOwner, type Snapshot, type StorageItem } from './api'

export type AdminView = 'dashboard' | 'users' | 'storage' | 'data' | 'config' | 'logs' | 'snapshots' | 'sources' | 'about'

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
  sourceOwner: CustomSourceOwner
  sources: AdminCustomSource[]
  logs: string[]
  logType: 'app' | 'access' | 'login' | 'error'
  error: string
  toast: string
  hydrate: () => Promise<void>
  signIn: (password: string) => Promise<void>
  signOut: () => Promise<void>
  setView: (view: AdminView) => void
  setSelectedUser: (user: string) => void
  setLogType: (type: 'app' | 'access' | 'login' | 'error') => void
  setStorageFolder: (folder: 'cache' | 'music') => void
  setSourceOwner: (owner: CustomSourceOwner) => void
  loadView: (view?: AdminView) => Promise<void>
  notify: (message: string) => void
  clearToast: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

let loadSequence = 0
let activeLoadController: AbortController | null = null

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError')
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
  sourceOwner: 'open',
  sources: [],
  logs: [],
  logType: 'app',
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
    loadSequence += 1
    activeLoadController?.abort()
    activeLoadController = null
    set({ authenticated: false, checking: false, busy: false, users: [], selectedUser: '', status: null, config: null, data: null, storage: [], snapshots: [], sources: [], logs: [], error: '', toast: '' })
  },
  setView: (view) => {
    set({ view, error: '' })
    void get().loadView(view)
  },
  setSelectedUser: (selectedUser) => {
    const view = get().view
    set({
      selectedUser,
      ...(view === 'data' ? { data: null } : {}),
      ...(view === 'snapshots' ? { snapshots: [] } : {}),
      ...(view === 'storage' ? { storage: [] } : {}),
    })
    if (get().view === 'data' || get().view === 'storage' || get().view === 'snapshots') void get().loadView()
  },
  setLogType: (logType) => {
    set({ logType })
    if (get().view === 'logs') void get().loadView('logs')
  },
  setStorageFolder: (storageFolder) => set({ storageFolder }),
  setSourceOwner: (sourceOwner) => {
    set({ sourceOwner, sources: [], error: '' })
    if (get().view === 'sources') void get().loadView('sources')
  },
  loadView: async (requestedView) => {
    const view = requestedView ?? get().view
    const sequence = ++loadSequence
    activeLoadController?.abort()
    const controller = new AbortController()
    activeLoadController = controller
    const { signal } = controller
    set({ busy: true, error: '' })
    try {
      if (view === 'dashboard') {
        const [status, users] = await Promise.all([adminApi.status(), adminApi.users(signal)])
        if (sequence !== loadSequence) return
        set({ status, users })
      } else if (view === 'users') {
        const users = await adminApi.users(signal)
        if (sequence !== loadSequence) return
        set({ users })
      } else if (view === 'data') {
        const user = get().selectedUser || get().users.find(item => item.name !== '_open')?.name || ''
        if (user) {
          const data = await adminApi.userData(user)
          if (sequence !== loadSequence) return
          set({ selectedUser: user, data })
        } else if (sequence === loadSequence) set({ data: null })
      } else if (view === 'storage') {
        const user = get().selectedUser || 'all'
        const result = await adminApi.cacheList(user)
        if (sequence !== loadSequence) return
        set({ storage: Array.isArray(result?.data) ? result.data : [] })
      } else if (view === 'config') {
        const config = await adminApi.config()
        if (sequence !== loadSequence) return
        set({ config })
      } else if (view === 'logs') {
        const result = await adminApi.logs(get().logType)
        if (sequence !== loadSequence) return
        set({ logs: result.logs ?? result.lines ?? [] })
      } else if (view === 'snapshots') {
        const user = get().selectedUser || get().users.find(item => item.name !== '_open')?.name || ''
        if (user) {
          const snapshots = await adminApi.snapshots(user)
          if (sequence !== loadSequence) return
          set({ selectedUser: user, snapshots })
        } else if (sequence === loadSequence) set({ snapshots: [] })
      } else if (view === 'sources') {
        const owner = get().sourceOwner
        const usersPromise = get().users.length ? Promise.resolve(get().users) : adminApi.users(signal)
        const [users, sources] = await Promise.all([usersPromise, adminApi.customSources(owner, signal)])
        if (sequence !== loadSequence) return
        set({ users, sources })
      }
    } catch (error) {
      if (sequence !== loadSequence) return
      if (isAbortError(error)) return
      const message = messageOf(error)
      set({ error: message, ...(message.includes('登录') ? { authenticated: false } : {}) })
    } finally {
      if (sequence === loadSequence) {
        activeLoadController = null
        set({ busy: false })
      }
    }
  },
  notify: (toast) => set({ toast }),
  clearToast: () => set({ toast: '' }),
}))
