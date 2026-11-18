import { useEffect, useRef, useState } from 'react'
import { adminApi, type StorageItem } from './api'
import { Button, ConfirmDialog, Empty, ErrorPanel, Icon, Loading, Panel, SelectMenu } from './components'
import { useAdminStore } from './store'
import { ViewFrame } from './view_frame'
import { formatBytes, formatDate, safeImageUrl } from '../../../shared/src/runtime'

type ConfirmRequest = { title: string; message: string; confirmLabel?: string; onConfirm: () => void | Promise<void> }

function storageItemKey(item: StorageItem): string {
  return `${String(item.rawUsername ?? '_open')}|${String(item.location ?? '')}|${String(item.folder ?? 'cache')}|${String(item.filename ?? item.id ?? item.name ?? '')}`
}

function storageCover(item: StorageItem): string {
  if (item.img) return safeImageUrl(item.img)
  const params = new URLSearchParams({
    filename: String(item.filename ?? ''),
    folder: String(item.folder ?? 'cache'),
    user: String(item.rawUsername ?? '_open'),
  })
  if (item.location === 'data' || item.location === 'root') params.set('location', item.location)
  return `/api/music/cache/cover?${params.toString()}`
}

function displayName(item: StorageItem): string {
  return String(item.name ?? item.filename ?? '未知歌曲')
}

function StorageSongRow({
  item,
  index,
  selected,
  playing,
  onSelect,
  onPreview,
  onMove,
  onDelete,
}: {
  item: StorageItem
  index: number
  selected: boolean
  playing: boolean
  onSelect: (checked: boolean) => void
  onPreview: () => void
  onMove: () => void
  onDelete: () => void
}) {
  const name = displayName(item)
  return (
    <tr className={playing ? 'is-playing' : ''}>
      <td className="admin-storage-check">
        <input
          type="checkbox"
          aria-label={`选择${name}`}
          checked={selected}
          onChange={event => onSelect(event.target.checked)}
        />
      </td>
      <td className="admin-storage-index">{String(index + 1).padStart(2, '0')}</td>
      <th scope="row" className="admin-data-song-cell">
        <div className="admin-data-song-content">
          <img src={storageCover(item)} width="44" height="44" loading="lazy" decoding="async" alt="" />
          <span>
            <strong>{name}</strong>
            <small>{String(item.singer ?? '未知歌手')}</small>
          </span>
        </div>
      </th>
      <td>{String(item.source ?? '—')}</td>
      <td>{formatBytes(item.size)}</td>
      <td>{String(item.username ?? item.rawUsername ?? '公共空间')}</td>
      <td>{formatDate(item.mtime)}</td>
      <td>
        <div className="admin-react-row-actions">
          <Button
            className="admin-react-button-compact"
            aria-label={playing ? `暂停试听${name}` : `试听${name}`}
            onClick={onPreview}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </Button>
          <Button
            className="admin-react-button-compact"
            aria-label={item.folder === 'cache' ? '转为下载音乐' : '转为缓存音乐'}
            onClick={onMove}
          >
            <Icon name="right-left" />
          </Button>
          <Button className="admin-react-button-compact" variant="danger" aria-label={`删除${name}`} onClick={onDelete}>
            <Icon name="trash" />
          </Button>
        </div>
      </td>
    </tr>
  )
}

export function StorageView() {
  const users = useAdminStore(state => state.users)
  const selectedUser = useAdminStore(state => state.selectedUser)
  const setSelectedUser = useAdminStore(state => state.setSelectedUser)
  const storageQuery = useAdminStore(state => state.storageQuery)
  const setStorageQuery = useAdminStore(state => state.setStorageQuery)
  const { folder, sort } = storageQuery
  const storage = useAdminStore(state => state.storage)
  const busy = useAdminStore(state => state.busy)
  const error = useAdminStore(state => state.error)
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [query, setQuery] = useState(storageQuery.query)
  const [selected, setSelected] = useState<Map<string, StorageItem>>(() => new Map())
  const [playingKey, setPlayingKey] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.addEventListener('ended', () => setPlayingKey(''))
    audio.addEventListener('error', () => setPlayingKey(''))
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
    }
  }, [])

  const pageItems = storage?.data ?? []
  const selectedItems = [...selected.values()]
  const selectedOnPage = pageItems.filter(item => selected.has(storageItemKey(item))).length
  const allSelected = pageItems.length > 0 && selectedOnPage === pageItems.length
  const pageIndex = storage?.page ?? 0
  const pageSize = storage?.pageSize ?? 100
  const pageCount = Math.max(1, Math.ceil((storage?.filtered ?? 0) / pageSize))

  useEffect(() => {
    const needle = query.trim()
    if (needle === storageQuery.query) return
    const timer = setTimeout(() => setStorageQuery({ query: needle, page: 0 }), 180)
    return () => clearTimeout(timer)
  }, [query, setStorageQuery, storageQuery.query])

  const remove = async (items: StorageItem[]) => {
    if (!items.length) return
    try {
      const result = await adminApi.removeCache(
        items
          .map(item => ({
            filename: String(item.filename ?? ''),
            folder: item.folder,
            location: item.location,
            user: String(item.rawUsername ?? '_open'),
          }))
          .filter(item => item.filename),
      )
      setSelected(new Map())
      notify(`已删除 ${result.deletedCount} 个文件${result.failedCount ? `，${result.failedCount} 个失败` : ''}`)
      await loadView('storage')
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除失败')
    }
  }

  const move = async (items: StorageItem[]) => {
    if (!items.length) return
    try {
      const result = await adminApi.moveCache(
        items
          .map(item => ({
            filename: String(item.filename ?? ''),
            location: item.location,
            user: String(item.rawUsername ?? '_open'),
          }))
          .filter(item => item.filename),
        folder === 'cache' ? 'music' : 'cache',
      )
      setSelected(new Map())
      notify(`已移动 ${result.successCount} 个文件${result.failCount ? `，${result.failCount} 个失败` : ''}`)
      await loadView('storage')
    } catch (error) {
      notify(error instanceof Error ? error.message : '移动失败')
    }
  }

  const clear = async () => {
    try {
      await adminApi.clearCache(selectedUser || 'all')
      setSelected(new Map())
      notify('缓存已清空')
      await loadView('storage')
    } catch (error) {
      notify(error instanceof Error ? error.message : '清空失败')
    }
  }

  const requestRemove = (items: StorageItem[]) => {
    if (items.length)
      setConfirmation({
        title: '删除文件',
        message: `确定删除 ${items.length} 个${folder === 'music' ? '下载' : '缓存'}文件吗？此操作不可恢复。`,
        confirmLabel: '删除',
        onConfirm: () => remove(items),
      })
  }
  const requestMove = (items: StorageItem[]) => {
    if (items.length)
      setConfirmation({
        title: '移动文件',
        message: `确定将 ${items.length} 个文件移至${folder === 'cache' ? '下载音乐' : '缓存音乐'}吗？`,
        confirmLabel: '移动',
        onConfirm: () => move(items),
      })
  }
  const requestClear = () =>
    setConfirmation({
      title: '清空缓存',
      message: `确定清空${selectedUser ? `用户“${selectedUser}”的` : '所有'}缓存吗？下载音乐不会受到影响。`,
      confirmLabel: '清空缓存',
      onConfirm: clear,
    })

  const preview = (item: StorageItem) => {
    const audio = audioRef.current
    if (!audio) return
    const key = storageItemKey(item)
    if (playingKey === key && !audio.paused) {
      audio.pause()
      setPlayingKey('')
      return
    }
    const params = new URLSearchParams({ folder: String(item.folder ?? 'cache') })
    if (item.location === 'data' || item.location === 'root') params.set('location', item.location)
    audio.src = `/api/music/cache/file/${encodeURIComponent(String(item.rawUsername ?? '_open'))}/${encodeURIComponent(String(item.filename ?? ''))}?${params.toString()}`
    void audio
      .play()
      .then(() => setPlayingKey(key))
      .catch(() => {
        setPlayingKey('')
        notify('试听播放失败')
      })
  }

  return (
    <ViewFrame>
      <ErrorPanel message={error} onRetry={() => void loadView('storage')} />
      <Panel
        className="admin-storage-panel"
        title="文件存储"
        actions={
          <div className="admin-react-toolbar">
            <label className="admin-react-inline-label">
              用户
              <SelectMenu
                label="存储用户"
                value={selectedUser}
                options={[
                  { value: '', label: '全部用户' },
                  { value: '_open', label: '公开空间' },
                  ...users.filter(user => user.name !== '_open').map(user => ({ value: user.name, label: user.name })),
                ]}
                onChange={value => {
                  setSelected(new Map())
                  setSelectedUser(value)
                }}
              />
            </label>
            <Button onClick={() => void loadView('storage')} disabled={busy}>
              <Icon name="rotate" />
              刷新
            </Button>
          </div>
        }
      >
        <div className="admin-storage-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={folder === 'cache'}
            className={folder === 'cache' ? 'is-active' : ''}
            onClick={() => {
              if (folder === 'cache') return
              setSelected(new Map())
              setStorageQuery({ folder: 'cache', page: 0 })
            }}
          >
            服务端缓存
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={folder === 'music'}
            className={folder === 'music' ? 'is-active' : ''}
            onClick={() => {
              if (folder === 'music') return
              setSelected(new Map())
              setStorageQuery({ folder: 'music', page: 0 })
            }}
          >
            下载音乐
          </button>
        </div>
        <div className="admin-storage-toolbar">
          <div className="admin-data-search">
            <Icon name="magnifying-glass" />
            <input
              aria-label="搜索存储歌曲"
              value={query}
              onChange={event => {
                setSelected(new Map())
                setQuery(event.target.value)
              }}
              placeholder="搜索歌曲、歌手或文件名"
              maxLength={256}
            />
          </div>
          <SelectMenu
            label="存储排序"
            value={sort}
            options={[
              { value: 'default', label: '默认顺序' },
              { value: 'name-asc', label: '名称 A-Z' },
              { value: 'name-desc', label: '名称 Z-A' },
              { value: 'size-desc', label: '文件最大' },
              { value: 'time-desc', label: '最近更新' },
            ]}
            onChange={value => {
              setSelected(new Map())
              setStorageQuery({ sort: value, page: 0 })
            }}
          />
        </div>
        <div className="admin-storage-summary">
          <span>{folder === 'cache' ? '服务端缓存' : '下载音乐'}</span>
          <strong>{storage?.total ?? 0} 首</strong>
          <small>
            占用 {formatBytes(storage?.size ?? 0)}
            {storageQuery.query && storage ? ` · 筛选后 ${storage.filtered} 首` : ''}
          </small>
        </div>
        <div className="admin-react-batch-bar">
          <label>
            <input
              type="checkbox"
              checked={allSelected}
              ref={element => {
                if (element) element.indeterminate = selectedOnPage > 0 && !allSelected
              }}
              disabled={!pageItems.length || busy}
              onChange={event => {
                const checked = event.target.checked
                setSelected(current => {
                  const next = new Map(current)
                  for (const item of pageItems) {
                    const key = storageItemKey(item)
                    if (checked) next.set(key, item)
                    else next.delete(key)
                  }
                  return next
                })
              }}
            />
            全选本页
          </label>
          <span>已选择 {selectedItems.length} 项</span>
          <Button disabled={!selectedItems.length || busy} onClick={() => requestMove(selectedItems)}>
            <Icon name="right-left" />
            {folder === 'cache' ? '转为下载' : '转为缓存'}
          </Button>
          <Button
            variant="danger"
            disabled={!selectedItems.length || busy}
            onClick={() => requestRemove(selectedItems)}
          >
            <Icon name="trash" />
            删除所选
          </Button>
          {folder === 'cache' && (
            <Button variant="danger" onClick={requestClear}>
              清空缓存
            </Button>
          )}
        </div>
        {busy && !storage ? (
          <Loading label="正在读取存储文件…" />
        ) : pageItems.length ? (
          <div className="admin-react-table-wrap admin-storage-table-wrap">
            <table className="admin-react-table admin-storage-table">
              <caption className="sr-only">{folder === 'cache' ? '服务端缓存' : '下载音乐'}列表</caption>
              <thead>
                <tr>
                  <th scope="col">选</th>
                  <th scope="col">#</th>
                  <th scope="col">歌曲 / 歌手</th>
                  <th scope="col">来源</th>
                  <th scope="col">大小</th>
                  <th scope="col">所属用户</th>
                  <th scope="col">更新时间</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((item, offset) => {
                  const index = pageIndex * pageSize + offset
                  const key = storageItemKey(item)
                  return (
                    <StorageSongRow
                      key={key}
                      item={item}
                      index={index}
                      selected={selected.has(key)}
                      playing={playingKey === key}
                      onSelect={checked =>
                        setSelected(current => {
                          const next = new Map(current)
                          if (checked) next.set(key, item)
                          else next.delete(key)
                          return next
                        })
                      }
                      onPreview={() => preview(item)}
                      onMove={() => requestMove([item])}
                      onDelete={() => requestRemove([item])}
                    />
                  )
                })}
              </tbody>
            </table>
            {pageCount > 1 && (
              <nav className="admin-react-toolbar admin-storage-pagination" aria-label="存储列表分页">
                <Button
                  disabled={busy || pageIndex === 0}
                  onClick={() => {
                    setStorageQuery({ page: pageIndex - 1 })
                  }}
                >
                  上一页
                </Button>
                <span aria-live="polite">
                  第 {pageIndex + 1} / {pageCount} 页
                </span>
                <Button
                  disabled={busy || pageIndex + 1 >= pageCount}
                  onClick={() => {
                    setStorageQuery({ page: pageIndex + 1 })
                  }}
                >
                  下一页
                </Button>
              </nav>
            )}
          </div>
        ) : (
          <Empty label={query ? '没有匹配的存储文件' : `当前${folder === 'cache' ? '缓存' : '下载'}目录暂无文件`} />
        )}
      </Panel>
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.title ?? ''}
        message={confirmation?.message ?? ''}
        confirmLabel={confirmation?.confirmLabel}
        onClose={() => setConfirmation(null)}
        onConfirm={() => confirmation?.onConfirm()}
      />
    </ViewFrame>
  )
}
