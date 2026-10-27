import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as fileCache from '@/server/fileCache'
import { getResourceBudgetStats, tryAcquireMediaStream } from '@/server/resourceBudget'
import { closeDb, initDatabase } from '@/database'
import {
  deduplicateDownloadTasks,
  filterPersistedTasksForUsers,
  enqueue,
  MAX_PENDING_TASKS_PER_USER,
  suspendUser,
  releaseUser,
  renameUser,
  removeUser,
  initialize,
  setConcurrency,
  isDownloadTaskRunnable,
  list,
  markDownloadTaskPausedIfAborted,
  pause,
  resume,
  pruneDownloadHistory,
  serializeDownloadTask,
  type ServerDownloadTask,
} from '@/server/serverDownloadQueue'

const makeTask = (
  username: string,
  id: string,
  status: ServerDownloadTask['status'],
  updatedAt: number,
): ServerDownloadTask => ({
  id,
  username,
  songKey: `${username}_${id}`,
  songInfo: { id, name: id },
  quality: '320k',
  requestedQuality: '320k',
  status,
  progress: status === 'finished' ? 100 : 0,
  total: 0,
  received: 0,
  speed: 0,
  errorMsg: '',
  enableOnlyDownloadMode: false,
  cacheLyric: true,
  embedLyric: true,
  background: false,
  createdAt: updatedAt,
  updatedAt,
})

test('global download admission spans users and relay completion wakes queued work', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-global-download-budget-'))
  const heldMedia: Array<() => void> = []
  const complete = new Map<string, () => void>()
  const count = getResourceBudgetStats().downloads.maxActive
  const users = Array.from({ length: count + 1 }, (_, index) => `global-budget-${index}`)
  const cache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
  const worker = spyOn(fileCache, 'downloadAndCache').mockImplementation(
    (song: any) =>
      new Promise<void>(resolve => {
        complete.set(song.songmid, resolve)
      }),
  )
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000
    while (!predicate() && Date.now() < deadline) await Bun.sleep(2)
    expect(predicate()).toBe(true)
  }
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    while (true) {
      const release = tryAcquireMediaStream()
      if (!release) break
      heldMedia.push(release)
    }
    initialize(async () => ({ url: 'https://example.test/song' }))
    for (const username of users)
      enqueue(username, [{ songInfo: { source: 'wy', songmid: username }, quality: '320k' }])
    expect(worker).not.toHaveBeenCalled()
    expect(users.every(username => list(username)[0]?.status === 'waiting')).toBe(true)
    heldMedia.shift()!()
    await waitFor(() => worker.mock.calls.length === 1)
    for (const release of heldMedia.splice(0)) release()
    await waitFor(() => worker.mock.calls.length === count)
    expect(getResourceBudgetStats().downloads.active).toBe(count)
    complete.get(users[0])!()
    await waitFor(() => worker.mock.calls.length === count + 1)
    expect(getResourceBudgetStats().downloads.active).toBe(count)
  } finally {
    for (const release of heldMedia) release()
    // Pause queued tasks first, then release the mocked in-flight downloads.
    for (const username of users) pause(username)
    for (const resolve of complete.values()) resolve()
    for (const username of users) {
      await suspendUser(username)
      await removeUser(username)
      releaseUser(username)
    }
    await Bun.sleep(180)
    cache.mockRestore()
    worker.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
  expect(getResourceBudgetStats().downloads.active).toBe(0)
})

test('queue capacity allows duplicate requests without admitting extra tasks', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-queue-capacity-'))
  const cache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
  let releaseResolver!: () => void
  const resolverHold = new Promise<void>(resolve => {
    releaseResolver = resolve
  })
  const username = 'queue-capacity-user'
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    initialize(async () => {
      await resolverHold
      return { url: 'https://example.test/song' }
    })
    for (let offset = 0; offset < MAX_PENDING_TASKS_PER_USER; offset += 100) {
      const count = Math.min(100, MAX_PENDING_TASKS_PER_USER - offset)
      enqueue(
        username,
        Array.from({ length: count }, (_, index) => ({
          songInfo: { source: 'wy', songmid: `capacity-${offset + index}` },
          quality: '320k',
        })),
      )
    }
    expect(list(username)).toHaveLength(MAX_PENDING_TASKS_PER_USER)
    expect(
      enqueue(username, [
        {
          songInfo: { source: 'wy', songmid: 'capacity-0' },
          quality: '320k',
          background: true,
        },
        {
          songInfo: { source: 'wy', songmid: 'capacity-0' },
          quality: '320k',
          enableOnlyDownloadMode: true,
        },
      ]),
    ).toEqual([])
    expect(list(username)).toHaveLength(MAX_PENDING_TASKS_PER_USER)
    expect(list(username).find(task => task.songInfo.songmid === 'capacity-0')).toMatchObject({
      enableOnlyDownloadMode: true,
      background: false,
    })
  } finally {
    releaseResolver()
    await suspendUser(username)
    await removeUser(username)
    releaseUser(username)
    await Bun.sleep(180)
    cache.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('capacity preflight counts a reused explicit task ID once across different songs', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-queue-capacity-id-'))
  const cache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
  let releaseResolver!: () => void
  const resolverHold = new Promise<void>(resolve => {
    releaseResolver = resolve
  })
  const username = 'queue-capacity-id-user'
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    initialize(async () => {
      await resolverHold
      return { url: 'https://example.test/song' }
    })
    for (let offset = 0; offset < MAX_PENDING_TASKS_PER_USER - 2; offset += 100) {
      const count = Math.min(100, MAX_PENDING_TASKS_PER_USER - 2 - offset)
      enqueue(
        username,
        Array.from({ length: count }, (_, index) => ({
          songInfo: { source: 'wy', songmid: `capacity-id-${offset + index}` },
          quality: '320k',
        })),
      )
    }
    enqueue(username, [
      { id: 'reused-id', songInfo: { source: 'wy', songmid: 'first-song' }, quality: '320k' },
      { id: 'reused-id', songInfo: { source: 'wy', songmid: 'second-song' }, quality: '320k' },
    ])
    expect(list(username)).toHaveLength(MAX_PENDING_TASKS_PER_USER - 1)
    enqueue(username, [
      { songInfo: { source: 'wy', songmid: 'duplicate-no-id' }, quality: '320k', background: true },
      {
        songInfo: { source: 'wy', songmid: 'duplicate-no-id' },
        quality: '320k',
        enableOnlyDownloadMode: true,
      },
    ])
    expect(list(username)).toHaveLength(MAX_PENDING_TASKS_PER_USER)
    expect(list(username).find(task => task.id === 'reused-id')?.songInfo.songmid).toBe('first-song')
    expect(list(username).find(task => task.songInfo.songmid === 'duplicate-no-id')).toMatchObject({
      enableOnlyDownloadMode: true,
    })
  } finally {
    releaseResolver()
    await suspendUser(username)
    await removeUser(username)
    releaseUser(username)
    await Bun.sleep(180)
    cache.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('slow queue persistence coalesces updates and rename/delete await the latest snapshot', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-coalesced-queue-'))
  const originalWrite = Bun.write.bind(Bun)
  let releaseWrite!: () => void
  let firstWriteStarted!: () => void
  const blocked = new Promise<void>(resolve => {
    releaseWrite = resolve
  })
  const started = new Promise<void>(resolve => {
    firstWriteStarted = resolve
  })
  let writes = 0
  const write = spyOn(Bun, 'write').mockImplementation(async (destination, contents) => {
    writes++
    if (writes === 1) {
      firstWriteStarted()
      await blocked
    }
    return originalWrite(destination as string, contents as string)
  })
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    initialize(async () => {
      throw new Error('No downloads expected')
    })
    setConcurrency('coalesce-old', 1)
    await started
    for (let index = 0; index < 20; index++) setConcurrency('coalesce-old', (index % 5) + 1)
    let renamed = false
    const renaming = renameUser('coalesce-old', 'coalesce-new').then(() => {
      renamed = true
    })
    await Promise.resolve()
    expect(renamed).toBe(false)
    releaseWrite()
    await renaming
    expect(writes).toBe(2)
    const queueFile = path.join(root, 'server-download-queue.json')
    const persisted = JSON.parse(fs.readFileSync(queueFile, 'utf8'))
    expect(persisted.concurrencyByUser['coalesce-old']).toBeUndefined()
    expect(persisted.concurrencyByUser['coalesce-new']).toBe(5)
    await removeUser('coalesce-new')
    expect(JSON.parse(fs.readFileSync(queueFile, 'utf8')).concurrencyByUser['coalesce-new']).toBeUndefined()
  } finally {
    releaseWrite()
    write.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('playback caching preserves an explicit music download across active, paused and completed states', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-target-'))
  const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
  const worker = spyOn(fileCache, 'downloadAndCache').mockResolvedValue(undefined)
  let finishResolver!: () => void
  const pending = new Promise<void>(resolve => {
    finishResolver = resolve
  })
  const username = 'download-target-user'
  const songInfo = { source: 'wy', songmid: 'target-song', name: 'Target Song' }
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    initialize(async () => {
      await pending
      return { url: 'https://example.com/song' }
    })
    enqueue(username, [{ id: 'target', songInfo, quality: 'flac', enableOnlyDownloadMode: true }])
    const cacheInput = { songInfo, quality: 'flac', background: true, enableOnlyDownloadMode: false }
    enqueue(username, [cacheInput])
    expect(list(username)[0]).toMatchObject({ status: 'downloading', enableOnlyDownloadMode: true, background: false })
    pause(username)
    enqueue(username, [cacheInput])
    expect(list(username)[0]).toMatchObject({ status: 'paused', enableOnlyDownloadMode: true, background: false })
    resume(username)
    finishResolver()
    const deadline = Date.now() + 3000
    while (list(username)[0]?.status !== 'finished' && Date.now() < deadline) await Bun.sleep(10)
    expect(worker.mock.calls[0]?.[5]).toBe(true)
    expect(list(username)[0]?.status).toBe('finished')
    enqueue(username, [cacheInput])
    expect(list(username)[0]).toMatchObject({ status: 'finished', enableOnlyDownloadMode: true, background: false })
    expect(worker).toHaveBeenCalledTimes(1)
  } finally {
    finishResolver()
    await suspendUser(username)
    await removeUser(username)
    releaseUser(username)
    await Bun.sleep(220)
    checkCache.mockRestore()
    worker.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persisted queue restoration drops deleted accounts but retains the shared _open queue', () => {
  const savedTasks = [
    { username: 'active-user', id: 'active' },
    { username: 'deleted-user', id: 'stale' },
    { username: '_open', id: 'shared' },
    { id: 'missing-owner' },
  ]

  expect(filterPersistedTasksForUsers(savedTasks, new Set(['active-user']))).toEqual([savedTasks[0], savedTasks[2]])
})

for (const cancellationPhase of ['resolver', 'download'] as const) {
  test(`quick resume survives cancellation while the previous ${cancellationPhase} settles`, async () => {
    const previousLx = global.lx
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-resume-'))
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
    let releaseCancelled!: () => void
    let firstEntered!: () => void
    const pending = new Promise<void>(resolve => {
      releaseCancelled = resolve
    })
    const entered = new Promise<void>(resolve => {
      firstEntered = resolve
    })
    let workerCalls = 0
    let resolverCalls = 0
    const worker = spyOn(fileCache, 'downloadAndCache').mockImplementation(async () => {
      workerCalls++
      if (cancellationPhase === 'download' && workerCalls === 1) {
        firstEntered()
        await pending
        throw new Error('Aborted')
      }
    })
    const username = `quick-resume-${cancellationPhase}`
    try {
      global.lx = { dataPath: root, config: {} } as typeof global.lx
      initialize(async () => {
        resolverCalls++
        if (cancellationPhase === 'resolver' && resolverCalls === 1) {
          firstEntered()
          await pending
        }
        return { url: 'https://example.com/song' }
      })
      enqueue(username, [{ id: 'resume-task', songInfo: { id: `resume-${cancellationPhase}` }, quality: 'flac' }])
      await entered
      pause(username)
      resume(username)
      expect(list(username)[0]?.status).toBe('waiting')
      expect(resolverCalls).toBe(1)
      releaseCancelled()
      const deadline = Date.now() + 3000
      while (list(username)[0]?.status !== 'finished' && Date.now() < deadline) await Bun.sleep(10)
      expect(list(username)[0]).toMatchObject({ status: 'finished', errorMsg: '' })
      expect(resolverCalls).toBe(2)
      expect(workerCalls).toBe(cancellationPhase === 'resolver' ? 1 : 2)
    } finally {
      releaseCancelled()
      await suspendUser(username)
      await removeUser(username)
      releaseUser(username)
      await Bun.sleep(220)
      checkCache.mockRestore()
      worker.mockRestore()
      global.lx = previousLx
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

describe('Server download queue retention', () => {
  test('caps terminal history per user while retaining active and resumable tasks', () => {
    const history = Array.from({ length: 5 }, (_, index) => makeTask('user-a', `finished-${index}`, 'finished', index))
    const otherUserHistory = Array.from({ length: 3 }, (_, index) =>
      makeTask('user-b', `finished-${index}`, 'error', index),
    )
    const active = makeTask('user-a', 'active', 'downloading', 0)
    const paused = makeTask('user-a', 'paused', 'paused', 0)

    const retained = pruneDownloadHistory([...history, ...otherUserHistory, active, paused], 2)

    expect(retained.filter(task => task.username === 'user-a' && task.status === 'finished')).toHaveLength(2)
    expect(retained.filter(task => task.username === 'user-b')).toHaveLength(2)
    expect(retained.some(task => task.id === 'active')).toBe(true)
    expect(retained.some(task => task.id === 'paused')).toBe(true)
  })

  test('marks a task paused when an in-flight worker observes cancellation', () => {
    const task = makeTask('user-a', 'aborted', 'downloading', 10)

    expect(markDownloadTaskPausedIfAborted(task, false)).toBe(false)
    expect(task.status).toBe('downloading')

    expect(markDownloadTaskPausedIfAborted(task, true)).toBe(true)
    expect(task.status).toBe('paused')
    expect(task.speed).toBe(0)
    expect(task.errorMsg).toBe('已暂停')
  })
})

describe('Server download queue deduplication', () => {
  test('keeps one task per user/song/quality and prefers a completed task', () => {
    const waiting = makeTask('user-a', 'waiting-copy', 'waiting', 20)
    waiting.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    waiting.songKey = 'wy_167655_flac'
    waiting.quality = 'flac'
    waiting.requestedQuality = 'flac'

    const finished = makeTask('user-a', 'finished-copy', 'finished', 10)
    finished.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    finished.songKey = 'wy_167655_flac'
    finished.quality = 'flac'
    finished.requestedQuality = 'flac'

    const retained = deduplicateDownloadTasks([waiting, finished])

    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe('finished-copy')
    expect(retained[0]?.status).toBe('finished')
  })

  test('keeps the stricter music target when merging cache and music requests', () => {
    const cached = makeTask('user-a', 'cached', 'finished', 20)
    cached.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    cached.songKey = 'wy_167655_flac'
    cached.quality = 'flac'
    cached.requestedQuality = 'flac'

    const music = makeTask('user-a', 'music', 'waiting', 10)
    music.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    music.songKey = 'wy_167655_flac'
    music.quality = 'flac'
    music.requestedQuality = 'flac'
    music.enableOnlyDownloadMode = true

    const retained = deduplicateDownloadTasks([cached, music])

    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe('music')
    expect(retained[0]?.enableOnlyDownloadMode).toBe(true)
  })

  test('does not persist transient resolved download URLs', () => {
    const task = makeTask('user-a', 'background', 'waiting', 10)
    task.background = true
    task.songInfo.url = 'https://cdn.example.test/song.flac?signature=secret'
    task.songInfo.meta = { url: 'https://cdn.example.test/meta.flac?signature=secret' }
    task.resolvedUrl = 'https://cdn.example.test/song.flac?signature=secret'
    task.resolvedUrlAt = Date.now()

    const serialized = serializeDownloadTask(task) as Record<string, unknown>

    expect(serialized.background).toBe(true)
    expect(serialized).not.toHaveProperty('resolvedUrl')
    expect(serialized).not.toHaveProperty('resolvedUrlAt')
    expect((serialized.songInfo as Record<string, unknown>).url).toBeUndefined()
    expect((serialized.songInfo as Record<string, any>).meta.url).toBeUndefined()
  })

  test('keeps resolver metadata while dropping large transient song payloads', () => {
    const task = makeTask('user-a', 'trimmed', 'waiting', 10)
    task.songInfo = {
      source: 'tx',
      songmid: 'mid-1',
      name: 'Trimmed Song',
      singer: 'Singer',
      albumName: 'Album',
      albumId: 'album-1',
      img: 'https://img.example.test/cover.jpg',
      hash: 'hash-1',
      strMediaMid: 'media-1',
      url: 'https://cdn.example.test/song.flac?signature=secret',
      lyric: 'very large lyric payload'.repeat(1000),
      rawResponse: { nested: 'payload' },
      meta: {
        songId: 'mid-1',
        picUrl: 'https://img.example.test/cover.jpg',
        url: 'https://cdn.example.test/meta.flac?signature=secret',
        lyric: 'large meta lyric payload'.repeat(1000),
      },
    }

    const serialized = serializeDownloadTask(task) as Record<string, any>
    expect(serialized.songInfo).toMatchObject({
      source: 'tx',
      songmid: 'mid-1',
      name: 'Trimmed Song',
      strMediaMid: 'media-1',
    })
    expect(serialized.songInfo.url).toBeUndefined()
    expect(serialized.songInfo.lyric).toBeUndefined()
    expect(serialized.songInfo.rawResponse).toBeUndefined()
    expect(serialized.songInfo.meta.url).toBeUndefined()
    expect(serialized.songInfo.meta.lyric).toBeUndefined()
  })

  test('limits background cache work to one active task and keeps explicit work eligible', () => {
    const background = makeTask('user-a', 'background', 'waiting', 10)
    background.background = true
    const explicit = makeTask('user-a', 'explicit', 'waiting', 20)
    const activeIdentities = new Set<string>()

    expect(isDownloadTaskRunnable(background, 0, 0, activeIdentities, 3)).toBe(true)
    expect(isDownloadTaskRunnable(background, 0, 1, activeIdentities, 3)).toBe(false)
    expect(isDownloadTaskRunnable(explicit, 2, 0, activeIdentities, 3)).toBe(true)
    expect(isDownloadTaskRunnable(explicit, 3, 0, activeIdentities, 3)).toBe(false)
  })

  test('prefers an explicit task over a background task when identities collide', () => {
    const background = makeTask('user-a', 'background', 'waiting', 20)
    background.background = true
    const explicit = makeTask('user-a', 'explicit', 'waiting', 10)
    background.songInfo = explicit.songInfo = { source: 'wy', songmid: 'same-song', name: 'Same Song' }

    const retained = deduplicateDownloadTasks([background, explicit])

    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe('explicit')
  })

  test('marks an existing music target complete without resolving a remote URL', async () => {
    const previousLx = (global as any).lx
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-queue-existing-'))
    const songInfo = { source: 'wy', songmid: 'already-downloaded', name: 'Already Downloaded', singer: 'Singer' }
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({
      exists: true,
      isCollision: false,
      folder: 'music',
      foundIn: 'existing-download-user',
      filename: 'already-downloaded.flac',
      quality: 'flac',
      path: '/tmp/already-downloaded.flac',
    } as any)
    const removeDuplicateCacheForSong = spyOn(fileCache, 'removeDuplicateCacheForSong').mockReturnValue(true)
    let resolverCalls = 0

    try {
      ;(global as any).lx = { dataPath: path.join(root, 'data'), config: {} }
      initialize(async () => {
        resolverCalls++
        return { url: 'https://example.com/already-downloaded.flac', quality: 'flac' }
      })

      const queued = enqueue('existing-download-user', [
        {
          id: 'wy_already-downloaded_flac',
          songInfo,
          quality: 'flac',
          enableOnlyDownloadMode: true,
        },
      ])
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(queued[0]).toMatchObject({ status: 'exists', progress: 100 })
      expect(list('existing-download-user')[0]).toMatchObject({ status: 'exists', progress: 100 })
      expect(resolverCalls).toBe(0)
      expect(removeDuplicateCacheForSong).toHaveBeenCalledWith(songInfo, 'flac', 'existing-download-user')
    } finally {
      await new Promise(resolve => setTimeout(resolve, 220))
      removeDuplicateCacheForSong.mockRestore()
      checkCache.mockRestore()
      ;(global as any).lx = previousLx
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  test('promotes a private cache without resolving a remote URL', async () => {
    const previousLx = (global as any).lx
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-queue-promote-'))
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({
      exists: true,
      isCollision: false,
      foundIn: 'promote-user',
      folder: 'cache',
      filename: 'cached-song.flac',
      path: '/tmp/cached-song.flac',
      quality: 'flac',
    } as any)
    const downloadAndCache = spyOn(fileCache, 'downloadAndCache').mockResolvedValue(undefined)
    let resolverCalls = 0

    try {
      ;(global as any).lx = { dataPath: path.join(root, 'data'), config: {} }
      initialize(async () => {
        resolverCalls++
        return { url: 'https://example.com/cached-song.flac', quality: 'flac' }
      })
      enqueue('promote-user', [
        {
          id: 'wy_cached-song_flac',
          songInfo: { source: 'wy', songmid: 'cached-song', name: 'Cached Song' },
          quality: 'flac',
          enableOnlyDownloadMode: true,
        },
      ])

      const deadline = Date.now() + 3000
      let task = list('promote-user').find(item => item.id === 'wy_cached-song_flac')
      while (Date.now() < deadline && task?.status !== 'finished') {
        await new Promise(resolve => setTimeout(resolve, 20))
        task = list('promote-user').find(item => item.id === 'wy_cached-song_flac')
      }
      expect(task?.status).toBe('finished')
      expect(resolverCalls).toBe(0)
      expect(downloadAndCache.mock.calls[0]?.[1]).toBe('')
    } finally {
      await new Promise(resolve => setTimeout(resolve, 220))
      downloadAndCache.mockRestore()
      checkCache.mockRestore()
      closeDb()
      ;(global as any).lx = previousLx
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  test('refreshes a browser-supplied URL once while retaining the requested cache identity', async () => {
    const previousLx = (global as any).lx
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-queue-retry-'))
    const downloadAndCache = spyOn(fileCache, 'downloadAndCache')
    let resolverCalls = 0
    let downloadCalls = 0
    downloadAndCache.mockImplementation(async () => {
      downloadCalls++
      if (downloadCalls === 1) throw new Error('expired supplied URL')
    })

    try {
      ;(global as any).lx = { dataPath: path.join(root, 'data'), config: {} }
      initialize(async task => {
        resolverCalls++
        return {
          url: 'https://fresh.example/song.flac',
          quality: task.requestedQuality,
          songInfo: { source: 'tx', songmid: 'fallback-song', name: 'Fallback Song', singer: 'Singer' },
          requestedSource: 'wy',
          downloadSource: 'tx',
        }
      })
      enqueue('retry-user', [
        {
          id: 'wy_retry-song_flac',
          songInfo: { source: 'wy', songmid: 'retry-song', name: 'Retry Song', singer: 'Singer' },
          quality: 'flac',
          resolvedUrl: 'https://expired.example/song.flac',
          background: true,
        },
      ])

      const deadline = Date.now() + 3000
      let task = list('retry-user').find(item => item.id === 'wy_retry-song_flac')
      while (Date.now() < deadline && task?.status !== 'finished') {
        await new Promise(resolve => setTimeout(resolve, 20))
        task = list('retry-user').find(item => item.id === 'wy_retry-song_flac')
      }

      expect(task?.status).toBe('finished')
      expect(downloadCalls).toBe(2)
      expect(resolverCalls).toBe(1)
      expect(downloadAndCache.mock.calls[0]?.[1]).toBe('https://expired.example/song.flac')
      expect(downloadAndCache.mock.calls[1]?.[1]).toBe('https://fresh.example/song.flac')
      expect(downloadAndCache.mock.calls[1]?.[0]).toMatchObject({ source: 'wy', songmid: 'retry-song' })
      expect(task?.songInfo).toMatchObject({ source: 'wy', songmid: 'retry-song' })
      expect(task?.songKey).toBe('wy_retry-song_flac')
    } finally {
      await new Promise(resolve => setTimeout(resolve, 220))
      downloadAndCache.mockRestore()
      closeDb()
      ;(global as any).lx = previousLx
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})

test('shared music is copied by the worker rather than counted as a personal download', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-shared-download-'))
  const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({
    exists: true,
    foundIn: '_open',
    folder: 'music',
    filename: 'shared.flac',
    path: '/tmp/shared.flac',
    quality: 'flac',
  } as any)
  const worker = spyOn(fileCache, 'downloadAndCache').mockResolvedValue(undefined)
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    initialize(async () => {
      throw new Error('Shared file needs no remote URL')
    })
    const added = enqueue('shared-copy-user', [
      { songInfo: { id: 'shared-copy-song' }, quality: 'flac', enableOnlyDownloadMode: true },
    ])
    expect(added[0]?.status).not.toBe('exists')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(worker).toHaveBeenCalled()
    expect(list('shared-copy-user')[0]?.status).toBe('finished')
    await removeUser('shared-copy-user')
  } finally {
    await new Promise(resolve => setTimeout(resolve, 220))
    checkCache.mockRestore()
    worker.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('account suspension drains workers, blocks new work and migrates paused tasks', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-drain-download-'))
  const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
  let finishResolver!: () => void
  const pending = new Promise<void>(resolve => {
    finishResolver = resolve
  })
  const worker = spyOn(fileCache, 'downloadAndCache').mockResolvedValue(undefined)
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    initialize(async () => {
      await pending
      return { url: 'https://example.com/song' }
    })
    enqueue('drain-old', [{ songInfo: { id: 'drain-song' }, quality: 'flac' }])
    let drained = false
    const draining = suspendUser('drain-old').then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(() => enqueue('drain-old', [{ songInfo: { id: 'blocked' } }])).toThrow()
    finishResolver()
    await draining
    expect(worker).not.toHaveBeenCalled()
    await renameUser('drain-old', 'drain-new')
    expect(list('drain-old')).toEqual([])
    expect(list('drain-new')[0]?.status).toBe('paused')
    await removeUser('drain-new')
    expect(list('drain-new')).toEqual([])
  } finally {
    releaseUser('drain-old')
    await new Promise(resolve => setTimeout(resolve, 220))
    checkCache.mockRestore()
    worker.mockRestore()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('promotion copies shared music and lyrics into the private library while preserving the originals', async () => {
  const previousLx = global.lx
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-shared-music-promote-'))
  closeDb()
  initDatabase(':memory:')
  try {
    global.lx = { dataPath: root, config: {} } as typeof global.lx
    const source = fileCache.getCacheDir('_open', true, 'data')
    fs.writeFileSync(path.join(source, 'shared.mp3'), 'test-audio')
    fs.writeFileSync(path.join(source, 'shared.lrc'), '[00:01]lyrics')
    fileCache.indexManager.update(
      '_open',
      {
        id: 'wy_shared-promotion',
        songmid: 'shared-promotion',
        name: 'Shared',
        singer: 'Singer',
        albumName: '',
        source: 'wy',
        quality: '320k',
        filename: 'shared.mp3',
        folder: 'music',
        mtime: Date.now(),
        size: 10,
        ext: 'mp3',
        lyricFilename: 'shared.lrc',
      },
      'music',
      'data',
    )
    const promoted = await fileCache.promoteCachedSongToMusic(
      { source: 'wy', songmid: 'shared-promotion' },
      '320k',
      'copy-target',
    )
    expect(promoted.successCount).toBe(1)
    const target = fileCache.getCacheDir('copy-target', true, 'data')
    expect(fs.readFileSync(path.join(target, 'shared.mp3'), 'utf8')).toBe('test-audio')
    expect(fs.readFileSync(path.join(target, 'shared.lrc'), 'utf8')).toBe('[00:01]lyrics')
    expect(fs.existsSync(path.join(source, 'shared.mp3'))).toBe(true)
    expect(fileCache.indexManager.getAll('copy-target', 'music', 'data')).toHaveLength(1)
  } finally {
    closeDb()
    global.lx = previousLx
    fs.rmSync(root, { recursive: true, force: true })
  }
})
