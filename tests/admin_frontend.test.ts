import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { adminSongId, normalizeAdminData } from '../frontend/admin/src/react/api'

const root = path.join(import.meta.dir, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('React admin frontend', () => {
  it('normalizes persisted song metadata so data view can render real playlist entries', () => {
    const data = normalizeAdminData({
      data: {
        defaultList: [{ id: 7, name: '试听歌曲', singer: '歌手', albumName: '专辑', album: '旧专辑字段', meta: { picUrl: 'https://example.com/cover.jpg', songId: 7 } }],
        loveList: [],
        userList: [{ id: 12, name: '夜间歌单', list: [{ songmid: 88, title: '另一首歌', artist: '另一位歌手', albumName: '另一张专辑' }] }],
      },
    })
    expect(data.defaultList?.[0]).toMatchObject({ id: '7', name: '试听歌曲', singer: '歌手', albumName: '专辑', img: 'https://example.com/cover.jpg' })
    expect('album' in (data.defaultList?.[0] ?? {})).toBe(false)
    expect(data.userList?.[0]).toMatchObject({ id: '12', name: '夜间歌单' })
    expect(data.userList?.[0]?.list[0]).toMatchObject({ id: '88', name: '另一首歌', singer: '另一位歌手', albumName: '另一张专辑' })
    expect(adminSongId(data.userList?.[0]?.list[0] ?? {}, '0')).toBe('88')
  })

  it('publishes a minimal shell with a hashed React module entry', () => {
    const html = read('public/index.html')
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('<script type="module" src="app-')
    expect(html).not.toContain('data-admin-action')
    expect(html).not.toContain('id="login-overlay"')
    expect(html).not.toContain('id="view-dashboard"')
  })

  it('uses React composition and Zustand state without a window app bridge', () => {
    const entry = read('frontend/admin/src/react/index.tsx')
    const store = read('frontend/admin/src/react/store.ts')
    const sources = [entry, store, read('frontend/admin/src/react/views.tsx'), read('frontend/admin/src/react/data-view.tsx'), read('frontend/admin/src/react/components.tsx')].join('\n')
    expect(entry).toContain('createRoot')
    expect(entry).toContain('LoginGate')
    for (const view of ['DashboardView', 'UsersView', 'StorageView', 'DataView', 'ConfigView', 'LogsView', 'SnapshotsView', 'AboutView']) expect(sources).toContain(view)
    expect(store).toContain("from 'zustand'")
    expect(sources).toContain('<dialog')
    expect(sources).toContain('role="alert"')
    expect(sources).not.toMatch(/window\.app\s*=/)
    expect(sources).not.toMatch(/data-admin-action/)
    expect(sources).not.toMatch(/\bon(click|change|submit)\s*=/)
    expect(sources).toContain('admin-data-workspace')
    expect(sources).toContain('batchDeleteSongs')
  })

  it('keeps semantic tables, labelled forms and focus-safe dialogs in the stylesheet', () => {
    const source = [
      read('frontend/admin/src/react/index.tsx'),
      read('frontend/admin/src/react/api.ts'),
      read('frontend/admin/src/react/views.tsx'),
      read('frontend/admin/src/react/data-view.tsx'),
      read('frontend/admin/src/react/storage-view.tsx'),
      read('frontend/admin/src/react/config-view.tsx'),
      read('frontend/admin/src/react/components.tsx'),
    ].join('\n')
    const css = read('frontend/styles/admin.css')
    expect(source).toContain('caption className="sr-only"')
    expect(source).toContain('scope="col"')
    expect(source).toContain('current-password')
    expect(source).toContain('showModal()')
    expect(source).toContain('previousFocus')
    expect(source).toContain('缓存歌曲')
    expect(source).toContain('下载歌曲')
    expect(source).toContain('cacheStats')
    expect(source).toContain('normalizeAdminData')
    expect(source).toContain('admin-config-toggle-grid')
    expect(source).toContain('logType')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('admin-react-storage-summary')
    expect(css).toContain('@media (max-width: 620px)')
    expect(css).toContain('React UI focus policy: quiet mouse focus, compact keyboard focus.')
    expect(css).toContain('box-shadow: inset 0 0 0 1px var(--app-accent) !important')
  })
})
