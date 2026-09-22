import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { adminApi, type AdminCustomSource, type CustomSourceOwner } from './api'
import { Button, ConfirmDialog, Empty, ErrorPanel, Icon, Loading, Modal, Panel, SelectMenu } from './components'
import { ViewFrame } from './view_frame'
import { useAdminStore } from './store'
import { formatBytes, formatDate } from '../../../shared/src/runtime'

function ownerLabel(owner: CustomSourceOwner): string {
  return owner === 'open' ? '公共音源' : `账户：${owner}`
}

function sourceName(source: AdminCustomSource): string {
  return String(source.name || source.id)
}

export function CustomSourcesView() {
  const users = useAdminStore(state => state.users)
  const sourceOwner = useAdminStore(state => state.sourceOwner)
  const sources = useAdminStore(state => state.sources)
  const busy = useAdminStore(state => state.busy)
  const error = useAdminStore(state => state.error)
  const setSourceOwner = useAdminStore(state => state.setSourceOwner)
  const loadView = useAdminStore(state => state.loadView)
  const notify = useAdminStore(state => state.notify)
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [action, setAction] = useState('')
  const [removeTarget, setRemoveTarget] = useState<AdminCustomSource | null>(null)
  const [transferTarget, setTransferTarget] = useState<AdminCustomSource | null>(null)
  const [targetOwner, setTargetOwner] = useState<CustomSourceOwner>('open')

  const userOptions = useMemo(() => users
    .filter(user => user.name !== '_open')
    .map(user => ({ value: user.name, label: user.name })), [users])
  const ownerOptions = useMemo(() => [{ value: 'open', label: '公共音源' }, ...userOptions], [userOptions])
  const visibleSources = useMemo(() => sources.filter(source => source.owner === sourceOwner), [sources, sourceOwner])
  const transferOptions = useMemo(() => [
    ...(sourceOwner !== 'open' ? [{ value: 'open', label: '公共音源' }] : []),
    ...userOptions.filter(option => option.value !== sourceOwner),
  ], [sourceOwner, userOptions])

  useEffect(() => {
    if (sourceOwner !== 'open' && users.length && !users.some(user => user.name === sourceOwner)) setSourceOwner('open')
  }, [setSourceOwner, sourceOwner, users])

  const refresh = () => void loadView('sources')

  const importSource = async (event: FormEvent) => {
    event.preventDefault()
    const value = url.trim()
    if (!value) return
    setAction('import')
    try {
      await adminApi.importCustomSource(value, undefined, sourceOwner)
      setUrl('')
      notify(`已导入${ownerLabel(sourceOwner)}`)
      await loadView('sources')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '导入音源失败')
    } finally {
      setAction('')
    }
  }

  const uploadSource = async (event: FormEvent) => {
    event.preventDefault()
    if (!file) return
    setAction('upload')
    try {
      const content = await file.text()
      const type = file.name.toLowerCase().endsWith('.json') ? 'json' : 'js'
      await adminApi.uploadCustomSource(file.name, content, type, sourceOwner)
      setFile(null)
      notify(`已上传至${ownerLabel(sourceOwner)}`)
      await loadView('sources')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '上传音源失败')
    } finally {
      setAction('')
    }
  }

  const toggleSource = async (source: AdminCustomSource) => {
    setAction(`toggle:${source.id}`)
    try {
      await adminApi.toggleCustomSource(source.id, !source.enabled, source.owner)
      notify(source.enabled ? '音源已停用' : '音源已启用')
      await loadView('sources')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '切换音源失败')
    } finally {
      setAction('')
    }
  }

  const removeSource = async () => {
    if (!removeTarget) return
    setAction(`delete:${removeTarget.id}`)
    try {
      await adminApi.deleteCustomSource(removeTarget.id, removeTarget.owner)
      notify('音源已删除')
      setRemoveTarget(null)
      await loadView('sources')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '删除音源失败')
    } finally {
      setAction('')
    }
  }

  const moveSource = async (source: AdminCustomSource, direction: -1 | 1) => {
    const index = visibleSources.findIndex(item => item.id === source.id)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= visibleSources.length) return
    const ids = visibleSources.map(item => item.id)
    ;[ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]]
    setAction(`reorder:${source.id}`)
    try {
      await adminApi.reorderCustomSources(sourceOwner, ids)
      await loadView('sources')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '保存排序失败')
    } finally {
      setAction('')
    }
  }

  const assignSource = async () => {
    if (!transferTarget || !targetOwner || targetOwner === transferTarget.owner) return
    setAction(`assign:${transferTarget.id}`)
    try {
      await adminApi.assignCustomSource(transferTarget.id, transferTarget.owner, targetOwner)
      notify(`已转移至${ownerLabel(targetOwner)}`)
      setTransferTarget(null)
      await loadView('sources')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '转移音源失败')
    } finally {
      setAction('')
    }
  }

  return <ViewFrame title="自定义源" subtitle="由管理员配置公共音源和账户专属音源">
    <ErrorPanel message={error} onRetry={refresh} />
    <Panel className="admin-custom-sources-panel" title="音源范围" actions={<div className="admin-react-toolbar admin-custom-source-scope"><label className="admin-react-inline-label">作用域<SelectMenu label="音源作用域" value={sourceOwner} options={ownerOptions} onChange={setSourceOwner} /></label><Button onClick={refresh} disabled={busy || Boolean(action)}><Icon name="rotate" />刷新</Button></div>}>
      <p className="admin-custom-source-hint">公共音源对所有播放器用户可用，账户专属音源只会被分配账户读取。</p>
      <div className="admin-custom-source-forms">
        <form className="admin-custom-source-form" onSubmit={importSource}>
          <div><strong>从 URL 导入</strong><small>导入远程 JavaScript 或 JSON 音源脚本</small></div>
          <div className="admin-custom-source-input-row"><input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/source.js" aria-label="音源脚本 URL" required /><Button variant="primary" type="submit" disabled={action === 'import'}>{action === 'import' ? '导入中…' : '导入'}</Button></div>
        </form>
        <form className="admin-custom-source-form" onSubmit={uploadSource}>
          <div><strong>上传脚本</strong><small>选择 .js 或 .json 文件，目标为{ownerLabel(sourceOwner)}</small></div>
          <div className="admin-custom-source-input-row"><label className="admin-react-file-picker"><Icon name="file-code" /><span title={file?.name}>{file?.name ?? '选择脚本文件'}</span><input className="admin-react-file-input" type="file" accept=".js,.json,application/javascript,application/json" onChange={event => setFile(event.target.files?.[0] ?? null)} aria-label="选择音源脚本" /></label><Button variant="primary" type="submit" disabled={!file || action === 'upload'}>{action === 'upload' ? '上传中…' : '上传'}</Button></div>
        </form>
      </div>
    </Panel>
    <Panel className="admin-custom-sources-list-panel" title={`${ownerLabel(sourceOwner)}列表`} actions={<span className="admin-custom-source-count">{visibleSources.length} 个</span>}>
      {busy && !sources.length ? <Loading /> : visibleSources.length ? <div className="admin-custom-source-table-wrap"><table className="admin-custom-source-table"><caption className="sr-only">{ownerLabel(sourceOwner)}列表</caption><thead><tr><th scope="col">音源</th><th scope="col">归属</th><th scope="col">支持平台</th><th scope="col">状态</th><th scope="col">大小</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead><tbody>{visibleSources.map((source, index) => <tr key={`${source.owner}-${source.id}`}><th scope="row"><div className="admin-custom-source-name"><span className="admin-custom-source-icon"><Icon name="plug" /></span><span><strong title={sourceName(source)}>{sourceName(source)}</strong><small>{source.author || '未知作者'}{source.version ? ` · v${source.version}` : ''}</small></span></div>{source.error && <p className="admin-custom-source-error">{source.error}</p>}</th><td>{ownerLabel(source.owner)}</td><td>{source.supportedSources?.length ? source.supportedSources.join('、') : '—'}</td><td><span className={`admin-react-status ${source.enabled ? 'is-ok' : ''}`}>{source.enabled ? '已启用' : '已停用'}</span></td><td>{formatBytes(source.size)}</td><td>{formatDate(source.uploadTime)}</td><td className="admin-react-row-actions"><Button onClick={() => void toggleSource(source)} disabled={Boolean(action)}>{source.enabled ? '停用' : '启用'}</Button><Button onClick={() => void moveSource(source, -1)} disabled={index === 0 || Boolean(action)} aria-label={`上移 ${sourceName(source)}`}><Icon name="chevron-up" /></Button><Button onClick={() => void moveSource(source, 1)} disabled={index === visibleSources.length - 1 || Boolean(action)} aria-label={`下移 ${sourceName(source)}`}><Icon name="chevron-down" /></Button><Button onClick={() => { setTransferTarget(source); setTargetOwner(source.owner === 'open' ? (userOptions[0]?.value ?? 'open') : 'open') }} disabled={!transferOptions.length || Boolean(action)}>转移</Button><Button variant="danger" onClick={() => setRemoveTarget(source)} disabled={Boolean(action)}>删除</Button></td></tr>)}</tbody></table></div> : <Empty label={`暂无${ownerLabel(sourceOwner)}`} />}
    </Panel>
    <ConfirmDialog open={Boolean(removeTarget)} title="删除自定义源" message={`确定删除“${removeTarget ? sourceName(removeTarget) : ''}”吗？此操作不可撤销。`} confirmLabel="删除" onClose={() => setRemoveTarget(null)} onConfirm={removeSource} />
    <Modal open={Boolean(transferTarget)} title="转移音源归属" onClose={() => setTransferTarget(null)}>
      <p>将“{transferTarget ? sourceName(transferTarget) : ''}”转移到新的作用域后，原作用域将不再提供该音源。</p>
      <label className="admin-custom-source-transfer-field">目标作用域<SelectMenu label="目标作用域" value={targetOwner} options={transferOptions} onChange={setTargetOwner} disabled={!transferOptions.length} /></label>
      <div className="admin-react-dialog-actions"><Button onClick={() => setTransferTarget(null)} disabled={Boolean(action)}>取消</Button><Button variant="primary" onClick={() => void assignSource()} disabled={!transferTarget || !targetOwner || targetOwner === transferTarget.owner || Boolean(action)}>{action.startsWith('assign:') ? '转移中…' : '确认转移'}</Button></div>
    </Modal>
  </ViewFrame>
}
