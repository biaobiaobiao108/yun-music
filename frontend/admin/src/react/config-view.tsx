import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { adminApi, type AdminConfig } from './api'
import { Button, Icon, Panel, SelectMenu } from './components'
import { useAdminStore } from './store'

function boolValue(config: AdminConfig, key: string, fallback = false): boolean {
  return config[key] === undefined ? fallback : Boolean(config[key])
}

function ConfigToggle({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="admin-config-toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span><strong>{label}</strong>{description && <small>{description}</small>}</span></label>
}

function ConfigField({ label, children, description }: { label: string; children: ReactNode; description?: string }) {
  return <label className="admin-config-field"><span>{label}</span>{children}{description && <small>{description}</small>}</label>
}

export function ConfigView() {
  const config = useAdminStore(state => state.config)
  const notify = useAdminStore(state => state.notify)
  const loadView = useAdminStore(state => state.loadView)
  const [draft, setDraft] = useState<AdminConfig>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (config) setDraft({ ...config, 'frontend.password': '', 'player.password': '' }) }, [config])
  const update = (key: string, value: unknown) => setDraft(current => ({ ...current, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const adminPath = String(draft['admin.path'] ?? '').trim()
    const playerPath = String(draft['player.path'] ?? '').trim()
    const normalizedPlayerPath = playerPath || '/music'
    if (!normalizedPlayerPath.startsWith('/') || (adminPath && !adminPath.startsWith('/')) || adminPath.startsWith('/api') || normalizedPlayerPath.startsWith('/api') || (adminPath || '/') === (normalizedPlayerPath === '/' ? '/' : normalizedPlayerPath.replace(/\/+$/, ''))) {
      notify('路径无效：路径必须以 / 开头，且管理员路径与播放器路径不能冲突或以 /api 开头')
      return
    }
    setSaving(true)
    try { const result = await adminApi.saveConfig({ ...draft, 'admin.path': adminPath, 'player.path': normalizedPlayerPath }); notify(result.warning || '配置已保存'); await loadView('config') } catch (error) { notify(error instanceof Error ? error.message : '保存失败') } finally { setSaving(false) }
  }
  const refresh = () => void loadView('config')
  return <ViewFrame title="系统配置" subtitle="修改服务、访问权限、代理与播放器认证设置"><form className="admin-config-layout" onSubmit={submit}>
    <Panel title="基础与路径"><div className="admin-config-grid"><ConfigField label="服务名称"><input value={String(draft.serverName ?? '')} onChange={event => update('serverName', event.target.value)} /></ConfigField><ConfigField label="管理员路径" description="留空表示使用根路径"><input value={String(draft['admin.path'] ?? '')} onChange={event => update('admin.path', event.target.value)} /></ConfigField><ConfigField label="播放器路径"><input value={String(draft['player.path'] ?? '/music')} onChange={event => update('player.path', event.target.value)} /></ConfigField><ConfigField label="最大快照数量"><input type="number" min="1" max="10000" value={Number(draft.maxSnapshotNum ?? 20)} onChange={event => update('maxSnapshotNum', Number(event.target.value))} /></ConfigField><div className="admin-config-field"><span>新歌加入位置</span><SelectMenu label="新歌加入位置" value={String(draft['list.addMusicLocationType'] ?? 'top')} options={[{ value: 'top', label: '列表顶部' }, { value: 'bottom', label: '列表底部' }]} onChange={value => update('list.addMusicLocationType', value)} /></div><ConfigField label="音源优先级" description="用逗号分隔，例如 tx,wy"><input value={String(draft['singer.sourcePriority'] ?? 'tx,wy')} onChange={event => update('singer.sourcePriority', event.target.value)} /></ConfigField></div></Panel>
    <Panel title="代理与请求"><div className="admin-config-grid"><ConfigToggle label="启用代理请求" description="为音频和外部资源请求使用代理" checked={boolValue(draft, 'proxy.enabled')} onChange={checked => update('proxy.enabled', checked)} /><ConfigField label="代理请求头"><input value={String(draft['proxy.header'] ?? '')} onChange={event => update('proxy.header', event.target.value)} placeholder="可选" /></ConfigField><ConfigToggle label="启用全局代理" description="将所有外部请求转发到指定地址" checked={boolValue(draft, 'proxy.all.enabled')} onChange={checked => update('proxy.all.enabled', checked)} /><ConfigField label="全局代理地址"><input value={String(draft['proxy.all.address'] ?? '')} onChange={event => update('proxy.all.address', event.target.value)} placeholder="http://127.0.0.1:7890" /></ConfigField></div></Panel>
    <Panel title="用户访问与缓存"><div className="admin-config-toggle-grid"><ConfigToggle label="启用用户路径" checked={boolValue(draft, 'user.enablePath', true)} onChange={checked => update('user.enablePath', checked)} /><ConfigToggle label="允许根用户模式" checked={boolValue(draft, 'user.enableRoot')} onChange={checked => update('user.enableRoot', checked)} /><ConfigToggle label="限制公开本地音乐" checked={boolValue(draft, 'user.enablePublicRestriction')} onChange={checked => update('user.enablePublicRestriction', checked)} /><ConfigToggle label="允许公开用户访问本地音乐" checked={boolValue(draft, 'user.enablePublicNonAdminLocalMusic')} onChange={checked => update('user.enablePublicNonAdminLocalMusic', checked)} /><ConfigToggle label="允许公开收藏" checked={boolValue(draft, 'user.enablePublicFavorites')} onChange={checked => update('user.enablePublicFavorites', checked)} /><ConfigToggle label="允许非管理员访问" checked={boolValue(draft, 'user.enablePublicNonAdminAccess')} onChange={checked => update('user.enablePublicNonAdminAccess', checked)} /><ConfigToggle label="限制登录缓存" checked={boolValue(draft, 'user.enableLoginCacheRestriction')} onChange={checked => update('user.enableLoginCacheRestriction', checked)} /><ConfigToggle label="启用缓存大小限制" checked={boolValue(draft, 'user.enableCacheSizeLimit')} onChange={checked => update('user.enableCacheSizeLimit', checked)} /></div><div className="admin-config-grid admin-config-grid-single"><ConfigField label="缓存大小上限（MB）"><input type="number" min="100" value={Number(draft['user.cacheSizeLimit'] ?? 2000)} onChange={event => update('user.cacheSizeLimit', Number(event.target.value))} /></ConfigField></div></Panel>
    <Panel title="认证安全"><div className="admin-config-grid"><ConfigField label="管理员新密码" description={config?.['frontend.passwordConfigured'] ? '已配置，留空保持不变' : '尚未配置，请设置密码'}><input type="password" autoComplete="new-password" value={String(draft['frontend.password'] ?? '')} onChange={event => update('frontend.password', event.target.value)} placeholder="留空表示不修改" /></ConfigField><ConfigToggle label="开启播放器认证" checked={boolValue(draft, 'player.enableAuth')} onChange={checked => update('player.enableAuth', checked)} /><ConfigField label="播放器新密码" description={config?.['player.passwordConfigured'] ? '已配置，留空保持不变' : '尚未配置，请设置密码'}><input type="password" autoComplete="new-password" value={String(draft['player.password'] ?? '')} onChange={event => update('player.password', event.target.value)} placeholder="留空表示不修改" /></ConfigField></div></Panel>
    <div className="admin-config-actions"><Button onClick={refresh} disabled={saving}><Icon name="rotate" />重新加载</Button><Button variant="primary" type="submit" disabled={saving}><Icon name="floppy-disk" />{saving ? '保存中…' : '保存配置'}</Button></div>
  </form></ViewFrame>
}

function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section className="view active admin-react-view"><header className="view-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}
