declare namespace LX {
  namespace Music {
    interface MusicQualityType {
      // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
    }
    type _MusicQualityType = Partial<
      Record<
        Quality,
        {
          size: string | null
        }
      >
    >

    interface MusicInfoMetaBase {
      songId: string | number // 歌曲ID，local为文件路径
      albumName: string // 歌曲专辑名称
      picUrl?: string | null // 歌曲图片链接
    }

    interface MusicInfoMeta_online extends MusicInfoMetaBase {
      qualitys: MusicQualityType[]
      _qualitys: _MusicQualityType
      albumId?: string | number // 歌曲专辑ID
    }

    interface MusicInfoMeta_local extends MusicInfoMetaBase {
      filePath: string
      ext: string
    }

    interface MusicInfoBase<S = LX.Source> {
      id: string
      name: string // 歌曲名
      singer: string // 艺术家名
      source: S // 源
      interval: string | null // 格式化后的歌曲时长，例：03:55
      meta: MusicInfoMetaBase
    }

    interface MusicInfoLocal extends MusicInfoBase<'local'> {
      meta: MusicInfoMeta_local
    }

    interface MusicInfo_wy extends MusicInfoBase<'wy'> {
      meta: MusicInfoMeta_online
    }

    interface MusicInfoMeta_tx extends MusicInfoMeta_online {
      strMediaMid: string // 歌曲strMediaMid
      id?: number // 歌曲songId
      albumMid?: string // 歌曲albumMid
    }
    interface MusicInfo_tx extends MusicInfoBase<'tx'> {
      meta: MusicInfoMeta_tx
    }

    type MusicInfoOnline = MusicInfo_wy | MusicInfo_tx
    type MusicInfo = MusicInfoOnline | MusicInfoLocal

    /** 历史列表中仍可能存在的、无法再进入播放流程的旧音源数据。 */
    interface UnsupportedMusicInfo {
      id: string
      name?: string
      singer?: string
      source: string
      interval?: string | null
      meta?: Record<string, unknown>
    }

    type PersistedMusicInfo = MusicInfo | UnsupportedMusicInfo

    interface LyricInfo {
      // 歌曲歌词
      lyric: string
      // 翻译歌词
      tlyric?: string | null
      // 罗马音歌词
      rlyric?: string | null
      // 逐字歌词
      lxlyric?: string | null
    }

    interface LyricInfoSave {
      id: string
      lyrics: LyricInfo
    }

    interface MusicFileMeta {
      title: string
      artist: string | null
      album: string | null
      APIC: string | null
      lyrics: string | null
    }

    interface MusicUrlInfo {
      id: string
      url: string
    }

    interface MusicInfoOtherSourceSave {
      id: string
      list: MusicInfoOnline[]
    }
  }
}
