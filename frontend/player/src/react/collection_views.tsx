import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { type UserPlaylist } from './api'
import { Button, Icon, Loading, Modal, SelectMenu, SelectionDock, SongList } from './components'
import {
  MUSIC_SOURCE_OPTIONS,
  normalizeMusicSource,
  selectLoveList,
  selectUserLists,
  useAuthStore,
  useCacheStore,
  useLibraryStore,
  usePlaybackStore,
  usePlayerUiStore,
  useSettingsStore,
} from './store'
import type { Song } from './types'
import { songKey } from './types'
import { ViewFrame } from './view_frame'

type SongCollectionViewProps = {
  listId: string
  name: string
  songs: Song[]
  loading: boolean
  error: string
  onRename?: (name: string) => Promise<void>
  onDelete?: () => Promise<void>
}

function SongCollectionView({ listId, name, songs, loading, error, onRename, onDelete }: SongCollectionViewProps) {
  const removeSongs = useLibraryStore(state => state.removeSongs)
  const enqueueDownloads = useCacheStore(state => state.enqueueDownloads)
  const playSong = usePlaybackStore(state => state.playSong)
  const notify = usePlayerUiStore(state => state.notify)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const preferredQuality = useSettingsStore(state => String(state.settings.preferredQuality || 'flac'))
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSongs, setSelectedSongs] = useState<Set<string>>(new Set())
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    setSelectedSongs(new Set())
    setBatchMode(false)
    setRenameValue(name)
  }, [listId, name])
  useEffect(() => {
    if (!batchMode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setBatchMode(false)
      setSelectedSongs(new Set())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [batchMode])
  const selectedListSongs = useMemo(
    () => songs.filter(song => selectedSongs.has(songKey(song))),
    [selectedSongs, songs],
  )
  const hasSelection = selectedListSongs.length > 0
  const allSelected = songs.length > 0 && songs.every(song => selectedSongs.has(songKey(song)))
  const toggleSong = (song: Song) =>
    setSelectedSongs(current => {
      const next = new Set(current)
      const key = songKey(song)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const selectAll = () => setSelectedSongs(new Set(songs.map(songKey)))
  const toggleSelectAll = () => {
    if (allSelected) setSelectedSongs(new Set())
    else selectAll()
  }
  const playRandom = () => {
    if (!songs.length) {
      notify('当前歌单没有歌曲')
      return
    }
    const index = Math.floor(Math.random() * songs.length)
    playSong(songs[index], songs, index)
  }
  const removeBatch = async () => {
    if (!selectedListSongs.length) return
    try {
      await removeSongs(listId, selectedListSongs)
      notify(`已从“${name}”移除 ${selectedListSongs.length} 首歌曲`)
      setSelectedSongs(new Set())
      setConfirmOpen(false)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '批量移除失败')
    }
  }
  const downloadBatch = async () => {
    if (!selectedListSongs.length || downloadBusy) return
    setDownloadBusy(true)
    try {
      const count = await enqueueDownloads(selectedListSongs, preferredQuality)
      notify(`已将 ${count} 首歌曲加入下载队列（${preferredQuality.toUpperCase()}）`)
      setSelectedSongs(new Set())
      setDrawer('download')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '批量下载失败')
    } finally {
      setDownloadBusy(false)
    }
  }
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    const nextName = renameValue.trim()
    if (!onRename || !nextName) return
    try {
      await onRename(nextName)
      setRenameOpen(false)
      notify('歌单已重命名')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '歌单重命名失败')
    }
  }
  const confirmDelete = async () => {
    if (!onDelete) return
    try {
      await onDelete()
      setDeleteOpen(false)
      openFavoriteList('love')
      notify('歌单已删除')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '歌单删除失败')
    }
  }
  const headerActions = (
    <>
      <Button
        variant="primary"
        className="react-icon-only-button"
        aria-label="随机漫游"
        onClick={playRandom}
        disabled={!songs.length}
      >
        <Icon name="shuffle" />
      </Button>
      {onRename && (
        <Button
          className="react-icon-only-button"
          aria-label="重命名歌单"
          onClick={() => {
            setRenameValue(name)
            setRenameOpen(true)
          }}
        >
          <Icon name="pen" />
        </Button>
      )}
      {onDelete && (
        <Button
          variant="danger"
          className="react-icon-only-button"
          aria-label="删除歌单"
          onClick={() => setDeleteOpen(true)}
        >
          <Icon name="trash" />
        </Button>
      )}
    </>
  )
  const normalActions = (
    <>
      <Button
        className="react-icon-only-button"
        aria-label="多选操作"
        onClick={() => {
          setBatchMode(true)
          setSelectedSongs(new Set())
        }}
        disabled={downloadBusy}
      >
        <Icon name="list" />
      </Button>
      {headerActions}
    </>
  )
  return (
    <ViewFrame
      title={name}
      actions={
        batchMode ? undefined : (
          <div className="react-view-header-actions react-playlist-header-actions">{normalActions}</div>
        )
      }
    >
      <section className={`react-content-card t-bg-panel react-playlist-page ${batchMode ? 'is-batch-selecting' : ''}`}>
        {loading ? (
          <Loading label="正在加载歌单…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : (
          <SongList
            songs={songs}
            listId={listId}
            selected={batchMode ? selectedSongs : undefined}
            onSelect={batchMode ? toggleSong : undefined}
            showFileMetadata={false}
            empty={listId === 'love' ? '还没有喜欢的歌曲，去搜索音乐吧' : '歌单还是空的，去搜索音乐吧'}
          />
        )}
        {batchMode && <div className="react-selection-dock-spacer" aria-hidden="true" />}
        {batchMode && (
          <SelectionDock
            count={selectedListSongs.length}
            allSelected={allSelected}
            canSelectAll={songs.length > 0}
            busy={downloadBusy}
            onToggleAll={toggleSelectAll}
            onClose={() => {
              setBatchMode(false)
              setSelectedSongs(new Set())
            }}
          >
            <button
              type="button"
              className="react-selection-action is-primary"
              onClick={() => void downloadBatch()}
              disabled={!hasSelection || downloadBusy}
            >
              <Icon name={downloadBusy ? 'spinner' : 'download'} />
              <span>{downloadBusy ? '加入中' : '下载'}</span>
            </button>
            <button
              type="button"
              className="react-selection-action is-danger"
              onClick={() => setConfirmOpen(true)}
              disabled={!hasSelection || downloadBusy}
            >
              <Icon name="trash" />
              <span>移除</span>
            </button>
          </SelectionDock>
        )}
        <Modal open={confirmOpen} title="批量移除歌曲" onClose={() => setConfirmOpen(false)}>
          <p>
            确定从“{name}”移除选中的 {selectedListSongs.length} 首歌曲吗？
          </p>
          <div className="react-dialog-actions">
            <Button onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button variant="danger" onClick={() => void removeBatch()}>
              确认移除
            </Button>
          </div>
        </Modal>
        <Modal open={renameOpen} title="重命名歌单" onClose={() => setRenameOpen(false)}>
          <form className="react-dialog-form" onSubmit={submitRename}>
            <label className="sr-only" htmlFor="rename-list-name">
              歌单名称
            </label>
            <input
              id="rename-list-name"
              value={renameValue}
              onChange={event => setRenameValue(event.target.value)}
              maxLength={80}
              required
            />
            <div className="react-dialog-actions">
              <Button type="button" onClick={() => setRenameOpen(false)}>
                取消
              </Button>
              <Button variant="primary" type="submit">
                保存
              </Button>
            </div>
          </form>
        </Modal>
        <Modal open={deleteOpen} title="删除歌单" onClose={() => setDeleteOpen(false)}>
          <p>确定删除歌单“{name}”吗？其中的歌曲也会从该歌单移除。</p>
          <div className="react-dialog-actions">
            <Button type="button" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" type="button" onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </div>
        </Modal>
      </section>
    </ViewFrame>
  )
}

function LoveListView({ songs, loading, error }: { songs: Song[]; loading: boolean; error: string }) {
  return <SongCollectionView listId="love" name="我喜欢的音乐" songs={songs} loading={loading} error={error} />
}

function UserPlaylistView({
  listId,
  list,
  loading,
  error,
}: {
  listId: string
  list?: UserPlaylist
  loading: boolean
  error: string
}) {
  const notify = usePlayerUiStore(state => state.notify)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const renameList = useLibraryStore(state => state.renameList)
  const deleteList = useLibraryStore(state => state.deleteList)
  useEffect(() => {
    if (!loading && !list) {
      notify('歌单不存在，已返回我喜欢的音乐')
      openFavoriteList('love')
    }
  }, [list, loading, notify, openFavoriteList])
  if (!list)
    return (
      <ViewFrame title="歌单">
        <section className="react-content-card t-bg-panel">
          {loading ? (
            <Loading label="正在加载歌单…" />
          ) : (
            <div className="react-empty">
              <Icon name="list" />
              <p>歌单不存在或已被删除</p>
              <Button variant="primary" onClick={() => openFavoriteList('love')}>
                返回我喜欢的音乐
              </Button>
            </div>
          )}
        </section>
      </ViewFrame>
    )
  const name = String(list.name || '未命名歌单')
  return (
    <SongCollectionView
      listId={listId}
      name={name}
      songs={list.list ?? []}
      loading={loading}
      error={error}
      onRename={nextName => renameList(listId, nextName)}
      onDelete={() => deleteList(listId)}
    />
  )
}

export function FavoritesView() {
  const loveSongs = useLibraryStore(selectLoveList)
  const loading = useLibraryStore(state => state.loading)
  const error = useLibraryStore(state => state.error)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const list = useLibraryStore(state => selectUserLists(state).find(item => String(item.id) === favoriteListId))
  return favoriteListId === 'love' ? (
    <LoveListView songs={loveSongs} loading={loading} error={error} />
  ) : (
    <UserPlaylistView listId={favoriteListId} list={list} loading={loading} error={error} />
  )
}

export function SettingsView() {
  const settings = useSettingsStore(state => state.settings)
  const setSetting = useSettingsStore(state => state.setSetting)
  const saveError = useSettingsStore(state => state.saveError)
  const clearSaveError = useSettingsStore(state => state.clearSaveError)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const userName = useAuthStore(state => state.userName)
  const userLogin = useAuthStore(state => state.userLogin)
  const userLogout = useAuthStore(state => state.userLogout)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [accountError, setAccountError] = useState('')
  const login = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await userLogin(username, password)
      setAccountError('')
    } catch (e) {
      setAccountError(e instanceof Error ? e.message : '登录失败')
    }
  }
  const logout = async () => {
    await userLogout()
  }
  const toggle = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => setSetting(key, event.target.checked)
  return (
    <ViewFrame title="设置">
      {saveError && (
        <div className="react-settings-sync-error" role="alert">
          <span>设置已保存在本机，但未同步到服务器：{saveError}</span>
          <button type="button" onClick={clearSaveError}>
            关闭
          </button>
        </div>
      )}
      <section className="react-settings-grid">
        <section className="react-content-card t-bg-panel">
          <h2>外观</h2>
          <div className="react-settings-form">
            <div className="react-setting-field">
              <span>外观模式</span>
              <SelectMenu
                label="外观模式"
                value={String(settings.appearance || 'system')}
                options={[
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                  { value: 'system', label: '跟随系统' },
                ]}
                onChange={value => setSetting('appearance', value)}
              />
            </div>
          </div>
        </section>
        <section className="react-content-card t-bg-panel">
          <h2>播放与音源</h2>
          <div className="react-settings-form">
            <div className="react-setting-field">
              <span>默认音源</span>
              <SelectMenu
                label="默认音源"
                value={normalizeMusicSource(settings.defaultSource)}
                options={MUSIC_SOURCE_OPTIONS.map(option => ({ ...option }))}
                onChange={value => setSetting('defaultSource', value)}
              />
            </div>
            <div className="react-setting-field">
              <span>默认音质</span>
              <SelectMenu
                label="默认音质"
                value={String(settings.preferredQuality)}
                options={[
                  { value: '128k', label: '128K' },
                  { value: '320k', label: '320K' },
                  { value: 'flac', label: '无损 FLAC' },
                  { value: 'hires', label: 'Hi-Res' },
                ]}
                onChange={value => setSetting('preferredQuality', value)}
              />
            </div>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.autoResume)} onChange={toggle('autoResume')} />
              <span>自动恢复上次播放进度</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableKeyboardShortcuts)}
                onChange={toggle('enableKeyboardShortcuts')}
              />
              <span>启用键盘快捷键</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.showLyricTranslation)}
                onChange={toggle('showLyricTranslation')}
              />
              <span>显示歌词翻译</span>
            </label>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.showLyricRoma)} onChange={toggle('showLyricRoma')} />
              <span>显示罗马音 / 逐字歌词</span>
            </label>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.keepScreenAwake)} onChange={toggle('keepScreenAwake')} />
              <span>播放时保持屏幕唤醒</span>
            </label>
          </div>
        </section>
        <section className="react-content-card t-bg-panel">
          <h2>缓存与播放策略</h2>
          <div className="react-settings-form">
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.enablePreloader)} onChange={toggle('enablePreloader')} />
              <span>预取下一首歌曲</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableAutoDegradeQuality)}
                onChange={toggle('enableAutoDegradeQuality')}
              />
              <span>播放失败时自动降级音质</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableAutoSwitchSource)}
                onChange={toggle('enableAutoSwitchSource')}
              />
              <span>解析失败时自动换源</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableServerCache)}
                onChange={toggle('enableServerCache')}
              />
              <span>播放后加入服务器缓存</span>
            </label>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.enableCrossfade)} onChange={toggle('enableCrossfade')} />
              <span>切歌淡入淡出</span>
            </label>
          </div>
        </section>
        <section className="react-content-card t-bg-panel react-account-card">
          <div className="react-account-heading">
            <div>
              <h2>用户账户</h2>
              <p>登录后同步歌单、收藏与播放记录</p>
            </div>
            <span className={`react-account-badge ${userAuthenticated ? 'is-active' : ''}`}>
              <Icon name={userAuthenticated ? 'circle-check' : 'circle-user'} />
              {userAuthenticated ? '已登录' : '未登录'}
            </span>
          </div>
          {userAuthenticated ? (
            <div className="react-account-state">
              <Icon name="circle-check" />
              <div className="react-account-copy">
                <strong>{userName}</strong>
                <span>账户已连接，支持多端数据同步</span>
              </div>
              <Button onClick={() => void logout()}>退出账户</Button>
            </div>
          ) : (
            <form className="react-settings-form react-account-form" onSubmit={login}>
              <label>
                用户名
                <input
                  value={username}
                  onChange={event => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              {accountError && (
                <p className="react-error" role="alert">
                  {accountError}
                </p>
              )}
              <Button variant="primary" type="submit">
                登录账户
              </Button>
            </form>
          )}
        </section>
      </section>
    </ViewFrame>
  )
}
