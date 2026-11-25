import { create } from 'zustand'
import { ApiRequestError } from '../../../shared/src/http'
import {
  adminApi,
  login,
  logout,
  verifySession,
  type AdminConfig,
  type AdminCustomSource,
  type AdminStatus,
  type AdminUser,
  type CustomSourceOwner,
  type StoragePage,
  type StorageQuery,
} from './api'

export type AdminView = 'dashboard' | 'users' | 'storage' | 'config' | 'logs' | 'backups' | 'sources'

type AdminState = {
  authenticated: boolean
  checking: boolean
  busy: boolean
  view: AdminView
  users: AdminUser[]
  pendingUserCleanups: string[]
  selectedUser: string
  status: AdminStatus | null
  config: AdminConfig | null
  storage: StoragePage | null
  storageQuery: StorageQuery
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
  setStorageQuery: (query: Partial<StorageQuery>) => void
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
  return Boolean(
    error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError',
  )
}

export const useAdminStore = create<AdminState>((set, get) => ({
  authenticated: false,
  checking: true,
  busy: false,
  view: 'dashboard',
  users: [],
  pendingUserCleanups: [],
  selectedUser: '',
  status: null,
  config: null,
  storage: null,
  storageQuery: { folder: 'cache', page: 0, query: '', sort: 'default' },
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
    } catch (error) {
      set({
        authenticated: false,
        checking: false,
        error: error instanceof ApiRequestError && error.status === 401 ? '' : messageOf(error),
      })
    }
  },
  signIn: async password => {
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
    set({
      authenticated: false,
      checking: false,
      busy: false,
      users: [],
      pendingUserCleanups: [],
      selectedUser: '',
      status: null,
      config: null,
      storage: null,
      storageQuery: { folder: 'cache', page: 0, query: '', sort: 'default' },
      sources: [],
      logs: [],
      error: '',
      toast: '',
    })
  },
  setView: view => {
    set({ view, error: '' })
    void get().loadView(view)
  },
  setSelectedUser: selectedUser => {
    set({ selectedUser, storage: null, storageQuery: { ...get().storageQuery, page: 0 } })
    if (get().view === 'storage') void get().loadView()
  },
  setLogType: logType => {
    set({ logType })
    if (get().view === 'logs') void get().loadView('logs')
  },
  setStorageQuery: query => {
    set({ storage: null, storageQuery: { ...get().storageQuery, ...query } })
    if (get().view === 'storage') void get().loadView('storage')
  },
  setSourceOwner: sourceOwner => {
    set({ sourceOwner, sources: [], error: '' })
    if (get().view === 'sources') void get().loadView('sources')
  },
  loadView: async requestedView => {
    const view = requestedView ?? get().view
    const sequence = ++loadSequence
    activeLoadController?.abort()
    const controller = new AbortController()
    activeLoadController = controller
    const { signal } = controller
    set({ busy: true, error: '' })
    try {
      if (view === 'dashboard') {
        const [status, users] = await Promise.all([adminApi.status(signal), adminApi.users(signal)])
        if (sequence !== loadSequence) return
        set({ status, users })
      } else if (view === 'users') {
        const [users, pendingUserCleanups] = await Promise.all([
          adminApi.users(signal),
          adminApi.pendingUserCleanups(signal),
        ])
        if (sequence !== loadSequence) return
        set({ users, pendingUserCleanups })
      } else if (view === 'storage') {
        const user = get().selectedUser || 'all'
        const result = await adminApi.cacheList(user, get().storageQuery, signal)
        if (sequence !== loadSequence) return
        set(state => ({ storage: result, storageQuery: { ...state.storageQuery, page: result.page } }))
      } else if (view === 'config') {
        const config = await adminApi.config(signal)
        if (sequence !== loadSequence) return
        set({ config })
      } else if (view === 'logs') {
        const result = await adminApi.logs(get().logType, signal)
        if (sequence !== loadSequence) return
        set({ logs: result.logs ?? result.lines ?? [] })
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
      const isUnauthorized = error instanceof ApiRequestError && error.status === 401
      set({ error: message, ...(isUnauthorized ? { authenticated: false } : {}) })
    } finally {
      if (sequence === loadSequence) {
        activeLoadController = null
        set({ busy: false })
      }
    }
  },
  notify: toast => set({ toast }),
  clearToast: () => set({ toast: '' }),
}))
