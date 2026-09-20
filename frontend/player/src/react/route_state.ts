import type { PlayerDetail, PlayerTab } from './types'

export type PlayerNavigation = { tab: PlayerTab; detail: PlayerDetail | null; listId?: string }

export const VALID_PLAYER_TABS: PlayerTab[] = [
  'home', 'favorites', 'recent', 'albums', 'artists', 'genres', 'library',
  'search', 'songlist', 'leaderboard', 'localmusic', 'settings', 'about',
]

export function parsePlayerHash(hash: string): { tab: PlayerTab; listId: string } {
  const raw = hash.replace(/^#/, '')
  const [tabPart, queryPart = ''] = raw.split('?')
  let decodedTab = tabPart || ''
  try { decodedTab = decodeURIComponent(decodedTab) } catch { decodedTab = '' }
  const query = new URLSearchParams(queryPart)
  const tab = VALID_PLAYER_TABS.includes(decodedTab as PlayerTab) ? decodedTab as PlayerTab : 'home'
  return { tab, listId: query.get('listId') || 'love' }
}

export function serializePlayerHash(route: Pick<PlayerNavigation, 'tab' | 'listId'>): string {
  if (route.tab === 'favorites' && route.listId && route.listId !== 'love') {
    return `#favorites?listId=${encodeURIComponent(route.listId)}`
  }
  return `#${encodeURIComponent(route.tab)}`
}

let routeWriter: ((navigation: PlayerNavigation) => void) | null = null

/**
 * UI actions emit a route intent through this adapter. The PlayerShell owns
 * History API writes; the store itself never mutates window.history.
 */
export function connectPlayerNavigation(navigate: (navigation: PlayerNavigation) => void): () => void {
  routeWriter = navigate
  return () => { if (routeWriter === navigate) routeWriter = null }
}

export function emitPlayerNavigation(navigation: PlayerNavigation): void {
  routeWriter?.(navigation)
}

export function goBack(): void {
  if (typeof window !== 'undefined') window.history.back()
}

export function goForward(): void {
  if (typeof window !== 'undefined') window.history.forward()
}
