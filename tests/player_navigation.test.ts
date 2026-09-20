import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlayerHistoryController } from '../frontend/player/src/features/player_history'

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
    controller.push({ page: 'search-detail', id: 'song-1' })
    controller.push({ page: 'songlist-detail', id: 'list-1' })
    expect(controller.canGoBack()).toBe(true)
    expect(controller.back()).toBe(true)
    expect(controller.handlePopState(currentState)?.state.page).toBe('search-detail')
    expect(controller.forward()).toBe(true)
    expect(controller.handlePopState(currentState)?.state.page).toBe('songlist-detail')
    expect(controller.forward()).toBe(false)
  })

  it('uses React-owned navigation, drawers and native dialog semantics', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const store = read('frontend/player/src/react/store.ts')
    const views = read('frontend/player/src/react/views.tsx')
    const components = read('frontend/player/src/react/components.tsx')
    const footer = read('frontend/player/src/react/player_footer.tsx')
    expect(store).toContain('window.history.pushState')
    expect(shell).toContain('window.history.back()')
    expect(shell).toContain('react-sidebar')
    expect(shell).toContain('PlayerFooterBar')
    expect(footer).toContain('react-player-footer')
    expect(shell).toContain('setDrawer(\'queue\')')
    expect(views).toContain('LyricsDialog')
    expect(components).toContain('<dialog')
    expect(components).toContain('inert={!open ? true : undefined}')
    expect(components).toContain('dialog.showModal()')
    expect(components).toContain('lastFocus.current?.focus')
    expect(views).toContain('<PlayerFooterBar embedded />')
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
    expect(views).toContain('react-load-more')
    expect(views).toContain('setSongs(current =>')
  })

  it('uses the reference artwork lyrics layout without the retired vinyl markup', () => {
    const views = read('frontend/player/src/react/views.tsx')
    const css = read('frontend/styles/player.css')
    expect(views).toContain('react-immersive-cover-panel')
    expect(views).toContain('react-immersive-cover')
    expect(views).toContain('<PlayerFooterBar embedded />')
    expect(views).not.toContain('react-vinyl-record')
    expect(css).toContain('--react-immersive-art')
    expect(css).toContain('.react-immersive-cover-panel')
    expect(css).toContain('.react-immersive-lyrics .react-vinyl')
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
