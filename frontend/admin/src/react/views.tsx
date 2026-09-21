import { useEffect, useState, type FormEvent } from 'react'
import { adminApi, type AdminStatus, type AdminUser, type Snapshot } from './api'
import { Button, ConfirmDialog, Empty, ErrorPanel, Icon, Loading, Modal, Panel, SelectMenu, StatCard, formatUptime } from './components'
import { useAdminStore, type AdminView } from './store'
import { formatBytes, formatDate } from '../../../shared/src/runtime'

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

export function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
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
    <Panel className="admin-users-panel" title="用户列表" actions={<div className="admin-react-toolbar admin-users-toolbar"><label className="admin-react-search-field"><Icon name="magnifying-glass" /><span className="sr-only">筛选用户</span><input aria-label="筛选用户" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用户" /></label><Button className="admin-users-add" variant="primary" onClick={() => setDialog('add')}><Icon name="plus" />新增用户</Button></div>}>
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

export { StorageView } from './storage-view'

export { DataView } from './data-view'
export { ConfigView } from './config-view'

export function LogsView() {
  const logs = useAdminStore(state => state.logs)
  const logType = useAdminStore(state => state.logType)
  const setLogType = useAdminStore(state => state.setLogType)
  const { error, retry } = useViewState()
  return <ViewFrame title="系统日志" subtitle="查看服务运行和访问记录"><ErrorPanel message={error} onRetry={retry} /><Panel title="系统日志" actions={<div className="admin-react-toolbar"><SelectMenu label="日志类型" value={logType} options={[{ value: 'app', label: '应用日志' }, { value: 'access', label: '访问日志' }, { value: 'login', label: '登录日志' }, { value: 'error', label: '错误日志' }]} onChange={value => setLogType(value as 'app' | 'access' | 'login' | 'error')} /><Button onClick={retry}><Icon name="rotate" />刷新</Button></div>}><pre className="admin-react-log-view" aria-label="系统日志">{logs.length ? logs.join('\n') : '暂无日志'}</pre></Panel></ViewFrame>
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

  return <ViewFrame title="快照管理" subtitle="备份、恢复与删除用户歌单快照"><Panel title="快照列表" actions={<div className="admin-react-toolbar"><label className="admin-react-inline-label">用户<SelectMenu label="快照用户" value={selectedUser} options={[{ value: '', label: '请选择' }, ...users.filter(user => user.name !== '_open').map(user => ({ value: user.name, label: user.name }))]} onChange={setSelectedUser} /></label><form onSubmit={upload} className="admin-react-upload-form"><input type="file" accept="application/json,.json" onChange={event => setSnapshotFile(event.target.files?.[0] ?? null)} /><Button variant="primary" type="submit" disabled={!snapshotFile || !selectedUser || Boolean(busyAction)}>上传快照</Button></form><Button onClick={requestDownloadBackup} disabled={Boolean(busyAction)}><Icon name="download" />下载全量备份</Button><form onSubmit={requestRestoreBackup} className="admin-react-upload-form"><input type="file" accept=".zip,application/zip" onChange={event => setBackupFile(event.target.files?.[0] ?? null)} /><Button variant="danger" type="submit" disabled={!backupFile || Boolean(busyAction)}>恢复全量备份</Button></form><Button onClick={requestRestart} disabled={Boolean(busyAction)}><Icon name="rotate" />重启服务</Button></div>}>{snapshots.length ? <div className="admin-react-table-wrap"><table className="admin-react-table"><caption className="sr-only">快照列表</caption><thead><tr><th scope="col">快照</th><th scope="col">大小</th><th scope="col">时间</th><th scope="col">操作</th></tr></thead><tbody>{snapshots.map((snapshot, index) => { const id = String(snapshot.id ?? snapshot.name ?? index); return <tr key={id}><th scope="row">{id}</th><td>{formatBytes(snapshot.size)}</td><td>{formatDate(snapshot.time)}</td><td className="admin-react-row-actions"><Button onClick={() => void downloadSnapshot(id)} disabled={Boolean(busyAction)}><Icon name="download" />下载</Button><Button onClick={() => requestRestoreSnapshot(id)} disabled={Boolean(busyAction)}><Icon name="rotate" />恢复</Button><Button variant="danger" onClick={() => requestDeleteSnapshot(id)} disabled={Boolean(busyAction)}><Icon name="trash" />删除</Button></td></tr> })}</tbody></table></div> : <Empty label={selectedUser ? '暂无快照' : '请选择用户'} />}</Panel><ConfirmDialog open={Boolean(confirmation)} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.confirmLabel} onClose={() => setConfirmation(null)} onConfirm={() => confirmation?.onConfirm()} /></ViewFrame>
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
