import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlayerHistoryController } from '../frontend/player/src/features/player_history'
import { songAlbum, songArtist, songDurationValue, songFormatValue, songSizeBytes, songSizeValue, songTitle } from '../frontend/player/src/react/types'

const root = path.join(import.meta.dir, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('React player navigation and state restoration', () => {
  it('keeps browser history boundaries and restores page payloads', () => {
    let currentState: unknown = null
    const stack: unknown[] = []
    let stackIndex = -1
    const history = {
      get state() { return currentState },
      replaceState(state: unknown) { currentState = state; if (stackIndex < 0) { stack.push(state); stackIndex = 0 } else stack[stackIndex] = state },
      pushState(state: unknown) { currentState = state; stack.splice(stackIndex + 1); stack.push(state); stackIndex += 1 },
      go(delta: number) { stackIndex = Math.max(0, Math.min(stack.length - 1, stackIndex + delta)); currentState = stack[stackIndex] },
    }
    const documentRef = { getElementById: () => null }
    const controller = createPlayerHistoryController({ history, documentRef })
    controller.initialize({ page: 'tab', tabId: 'search' })
    controller.push({ page: 'search-detail', id: 'song-1', name: '测试歌手', image: '/cover.jpg' })
    controller.push({ page: 'songlist-detail', id: 'list-1' })
    expect(controller.canGoBack()).toBe(true)
    expect(controller.back()).toBe(true)
    expect(controller.handlePopState(currentState)?.state.page).toBe('search-detail')
    expect(controller.forward()).toBe(true)
    expect(controller.handlePopState(currentState)?.state.page).toBe('songlist-detail')
    expect(controller.forward()).toBe(false)
  })

  it('serializes the love list and custom playlist routes without losing history state', () => {
    let currentState: unknown = null
    let currentUrl = ''
    const stack: Array<{ state: unknown; url: string }> = []
    let stackIndex = -1
    const history = {
      get state() { return currentState },
      replaceState(state: unknown, _title: string, url?: string | URL | null) {
        currentState = state
        currentUrl = String(url ?? '')
        if (stackIndex < 0) {
          stack.push({ state, url: currentUrl })
          stackIndex = 0
        } else {
          stack[stackIndex] = { state, url: currentUrl }
        }
      },
      pushState(state: unknown, _title: string, url?: string | URL | null) {
        currentState = state
        currentUrl = String(url ?? '')
        stack.splice(stackIndex + 1)
        stack.push({ state, url: currentUrl })
        stackIndex += 1
      },
      go(delta: number) {
        stackIndex = Math.max(0, Math.min(stack.length - 1, stackIndex + delta))
        currentState = stack[stackIndex]?.state ?? null
        currentUrl = stack[stackIndex]?.url ?? ''
      },
    }
    const controller = createPlayerHistoryController({ history, documentRef: { getElementById: () => null } })
    controller.initialize({ page: 'tab', tabId: 'favorites', listId: 'love' })
    expect(currentUrl).toBe('#favorites')
    controller.push({ page: 'tab', tabId: 'favorites', listId: 'playlist 1' })
    expect(currentUrl).toBe('#favorites?listId=playlist%201')
    expect(controller.getState()?.listId).toBe('playlist 1')
    expect(controller.back()).toBe(true)
    expect(controller.handlePopState(currentState)?.state.listId).toBe('love')
    expect(controller.forward()).toBe(true)
    expect(controller.handlePopState(currentState)?.state.listId).toBe('playlist 1')
  })

  it('keeps detail presentation metadata across browser history restores', () => {
    let currentState: unknown = null
    const history = {
      get state() { return currentState },
      replaceState(state: unknown) { currentState = state },
      pushState(state: unknown) { currentState = state },
      go() {},
    }
    const controller = createPlayerHistoryController({ history, documentRef: { getElementById: () => null } })
    controller.initialize({ page: 'tab', tabId: 'search' })
    controller.push({ page: 'search-detail', tabId: 'search', kind: 'artist', id: 'artist-1', source: 'wy', name: 'Aimer', image: '/aimer.jpg' })
    const restored = controller.handlePopState(currentState)
    expect(restored?.state.name).toBe('Aimer')
    expect(restored?.state.image).toBe('/aimer.jpg')
  })

  it('uses React-owned navigation, drawers and native dialog semantics', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const store = read('frontend/player/src/react/store.ts')
    const routeState = read('frontend/player/src/react/route_state.ts')
    const views = read('frontend/player/src/react/views.tsx')
    const components = read('frontend/player/src/react/components.tsx')
    const footer = read('frontend/player/src/react/player_footer.tsx')
    expect(store).not.toContain('window.history.pushState')
    expect(routeState).toContain('serializePlayerHash')
    expect(shell).toContain('createPlayerHistoryController')
    expect(shell).toContain('react-sidebar')
    expect(shell).toContain('PlayerFooterBar')
    expect(footer).toContain('react-player-footer')
    expect(shell).not.toContain('aria-label="播放队列"')
    expect(footer).toContain("setDrawer('queue')")
    expect(views).toContain('LyricsDialog')
    expect(components).toContain('<dialog')
    expect(components).toContain('inert={!open ? true : undefined}')
    expect(components).toContain('dialog.showModal()')
    expect(components).toContain('lastFocus.current')
    expect(components).toContain('type="button"')
    expect(views).toContain('<PlayerFooterBar variant="immersive" />')
    expect(views).toContain('{open && <PlayerFooterBar variant="immersive" />}')
    expect(footer).toContain('id="player-footer"')
    expect(footer).toContain('<SongActionsPopover song={currentSong}')
    expect(footer).not.toContain('if (immersive) setImmersiveLyrics(false)')
    expect(footer).toContain('preferredQuality')
    expect(footer).not.toContain('react-immersive-footer')
    expect(shell).toContain('<PlayerFooter hidden={immersiveLyrics} />')
    expect(views).toContain('consumeImmersiveLyricsTrigger')
    expect(views).toContain("#player-footer .react-footer-cover-button")
    expect(shell).not.toContain('react-sidebar-close')
  })

  it('refreshes search results when source or type changes and keeps search controls aligned', () => {
    const searchStore = read('frontend/player/src/react/store/search.ts')
    const views = read('frontend/player/src/react/views.tsx')
    const css = read('frontend/styles/player.css')
    expect(searchStore).toContain('if (query) void get().search(query, 1, { force: true })')
    expect(views).not.toContain('<span>音源</span>')
    expect(views).not.toContain('<span>类型</span>')
    expect(css).toContain('grid-template-columns: minmax(12rem, 1fr) minmax(8.75rem, 10rem) minmax(8.75rem, 10rem) auto')
    expect(css).toContain('.react-search-filter .react-select-menu-trigger')
  })

  it('reads album names from the canonical React song field', () => {
    expect(songAlbum({ albumName: '顶层专辑' })).toBe('顶层专辑')
    expect(songAlbum({ meta: { albumName: '旧快照专辑' } })).toBe('旧快照专辑')
    expect(songAlbum({ album: { name: '对象专辑' } })).toBe('对象专辑')
    expect(songSizeValue({ meta: { sizeBytes: 5242880 } })).toBe(5242880)
    expect(songSizeValue({ meta: { qualitys: [{ type: 'flac', size: '5 MB' }] }, quality: 'flac' })).toBe('5 MB')
    expect(songSizeBytes({ meta: { qualitys: [{ type: 'flac', size: '5 MB' }] }, quality: 'flac' })).toBe(5 * 1024 * 1024)
    expect(songSizeBytes({ meta: { qualitys: [{ type: 'flac', size: '3.56M' }] }, quality: 'flac' })).toBeCloseTo(3.56 * 1024 * 1024)
    expect(songTitle({ meta: { title: '旧标题' } })).toBe('旧标题')
    expect(songArtist({ meta: { singerName: '旧歌手' } })).toBe('旧歌手')
    expect(songDurationValue({ meta: { interval: '03:21' } })).toBe('03:21')
    expect(songFormatValue({ meta: { ext: 'flac' } })).toBe('flac')
    expect(songAlbum({ name: '没有专辑' })).toBe('—')
  })

  it('keeps the normal footer order and exposes the portal song action flow', () => {
    const footer = read('frontend/player/src/react/player_footer.tsx')
    const actions = read('frontend/player/src/react/song_actions.tsx')
    const views = read('frontend/player/src/react/views.tsx')
    expect(footer.indexOf('react-footer-controls')).toBeLessThan(footer.indexOf('react-footer-song-section'))
    expect(footer.indexOf('react-footer-song-section')).toBeLessThan(footer.indexOf('react-footer-actions'))
    expect(footer.indexOf('react-song-menu-button')).toBeLessThan(footer.indexOf('react-mode-button'))
    expect(footer.indexOf('react-like-button')).toBeLessThan(footer.indexOf('打开播放队列'))
    expect(footer.indexOf('打开播放队列')).toBeLessThan(footer.indexOf('<VolumeControl'))
    expect(footer).toContain('react-volume-popover')
    expect(footer).toContain("'--volume'")
    expect(footer).not.toContain("'repeat-1'")
    expect(footer).toContain("'--progress'")
    const css = read('frontend/styles/player.css')
    expect(css).toContain('width: min(56rem')
    expect(css).toContain('min-height: 4.05rem')
    expect(css).toContain('var(--progress, 0%)')
    expect(css).toContain('var(--volume, 0%)')
    expect(actions).toContain('createPortal')
    expect(actions).toContain("anchorRef.current?.closest('dialog')")
    expect(actions).toContain('role="dialog"')
    for (const label of ['歌手详情', '专辑', '添加到歌单', '评论', '下载歌曲', '睡眠定时器']) expect(actions).toContain(label)
    expect(views).toContain('export function AddToListDialog')
    expect(views).toContain("name: '我的收藏'")
    expect(views).toContain('userList')
  })

  it('keeps entity favorites and filtering controls inside the React surface', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const components = read('frontend/player/src/react/components.tsx')
    const heavyViews = read('frontend/player/src/react/heavy_views.tsx')
    const shell = read('frontend/player/src/react/shell.tsx')
    expect(views).toContain('toggleRemotePlaylist')
    expect(views).toContain('toggleMedia')
    expect(views).toContain('react-detail-favorite')
    expect(components).toContain('role="listbox"')
    expect(heavyViews).toContain('<SelectMenu')
    expect(shell).not.toContain("{ id: 'genres', label: '风格'")
  })

  it('keeps the love page separate from custom playlists while preserving legacy list data', () => {
    const api = read('frontend/player/src/react/api.ts')
    const store = read('frontend/player/src/react/store.ts')
    const library = read('frontend/player/src/react/store/library.ts')
    const shell = read('frontend/player/src/react/shell.tsx')
    const views = read('frontend/player/src/react/views.tsx')
    expect(api).toContain('export type UserPlaylist')
    expect(library).toContain('defaultList')
    expect(library).toContain('userList')
    expect(library).toContain('Promise<UserPlaylist>')
    expect(library).toContain('removeSongs')
    expect(shell).toContain('favoriteListId === \'love\'')
    expect(shell).toContain('aria-current={isActive ? \'page\' : undefined}')
    expect(views).toContain('name="我喜欢的音乐"')
    expect(views).toContain('function UserPlaylistView')
    expect(views).toContain('react-playlist-page')
    expect(views).not.toContain('默认列表')
  })

  it('renders one visible heading for playlist pages while retaining the browser title', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const views = read('frontend/player/src/react/views.tsx')
    const components = read('frontend/player/src/react/components.tsx')
    const css = read('frontend/styles/player.css')
    expect(shell).not.toContain('className="react-topbar-title"')
    expect(shell).toContain('document.title = `${title} - 云音`')
    expect(views).toContain('<h2>歌曲</h2>{batchMode && selectedSongs.size > 0 && <p>已选择 {selectedSongs.size} 首</p>}')
    expect(views).toContain('showFileMetadata={false}')
    expect(components).toContain('react-song-table--without-file-metadata')
    expect(css).toContain('.react-song-table--without-file-metadata .react-song-head')
    expect(views).not.toContain("listId === 'love' ? '我喜欢的音乐' : '歌单歌曲'")
  })

  it('preserves responsive, reduced-motion and long-list performance guards', () => {
    const html = read('public/music/index.html')
    const css = read('frontend/styles/player.css')
    const source = `${read('frontend/player/src/react/views.tsx')}\n${read('frontend/player/src/react/components.tsx')}`
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('<div id="root"></div>')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('content-visibility: auto')
    expect(css).toContain('contain-intrinsic-size')
    expect(css).toContain('@media (max-width: 720px)')
    expect(css).toContain('React UI focus policy: quiet mouse focus, compact keyboard focus.')
    expect(css).toContain('box-shadow: inset 0 0 0 1px var(--app-accent) !important')
    expect(source).toContain('loading="lazy"')
    expect(source).toContain('react-song-album')
    expect(source).toContain('react-song-duration')
  })

  it('loads artist songs in 40-song pages and keeps requesting on the scroll sentinel', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const api = read('frontend/player/src/react/api.ts')
    expect(api).toContain('artistSongs: (source: string, id: string, order = \'hot\', page = 1, limit = 40')
    expect(views).toContain('artistSongs(detail.source, detail.id, order, 1, 40')
    expect(views).toContain('artistSongs(detail.source, detail.id, order, nextPage, 40')
    expect(views).toContain('new IntersectionObserver')
    expect(views).toContain('loadMoreIntersectionActive.current = false')
    expect(views).toContain('loadMoreController.current?.abort()')
    expect(views).toContain('react-load-more')
    expect(views).toContain('setSongs(current =>')
  })

  it('uses the reference artwork lyrics layout without the retired vinyl markup', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const css = read('frontend/styles/player.css')
    expect(views).toContain('react-immersive-cover-panel')
    expect(views).toContain('react-immersive-cover')
    expect(views).toContain('<PlayerFooterBar variant="immersive" />')
    expect(views).not.toContain('<PlayerFooterBar embedded />')
    expect(views).not.toContain('react-vinyl-record')
    expect(css).toContain('--react-immersive-art')
    expect(css).toContain('.react-immersive-cover-panel')
    expect(css).toContain('.react-immersive-shared-footer#player-footer')
    expect(css).toContain('--react-immersive-footer-reserve')
    expect(views).toContain('--react-immersive-scrollbar-gutter')
    expect(css).toContain('var(--app-sidebar-width, 17.5rem)')
    expect(css).toContain('@keyframes react-immersive-dialog-enter')
    expect(css).toContain('.react-immersive-lyrics-dialog[open]::backdrop')
    expect(css).not.toContain('translate3d(0, .55rem, 0) scale(.992)')
    expect(css).not.toMatch(/(?:react-)?vinyl|visualizer|频谱/i)
  })

  it('keeps the floating topbar, recent rail and immersive footer geometry stable', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const css = read('frontend/styles/player.css')
    expect(css).toContain('.react-player-main {\n    display: block !important;')
    expect(css).toContain('height: 0 !important;\n    min-height: 0 !important;')
    expect(css).toContain('.react-home-rail {\n    display: flex;\n    flex-wrap: nowrap;')
    expect(css).toContain('--react-footer-glass-alpha: 48%;')
    expect(css).toContain('react-immersive-dialog-exit')
    expect(css).toContain('.react-immersive-lyrics-dialog.is-closing')
    expect(views).toContain('const closeTimer = useRef<number | null>(null)')
    expect(views).toContain('className={`react-immersive-lyrics-dialog ${isClosing ? \'is-closing\' : \'\'}`}')
  })

  it('uses the shared settings account and source form surfaces', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const css = read('frontend/styles/player.css')
    expect(views).toContain('react-account-card')
    expect(views).toContain('react-account-badge')
    expect(views).toContain('react-source-form')
    expect(views).toContain('react-source-input-row')
    expect(css).toContain('.react-account-state {\n    display: flex;')
    expect(css).toContain('.react-source-input-row {')
    expect(css).toContain('::file-selector-button')
  })

  it('keeps the main player surface open instead of wrapping it in a card', () => {
    const css = read('frontend/styles/player.css')
    expect(css).toContain('#player-main-content.react-player-content {')
    expect(css).toContain('background: transparent !important')
    expect(css).toContain('border-radius: 0 !important')
    expect(css).toContain('box-shadow: none !important')
  })

  it('keeps playlist artwork through detail navigation and renders one entity heading', () => {
    const heavyViews = read('frontend/player/src/react/heavy_views.tsx')
    const views = read('frontend/player/src/react/views.tsx')
    const types = read('frontend/player/src/react/types.ts')
    const css = read('frontend/styles/player.css')
    expect(types).toContain("'info', 'playlist', 'diss'")
    expect(heavyViews).toContain('listItemImage(payload as Song, detail.image)')
    expect(heavyViews).toContain('info.name')
    expect(heavyViews).toContain('hideHeader')
    expect(views).toContain('hideHeader')
    expect(views).toContain('<h1>{name}</h1>')
    expect(heavyViews).not.toContain('<h2>{name}</h2>')
    expect(views).not.toContain('<h2>{name}</h2>')
    expect(css).toContain('@keyframes react-view-enter')
    expect(css).toContain('@keyframes react-grid-item-enter')
    expect(css).toContain('prefers-reduced-motion: reduce')
  })

  it('does not retain legacy HTML event bridges in the React source or release shell', () => {
    const files = [
      'frontend/player/src/react/index.tsx',
      'frontend/player/src/react/login.tsx',
      'frontend/player/src/react/shell.tsx',
      'frontend/player/src/react/views.tsx',
      'frontend/player/src/react/components.tsx',
      'public/music/index.html',
      'public/music/login.html',
    ]
    const source = files.map(read).join('\n')
    expect(source).not.toMatch(/data-(?:event-click|admin)-action/)
    expect(source).not.toMatch(/\bon(?:click|change|submit)\s*=/)
    expect(source).not.toMatch(/window\.(?:toggle|play|pause|selected|current)\w*\s*=/)
  })
})
