import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import { getUserSpace } from '@/user'
import { getDb } from '@/database'
import { PlaylistIdConflictError, type PlaylistMutation } from '@/modules/list/listDataManage'
import {
  MAX_USER_SETTING_BODY_BYTES,
  isRecord,
  rejectUnavailableDataWrite,
  resolveTargetUsername,
} from './userRouteShared'

const MAX_PLAY_HISTORY_ITEMS = 50
const PLAY_HISTORY_SETTING_KEY = 'play_history'

function playHistorySongKey(song: Record<string, unknown>): string {
  return `${String(song.source || 'unknown')}:${String(song.songmid ?? song.id ?? song.hash ?? song.name ?? '')}`
}

function validatePlayHistoryItems(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_PLAY_HISTORY_ITEMS) {
    throw new Error(`播放历史最多保存 ${MAX_PLAY_HISTORY_ITEMS} 首歌曲`)
  }
  return value.map(item => {
    if (!isRecord(item)) throw new Error('播放历史数据格式错误')
    const id = item.songmid ?? item.id ?? item.hash ?? item.name
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      !String(id).trim() ||
      (item.source !== undefined && typeof item.source !== 'string') ||
      (item.playedAt !== undefined &&
        (typeof item.playedAt !== 'number' || !Number.isFinite(item.playedAt) || item.playedAt < 0))
    ) {
      throw new Error('播放历史歌曲信息无效')
    }
    return item
  })
}

export const createUserLibraryRouter = (): Router => {
  const router = new Router()

  // 1. 读取用户歌单数据 (GET /api/user/list)
  router.get('/api/user/list', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }

    try {
      const userSpace = getUserSpace(username)
      const data = await userSpace.listManage.getListData()
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/playlists', async ctx => {
    const username = resolveTargetUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '公共歌单修改需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const mutation = await ctx.bodyJson<PlaylistMutation>(MAX_USER_SETTING_BODY_BYTES)
      if (!mutation || !['create', 'toggle', 'rename', 'delete'].includes(mutation.action))
        return ctx.fail(400, '歌单操作无效')
      if (mutation.action === 'create' || mutation.action === 'toggle') {
        const playlist = mutation.playlist
        if (
          !playlist ||
          typeof playlist.id !== 'string' ||
          !playlist.id.trim() ||
          ['default', 'love', 'temp'].includes(playlist.id) ||
          typeof playlist.name !== 'string' ||
          !playlist.name.trim() ||
          playlist.name.length > 80 ||
          !Array.isArray(playlist.list) ||
          playlist.list.some(song => !song || typeof song !== 'object' || Array.isArray(song))
        )
          return ctx.fail(400, '歌单数据无效')
        if (
          mutation.action === 'toggle' &&
          (!['wy', 'tx'].includes(String(playlist.source)) ||
            typeof playlist.sourceListId !== 'string' ||
            !playlist.sourceListId)
        )
          return ctx.fail(400, '在线歌单来源无效')
      } else {
        if (typeof mutation.id !== 'string' || !mutation.id) return ctx.fail(400, '歌单 ID 无效')
        if (
          mutation.action === 'rename' &&
          (typeof mutation.name !== 'string' || !mutation.name.trim() || mutation.name.length > 80)
        )
          return ctx.fail(400, '歌单名称无效')
      }
      const manager = getUserSpace(username).listManage
      const result = await manager.runWithPersistence(() => manager.listDataManage.mutatePlaylist(mutation))
      if (!result) return ctx.fail(404, '歌单不存在')
      return ctx.json({ success: true, ...result })
    } catch (err: any) {
      if (err instanceof PlaylistIdConflictError) return ctx.fail(409, err.message)
      return ctx.fail(400, toUserMessage(err, '歌单操作失败，请稍后重试'))
    }
  })

  // 2. 覆盖保存用户歌单数据 (POST /api/user/list)
  router.post('/api/user/list/compare-and-swap', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '公共歌单修改需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const body = await ctx.bodyJson<{ expected: LX.List.ListData; next: LX.List.ListData }>(
        MAX_USER_SETTING_BODY_BYTES,
      )
      const manager = getUserSpace(username).listManage
      const applied = await manager.runWithPersistence(async () => {
        if (JSON.stringify(await manager.getListData()) !== JSON.stringify(body.expected)) return null
        await manager.listDataManage.restore(body.next)
        return true
      })
      if (!applied) return ctx.fail(409, '歌单已被其他客户端修改，请重试')
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '歌单操作失败'))
    }
  })

  router.post('/api/user/library/compare-and-swap', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const body = await ctx.bodyJson<{ kind: string; expected: unknown[]; next: unknown[] }>(
        MAX_USER_SETTING_BODY_BYTES,
      )
      const kind = body.kind
      if (kind !== 'albums' && kind !== 'artists') return ctx.fail(404, '曲库不存在')
      if (!Array.isArray(body.expected) || !Array.isArray(body.next)) return ctx.fail(400, '曲库数据无效')
      const db = getDb()
      const key = `library_${kind}`
      const applied = db.transaction(() => {
        const row = db
          .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
          .get(username, key)
        if (JSON.stringify(row ? JSON.parse(row.value) : []) !== JSON.stringify(body.expected)) return false
        db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
          username,
          key,
          JSON.stringify(body.next),
          Date.now(),
        ])
        return true
      })()
      if (!applied) return ctx.fail(409, '曲库已被其他客户端修改，请重试')
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '曲库操作失败'))
    }
  })

  router.post('/api/user/list', async ctx => {
    const isAdmin = verifyAdminAuth(ctx.request)
    const username = resolveTargetUsername(ctx, false)

    if (!username) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    if (username === '_open' && !isAdmin) {
      return ctx.json({ success: false, error: '权限不足：公共歌单修改受限，请先验证管理员身份。' }, 403)
    }
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable

    try {
      const listData = await ctx.bodyJson<LX.List.ListData>()
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() => userSpace.listManage.listDataManage.restore(listData))
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 用户最近播放历史单独保存，避免播放时重写歌单数据。
  router.get('/api/user/play-history', ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const row = getDb()
        .query<{ value: string; updated_at: number }, [string, string]>(
          'SELECT value, updated_at FROM user_settings WHERE user_name = ? AND key = ?',
        )
        .get(username, PLAY_HISTORY_SETTING_KEY)
      const revision = row?.updated_at ?? 0
      const unchanged = ctx.query.get('since') === String(revision)
      const items = unchanged ? [] : row ? validatePlayHistoryItems(JSON.parse(row.value)) : []
      return new Response(JSON.stringify({ items, revision, ...(unchanged ? { unchanged: true } : {}) }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '播放历史读取失败'))
    }
  })

  // Playback events are idempotent so retries and multiple tabs cannot reorder a song twice.
  router.post('/api/user/play-history/events', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const body = await ctx.bodyJson<{ events?: unknown }>(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(body?.events) || body.events.length > 50) throw new Error('播放记录格式错误')
      const events = body.events.map((event: unknown) => {
        if (!isRecord(event) || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(event.id))
          throw new Error('播放记录标识无效')
        return { id: event.id, song: validatePlayHistoryItems([event.song])[0]! }
      })
      const db = getDb()
      const result = db.transaction(() => {
        const getSetting = (key: string) =>
          db
            .query<{ value: string; updated_at: number }, [string, string]>(
              'SELECT value, updated_at FROM user_settings WHERE user_name = ? AND key = ?',
            )
            .get(username, key)
        const previous = getSetting(PLAY_HISTORY_SETTING_KEY)
        let history = previous ? validatePlayHistoryItems(JSON.parse(previous.value)) : []
        const now = Date.now()
        const insert = db.prepare(
          'INSERT OR IGNORE INTO play_history_events (user_name, event_id, created_at) VALUES (?, ?, ?)',
        )
        let changed = false
        let orderTime = now
        for (const event of events) {
          if (!insert.run(username, event.id, now).changes) continue
          if (!changed)
            history = history.map(song => ({ ...song, playedAt: Math.min(now, Number(song.playedAt || 0)) }))
          const song = { ...event.song, playedAt: ++orderTime }
          history = [song, ...history.filter(item => playHistorySongKey(item) !== playHistorySongKey(song))].slice(
            0,
            MAX_PLAY_HISTORY_ITEMS,
          )
          changed = true
        }
        let revision = previous?.updated_at ?? 0
        if (changed) {
          revision = Math.max(now, revision + 1)
          db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
            username,
            PLAY_HISTORY_SETTING_KEY,
            JSON.stringify(history),
            revision,
          ])
          db.run('DELETE FROM play_history_events WHERE user_name = ? AND created_at < ?', [
            username,
            now - 30 * 86400000,
          ])
          db.run(
            `DELETE FROM play_history_events WHERE rowid IN (
            SELECT rowid FROM play_history_events WHERE user_name = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 5000
          )`,
            [username],
          )
        }
        return { items: history, revision }
      })()
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '播放历史保存失败'))
    }
  })

  // 3. 用户曲库：歌手与专辑 (GET & POST)
  router.get('/api/user/library/artists', ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const db = getDb()
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'library_artists')

      if (row) {
        return ctx.json(JSON.parse(row.value))
      }
      return ctx.json([])
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/library/artists', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const parsed = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(parsed)) throw new Error('Expected an array')
      const db = getDb()
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        username,
        'library_artists',
        JSON.stringify(parsed),
        Date.now(),
      ])
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.get('/api/user/library/albums', ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const db = getDb()
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'library_albums')

      if (row) {
        return ctx.json(JSON.parse(row.value))
      }
      return ctx.json([])
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/library/albums', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const parsed = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(parsed)) throw new Error('Expected an array')
      const db = getDb()
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        username,
        'library_albums',
        JSON.stringify(parsed),
        Date.now(),
      ])
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  // 4. 用户设置 (GET & POST /api/user/settings)

  // 6. 歌单与歌曲批量修改 (POST /api/music/user/list/*)
  router.post('/api/music/user/list/remove', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '需要用户认证，请先登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const { listId, songIds } = await ctx.bodyJson<{ listId?: string; songIds?: string[] }>()
      if (!listId || !Array.isArray(songIds)) return ctx.text('参数错误:需要listId和songIds数组', 400)
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() =>
        userSpace.listManage.listDataManage.listMusicRemove(listId, songIds),
      )
      return ctx.text('删除成功', 200)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '删除失败，请稍后重试'))
    }
  })

  router.post('/api/music/user/list/add', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '需要用户认证，请先登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const {
        listId,
        musicInfos,
        location: requestedLocation,
      } = await ctx.bodyJson<{
        listId?: string
        musicInfos?: any[]
        location?: unknown
      }>()
      if (!listId || !Array.isArray(musicInfos)) return ctx.text('参数错误:需要listId和musicInfos数组', 400)
      const userLocation = global.lx.config.users.find(user => user.name === username)?.['list.addMusicLocationType']
      const configuredLocation = userLocation ?? global.lx.config['list.addMusicLocationType']
      const location =
        requestedLocation === 'top' || requestedLocation === 'bottom'
          ? requestedLocation
          : configuredLocation === 'top'
            ? 'top'
            : 'bottom'
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() =>
        userSpace.listManage.listDataManage.listMusicAdd(listId, musicInfos, location),
      )
      return ctx.text('添加成功', 200)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '添加失败，请稍后重试'))
    }
  })

  return router
}
