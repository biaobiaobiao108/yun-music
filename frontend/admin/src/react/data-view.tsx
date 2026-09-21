import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { adminApi, adminSongId, type AdminData, type AdminPlaylist, type AdminSong } from './api'
import { Button, ConfirmDialog, Empty, ErrorPanel, Icon, Loading, Modal, Panel, SelectMenu } from './components'
import { useAdminStore } from './store'
import { formatBytes, formatDuration, parseByteSize, safeImageUrl } from '../../../shared/src/runtime'

type ListKind = 'all' | 'default' | 'love' | 'user'

type DataList = {
  id: string
  name: string
  kind: ListKind
  songs: AdminSong[]
  count: number
}

type SongRow = {
  key: string
  song: AdminSong
  index: number
  sourceName: string
  sourceId: string
}

type ConfirmRequest = { title: string; message: string; confirmLabel?: string; onConfirm: () => void | Promise<void> }

function textOf(value: unknown, fallback = '—'): string {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text || fallback
}

function songTitle(song: AdminSong): string {
  const meta = song.meta
  const nested = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const songInfo = nested(song.songInfo)
  const info = nested(song.info)
  const data = nested(song.data)
  return textOf(song.name ?? song.title ?? song.songName ?? meta?.name ?? meta?.title ?? songInfo?.name ?? songInfo?.title ?? info?.name ?? info?.title ?? data?.name ?? data?.title, '未知歌曲')
}

function songSinger(song: AdminSong): string {
  const meta = song.meta
  const nested = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const songInfo = nested(song.songInfo)
  const info = nested(song.info)
  const data = nested(song.data)
  return textOf(song.singer ?? song.artist ?? song.artistName ?? meta?.singer ?? meta?.singerName ?? meta?.artist ?? songInfo?.singer ?? songInfo?.artist ?? info?.singer ?? info?.artist ?? data?.singer ?? data?.artist, '未知歌手')
}

function songAlbum(song: AdminSong): string {
  const album = song.album
  const albumRecord = album && typeof album === 'object' ? album as Record<string, unknown> : undefined
  const metaAlbum = song.meta?.album && typeof song.meta.album === 'object' ? song.meta.album as Record<string, unknown> : undefined
  const songInfo = song.songInfo && typeof song.songInfo === 'object' ? song.songInfo as Record<string, unknown> : undefined
  const info = song.info && typeof song.info === 'object' ? song.info as Record<string, unknown> : undefined
  const data = song.data && typeof song.data === 'object' ? song.data as Record<string, unknown> : undefined
  const songInfoAlbum = songInfo?.album && typeof songInfo.album === 'object' ? songInfo.album as Record<string, unknown> : undefined
  const infoAlbum = info?.album && typeof info.album === 'object' ? info.album as Record<string, unknown> : undefined
  const dataAlbum = data?.album && typeof data.album === 'object' ? data.album as Record<string, unknown> : undefined
  const metadata = song.metadata && typeof song.metadata === 'object' ? song.metadata as Record<string, unknown> : undefined
  const songInfoMeta = songInfo?.meta && typeof songInfo.meta === 'object' ? songInfo.meta as Record<string, unknown> : undefined
  const infoMeta = info?.meta && typeof info.meta === 'object' ? info.meta as Record<string, unknown> : undefined
  const dataMeta = data?.meta && typeof data.meta === 'object' ? data.meta as Record<string, unknown> : undefined
  return textOf(song.albumName ?? (typeof album === 'string' ? album : undefined) ?? song.albumname ?? song.albumTitle ?? albumRecord?.name ?? albumRecord?.title ?? albumRecord?.albumName ?? song.meta?.albumName ?? metaAlbum?.name ?? metaAlbum?.title ?? songInfo?.albumName ?? songInfo?.albumTitle ?? songInfoAlbum?.name ?? songInfoAlbum?.title ?? info?.albumName ?? infoAlbum?.name ?? infoAlbum?.title ?? data?.albumName ?? dataAlbum?.name ?? dataAlbum?.title ?? metadata?.albumName ?? (metadata?.album as Record<string, unknown> | undefined)?.name ?? (metadata?.album as Record<string, unknown> | undefined)?.title ?? songInfoMeta?.albumName ?? infoMeta?.albumName ?? dataMeta?.albumName)
}

function songCover(song: AdminSong): string {
  const nested = (...values: unknown[]) => values.map(value => value && typeof value === 'object' ? value as Record<string, unknown> : undefined).flatMap(value => value ? [value.img, value.picUrl, value.pic, value.cover, value.coverUrl, value.image] : [])
  return safeImageUrl(song.img ?? song.picUrl ?? song.meta?.picUrl ?? song.meta?.img ?? song.meta?.pic ?? song.meta?.cover ?? nested(song.songInfo, song.info, song.data, song.metadata)[0])
}

function songSize(song: AdminSong): string {
  const songInfo = song.songInfo && typeof song.songInfo === 'object' ? song.songInfo as Record<string, unknown> : undefined
  const info = song.info && typeof song.info === 'object' ? song.info as Record<string, unknown> : undefined
  const data = song.data && typeof song.data === 'object' ? song.data as Record<string, unknown> : undefined
  const value = song.size ?? song.fileSize ?? song.sizeBytes ?? song.meta?.size ?? song.meta?.fileSize ?? song.meta?.sizeBytes ?? songInfo?.size ?? songInfo?.fileSize ?? songInfo?.sizeBytes ?? info?.size ?? info?.fileSize ?? info?.sizeBytes ?? data?.size ?? data?.fileSize ?? data?.sizeBytes ?? qualitySize(song, song.quality ?? song.meta?.quality)
  const bytes = parseByteSize(value)
  return bytes === undefined ? '—' : formatBytes(bytes)
}

function qualitySize(song: AdminSong, preferredQuality: unknown): unknown {
  const record = song as Record<string, unknown>
  const preferred = String(preferredQuality ?? '').trim()
  for (const candidate of [record.qualitys, record._qualitys, record.qualities, record.quality, song.meta?.qualitys, song.meta?._qualitys]) {
    if (Array.isArray(candidate)) {
      const entries = candidate.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
      const entry = entries.find(item => String(item.type ?? item.quality ?? item.name ?? '').trim() === preferred) ?? entries[0]
      const size = entry?.size ?? entry?.fileSize ?? entry?.sizeBytes ?? entry?.bytes
      if (size !== undefined && size !== null && size !== '') return size
    } else if (candidate && typeof candidate === 'object') {
      const table = candidate as Record<string, unknown>
      const preferredEntry = preferred && table[preferred] && typeof table[preferred] === 'object' ? table[preferred] as Record<string, unknown> : null
      const directSize = preferredEntry?.size ?? preferredEntry?.fileSize ?? preferredEntry?.sizeBytes ?? preferredEntry?.bytes
      if (directSize !== undefined && directSize !== null && directSize !== '') return directSize
      for (const item of Object.values(table)) {
        if (!item || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        const size = entry.size ?? entry.fileSize ?? entry.sizeBytes ?? entry.bytes
        if (size !== undefined && size !== null && size !== '') return size
      }
    }
  }
  return undefined
}

function songFormat(song: AdminSong): string {
  const nested = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const songInfo = nested(song.songInfo)
  const info = nested(song.info)
  const data = nested(song.data)
  return textOf(song.format ?? song.type ?? song.ext ?? song.quality ?? song.meta?.format ?? song.meta?.type ?? song.meta?.ext ?? song.meta?.quality ?? songInfo?.format ?? songInfo?.type ?? songInfo?.ext ?? songInfo?.quality ?? info?.format ?? info?.type ?? info?.ext ?? info?.quality ?? data?.format ?? data?.type ?? data?.ext ?? data?.quality, '—').toUpperCase()
}

function songDuration(song: AdminSong): string {
  const songInfo = song.songInfo && typeof song.songInfo === 'object' ? song.songInfo as Record<string, unknown> : undefined
  const info = song.info && typeof song.info === 'object' ? song.info as Record<string, unknown> : undefined
  const data = song.data && typeof song.data === 'object' ? song.data as Record<string, unknown> : undefined
  const value = song.interval ?? song.duration ?? song.durationMs ?? song.meta?.interval ?? song.meta?.duration ?? song.meta?.durationMs ?? songInfo?.interval ?? songInfo?.duration ?? info?.interval ?? info?.duration ?? data?.interval ?? data?.duration
  if (typeof value === 'string' && /^\d{1,3}:\d{2}(?::\d{2})?$/.test(value.trim())) return value.trim()
  return formatDuration(value)
}

function listFromData(data: AdminData | null): DataList[] {
  if (!data) return []
  const defaultList = data.defaultList ?? []
  const loveList = data.loveList ?? []
  const customLists = data.userList ?? []
  const allSongs = [
    ...defaultList,
    ...loveList,
    ...customLists.flatMap(list => list.list ?? []),
  ]
  return [
    { id: 'all', name: '全部歌曲', kind: 'all', songs: allSongs, count: allSongs.length },
    { id: 'love', name: '我的收藏', kind: 'love', songs: loveList, count: loveList.length },
    { id: 'default', name: '试听列表', kind: 'default', songs: defaultList, count: defaultList.length },
    ...customLists.map(list => ({ id: String(list.id), name: list.name, kind: 'user' as const, songs: list.list ?? [], count: (list.list ?? []).length })),
  ]
}

function rowsForList(list: DataList): SongRow[] {
  if (list.kind !== 'all') {
    return list.songs.map((song, index) => ({
      key: `${list.id}:${adminSongId(song, String(index))}:${index}`,
      song,
      index,
      sourceName: list.name,
      sourceId: list.id,
    }))
  }
  return list.songs.map((song, index) => ({
    key: `all:${adminSongId(song, String(index))}:${index}`,
    song,
    index,
    sourceName: textOf(song._sourceListName, '歌曲数据'),
    sourceId: textOf(song._sourceListId, 'all'),
  }))
}

function allRows(data: AdminData | null): SongRow[] {
  if (!data) return []
  const rows: SongRow[] = []
  const append = (songs: AdminSong[] | undefined, sourceId: string, sourceName: string) => {
    for (const [index, song] of (songs ?? []).entries()) {
      rows.push({ key: `all:${sourceId}:${adminSongId(song, String(index))}:${index}`, song, index, sourceName, sourceId })
    }
  }
  append(data.defaultList, 'default', '试听列表')
  append(data.loveList, 'love', '我的收藏')
  for (const list of data.userList ?? []) append(list.list, String(list.id), list.name)
  return rows
}

function DataSongRow({ row, position, selected, canDelete, onSelect, onDelete }: { row: SongRow; position: number; selected: boolean; canDelete: boolean; onSelect: (checked: boolean) => void; onDelete: () => void }) {
  const song = row.song
  const title = songTitle(song)
  const singer = songSinger(song)
  return <tr className="admin-data-song-row">
    <td className="admin-data-check-cell">{canDelete && <input type="checkbox" aria-label={`选择 ${title}`} checked={selected} onChange={event => onSelect(event.target.checked)} />}</td>
    <td className="admin-data-index-cell">{String(position + 1).padStart(2, '0')}</td>
    <th scope="row" className="admin-data-song-cell"><div className="admin-data-song-content"><img src={songCover(song)} width="44" height="44" loading="lazy" decoding="async" alt="" /><span><strong title={title}>{title}</strong><small title={singer}>{singer}</small></span></div></th>
    <td className="admin-data-album-cell" title={songAlbum(song)}>{songAlbum(song)}</td>
    <td className="admin-data-source-cell" title={row.sourceName}>{row.sourceName}</td>
    <td className="admin-data-meta-cell">{songDuration(song)}</td>
    <td className="admin-data-meta-cell">{songSize(song)}</td>
    <td className="admin-data-meta-cell">{songFormat(song)}</td>
    <td className="admin-react-row-actions">{canDelete && <Button className="admin-react-button-compact" variant="danger" aria-label={`从${row.sourceName}删除${title}`} title="从列表删除" onClick={onDelete}><Icon name="trash" /></Button>}</td>
  </tr>
}

function DataListNavigation({ lists, activeId, onChange }: { lists: DataList[]; activeId: string; onChange: (id: string) => void }) {
  return <aside className="admin-data-nav" aria-label="数据列表">
    <div className="admin-data-nav-heading"><span>列表</span><small>{lists.length} 个</small></div>
    <div className="admin-data-nav-items">
      {lists.map((list, index) => <button type="button" key={`${list.id}-${index}`} className={`admin-data-nav-item ${activeId === list.id ? 'is-active' : ''}`} aria-current={activeId === list.id ? 'page' : undefined} onClick={() => onChange(list.id)}><span className="admin-data-nav-icon"><Icon name={list.kind === 'love' ? 'heart' : list.kind === 'user' ? 'list-music' : list.kind === 'default' ? 'clock-rotate-left' : 'music'} /></span><span className="admin-data-nav-copy"><strong>{list.name}</strong><small>{list.count} 首歌曲</small></span></button>)}
    </div>
  </aside>
}

function RenamePlaylistDialog({ open, playlist, username, onClose, onSaved }: { open: boolean; playlist: AdminPlaylist | null; username: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const notify = useAdminStore(state => state.notify)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setName(playlist?.name ?? '') }, [playlist, open])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!playlist || !name.trim()) return
    setBusy(true)
    try {
      await adminApi.renamePlaylist(username, playlist.id, name.trim())
      notify('歌单已重命名')
      onClose()
      await onSaved()
    } catch (error) {
      notify(error instanceof Error ? error.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }
  return <Modal open={open} title="重命名歌单" onClose={onClose}><form className="admin-react-form" onSubmit={submit}><label htmlFor="admin-playlist-name">歌单名称</label><input id="admin-playlist-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} autoFocus required /><div className="admin-react-form-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</Button></div></form></Modal>
}

export function DataView() {
  const users = useAdminStore(state => state.users)
  const selectedUser = useAdminStore(state => state.selectedUser)
  const setSelectedUser = useAdminStore(state => state.setSelectedUser)
  const data = useAdminStore(state => state.data)
  const busy = useAdminStore(state => state.busy)
  const error = useAdminStore(state => state.error)
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [activeId, setActiveId] = useState('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('default')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)

  const lists = useMemo(() => listFromData(data), [data])
  const activeList = lists.find(list => list.id === activeId) ?? lists[0]
  const customPlaylist = activeList?.kind === 'user' ? (data?.userList ?? []).find(list => String(list.id) === activeList.id) ?? null : null
  const sourceRows = useMemo(() => activeList?.kind === 'all' ? allRows(data) : activeList ? rowsForList(activeList) : [], [activeList, data])
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = sourceRows.filter(row => {
      if (!needle) return true
      const searchable = [songTitle(row.song), songSinger(row.song), songAlbum(row.song), row.sourceName].join(' ').toLocaleLowerCase()
      return searchable.includes(needle)
    })
    if (sort === 'default') return filtered
    const sorted = [...filtered]
    const direction = sort.endsWith('-desc') ? -1 : 1
    const field = sort.replace(/-(?:asc|desc)$/, '')
    sorted.sort((left, right) => {
      const a = field === 'artist' ? songSinger(left.song) : field === 'album' ? songAlbum(left.song) : field === 'source' ? left.sourceName : songTitle(left.song)
      const b = field === 'artist' ? songSinger(right.song) : field === 'album' ? songAlbum(right.song) : field === 'source' ? right.sourceName : songTitle(right.song)
      return a.localeCompare(b, 'zh-CN') * direction
    })
    return sorted
  }, [query, sort, sourceRows])
  const canDelete = activeList?.kind !== 'all'
  const selectedVisible = visibleRows.filter(row => selectedKeys.includes(row.key))
  const allSelected = canDelete && visibleRows.length > 0 && visibleRows.every(row => selectedKeys.includes(row.key))

  useEffect(() => {
    if (!activeList || !lists.some(list => list.id === activeId)) setActiveId(lists[0]?.id ?? 'all')
    setSelectedKeys([])
  }, [activeId, activeList, lists])

  const requestDeletePlaylist = () => {
    if (!customPlaylist || !selectedUser) return
    setConfirmation({ title: '删除歌单', message: `确定删除“${customPlaylist.name}”吗？歌单中的歌曲也会从该歌单移除。`, confirmLabel: '删除歌单', onConfirm: async () => {
      try { await adminApi.deletePlaylist(selectedUser, customPlaylist.id); notify('歌单已删除'); setActiveId('love'); await loadView('data') } catch (error) { notify(error instanceof Error ? error.message : '删除失败') }
    } })
  }

  const removeRows = (rows: SongRow[]) => {
    if (!selectedUser || !rows.length || !activeList || activeList.kind === 'all') return
    setConfirmation({ title: '删除歌曲', message: `确定从“${activeList.name}”中删除 ${rows.length} 首歌曲吗？`, confirmLabel: '删除歌曲', onConfirm: async () => {
      try {
        if (activeList.kind === 'user') {
          const indices = rows.map(row => row.index).sort((a, b) => b - a)
          await adminApi.batchDeleteSongs(selectedUser, activeList.id, indices)
        } else {
          for (const row of rows) await adminApi.deleteSong(selectedUser, activeList.id, adminSongId(row.song, String(row.index)))
        }
        setSelectedKeys([])
        notify('歌曲已删除')
        await loadView('data')
      } catch (error) { notify(error instanceof Error ? error.message : '删除失败') }
    } })
  }

  if (busy && !data) return <ViewFrame title="数据查看" subtitle="浏览用户歌单与歌曲数据"><Loading label="正在读取歌单数据…" /></ViewFrame>
  return <ViewFrame title="数据查看" subtitle="按用户查看试听列表、收藏和自定义歌单"><ErrorPanel message={error} onRetry={() => void loadView('data')} />
    <Panel className="admin-data-panel" title="用户数据" actions={<div className="admin-react-toolbar"><label className="admin-react-inline-label">用户<SelectMenu label="数据用户" value={selectedUser} options={[{ value: '', label: '请选择用户' }, ...users.map(user => ({ value: user.name, label: user.name === '_open' ? '公开用户' : user.name }))]} onChange={value => { setSelectedUser(value); setActiveId('all') }} /></label><Button onClick={() => void loadView('data')} disabled={busy}><Icon name="rotate" />刷新</Button></div>}>
      {!selectedUser ? <Empty label="请选择用户" /> : !lists.length ? <Empty label="该用户暂无歌单数据" /> : <div className="admin-data-workspace">
        <DataListNavigation lists={lists} activeId={activeList?.id ?? 'all'} onChange={id => { setActiveId(id); setQuery(''); setSelectedKeys([]) }} />
        <div className="admin-data-detail">
          <div className="admin-data-summary-grid"><SummaryMetric label="全部歌曲" value={listFromData(data).find(list => list.id === 'all')?.count ?? 0} /><SummaryMetric label="我的收藏" value={data?.loveList?.length ?? 0} /><SummaryMetric label="自定义歌单" value={data?.userList?.length ?? 0} /></div>
          {activeList && <>
            <header className="admin-data-detail-header"><div><p className="admin-data-kicker">{activeList.kind === 'user' ? '自定义歌单' : '系统列表'}</p><h3>{activeList.name}</h3><span>{activeList.count} 首歌曲{activeList.kind === 'user' ? ` · ID ${activeList.id}` : ''}</span></div><div className="admin-react-toolbar">{customPlaylist && <><Button onClick={() => setRenameOpen(true)}><Icon name="pen" />重命名</Button><Button variant="danger" onClick={requestDeletePlaylist}><Icon name="trash" />删除歌单</Button></>}</div></header>
            <div className="admin-data-toolbar"><div className="admin-data-search"><Icon name="magnifying-glass" /><input aria-label="筛选歌曲" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索歌曲、歌手、专辑" /></div><SelectMenu label="歌曲排序" value={sort} options={[{ value: 'default', label: '默认顺序' }, { value: 'name-asc', label: '歌曲名 A-Z' }, { value: 'name-desc', label: '歌曲名 Z-A' }, { value: 'artist-asc', label: '歌手 A-Z' }, { value: 'artist-desc', label: '歌手 Z-A' }, { value: 'album-asc', label: '专辑 A-Z' }, { value: 'source-asc', label: '所属列表 A-Z' }]} onChange={setSort} /></div>
            {canDelete && <div className="admin-data-batchbar"><label className="admin-data-check-all"><input type="checkbox" checked={allSelected} ref={element => { if (element) element.indeterminate = selectedKeys.length > 0 && !allSelected }} onChange={event => setSelectedKeys(event.target.checked ? visibleRows.map(row => row.key) : [])} />全选当前结果</label><span>已选择 {selectedVisible.length} 首</span><Button variant="danger" disabled={!selectedVisible.length} onClick={() => removeRows(selectedVisible)}><Icon name="trash" />批量删除</Button></div>}
            {visibleRows.length ? <div className="admin-react-table-wrap admin-data-table-wrap"><table className="admin-react-table admin-data-table"><caption className="sr-only">{activeList.name}歌曲列表</caption><thead><tr><th scope="col" className="admin-data-check-cell">{canDelete ? '选' : ''}</th><th scope="col">#</th><th scope="col">歌曲 / 歌手</th><th scope="col">专辑</th><th scope="col">所属列表</th><th scope="col">时长</th><th scope="col">大小</th><th scope="col">格式</th><th scope="col">操作</th></tr></thead><tbody>{visibleRows.map((row, index) => <DataSongRow key={row.key} row={row} position={index} canDelete={canDelete} selected={selectedKeys.includes(row.key)} onSelect={checked => setSelectedKeys(current => checked ? [...new Set([...current, row.key])] : current.filter(key => key !== row.key))} onDelete={() => removeRows([row])} />)}</tbody></table></div> : <Empty label={query ? '没有匹配的歌曲' : '此列表暂无歌曲'} />}
          </>}
        </div>
      </div>}
    </Panel>
    <RenamePlaylistDialog open={renameOpen} playlist={customPlaylist} username={selectedUser} onClose={() => setRenameOpen(false)} onSaved={() => loadView('data')} />
    <ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} />
  </ViewFrame>
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return <div className="admin-data-summary-metric"><span>{label}</span><strong>{value}</strong></div>
}

function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section className="view active admin-react-view"><header className="view-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}
