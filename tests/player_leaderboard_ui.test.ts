import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, MUSIC_SOURCE_OPTIONS, normalizeMusicSource } from '../frontend/player/src/react/store/shared'
import { usePlayerUiStore } from '../frontend/player/src/react/store/ui'

const root = path.join(import.meta.dir, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')
const section = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end))

const initialUi = usePlayerUiStore.getState()
afterEach(() => usePlayerUiStore.setState(initialUi))

describe('Player leaderboard and default source', () => {
  it('normalizes the persisted music source', () => {
    expect(DEFAULT_SETTINGS.defaultSource).toBe('wy')
    expect(MUSIC_SOURCE_OPTIONS.map(option => option.value)).toEqual(['wy', 'tx'])
    expect(normalizeMusicSource('tx')).toBe('tx')
    expect(normalizeMusicSource('unknown')).toBe('wy')
  })

  it('selects a leaderboard without leaving the current view or adding navigation', () => {
    usePlayerUiStore.setState({ tab: 'leaderboard', detail: null, leaderboardBoardId: '19723756' })
    usePlayerUiStore.getState().selectLeaderboardBoard('3778678')
    expect(usePlayerUiStore.getState()).toMatchObject({
      tab: 'leaderboard',
      detail: null,
      leaderboardBoardId: '3778678',
    })
  })

  it('uses one default source across content pages', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const heavyViews = read('frontend/player/src/react/heavy_views.tsx')
    const libraryViews = read('frontend/player/src/react/library_views.tsx')
    const searchView = section(views, 'export function SearchView(', 'export function FavoritesView()')
    const settingsView = section(views, 'export function SettingsView()', 'type ImmersiveFooterHost')
    const songListView = section(heavyViews, 'function SongListGrid()', 'export function SongListView(')
    const leaderboardView = section(heavyViews, 'export function LeaderboardView()', 'function localCacheItemKey(')
    const homeDiscovery = section(libraryViews, 'function HomeDiscovery()', 'export function RecentView()')
    expect(searchView).not.toContain('label="音源"')
    expect(searchView).toContain('state.settings.defaultSource')
    expect(songListView).not.toContain('label="音源"')
    expect(songListView).toContain('state.settings.defaultSource')
    expect(leaderboardView).not.toContain('label="音源"')
    expect(leaderboardView).toContain('state.settings.defaultSource')
    expect(homeDiscovery).toContain('state.settings.defaultSource')
    expect(settingsView).toContain('默认音源')
    expect(settingsView).toContain("setSetting('defaultSource', value)")
  })

  it('renders a two-column chart browser with accurate pagination and covers', () => {
    const heavyViews = read('frontend/player/src/react/heavy_views.tsx')
    const libraryViews = read('frontend/player/src/react/library_views.tsx')
    const css = read('frontend/styles/player.css')
    const leaderboardView = section(heavyViews, 'export function LeaderboardView()', 'function localCacheItemKey(')
    expect(leaderboardView).toContain('className="react-leaderboard-layout"')
    expect(leaderboardView).toContain('className="react-leaderboard-index-region"')
    expect(leaderboardView).toContain('className="react-leaderboard-index custom-scrollbar"')
    expect(leaderboardView).toContain('className="react-leaderboard-detail"')
    expect(leaderboardView).toContain('className="react-leaderboard-songs-region"')
    expect(leaderboardView).toContain('ref={songsScrollRef}')
    expect(heavyViews).toContain('LEADERBOARD_PAGE_SIZE = 100')
    expect(leaderboardView).toContain('total > limit')
    expect(leaderboardView).toContain('page >= pageCount')
    expect(leaderboardView).toContain('loadedBoardRef.current !== selected')
    expect(leaderboardView).not.toContain('scrollIntoView')
    expect(libraryViews).toContain("image: safeImageUrl(item.img ?? item.coverImgUrl ?? item.picUrl, '')")
    expect(libraryViews).toContain('<SafeImage src={chart.image}')
    const leaderboardCss = css.slice(css.indexOf('.react-leaderboard-layout'))
    const mobileStart = leaderboardCss.indexOf('@media (max-width: 900px)')
    const mobileCss = leaderboardCss.slice(
      mobileStart,
      leaderboardCss.indexOf('@media (max-width: 560px)', mobileStart),
    )
    expect(leaderboardCss).toMatch(
      /\.react-leaderboard-layout\s*\{[^}]*grid-template-columns:\s*minmax\(13rem, 16rem\)/s,
    )
    expect(leaderboardCss).toContain('#player-main-content.react-player-content:has(#react-view-leaderboard)')
    expect(leaderboardCss).toContain('--leaderboard-song-bg: #f4f2ef')
    expect(leaderboardCss).toContain('.react-leaderboard-index-region::before')
    expect(leaderboardCss).toContain('.react-leaderboard-songs-region::before')
    expect(leaderboardCss).not.toContain('inset 2px 0 var(--app-accent)')
    expect(mobileCss).toContain('.react-leaderboard-index {')
    expect(mobileCss).toContain('overflow-x: auto;')
  })
})
