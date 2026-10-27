import { create } from 'zustand'
import { playerApi, type SearchType } from '../api'
import { invalidateRequestCache, isAbortError } from '../data/request'
import type { Song } from '../types'

let searchController: AbortController | null = null
let searchRequestId = 0

export type SearchState = {
  query: string
  source: string
  type: SearchType
  page: number
  results: Song[]
  loading: boolean
  refreshing: boolean
  error: string
  tips: string[]
  loadedAt: number
  setQuery: (query: string) => void
  setSource: (source: string) => void
  setType: (type: SearchType) => void
  search: (query?: string, page?: number, options?: { force?: boolean }) => Promise<void>
  invalidate: () => void
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  source: 'wy',
  type: 'song',
  page: 1,
  results: [],
  loading: false,
  refreshing: false,
  error: '',
  tips: [],
  loadedAt: 0,
  setQuery: query => {
    if (get().query === query) return
    searchController?.abort()
    searchController = null
    searchRequestId += 1
    set({ query, page: 1, results: [], loading: false, refreshing: false, error: '', loadedAt: 0 })
  },
  setSource: source => {
    searchController?.abort()
    searchRequestId += 1
    set({ source, page: 1, results: [], error: '', loadedAt: 0 })
    const query = get().query.trim()
    if (query) void get().search(query, 1, { force: true })
  },
  setType: type => {
    searchController?.abort()
    searchRequestId += 1
    set({ type, page: 1, results: [], error: '', loadedAt: 0 })
    const query = get().query.trim()
    if (query) void get().search(query, 1, { force: true })
  },
  search: async (query = get().query, page = 1, options = {}) => {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      set({ results: [], error: '请输入搜索内容', loading: false, refreshing: false })
      return
    }
    const hadController = Boolean(searchController)
    searchController?.abort()
    const controller = new AbortController()
    searchController = controller
    const requestId = ++searchRequestId
    const state = get()
    const cacheKey = `search:${state.source}:${state.type}:${normalizedQuery}:${page}`
    set({ query, page, loading: true, refreshing: state.results.length > 0, error: '' })
    try {
      const results = await playerApi.search(normalizedQuery, state.source, state.type, page, controller.signal, {
        cacheKey,
        cacheTtlMs: 30_000,
        force: options.force ?? hadController,
      })
      if (!controller.signal.aborted && requestId === searchRequestId) {
        set({ results: Array.isArray(results) ? results : [], loadedAt: Date.now() })
      }
    } catch (error) {
      if (!controller.signal.aborted && requestId === searchRequestId && !isAbortError(error)) {
        set({ error: error instanceof Error ? error.message : '搜索失败，请稍后重试' })
      }
    } finally {
      if (searchController === controller) {
        searchController = null
        set({ loading: false, refreshing: false })
      }
    }
  },
  invalidate: () => {
    searchController?.abort()
    searchRequestId += 1
    invalidateRequestCache('search:')
    set({ loadedAt: 0 })
  },
}))

export const getSearchActions = () => useSearchStore.getState()

export function prepareSearch(source: string, type: SearchType, query: string): void {
  useSearchStore.setState({
    source,
    type,
    query,
    page: 1,
    results: [],
    error: '',
    refreshing: false,
    loading: false,
    loadedAt: 0,
  })
}
