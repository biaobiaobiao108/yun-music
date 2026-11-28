/**
 * 规范化歌曲信息，确保收藏列表中的 meta 属性在根节点也可用。
 */
export const normalizeSongInfo = (songInfo: any) => {
  if (!songInfo) return songInfo
  const meta = songInfo.meta || {}

  if (!songInfo.types && meta) {
    songInfo.types = meta.qualitys || meta.types
  }
  if (!songInfo._types && meta) {
    songInfo._types = meta._qualitys || meta._types
  }

  if (!songInfo.albumName && meta.albumName) songInfo.albumName = meta.albumName
  if (!songInfo.albumId && meta.albumId) songInfo.albumId = meta.albumId
  if (!songInfo.img && meta.picUrl) songInfo.img = meta.picUrl
  if (!songInfo.name && meta.name) songInfo.name = meta.name
  if (!songInfo.singer && meta.singer) songInfo.singer = meta.singer
  if (!songInfo.source && meta.source) songInfo.source = meta.source
  if (!songInfo.interval && meta.interval) songInfo.interval = meta.interval

  if (!songInfo.songmid) {
    if (meta.songId) {
      songInfo.songmid = String(meta.songId)
    } else if (songInfo.id) {
      const rawId = String(songInfo.id)
      const sourcePrefix = `${songInfo.source}_`
      if (rawId.startsWith(sourcePrefix)) {
        songInfo.songmid = rawId.slice(sourcePrefix.length)
      } else {
        songInfo.songmid = rawId
      }
    }
  }
  if (songInfo.songmid != null) {
    songInfo.songmid = String(songInfo.songmid)
  }

  switch (songInfo.source) {
    case 'wy':
      if (!songInfo.id && meta.songId) songInfo.id = String(meta.songId)
      if (!songInfo.songmid && songInfo.id) songInfo.songmid = String(songInfo.id)
      break

    case 'tx': {
      if (!songInfo.strMediaMid && meta.strMediaMid) songInfo.strMediaMid = meta.strMediaMid
      if (!songInfo.albumMid && meta.albumMid) songInfo.albumMid = meta.albumMid
      const metaSongId = String(meta.songId || '')
      if (/^\d+$/.test(metaSongId)) {
        songInfo.songId = metaSongId
      }
      break
    }
  }

  return songInfo
}
