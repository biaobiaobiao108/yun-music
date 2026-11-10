import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { PLAYLIST_ICON_OPTIONS, playlistIcon, type CommentItem, type PlaylistIconKey } from './api'
import { Button, Icon, Loading, Modal, SafeImage } from './components'
import {
  selectLoveList,
  selectUserLists,
  useAuthStore,
  useCommentStore,
  useLibraryStore,
  usePlaybackStore,
  usePlayerUiStore,
} from './store'
import type { Song } from './types'
import { sameSong, songArtist, songImage, songTitle } from './types'
import { formatDate, safeImageUrl } from '../../../shared/src/runtime'

function CommentItemView({ item, nested = false }: { item: CommentItem; nested?: boolean }) {
  const replies = Array.isArray(item.reply) ? item.reply : []
  const timestamp = item.timeStr || (item.time ? formatDate(item.time) : '')
  return (
    <article className={`react-comment-item ${nested ? 'is-reply' : ''}`}>
      <img
        src={safeImageUrl(item.avatar)}
        width="40"
        height="40"
        loading="lazy"
        alt={`${String(item.userName || '用户')}的头像`}
      />
      <div>
        <header>
          <strong>{String(item.userName || '用户')}</strong>
          <small>{String(item.likedCount ?? 0)} 赞</small>
        </header>
        <p>{String(item.text || '')}</p>
        <footer>
          {String(timestamp)}
          {item.location ? ` · ${String(item.location)}` : ''}
        </footer>
        {replies.length > 0 && (
          <div className="react-comment-replies">
            {replies.map((reply, index) => (
              <CommentItemView key={`${String(reply.userName)}-${index}`} item={reply} nested />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export function CommentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = usePlaybackStore(state => state.currentSong)
  const type = useCommentStore(state => state.type)
  const page = useCommentStore(state => state.page)
  const total = useCommentStore(state => state.total)
  const maxPage = useCommentStore(state => state.maxPage)
  const items = useCommentStore(state => state.items)
  const loading = useCommentStore(state => state.loading)
  const error = useCommentStore(state => state.error)
  const load = useCommentStore(state => state.load)
  const setType = useCommentStore(state => state.setType)
  const next = useCommentStore(state => state.next)
  const previous = useCommentStore(state => state.previous)
  useEffect(() => {
    if (open) void load(song, type, 1)
  }, [load, open, song])
  return (
    <Modal
      open={open}
      title={song ? `${songTitle(song)} · 评论` : '评论'}
      onClose={onClose}
      className="react-comments-modal"
    >
      <div className="react-comments-dialog">
        <div className="react-comment-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={type === 'hot'}
            className={type === 'hot' ? 'is-active' : ''}
            onClick={() => setType('hot')}
          >
            热门
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={type === 'new'}
            className={type === 'new' ? 'is-active' : ''}
            onClick={() => setType('new')}
          >
            最新
          </button>
          <span>{total ? `${total} 条` : ''}</span>
        </div>
        {loading ? (
          <Loading label="正在加载评论…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : items.length ? (
          <div className="react-comment-list">
            {items.map((item, index) => (
              <CommentItemView key={`${String(item.userName)}-${String(item.time)}-${index}`} item={item} />
            ))}
          </div>
        ) : (
          <div className="react-empty">
            <Icon name="comments" />
            <p>暂无评论</p>
          </div>
        )}
        <nav className="react-comment-pagination" aria-label="评论分页">
          <button type="button" onClick={previous} disabled={loading || page <= 1}>
            上一页
          </button>
          <span>
            第 {page} / {maxPage} 页
          </span>
          <button type="button" onClick={next} disabled={loading || page >= maxPage}>
            下一页
          </button>
        </nav>
      </div>
    </Modal>
  )
}

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const login = useAuthStore(state => state.login)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await login(password)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    }
  }
  return (
    <Modal open={open} title="访问播放器" onClose={onClose}>
      <form className="react-dialog-form" onSubmit={submit}>
        <label htmlFor="player-password">访问密码</label>
        <input
          id="player-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          required
        />
        {error && (
          <p className="react-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit">
          进入播放器
        </Button>
      </form>
    </Modal>
  )
}

export function UserLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const userLogin = useAuthStore(state => state.userLogin)
  const pendingSong = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await userLogin(username, password)
      if (pendingSong) setDialog('addToList')
      else onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    }
  }
  return (
    <Modal open={open} title="登录用户账户" onClose={onClose}>
      <form className="react-dialog-form" onSubmit={submit}>
        <label htmlFor="user-name">用户名</label>
        <input
          id="user-name"
          autoComplete="username"
          value={username}
          onChange={event => setUsername(event.target.value)}
          required
        />
        <label htmlFor="user-password">密码</label>
        <input
          id="user-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          required
        />
        {error && (
          <p className="react-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit">
          登录
        </Button>
      </form>
    </Modal>
  )
}

export function CreateListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createList = useLibraryStore(state => state.createList)
  const notify = usePlayerUiStore(state => state.notify)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const pendingSong = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [name, setName] = useState('')
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [icon, setIcon] = useState<PlaylistIconKey>('music')
  useEffect(() => {
    if (open) {
      setName('')
      setIcon('music')
    }
  }, [open])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      const created = await createList(name.trim(), icon)
      setName('')
      setIcon('music')
      if (pendingSong) setDialog('addToList')
      else {
        onClose()
        openFavoriteList(String(created.id))
      }
      notify('歌单已创建')
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建歌单失败')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title="新建歌单" onClose={onClose}>
      <form className="react-dialog-form" onSubmit={submit}>
        <label htmlFor="new-list-name">歌单名称</label>
        <input
          id="new-list-name"
          value={name}
          onChange={event => setName(event.target.value)}
          required
          maxLength={80}
        />
        <fieldset className="react-playlist-icon-picker">
          <div className="react-playlist-icon-options" role="radiogroup" aria-label="选择歌单图标">
            {PLAYLIST_ICON_OPTIONS.map(option => (
              <label
                className={`react-playlist-icon-option ${icon === option.key ? 'is-selected' : ''}`}
                key={option.key}
              >
                <input
                  type="radio"
                  name="playlist-icon"
                  value={option.key}
                  aria-label={option.label}
                  checked={icon === option.key}
                  onChange={() => setIcon(option.key)}
                />
                <span className="react-playlist-icon-option-visual">
                  <Icon name={option.key} />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? '创建中…' : '创建'}
        </Button>
      </form>
    </Modal>
  )
}

export function AddToListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const loveSongs = useLibraryStore(selectLoveList)
  const userLists = useLibraryStore(selectUserLists)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const lists = useMemo(
    () => [
      { id: 'love', name: '我的收藏', icon: 'heart', songs: loveSongs },
      ...userLists.map(list => ({
        id: String(list.id),
        name: list.name,
        icon: playlistIcon(list.icon),
        songs: list.list ?? [],
      })),
    ],
    [loveSongs, userLists],
  )
  const toggleList = async (list: { id: string; name: string; songs: Song[] }) => {
    if (!song) return
    const included = list.songs.some(item => sameSong(item, song))
    try {
      if (included) {
        await removeSong(list.id, song)
        notify(`已从“${list.name}”移除`)
      } else {
        await addSong(list.id, song)
        notify(`已添加到“${list.name}”`)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '歌单操作失败')
    }
  }
  return (
    <Modal open={open} title="添加到歌单" onClose={onClose}>
      <div className="react-add-to-list-dialog">
        {song && (
          <p className="react-add-to-list-song">
            <SafeImage src={songImage(song)} width="44" height="44" alt="" />
            <span>
              <strong>{songTitle(song)}</strong>
              <small>{songArtist(song)}</small>
            </span>
          </p>
        )}
        <div className="react-add-to-list-options">
          {lists.map((list, index) => {
            const included = Boolean(song && list.songs.some(item => sameSong(item, song)))
            return (
              <button
                type="button"
                key={`${list.id}-${index}`}
                className={`react-add-to-list-option ${included ? 'is-included' : ''}`}
                aria-pressed={included}
                onClick={() => void toggleList(list)}
              >
                <span>
                  <Icon name={list.icon} />
                  <strong>{list.name}</strong>
                  <small>{list.songs.length} 首歌曲</small>
                </span>
                <Icon name={included ? 'check' : 'plus'} />
              </button>
            )
          })}
          <Button type="button" className="react-add-to-list-create" onClick={() => setDialog('createList')}>
            <Icon name="plus" />
            新建歌单
          </Button>
        </div>
        {!song && <p className="react-empty-text">当前没有正在播放的歌曲</p>}
      </div>
    </Modal>
  )
}
