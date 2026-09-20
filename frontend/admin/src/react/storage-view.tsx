import { useEffect, useMemo, useRef, useState } from 'react'
import { adminApi, type StorageItem } from './api'
import { Button, ConfirmDialog, Empty, ErrorPanel, Icon, Loading, Panel, SelectMenu } from './components'
import { useAdminStore } from './store'
import { formatBytes, formatDate, safeImageUrl } from '../../../shared/src/runtime'

type ConfirmRequest = { title: string; message: string; confirmLabel?: string; onConfirm: () => void | Promise<void> }
type SortMode = 'default' | 'name-asc' | 'name-desc' | 'size-desc' | 'time-desc'

function storageItemKey(item: StorageItem): string {
  return `${String(item.rawUsername ?? '_open')}|${String(item.folder ?? 'cache')}|${String(item.filename ?? item.id ?? item.name ?? '')}`
}

function storageCover(item: StorageItem): string {
  if (item.img) return safeImageUrl(item.img)
  return `/api/music/cache/cover?filename=${encodeURIComponent(String(item.filename ?? ''))}&folder=${encodeURIComponent(String(item.folder ?? 'cache'))}&user=${encodeURIComponent(String(item.rawUsername ?? '_open'))}`
}

function displayName(item: StorageItem): string {
  return String(item.name ?? item.filename ?? '未知歌曲')
}

function StorageSongRow({ item, index, selected, playing, onSelect, onPreview, onMove, onDelete }: { item: StorageItem; index: number; selected: boolean; playing: boolean; onSelect: (checked: boolean) => void; onPreview: () => void; onMove: () => void; onDelete: () => void }) {
  const name = displayName(item)
  return <tr className={playing ? 'is-playing' : ''}>
    <td className="admin-storage-check"><input type="checkbox" aria-label={`选择${name}`} checked={selected} onChange={event => onSelect(event.target.checked)} /></td>
    <td className="admin-storage-index">{String(index + 1).padStart(2, '0')}</td>
    <th scope="row" className="admin-data-song-cell"><img src={storageCover(item)} width="44" height="44" loading="lazy" decoding="async" alt="" /><span><strong title={name}>{name}</strong><small title={String(item.singer ?? '未知歌手')}>{String(item.singer ?? '未知歌手')}</small></span></th>
    <td>{String(item.source ?? '—')}</td>
    <td>{formatBytes(item.size)}</td>
    <td>{String(item.username ?? item.rawUsername ?? '公共空间')}</td>
    <td>{formatDate(item.mtime)}</td>
    <td className="admin-react-row-actions"><Button className="admin-react-button-compact" aria-label={playing ? `暂停试听${name}` : `试听${name}`} title={playing ? '暂停试听' : '试听'} onClick={onPreview}><Icon name={playing ? 'pause' : 'play'} /></Button><Button className="admin-react-button-compact" aria-label="移动文件" title={item.folder === 'cache' ? '转为下载音乐' : '转为缓存音乐'} onClick={onMove}><Icon name="right-left" /></Button><Button className="admin-react-button-compact" variant="danger" aria-label={`删除${name}`} title="删除" onClick={onDelete}><Icon name="trash" /></Button></td>
  </tr>
}

export function StorageView() {
  const users = useAdminStore(state => state.users)
  const selectedUser = useAdminStore(state => state.selectedUser)
  const setSelectedUser = useAdminStore(state => state.setSelectedUser)
  const folder = useAdminStore(state => state.storageFolder)
  const setStorageFolder = useAdminStore(state => state.setStorageFolder)
  const storage = useAdminStore(state => state.storage)
  const busy = useAdminStore(state => state.busy)
  const error = useAdminStore(state => state.error)
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('default')
  const [selected, setSelected] = useState<string[]>([])
  const [playingKey, setPlayingKey] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.addEventListener('ended', () => setPlayingKey(''))
    audio.addEventListener('error', () => setPlayingKey(''))
    audioRef.current = audio
    return () => { audio.pause(); audio.removeAttribute('src'); audio.load(); audioRef.current = null }
  }, [])

  const currentItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const result = storage.filter(item => item.folder === folder && (!needle || [item.name, item.singer, item.filename, item.source].some(value => String(value ?? '').toLocaleLowerCase().includes(needle))))
    if (sort === 'default') return result
    return [...result].sort((a, b) => {
      if (sort === 'size-desc') return Number(b.size ?? 0) - Number(a.size ?? 0)
      if (sort === 'time-desc') return Number(b.mtime ?? 0) - Number(a.mtime ?? 0)
      const direction = sort.endsWith('-desc') ? -1 : 1
      return displayName(a).localeCompare(displayName(b), 'zh-CN') * direction
    })
  }, [folder, query, sort, storage])
  const currentKeys = currentItems.map(storageItemKey)
  const selectedCurrent = selected.filter(key => currentKeys.includes(key))
  const allSelected = currentItems.length > 0 && currentItems.every(item => selected.includes(storageItemKey(item)))
  const summaryCount = storage.filter(item => item.folder === folder).length
  const summarySize = storage.filter(item => item.folder === folder).reduce((total, item) => total + Number(item.size ?? 0), 0)

  const remove = async (items: StorageItem[]) => {
    if (!items.length) return
    try {
      await adminApi.removeCache(items.map(item => ({ filename: String(item.filename ?? ''), folder: item.folder, user: String(item.rawUsername ?? '_open') })).filter(item => item.filename))
      setSelected([])
      notify(`已删除 ${items.length} 个文件`)
      await loadView('storage')
    } catch (error) { notify(error instanceof Error ? error.message : '删除失败') }
  }

  const move = async (items: StorageItem[]) => {
    if (!items.length) return
    try {
      await adminApi.moveCache(items.map(item => ({ filename: String(item.filename ?? ''), user: String(item.rawUsername ?? '_open') })).filter(item => item.filename))
      setSelected([])
      notify(`已移动 ${items.length} 个文件`)
      await loadView('storage')
    } catch (error) { notify(error instanceof Error ? error.message : '移动失败') }
  }

  const clear = async () => {
    try { await adminApi.clearCache(selectedUser || 'all'); setSelected([]); notify('缓存已清空'); await loadView('storage') } catch (error) { notify(error instanceof Error ? error.message : '清空失败') }
  }

  const requestRemove = (items: StorageItem[]) => { if (items.length) setConfirmation({ title: '删除文件', message: `确定删除 ${items.length} 个${folder === 'music' ? '下载' : '缓存'}文件吗？此操作不可恢复。`, confirmLabel: '删除', onConfirm: () => remove(items) }) }
  const requestMove = (items: StorageItem[]) => { if (items.length) setConfirmation({ title: '移动文件', message: `确定将 ${items.length} 个文件移至${folder === 'cache' ? '下载音乐' : '缓存音乐'}吗？`, confirmLabel: '移动', onConfirm: () => move(items) }) }
  const requestClear = () => setConfirmation({ title: '清空缓存', message: `确定清空${selectedUser ? `用户“${selectedUser}”的` : '所有'}缓存吗？下载音乐不会受到影响。`, confirmLabel: '清空缓存', onConfirm: clear })

  const preview = (item: StorageItem) => {
    const audio = audioRef.current
    if (!audio) return
    const key = storageItemKey(item)
    if (playingKey === key && !audio.paused) { audio.pause(); setPlayingKey(''); return }
    audio.src = `/api/music/cache/file/${encodeURIComponent(String(item.rawUsername ?? '_open'))}/${encodeURIComponent(String(item.filename ?? ''))}?folder=${encodeURIComponent(String(item.folder ?? 'cache'))}`
    void audio.play().then(() => setPlayingKey(key)).catch(() => { setPlayingKey(''); notify('试听播放失败') })
  }

  return <ViewFrame title="存储管理" subtitle="查看缓存与下载音乐，执行安全清理"><ErrorPanel message={error} onRetry={() => void loadView('storage')} />
    <Panel title="文件存储" actions={<div className="admin-react-toolbar"><label className="admin-react-inline-label">用户<SelectMenu label="存储用户" value={selectedUser} options={[{ value: '', label: '全部用户' }, { value: '_open', label: '公开空间' }, ...users.filter(user => user.name !== '_open').map(user => ({ value: user.name, label: user.name }))]} onChange={setSelectedUser} /></label><Button onClick={() => void loadView('storage')} disabled={busy}><Icon name="rotate" />刷新</Button></div>}>
      <div className="admin-storage-tabs" role="tablist"><button type="button" role="tab" aria-selected={folder === 'cache'} className={folder === 'cache' ? 'is-active' : ''} onClick={() => setStorageFolder('cache')}>服务端缓存</button><button type="button" role="tab" aria-selected={folder === 'music'} className={folder === 'music' ? 'is-active' : ''} onClick={() => setStorageFolder('music')}>下载音乐</button></div>
      <div className="admin-storage-toolbar"><div className="admin-data-search"><Icon name="magnifying-glass" /><input aria-label="搜索存储歌曲" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索歌曲、歌手或文件名" /></div><SelectMenu label="存储排序" value={sort} options={[{ value: 'default', label: '默认顺序' }, { value: 'name-asc', label: '名称 A-Z' }, { value: 'name-desc', label: '名称 Z-A' }, { value: 'size-desc', label: '文件最大' }, { value: 'time-desc', label: '最近更新' }]} onChange={value => setSort(value as SortMode)} /></div>
      <div className="admin-storage-summary"><span>{folder === 'cache' ? '服务端缓存' : '下载音乐'}</span><strong>{summaryCount} 首</strong><small>占用 {formatBytes(summarySize)}{query ? ` · 当前显示 ${currentItems.length} 首` : ''}</small></div>
      <div className="admin-react-batch-bar"><label><input type="checkbox" checked={allSelected} ref={element => { if (element) element.indeterminate = selectedCurrent.length > 0 && !allSelected }} onChange={event => setSelected(event.target.checked ? [...new Set([...selected, ...currentKeys])] : selected.filter(key => !currentKeys.includes(key)))} />全选</label><span>已选择 {selectedCurrent.length} 项</span><Button disabled={!selectedCurrent.length} onClick={() => requestMove(currentItems.filter(item => selectedCurrent.includes(storageItemKey(item))))}><Icon name="right-left" />{folder === 'cache' ? '转为下载' : '转为缓存'}</Button><Button variant="danger" disabled={!selectedCurrent.length} onClick={() => requestRemove(currentItems.filter(item => selectedCurrent.includes(storageItemKey(item))))}><Icon name="trash" />删除所选</Button>{folder === 'cache' && <Button variant="danger" onClick={requestClear}>清空缓存</Button>}</div>
      {busy && !storage.length ? <Loading label="正在读取存储文件…" /> : currentItems.length ? <div className="admin-react-table-wrap admin-storage-table-wrap"><table className="admin-react-table admin-storage-table"><caption className="sr-only">{folder === 'cache' ? '服务端缓存' : '下载音乐'}列表</caption><thead><tr><th scope="col">选</th><th scope="col">#</th><th scope="col">歌曲 / 歌手</th><th scope="col">来源</th><th scope="col">大小</th><th scope="col">所属用户</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead><tbody>{currentItems.map((item, index) => { const key = storageItemKey(item); return <StorageSongRow key={key} item={item} index={index} selected={selected.includes(key)} playing={playingKey === key} onSelect={checked => setSelected(current => checked ? [...new Set([...current, key])] : current.filter(itemKey => itemKey !== key))} onPreview={() => preview(item)} onMove={() => requestMove([item])} onDelete={() => requestRemove([item])} /> })}</tbody></table></div> : <Empty label={query ? '没有匹配的存储文件' : `当前${folder === 'cache' ? '缓存' : '下载'}目录暂无文件`} />}
    </Panel><ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} /></ViewFrame>
}

function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section className="view active admin-react-view"><header className="view-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}
