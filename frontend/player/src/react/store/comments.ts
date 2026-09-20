import { create } from 'zustand'
import { playerApi, type CommentItem } from '../api'
import { isAbortError } from '../data/request'
import type { Song } from '../types'

let commentController: AbortController | null = null

export function normalizeComments(payload: unknown): { items: CommentItem[]; total: number; maxPage: number } {
  if (Array.isArray(payload)) return { items: payload as CommentItem[], total: payload.length, maxPage: 1 }
  if (!payload || typeof payload !== 'object') return { items: [], total: 0, maxPage: 1 }
  const record = payload as Record<string, unknown>
  const items = (['comments', 'list', 'data', 'hotComments', 'newComments'].map(key => record[key]).find(value => Array.isArray(value)) ?? []) as CommentItem[]
  const total = Math.max(items.length, Number(record.total ?? record.totalCount ?? record.commentCount ?? 0) || 0)
  const maxPage = Math.max(1, Number(record.maxPage ?? record.totalPages ?? Math.ceil(total / 20)) || 1)
  return { items, total, maxPage }
}

export type CommentState = {
  song: Song | null
  type: 'hot' | 'new'
  page: number
  total: number
  maxPage: number
  items: CommentItem[]
  loading: boolean
  error: string
  load: (song: Song | null, type?: 'hot' | 'new', page?: number) => Promise<void>
  setType: (type: 'hot' | 'new') => void
  next: () => void
  previous: () => void
}

export const useCommentStore = create<CommentState>((set, get) => ({
  song: null,
  type: 'hot',
  page: 1,
  total: 0,
  maxPage: 1,
  items: [],
  loading: false,
  error: '',
  load: async (song, type = get().type, page = 1) => {
    if (!song) {
      set({ song: null, items: [], total: 0, maxPage: 1, page, loading: false, error: '' })
      return
    }
    commentController?.abort()
    const controller = new AbortController()
    commentController = controller
    set({ song, type, page, loading: true, error: '' })
    try {
      const result = normalizeComments(await playerApi.comments(song, type, page, 20, controller.signal))
      if (!controller.signal.aborted) set({ items: result.items, total: result.total, maxPage: result.maxPage })
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) set({ items: [], error: error instanceof Error ? error.message : '评论加载失败' })
    } finally {
      if (commentController === controller) {
        commentController = null
        set({ loading: false })
      }
    }
  },
  setType: type => {
    set({ type, page: 1 })
    const song = get().song
    if (song) void get().load(song, type, 1)
  },
  next: () => {
    const state = get()
    if (state.song && state.page < state.maxPage) void state.load(state.song, state.type, state.page + 1)
  },
  previous: () => {
    const state = get()
    if (state.song && state.page > 1) void state.load(state.song, state.type, state.page - 1)
  },
}))
