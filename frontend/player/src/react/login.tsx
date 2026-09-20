import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { playerApi } from './api'
import { Button, Icon } from './components'
import { useAuthStore } from './store'

function LoginPage() {
  const [ready, setReady] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const login = useAuthStore(state => state.login)
  useEffect(() => { void Promise.all([playerApi.config(), playerApi.verify()]).then(([config, session]) => { if (!config['player.enableAuth'] || session.valid) window.location.replace('./'); else { setEnabled(true); setReady(true) } }).catch(() => { setError('初始化检查失败，请刷新页面重试'); setReady(true) }) }, [])
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await login(password); window.location.replace('./') } catch (e) { setError(e instanceof Error ? e.message : '密码错误，请重试') } }
  if (!ready) return <main className="react-player-login-page"><div className="react-player-login-card"><Icon name="spinner" /><p>正在检查登录状态…</p></div></main>
  if (!enabled) return null
  return <main className="react-player-login-page"><div className="react-player-login-card"><img src="assets/yun-yin.png" width="80" height="80" alt="云音图标" /><h1>云音</h1><p>输入密码以访问播放器</p><form onSubmit={submit}><label htmlFor="auth-password-input">访问密码</label><div className="react-login-input"><Icon name="lock" /><input id="auth-password-input" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="请输入访问密码" required /></div>{error && <p className="react-error" role="alert">{error}</p>}<Button variant="primary" type="submit"><Icon name="right-to-bracket" />进入播放器</Button></form><small>请联系管理员获取访问密码</small></div></main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><LoginPage /></StrictMode>)
