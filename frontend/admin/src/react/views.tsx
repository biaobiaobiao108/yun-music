import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { adminApi, type AdminConfig, type AdminData, type AdminSong, type AdminStatus, type AdminUser, type Snapshot, type StorageItem } from './api'
import { Button, ConfirmDialog, Empty, ErrorPanel, Icon, Loading, Modal, Panel, StatCard, formatUptime } from './components'
import { useAdminStore, type AdminView } from './store'
import { formatBytes, formatDate, safeImageUrl } from '../../../shared/src/runtime'

function storageItemKey(item: StorageItem): string {
  return `${String(item.rawUsername ?? '_open')}|${String(item.folder ?? 'cache')}|${String(item.filename ?? item.id ?? item.name ?? '')}`
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function useViewState() {
  const busy = useAdminStore(state => state.busy)
  const error = useAdminStore(state => state.error)
  const loadView = useAdminStore(state => state.loadView)
  return { busy, error, retry: () => void loadView() }
}

type ConfirmRequest = { title: string; message: string; confirmLabel?: string; onConfirm: () => void | Promise<void> }

function storageSummary(stats: AdminStatus['cacheStats'], key: 'cache' | 'music'): { fileCount: number; totalSize: number } {
  const value = stats?.[key]
  if (!value || typeof value !== 'object') return { fileCount: 0, totalSize: 0 }
  const record = value as Record<string, unknown>
  return {
    fileCount: Number(record.fileCount ?? record.count) || 0,
    totalSize: Number(record.totalSize ?? record.size) || 0,
  }
}

export function DashboardView() {
  const status = useAdminStore(state => state.status)
  const users = useAdminStore(state => state.users)
  const setView = useAdminStore(state => state.setView)
  const { busy, error, retry } = useViewState()
  const cache = storageSummary(status?.cacheStats, 'cache')
  const downloads = storageSummary(status?.cacheStats, 'music')
  return <ViewFrame title="仪表盘" subtitle="实时查看服务运行状态与存储概况">
    <ErrorPanel message={error} onRetry={retry} />
    {busy && !status ? <Loading /> : <>
      <div className="admin-react-stats-grid">
        <StatCard label="用户数量" value={status?.users ?? users.length} icon="users" />
        <StatCard label="服务状态" value={status?.publicAccess ? '公开访问' : '访问受限'} icon="shield-halved" />
        <StatCard label="系统 CPU" value={`${status?.cpuUsage ?? '0.00'}%`} icon="microchip" />
        <StatCard label="进程内存" value={`${status?.processMemoryUsage ?? '0.00'}%`} icon="memory" />
      </div>
      <div className="admin-react-storage-summary" aria-label="缓存与下载统计">
        <article className="admin-react-storage-stat"><span className="admin-react-storage-icon"><Icon name="database" /></span><div><span>缓存歌曲</span><strong>{cache.fileCount} 首</strong><small>占用 {formatBytes(cache.totalSize)}</small></div></article>
        <article className="admin-react-storage-stat"><span className="admin-react-storage-icon"><Icon name="download" /></span><div><span>下载歌曲</span><strong>{downloads.fileCount} 首</strong><small>占用 {formatBytes(downloads.totalSize)}</small></div></article>
      </div>
      <div className="admin-react-two-column">
        <Panel title="运行概览"><dl className="admin-react-definition-list"><div><dt>运行时间</dt><dd>{formatUptime(status?.uptime)}</dd></div><div><dt>处理器</dt><dd>{String(status?.cpuModel || '—')}</dd></div><div><dt>内存占用</dt><dd>{formatBytes(status?.memory)}</dd></div><div><dt>缓存限制</dt><dd>{formatBytes(status?.cacheLimit)}</dd></div></dl></Panel>
        <Panel title="快捷操作"><div className="admin-react-quick-actions"><Button variant="primary" onClick={() => setView('users')}><Icon name="user-plus" />添加用户</Button><Button onClick={() => setView('storage')}><Icon name="hard-drive" />存储管理</Button><Button onClick={() => setView('logs')}><Icon name="file-lines" />查看日志</Button><Button onClick={() => setView('config')}><Icon name="gear" />系统配置</Button></div></Panel>
      </div>
    </>}
  </ViewFrame>
}

function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section className="view active admin-react-view"><header className="view-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}

export function UsersView() {
  const users = useAdminStore(state => state.users)
  const { busy, error, retry } = useViewState()
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<'add' | 'edit' | null>(null)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [query, setQuery] = useState('')
  const [deleteData, setDeleteData] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)
  const filtered = users.filter(user => user.name.toLowerCase().includes(query.toLowerCase()))
  const allSelected = filtered.length > 0 && filtered.every(user => selected.includes(user.name))
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const removeUsers = async (names: string[]) => {
    if (!names.length) return
    try { await adminApi.deleteUsers(names, deleteData); setSelected([]); notify('用户已删除'); await loadView('users') } catch (e) { notify(e instanceof Error ? e.message : '删除失败') }
  }
  const requestDeleteUsers = (names: string[]) => {
    if (!names.length) return
    setConfirmation({ title: '删除用户', message: `确定删除 ${names.length} 个用户吗？${deleteData ? '同时删除用户数据。' : ''}`, confirmLabel: '删除', onConfirm: () => removeUsers(names) })
  }
  return <ViewFrame title="用户管理" subtitle="管理播放器账号、密码与用户数据空间"><ErrorPanel message={error} onRetry={retry} />
    <Panel title="用户列表" actions={<div className="admin-react-toolbar"><input aria-label="筛选用户" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用户" /><Button variant="primary" onClick={() => setDialog('add')}><Icon name="plus" />新增用户</Button></div>}>
      <div className="admin-react-batch-bar"><label><input type="checkbox" checked={allSelected} onChange={event => setSelected(event.target.checked ? filtered.map(user => user.name) : [])} />全选</label><span>已选择 {selected.length} 项</span><label><input type="checkbox" checked={deleteData} onChange={event => setDeleteData(event.target.checked)} />同时删除用户数据</label><Button variant="danger" disabled={!selected.length} onClick={() => requestDeleteUsers(selected)}><Icon name="trash" />批量删除</Button></div>
      {busy && !users.length ? <Loading /> : filtered.length ? <div className="admin-react-table-wrap"><table className="admin-react-table"><caption className="sr-only">用户列表</caption><thead><tr><th scope="col">选择</th><th scope="col">用户名</th><th scope="col">密码状态</th><th scope="col">操作</th></tr></thead><tbody>{filtered.map(user => <tr key={user.name}><td><input type="checkbox" aria-label={`选择 ${user.name}`} checked={selected.includes(user.name)} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, user.name])] : current.filter(name => name !== user.name))} /></td><th scope="row">{user.name}</th><td><span className={`admin-react-status ${user.hasPassword ? 'is-ok' : ''}`}>{user.hasPassword ? '已设置密码' : '公开用户'}</span></td><td className="admin-react-row-actions"><Button onClick={() => { setEditing(user); setDialog('edit') }} disabled={user.name === '_open'}>编辑</Button><Button variant="danger" onClick={() => requestDeleteUsers([user.name])} disabled={user.name === '_open'}>删除</Button></td></tr>)}</tbody></table></div> : <Empty label="暂无用户" />}
    </Panel>
    <UserDialog open={dialog === 'add'} mode="add" user={null} onClose={() => setDialog(null)} />
    <UserDialog open={dialog === 'edit'} mode="edit" user={editing} onClose={() => { setDialog(null); setEditing(null) }} />
    <ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} />
  </ViewFrame>
}

function UserDialog({ open, mode, user, onClose }: { open: boolean; mode: 'add' | 'edit'; user: AdminUser | null; onClose: () => void }) {
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [name, setName] = useState(user?.name ?? '')
  const [password, setPassword] = useState('')
  const nameId = `admin-user-name-${mode}`
  const passwordId = `admin-user-password-${mode}`
  useEffect(() => { setName(user?.name ?? ''); setPassword('') }, [user, open])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      if (mode === 'add') await adminApi.addUser(name, password)
      else if (user) await adminApi.updateUser(user.name, { newName: name, ...(password ? { password } : {}) })
      notify(mode === 'add' ? '用户已创建' : '用户已更新'); onClose(); await loadView('users')
    } catch (e) { notify(e instanceof Error ? e.message : '保存失败') }
  }
  return <Modal open={open} title={mode === 'add' ? '新增用户' : '编辑用户'} onClose={onClose}><form className="admin-react-form" onSubmit={submit}><label htmlFor={nameId}>用户名</label><input id={nameId} value={name} onChange={event => setName(event.target.value)} autoComplete="username" required disabled={user?.name === '_open'} /><label htmlFor={passwordId}>{mode === 'add' ? '密码' : '新密码'}</label><input id={passwordId} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === 'add' ? 'new-password' : 'new-password'} required={mode === 'add'} placeholder={mode === 'edit' ? '留空表示不修改' : ''} /><div className="admin-react-form-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" type="submit">保存</Button></div></form></Modal>
}

export function StorageView() {
  const users = useAdminStore(state => state.users)
  const selectedUser = useAdminStore(state => state.selectedUser)
  const setSelectedUser = useAdminStore(state => state.setSelectedUser)
  const folder = useAdminStore(state => state.storageFolder)
  const storage = useAdminStore(state => state.storage)
  const loadView = useAdminStore(state => state.loadView)
  const setFolder = (next: 'cache' | 'music') => { useAdminStore.setState({ storageFolder: next }); void loadView('storage') }
  const notify = useAdminStore(state => state.notify)
  const [selected, setSelected] = useState<string[]>([])
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)
  const remove = async (keys: string[]) => {
    if (!keys.length) return
    const items = storage.filter(item => keys.includes(storageItemKey(item)))
      .map(item => ({ filename: String(item.filename ?? ''), folder: item.folder, user: String(item.rawUsername ?? (selectedUser || '_open')) }))
      .filter(item => item.filename)
    if (!items.length) return
    try { await adminApi.removeCache(items); setSelected([]); notify('文件已删除'); await loadView('storage') } catch (e) { notify(e instanceof Error ? e.message : '删除失败') }
  }
  const clear = async () => {
    if (folder !== 'cache') return
    try { await adminApi.clearCache(selectedUser || 'all'); notify('缓存已清空'); await loadView('storage') } catch (e) { notify(e instanceof Error ? e.message : '清空失败') }
  }
  const requestRemove = (keys: string[]) => { if (keys.length) setConfirmation({ title: '删除文件', message: `确定删除 ${keys.length} 个文件吗？此操作不可恢复。`, confirmLabel: '删除', onConfirm: () => remove(keys) }) }
  const requestClear = () => setConfirmation({ title: '清空缓存', message: '确定清空当前用户的全部缓存吗？此操作不可恢复。', confirmLabel: '清空缓存', onConfirm: clear })
  return <ViewFrame title="存储管理" subtitle="查看缓存与下载音乐，执行安全清理"><Panel title="文件存储" actions={<div className="admin-react-toolbar"><label className="admin-react-inline-label">用户<select value={selectedUser} onChange={event => setSelectedUser(event.target.value)}><option value="">全部用户</option><option value="_open">公开空间</option>{users.filter(user => user.name !== '_open').map(user => <option key={user.name} value={user.name}>{user.name}</option>)}</select></label><Button onClick={() => void loadView('storage')}><Icon name="rotate" />刷新</Button></div>}>
    <div className="admin-react-tabs" role="tablist"><button type="button" role="tab" aria-selected={folder === 'cache'} className={folder === 'cache' ? 'is-active' : ''} onClick={() => setFolder('cache')}>服务端缓存</button><button type="button" role="tab" aria-selected={folder === 'music'} className={folder === 'music' ? 'is-active' : ''} onClick={() => setFolder('music')}>下载音乐</button></div>
    <div className="admin-react-batch-bar"><span>共 {storage.filter(item => item.folder === folder).length} 项，已选择 {selected.length} 项</span><Button variant="danger" disabled={!selected.length} onClick={() => requestRemove(selected)}>删除所选</Button>{folder === 'cache' && <Button variant="danger" onClick={requestClear}>清空缓存</Button>}</div>
    {storage.filter(item => item.folder === folder).length ? <div className="admin-react-table-wrap"><table className="admin-react-table"><caption className="sr-only">存储文件列表</caption><thead><tr><th scope="col">选择</th><th scope="col">歌曲</th><th scope="col">来源</th><th scope="col">大小</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead><tbody>{storage.filter(item => item.folder === folder).map((item, index) => { const key = storageItemKey(item); return <StorageRow key={`${key}-${index}`} item={item} checked={selected.includes(key)} onChange={checked => setSelected(current => checked ? [...new Set([...current, key])] : current.filter(id => id !== key))} onDelete={() => requestRemove([key])} /> })}</tbody></table></div> : <Empty label="当前目录暂无文件" />}
  </Panel><ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} /></ViewFrame>
}

function StorageRow({ item, checked, onChange, onDelete }: { item: StorageItem; checked: boolean; onChange: (value: boolean) => void; onDelete: () => void }) {
  return <tr><td><input type="checkbox" aria-label={`选择 ${String(item.name || item.filename || '文件')}`} checked={checked} onChange={event => onChange(event.target.checked)} /></td><th scope="row"><div className="admin-react-song-cell"><img src={safeImageUrl(item.img)} width="40" height="40" alt="" loading="lazy" /><span><strong>{String(item.name || item.filename || '未知歌曲')}</strong><small>{String(item.singer || '未知歌手')}</small></span></div></th><td>{String(item.source || '—')}</td><td>{formatBytes(item.size)}</td><td>{formatDate(item.mtime)}</td><td><Button variant="danger" onClick={onDelete}>删除</Button></td></tr>
}

export function DataView() {
  const users = useAdminStore(state => state.users)
  const selectedUser = useAdminStore(state => state.selectedUser)
  const setSelectedUser = useAdminStore(state => state.setSelectedUser)
  const data = useAdminStore(state => state.data)
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [playlistId, setPlaylistId] = useState('')
  const [query, setQuery] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)
  const playlists = data?.userList ?? []
  const selectedPlaylist = playlists.find(list => list.id === playlistId) ?? playlists[0]
  const songs = (selectedPlaylist?.list ?? []).filter(song => `${song.name ?? ''} ${song.singer ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => { if (!playlistId && playlists[0]) setPlaylistId(playlists[0].id) }, [playlistId, playlists])
  const requestDeletePlaylist = (id: string) => setConfirmation({ title: '删除歌单', message: '确定删除这个歌单吗？其中的歌曲数据也会被移除。', confirmLabel: '删除歌单', onConfirm: async () => { try { await adminApi.deletePlaylist(selectedUser, id); notify('歌单已删除'); await loadView('data') } catch (e) { notify(e instanceof Error ? e.message : '删除失败') } } })
  const requestDeleteSong = (playlist: string, id: string) => setConfirmation({ title: '删除歌曲', message: '确定从当前歌单删除这首歌曲吗？', confirmLabel: '删除歌曲', onConfirm: async () => { try { await adminApi.deleteSong(selectedUser, playlist, id); notify('歌曲已删除'); await loadView('data') } catch (e) { notify(e instanceof Error ? e.message : '删除失败') } } })
  return <ViewFrame title="数据查看" subtitle="浏览用户歌单与歌曲数据"><Panel title="歌单数据" actions={<div className="admin-react-toolbar"><label className="admin-react-inline-label">用户<select value={selectedUser} onChange={event => { setSelectedUser(event.target.value); setPlaylistId('') }}><option value="">请选择</option>{users.filter(user => user.name !== '_open').map(user => <option key={user.name} value={user.name}>{user.name}</option>)}</select></label><Button onClick={() => void loadView('data')}>刷新</Button></div>}>{selectedUser ? <><div className="admin-react-playlist-grid">{[...(data?.defaultList ? [{ id: 'default', name: '默认歌单', list: data.defaultList }] : []), ...(data?.loveList ? [{ id: 'love', name: '我喜欢的音乐', list: data.loveList }] : []), ...playlists].map(list => <button type="button" key={list.id} className={`admin-react-playlist-card ${selectedPlaylist?.id === list.id ? 'is-active' : ''}`} onClick={() => setPlaylistId(list.id)}><Icon name="music" /><span>{list.name}</span><small>{list.list?.length ?? 0} 首</small></button>)}</div>{selectedPlaylist && <div className="admin-react-detail-panel"><div className="admin-react-subheader"><h3>{selectedPlaylist.name}</h3><div className="admin-react-toolbar"><input aria-label="筛选歌曲" placeholder="筛选歌曲" value={query} onChange={event => setQuery(event.target.value)} />{!['default', 'love'].includes(selectedPlaylist.id) && <Button variant="danger" onClick={() => requestDeletePlaylist(selectedPlaylist.id)}>删除歌单</Button>}</div></div><div className="admin-react-table-wrap"><table className="admin-react-table"><caption className="sr-only">歌单歌曲</caption><thead><tr><th scope="col">歌曲</th><th scope="col">歌手</th><th scope="col">专辑</th><th scope="col">操作</th></tr></thead><tbody>{songs.map((song, index) => <tr key={`${String(song.id ?? song.name)}-${index}`}><th scope="row">{String(song.name || '未知歌曲')}</th><td>{String(song.singer || '—')}</td><td>{String(song.album || '—')}</td><td><Button variant="danger" onClick={() => requestDeleteSong(selectedPlaylist.id, String(song.id ?? ''))}>删除</Button></td></tr>)}</tbody></table></div></div>}</> : <Empty label="请选择用户" />}</Panel><ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} /></ViewFrame>
}

export function ConfigView() {
  const config = useAdminStore(state => state.config)
  const notify = useAdminStore(state => state.notify)
  const loadView = useAdminStore(state => state.loadView)
  const [draft, setDraft] = useState<AdminConfig>({})
  useEffect(() => { if (config) setDraft(config) }, [config])
  const update = (key: string, value: unknown) => setDraft(current => ({ ...current, [key]: value }))
  const submit = async (event: FormEvent) => { event.preventDefault(); try { const result = await adminApi.saveConfig(draft); notify(result.warning || '配置已保存'); await loadView('config') } catch (e) { notify(e instanceof Error ? e.message : '保存失败') } }
  return <ViewFrame title="系统配置" subtitle="修改服务、访问权限与播放器认证设置"><Panel title="基础配置"><form className="admin-react-config-form" onSubmit={submit}><label>服务名称<input value={String(draft.serverName ?? '')} onChange={event => update('serverName', event.target.value)} /></label><label>管理员路径<input value={String(draft['admin.path'] ?? '')} onChange={event => update('admin.path', event.target.value)} /></label><label>播放器路径<input value={String(draft['player.path'] ?? '/music')} onChange={event => update('player.path', event.target.value)} /></label><label>最大快照数量<input type="number" min="1" max="10000" value={Number(draft.maxSnapshotNum ?? 20)} onChange={event => update('maxSnapshotNum', Number(event.target.value))} /></label><label className="admin-react-check"><input type="checkbox" checked={Boolean(draft['player.enableAuth'])} onChange={event => update('player.enableAuth', event.target.checked)} />开启播放器认证</label><label>播放器新密码<input type="password" autoComplete="new-password" value={String(draft['player.password'] ?? '')} onChange={event => update('player.password', event.target.value)} placeholder="留空表示不修改" /></label><label className="admin-react-check"><input type="checkbox" checked={Boolean(draft['user.enablePublicFavorites'])} onChange={event => update('user.enablePublicFavorites', event.target.checked)} />允许公开收藏</label><label className="admin-react-check"><input type="checkbox" checked={Boolean(draft['user.enablePublicNonAdminAccess'])} onChange={event => update('user.enablePublicNonAdminAccess', event.target.checked)} />允许非管理员访问</label><div className="admin-react-form-actions"><Button onClick={() => void loadView('config')}>取消修改</Button><Button variant="primary" type="submit">保存配置</Button></div></form></Panel></ViewFrame>
}

export function LogsView() {
  const logs = useAdminStore(state => state.logs)
  const { error, retry } = useViewState()
  return <ViewFrame title="系统日志" subtitle="查看服务运行和访问记录"><ErrorPanel message={error} onRetry={retry} /><Panel title="应用日志" actions={<Button onClick={retry}>刷新</Button>}><pre className="admin-react-log-view" aria-label="系统日志">{logs.length ? logs.join('\n') : '暂无日志'}</pre></Panel></ViewFrame>
}

export function SnapshotsView() {
  const users = useAdminStore(state => state.users)
  const selectedUser = useAdminStore(state => state.selectedUser)
  const setSelectedUser = useAdminStore(state => state.setSelectedUser)
  const snapshots = useAdminStore(state => state.snapshots)
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [snapshotFile, setSnapshotFile] = useState<File | null>(null)
  const [backupFile, setBackupFile] = useState<File | null>(null)
  const [busyAction, setBusyAction] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null)

  const upload = async (event: FormEvent) => {
    event.preventDefault()
    if (!snapshotFile || !selectedUser) return
    setBusyAction('upload-snapshot')
    try {
      await adminApi.uploadSnapshot(selectedUser, snapshotFile)
      notify('快照已上传')
      setSnapshotFile(null)
      await loadView('snapshots')
    } catch (error) {
      notify(error instanceof Error ? error.message : '上传失败')
    } finally {
      setBusyAction('')
    }
  }

  const downloadSnapshot = async (id: string) => {
    if (!selectedUser) return
    setBusyAction(`download-${id}`)
    try {
      const data = await adminApi.snapshot(selectedUser, id)
      const backup = {
        type: 'playList_v2',
        data: [
          { id: 'default', name: 'list__name_default', list: data.defaultList ?? [] },
          { id: 'love', name: 'list__name_love', list: data.loveList ?? [] },
          ...(data.userList ?? []),
        ],
      }
      downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), `lx_backup_${selectedUser}_${id.slice(0, 8)}.json`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusyAction('')
    }
  }

  const restoreSnapshot = async (id: string) => {
    if (!selectedUser) return
    setBusyAction(`restore-${id}`)
    try {
      await adminApi.restoreSnapshot(selectedUser, id)
      notify('快照已恢复')
      await loadView('snapshots')
    } catch (error) {
      notify(error instanceof Error ? error.message : '恢复失败')
    } finally {
      setBusyAction('')
    }
  }

  const deleteSnapshot = async (id: string) => {
    if (!selectedUser) return
    setBusyAction(`delete-${id}`)
    try {
      await adminApi.deleteSnapshot(selectedUser, id)
      notify('快照已删除')
      await loadView('snapshots')
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除失败')
    } finally {
      setBusyAction('')
    }
  }

  const downloadBackup = async () => {
    setBusyAction('download-backup')
    try {
      downloadBlob(await adminApi.backup(), `yun-yin-backup-${new Date().toISOString().slice(0, 10)}.zip`)
      notify('全量备份已开始下载')
    } catch (error) {
      notify(error instanceof Error ? error.message : '备份下载失败')
    } finally {
      setBusyAction('')
    }
  }

  const restoreBackup = async () => {
    if (!backupFile) return
    setBusyAction('restore-backup')
    try {
      await adminApi.restoreBackup(backupFile)
      notify('全量备份已恢复，页面即将刷新')
      window.setTimeout(() => window.location.reload(), 1200)
    } catch (error) {
      notify(error instanceof Error ? error.message : '备份恢复失败')
      setBusyAction('')
    }
  }

  const restart = async () => {
    setBusyAction('restart')
    try {
      await adminApi.restart()
      notify('服务器正在重启，页面将在稍后刷新')
      window.setTimeout(() => window.location.reload(), 5000)
    } catch (error) {
      notify(error instanceof Error ? error.message : '重启失败')
      setBusyAction('')
    }
  }

  const requestRestoreSnapshot = (id: string) => setConfirmation({ title: '恢复快照', message: '确定将用户歌单恢复到此快照吗？当前未保存的修改会丢失。', confirmLabel: '恢复快照', onConfirm: () => restoreSnapshot(id) })
  const requestDeleteSnapshot = (id: string) => setConfirmation({ title: '删除快照', message: '确定永久删除此快照吗？此操作不可恢复。', confirmLabel: '永久删除', onConfirm: () => deleteSnapshot(id) })
  const requestDownloadBackup = () => setConfirmation({ title: '下载全量备份', message: '确定创建并下载全量 ZIP 备份吗？', confirmLabel: '开始下载', onConfirm: downloadBackup })
  const requestRestoreBackup = (event: FormEvent) => { event.preventDefault(); if (backupFile) setConfirmation({ title: '恢复全量备份', message: '确定用此 ZIP 覆盖服务器数据吗？此操作不可撤销。', confirmLabel: '覆盖并恢复', onConfirm: restoreBackup }) }
  const requestRestart = () => setConfirmation({ title: '重启服务', message: '确定重启服务器吗？当前请求可能会被中断。', confirmLabel: '重启服务', onConfirm: restart })

  return <ViewFrame title="快照管理" subtitle="备份、恢复与删除用户歌单快照"><Panel title="快照列表" actions={<div className="admin-react-toolbar"><label className="admin-react-inline-label">用户<select value={selectedUser} onChange={event => setSelectedUser(event.target.value)}><option value="">请选择</option>{users.filter(user => user.name !== '_open').map(user => <option key={user.name} value={user.name}>{user.name}</option>)}</select></label><form onSubmit={upload} className="admin-react-upload-form"><input type="file" accept="application/json,.json" onChange={event => setSnapshotFile(event.target.files?.[0] ?? null)} /><Button variant="primary" type="submit" disabled={!snapshotFile || !selectedUser || Boolean(busyAction)}>上传快照</Button></form><Button onClick={requestDownloadBackup} disabled={Boolean(busyAction)}><Icon name="download" />下载全量备份</Button><form onSubmit={requestRestoreBackup} className="admin-react-upload-form"><input type="file" accept=".zip,application/zip" onChange={event => setBackupFile(event.target.files?.[0] ?? null)} /><Button variant="danger" type="submit" disabled={!backupFile || Boolean(busyAction)}>恢复全量备份</Button></form><Button onClick={requestRestart} disabled={Boolean(busyAction)}><Icon name="rotate" />重启服务</Button></div>}>{snapshots.length ? <div className="admin-react-table-wrap"><table className="admin-react-table"><caption className="sr-only">快照列表</caption><thead><tr><th scope="col">快照</th><th scope="col">大小</th><th scope="col">时间</th><th scope="col">操作</th></tr></thead><tbody>{snapshots.map((snapshot, index) => { const id = String(snapshot.id ?? snapshot.name ?? index); return <tr key={id}><th scope="row">{id}</th><td>{formatBytes(snapshot.size)}</td><td>{formatDate(snapshot.time)}</td><td className="admin-react-row-actions"><Button onClick={() => void downloadSnapshot(id)} disabled={Boolean(busyAction)}><Icon name="download" />下载</Button><Button onClick={() => requestRestoreSnapshot(id)} disabled={Boolean(busyAction)}><Icon name="rotate" />恢复</Button><Button variant="danger" onClick={() => requestDeleteSnapshot(id)} disabled={Boolean(busyAction)}><Icon name="trash" />删除</Button></td></tr> })}</tbody></table></div> : <Empty label={selectedUser ? '暂无快照' : '请选择用户'} />}</Panel><ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} /></ViewFrame>
}

export function AboutView() {
  const [content, setContent] = useState('<p>加载中…</p>')
  useEffect(() => {
    let active = true
    void Promise.all([fetch('/about.md'), import('../../../shared/src/markdown')]).then(async ([response, markdown]) => {
      if (!response.ok) throw new Error('about request failed')
      const text = await response.text()
      if (active) setContent(markdown.renderSafeMarkdown(text))
    }).catch(() => { if (active) setContent('<p>加载关于页面失败</p>') })
    return () => { active = false }
  }, [])
  return <ViewFrame title="关于" subtitle="云音 Web 播放器与管理后台"><Panel title="云音"><div className="admin-react-about" dangerouslySetInnerHTML={{ __html: content }} /></Panel></ViewFrame>
}
