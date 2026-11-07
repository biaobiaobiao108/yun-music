import { expect, spyOn, test } from 'bun:test'
import * as requestUtils from '@/modules/utils/request'
import search from '@/modules/utils/musicSdk/tx/extendSearch'

test('QQ search retries upstream rejection and maps singer and album metadata', async () => {
  const fetch = spyOn(requestUtils, 'httpFetch')
  let calls = 0
  fetch.mockImplementation((_url, options: any) => {
    calls++
    const type = options.body.req.param.search_type
    const data =
      type === 1
        ? { singer: { list: [{ singerMID: 'singer-mid', singerName: 'Singer' }] } }
        : {
            album: {
              list: [
                {
                  albumMID: 'album-mid',
                  albumName: 'Album',
                  singerMID: 'singer-mid',
                  singerName: 'Singer',
                  publicTime: '2024-01-02',
                },
              ],
            },
          }
    return {
      promise: Promise.resolve({
        body:
          calls === 1
            ? { code: 0, req: { code: 2001 } }
            : { code: 0, req: { code: 0, data: { body: data, meta: { sum: 42 } } } },
      }),
    } as any
  })
  try {
    const singer = await search.searchSinger('Singer', 1, 10)
    expect(singer.list[0]).toMatchObject({ id: 'singer-mid', name: 'Singer' })
    expect(singer.total).toBe(42)
    expect(calls).toBe(2)
    const album = await search.searchAlbum('Album', 1, 10)
    expect(album.list[0]).toMatchObject({ id: 'album-mid', artistId: 'singer-mid', publishTime: '2024-01-02' })
    expect(album.allPage).toBe(5)
  } finally {
    fetch.mockRestore()
  }
})

test('QQ search reports repeated upstream rejection instead of an empty result', async () => {
  const fetch = spyOn(requestUtils, 'httpFetch').mockReturnValue({
    promise: Promise.resolve({ body: { code: 0, req: { code: 2001 } } }),
  } as any)
  try {
    await expect(search.searchSinger('Singer')).rejects.toThrow('暂时限制')
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally {
    fetch.mockRestore()
  }
})
