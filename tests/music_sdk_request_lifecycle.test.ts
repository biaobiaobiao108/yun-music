import { expect, spyOn, test } from 'bun:test'
import * as requestUtils from '@/modules/utils/request'
import txBoards from '@/modules/utils/musicSdk/tx/leaderboard'
import wyBoards from '@/modules/utils/musicSdk/wy/leaderboard'
import txHotSearch from '@/modules/utils/musicSdk/tx/hotSearch'
import wyHotSearch from '@/modules/utils/musicSdk/wy/hotSearch'
import txSongList from '@/modules/utils/musicSdk/tx/songList'
import wySongList from '@/modules/utils/musicSdk/wy/songList'
import txTipSearch from '@/modules/utils/musicSdk/tx/tipSearch'
import wyTipSearch from '@/modules/utils/musicSdk/wy/tipSearch'
import { releaseRequestWhenSettled } from '@/modules/utils/musicSdk/requestLifecycle'

test('SDK singleton releases its completed response without changing the public promise', async () => {
  const response = { statusCode: 200, body: { payload: 'kept by caller' }, raw: Buffer.alloc(1024) }
  const request = { promise: Promise.resolve(response), cancelHttp: () => {} }
  const fetch = spyOn(requestUtils, 'httpFetch').mockReturnValue(request as any)
  try {
    for (const boards of [txBoards, wyBoards]) {
      const promise = boards.getBoardsData()
      expect(promise).toBe(request.promise)
      expect(await promise).toBe(response)
      expect(boards._requestBoardsObj).toBeNull()
    }
  } finally {
    fetch.mockRestore()
  }
})

test('settling an older request does not clear a newer cancellation handle, and failures release it', async () => {
  let resolveOld!: () => void
  let rejectNew!: (reason: Error) => void
  const older = {
    promise: new Promise<void>(resolve => {
      resolveOld = resolve
    }),
  }
  const newer = {
    promise: new Promise<void>((_resolve, reject) => {
      rejectNew = reject
    }),
  }
  const owner: { request: typeof older | null } = { request: older }
  releaseRequestWhenSettled(owner, 'request')
  owner.request = newer
  releaseRequestWhenSettled(owner, 'request')
  resolveOld()
  await older.promise
  expect(owner.request).toBe(newer)
  rejectNew(new Error('request failed'))
  await expect(newer.promise).rejects.toThrow('request failed')
  expect(owner.request).toBeNull()
})

test('overlapping singleton SDK calls keep each request alive', async () => {
  const makeRequest = () => {
    let resolve!: (response: any) => void
    const request = {
      cancelled: false,
      cancelHttp() {
        request.cancelled = true
      },
      promise: new Promise<any>(done => {
        resolve = done
      }),
    }
    return { request, resolve: (response: any) => resolve(response) }
  }

  const cases: Array<{
    call: () => Promise<unknown>
    response: any
  }> = [
    { call: () => txBoards.getBoardsData(), response: { statusCode: 200, body: {} } },
    { call: () => wyBoards.getBoardsData(), response: { statusCode: 200, body: {} } },
    {
      call: () => txSongList.getTag(),
      response: { statusCode: 200, body: { code: 0, tags: { data: { v_group: [] } } } },
    },
    { call: () => txSongList.getHotTag(), response: { statusCode: 200, body: '' } },
    {
      call: () => txSongList.getList('hot', '', 1),
      response: { statusCode: 200, body: { code: 0, playlist: { data: { v_playlist: [], total: 0 } } } },
    },
    {
      call: () => wySongList.getList('hot', '全部', 1),
      response: { statusCode: 200, body: { code: 200, playlists: [], total: 0 } },
    },
    { call: () => wySongList.getTag(), response: { statusCode: 200, body: { code: 200, sub: [], categories: {} } } },
    { call: () => wySongList.getHotTag(), response: { statusCode: 200, body: { code: 200, tags: [] } } },
    {
      call: () => txHotSearch.getList(),
      response: { statusCode: 200, body: { code: 0, hotkey: { data: { vec_hotkey: [] } } } },
    },
    { call: () => wyHotSearch.getList(), response: { statusCode: 200, body: { code: 200, data: { itemList: [] } } } },
    {
      call: () => txTipSearch.tipSearch('one'),
      response: { statusCode: 200, body: { code: 0, data: { song: { itemlist: [] } } } },
    },
    {
      call: () => wyTipSearch.tipSearchBySong('one'),
      response: { statusCode: 200, body: { code: 200, result: { songs: [] } } },
    },
  ]
  const fetch = spyOn(requestUtils, 'httpFetch')
  const pending: Array<{ request: ReturnType<typeof makeRequest>; response: any }> = []
  const operations: Promise<unknown>[] = []

  try {
    for (const { call, response } of cases) {
      const pair = [makeRequest(), makeRequest()]
      const queued = [...pair]
      fetch.mockImplementation(() => queued.shift()!.request as any)
      operations.push(call(), call())
      pending.push(...pair.map(request => ({ request, response })))
    }
    expect(pending.every(({ request }) => request.request.cancelled === false)).toBe(true)
  } finally {
    fetch.mockRestore()
  }

  pending.forEach(({ request, response }) => request.resolve(response))
  await Promise.all(operations)
  expect(pending.every(({ request }) => request.request.cancelled === false)).toBe(true)
})
