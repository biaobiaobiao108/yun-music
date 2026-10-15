import { expect, spyOn, test } from 'bun:test'
import * as requestUtils from '@/modules/utils/request'
import txBoards from '@/modules/utils/musicSdk/tx/leaderboard'
import wyBoards from '@/modules/utils/musicSdk/wy/leaderboard'
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
  const older = { promise: new Promise<void>(resolve => { resolveOld = resolve }) }
  const newer = { promise: new Promise<void>((_resolve, reject) => { rejectNew = reject }) }
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
