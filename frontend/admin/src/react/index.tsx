import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { runtimeConfig } from '../../../shared/src/runtime'
import { applyThemePreferences, readThemePreferences, updateThemePreferences, type Appearance } from '../../../shared/src/theme'
import { Button, Icon, Loading } from './components'
import { useAdminStore, type AdminView } from './store'
import { ConfigView, DashboardView, DataView, LogsView, SnapshotsView, StorageView, UsersView } from './views'
import { CustomSourcesView } from './custom-sources-view'

const NAV_ITEMS: { id: AdminView; label: string; icon: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: 'chart-line' },
  { id: 'users', label: '用户管理', icon: 'users' },
  { id: 'storage', label: '存储管理', icon: 'hard-drive' },
  { id: 'data', label: '数据查看', icon: 'database' },
  { id: 'config', label: '系统配置', icon: 'gear' },
  { id: 'logs', label: '系统日志', icon: 'file-lines' },
  { id: 'snapshots', label: '快照管理', icon: 'clock-rotate-left' },
  { id: 'sources', label: '自定义源', icon: 'plug' },
]

function LoginGate() {
  const signIn = useAdminStore(state => state.signIn)
  const error = useAdminStore(state => state.error)
  const busy = useAdminStore(state => state.busy)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await signIn(password) } catch { /* store exposes the safe message */ } }
  return <main className="admin-react-login overlay"><section className="login-box glass" aria-labelledby="login-title"><div className="login-header"><img className="logo-icon" src="/assets/yun-yin.png" width="56" height="56" alt="云音图标" /><h1 id="login-title">云音</h1></div><p className="login-subtitle">管理控制台</p><form onSubmit={submit} className="admin-react-login-form"><label htmlFor="access-password" className="sr-only">访问密码</label><div className="login-password-field"><input id="access-password" name="password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="请输入访问密码" autoComplete="current-password" required /><button type="button" className="login-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}><Icon name={showPassword ? 'eye-slash' : 'eye'} /></button></div><Button variant="primary" className="admin-react-login-submit" type="submit" disabled={busy}>{busy ? <><Icon name="spinner" />登录中…</> : '登录'}</Button>{error && <p className="error-msg" role="alert">{error}</p>}</form></section></main>
}

function viewFor(view: AdminView) {
  switch (view) {
    case 'users': return <UsersView />
    case 'storage': return <StorageView />
    case 'data': return <DataView />
    case 'config': return <ConfigView />
    case 'logs': return <LogsView />
    case 'snapshots': return <SnapshotsView />
    case 'sources': return <CustomSourcesView />
    default: return <DashboardView />
  }
}

function AdminShell() {
  const view = useAdminStore(state => state.view)
  const setView = useAdminStore(state => state.setView)
  const signOut = useAdminStore(state => state.signOut)
  const toast = useAdminStore(state => state.toast)
  const clearToast = useAdminStore(state => state.clearToast)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [toastPhase, setToastPhase] = useState<'entering' | 'visible' | 'leaving'>('entering')
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [appearance, setAppearance] = useState<Appearance>(() => (readThemePreferences().appearance || 'system') as Appearance)
  const config = runtimeConfig()
  const title = NAV_ITEMS.find(item => item.id === view)?.label ?? '管理控制台'

  useEffect(() => {
    document.title = `${title} - 云音`
    if (!toast) return undefined
    setToastPhase('entering')
    const frame = window.requestAnimationFrame(() => setToastPhase('visible'))
    const leaveTimer = window.setTimeout(() => setToastPhase('leaving'), 1880)
    const clearTimer = window.setTimeout(clearToast, 2000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(leaveTimer)
      window.clearTimeout(clearTimer)
    }
  }, [clearToast, title, toast])
  useEffect(() => { const handle = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent) }; window.addEventListener('beforeinstallprompt', handle); return () => window.removeEventListener('beforeinstallprompt', handle) }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !mobileOpen) return
      event.preventDefault()
      setMobileOpen(false)
      window.requestAnimationFrame(() => menuButtonRef.current?.focus())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen])
  const install = async () => { if (!installPrompt) return; await installPrompt.prompt(); setInstallPrompt(null) }
  const closeMobile = () => { setMobileOpen(false); window.requestAnimationFrame(() => menuButtonRef.current?.focus()) }
  const selectView = (next: AdminView) => { setView(next); closeMobile() }
  const toggleTheme = () => { const next: Appearance = appearance === 'dark' ? 'light' : 'dark'; setAppearance(next); updateThemePreferences({ appearance: next }) }
  return <div className="admin-react-shell"><div className={`mobile-sidebar-overlay ${mobileOpen ? 'active' : 'hidden'}`} onClick={closeMobile} aria-hidden="true" /><aside className={`sidebar glass ${mobileOpen ? 'active' : ''}`} aria-label="管理导航"><div className="sidebar-header"><div className="sidebar-brand"><img src="/assets/yun-yin.png" className="logo-icon" width="42" height="42" alt="云音图标" /><h2>云音</h2></div><button type="button" className="admin-react-icon-button admin-react-mobile-close" aria-label="关闭导航菜单" onClick={closeMobile}><Icon name="xmark" /></button></div><nav className="sidebar-nav"><p className="admin-react-nav-label">管理控制台</p>{NAV_ITEMS.map(item => <button key={item.id} type="button" className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => selectView(item.id)}><span className="admin-react-nav-icon"><Icon name={item.icon} /></span><span className="admin-react-nav-text">{item.label}</span></button>)}<a className="nav-item" href={String(config['player.path'] || '/music')}><span className="admin-react-nav-icon"><Icon name="music" /></span><span className="admin-react-nav-text">打开播放器</span></a></nav><div className="sidebar-footer"><Button onClick={() => void signOut()} className="btn-logout"><Icon name="right-from-bracket" />退出登录</Button></div></aside><div className="admin-react-main"><header className="admin-react-topbar"><button ref={menuButtonRef} type="button" className="admin-react-menu-button" aria-label="打开导航菜单" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Icon name="bars" /></button><div><p className="admin-react-eyebrow">云音管理后台</p><h1 id="page-title">{title}</h1></div><div className="admin-react-top-actions"><button type="button" className="admin-react-icon-button" aria-label="切换主题" title="切换深浅色" onClick={toggleTheme}><Icon name={appearance === 'dark' ? 'sun' : 'moon'} /></button>{installPrompt && <Button onClick={() => void install()}><Icon name="download" />安装应用</Button>}<Button variant="secondary" onClick={() => void signOut()}><Icon name="right-from-bracket" />退出</Button></div></header><main id="admin-main" className="admin-react-content" tabIndex={-1}>{viewFor(view)}</main></div>{toast && <div className={`admin-react-toast is-${toastPhase}`} role="status" aria-live="polite"><Icon name="circle-info" /><span>{toast}</span></div>}</div>
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function App() {
  const authenticated = useAdminStore(state => state.authenticated)
  const checking = useAdminStore(state => state.checking)
  const hydrate = useAdminStore(state => state.hydrate)
  useEffect(() => { applyThemePreferences(readThemePreferences()) }, [])
  useEffect(() => { void hydrate() }, [hydrate])
  if (checking) return <main className="admin-react-loading-screen"><Loading label="正在检查登录状态…" /></main>
  return authenticated ? <AdminShell /> : <LoginGate />
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
