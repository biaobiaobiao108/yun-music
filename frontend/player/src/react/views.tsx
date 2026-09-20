import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { playerApi, type CommentItem, type CustomSource, type SearchType } from './api'
import { Button, Icon, Loading, Modal, SafeImage, SongList } from './components'
import { PlayerFooterBar } from './player_footer'
import { useAuthStore, useCommentStore, useLibraryStore, useLyricStore, usePlaybackStore, usePlayerUiStore, useSearchStore, useSettingsStore } from './store'
import type { PlayerDetail, PlayerTab, Song } from './types'
import { songArtist, songImage, songKey, songTitle } from './types'
import { formatBytes, formatDate, safeImageUrl } from '../../../shared/src/runtime'

function extractSongs(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'songs', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function resultId(song: Song, index: number): string {
  return String(song.id ?? song.artistId ?? song.albumId ?? song.listId ?? song.songmid ?? song.hash ?? index)
}

function resultImage(song: Song): string {
  return safeImageUrl(songImage(song))
}

function SearchEntityGrid({ items, kind, onOpen }: { items: Song[]; kind: 'artist' | 'album' | 'playlist'; onOpen: (detail: PlayerDetail) => void }) {
  if (!items.length) return <div className="react-empty"><Icon name={kind === 'artist' ? 'user' : kind === 'album' ? 'compact-disc' : 'list'} /><p>没有找到匹配的结果</p></div>
  return <div className="react-entity-grid">{items.map((item, index) => {
    const id = resultId(item, index)
    const name = String(item.name ?? item.artistName ?? item.singer ?? item.title ?? '未命名')
    const source = String(item.source || 'wy')
    const subtitle = kind === 'artist' ? `${String(item.albumSize ?? 0)} 张专辑` : kind === 'album' ? String(item.artistName ?? item.singer ?? '未知歌手') : String(item.creator ?? item.artistName ?? '平台歌单')
    return <article className="react-entity-card" key={`${source}:${id}`}><button type="button" onClick={() => onOpen({ page: 'search-detail', kind, id, source, name, image: resultImage(item) })}><SafeImage src={resultImage(item)} width="160" height="160" loading="lazy" alt={`${name}封面`} /><strong>{name}</strong><small>{subtitle}</small></button></article>
  })}</div>
}

export function SearchDetailView({ detail }: { detail: PlayerDetail }) {
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [info, setInfo] = useState<Record<string, unknown>>({})
  const [songs, setSongs] = useState<Song[]>([])
  const [albums, setAlbums] = useState<Song[]>([])
  const [activeTab, setActiveTab] = useState<'songs' | 'albums'>('songs')
  const [order, setOrder] = useState<'hot' | 'time'>('hot')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const load = async () => {
      try {
        if (detail.kind === 'artist') {
          const [artist, songPayload] = await Promise.all([playerApi.artistDetail(detail.source, detail.id, controller.signal), playerApi.artistSongs(detail.source, detail.id, order, 1, 40, controller.signal)])
          if (controller.signal.aborted) return
          setInfo(recordOf(artist)); setSongs(extractSongs(songPayload))
        } else if (detail.kind === 'album') {
          const payload = await playerApi.albumSongs(detail.source, detail.id, controller.signal)
          if (controller.signal.aborted) return
          setInfo(recordOf(payload)); setSongs(extractSongs(payload))
        } else {
          const payload = await playerApi.songListDetail(detail.source, detail.id)
          if (controller.signal.aborted) return
          setInfo(recordOf(payload)); setSongs(extractSongs(payload))
        }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '详情加载失败') } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [detail.id, detail.kind, detail.source, order])
  useEffect(() => {
    if (detail.kind !== 'artist' || activeTab !== 'albums') return
    const controller = new AbortController()
    void playerApi.artistAlbums(detail.source, detail.id, 1, 40, controller.signal).then(payload => { if (!controller.signal.aborted) setAlbums(extractSongs(payload)) }).catch(() => { if (!controller.signal.aborted) setAlbums([]) })
    return () => controller.abort()
  }, [activeTab, detail.id, detail.kind, detail.source])
  const name = String(info.name ?? info.artistName ?? info.albumName ?? info.title ?? detail.name ?? '详情')
  const image = String(info.avatar ?? info.picUrl ?? info.img ?? info.pic ?? detail.image ?? '/music/assets/yun-yin.png')
  const description = String(info.desc ?? info.description ?? info.intro ?? '')
  return <ViewFrame title={name} subtitle={detail.kind === 'artist' ? '歌手详情' : detail.kind === 'album' ? '专辑详情' : '歌单详情'}><section className="react-detail-header t-bg-panel"><button type="button" className="react-secondary-button" onClick={() => window.history.back()}><Icon name="arrow-left" />返回搜索结果</button><div className="react-detail-hero"><SafeImage src={image} width="144" height="144" loading="lazy" alt={`${name}封面`} /><div><h2>{name}</h2>{description && <p>{description}</p>}<small>{detail.source.toUpperCase()} · {songs.length} 首歌曲</small></div></div></section>{detail.kind === 'artist' && <div className="react-detail-tabs" role="tablist"><button type="button" role="tab" aria-selected={activeTab === 'songs'} className={activeTab === 'songs' ? 'is-active' : ''} onClick={() => setActiveTab('songs')}>热门歌曲</button><button type="button" role="tab" aria-selected={activeTab === 'albums'} className={activeTab === 'albums' ? 'is-active' : ''} onClick={() => setActiveTab('albums')}>专辑</button>{activeTab === 'songs' && <span><button type="button" className={order === 'hot' ? 'is-active' : ''} onClick={() => setOrder('hot')}>最热</button><button type="button" className={order === 'time' ? 'is-active' : ''} onClick={() => setOrder('time')}>最新</button></span>}</div>}<section className="react-content-card t-bg-panel">{loading ? <Loading label="正在加载详情…" /> : error ? <p className="react-error" role="alert">{error}</p> : detail.kind === 'artist' && activeTab === 'albums' ? <SearchEntityGrid items={albums} kind="album" onOpen={next => setDetail(next)} /> : <SongList songs={songs} empty="暂无歌曲" />}</section></ViewFrame>
}

export function SearchView({ detail = null }: { detail?: PlayerDetail | null } = {}) {
  const query = useSearchStore(state => state.query)
  const source = useSearchStore(state => state.source)
  const type = useSearchStore(state => state.type)
  const page = useSearchStore(state => state.page)
  const results = useSearchStore(state => state.results)
  const loading = useSearchStore(state => state.loading)
  const error = useSearchStore(state => state.error)
  const hot = useSearchStore(state => state.hot)
  const search = useSearchStore(state => state.search)
  const setQuery = useSearchStore(state => state.setQuery)
  const setType = useSearchStore(state => state.setType)
  const loadHot = useSearchStore(state => state.loadHot)
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [input, setInput] = useState(query)
  useEffect(() => { void loadHot() }, [loadHot])
  useEffect(() => setInput(query), [query])
  const submit = (event: FormEvent) => { event.preventDefault(); void search(input, 1) }
  const label = type === 'song' ? '歌曲' : type === 'singer' ? '歌手' : type === 'album' ? '专辑' : '歌单'
  if (detail) return <SearchDetailView detail={detail} />
  const resultView = type === 'singer' ? <SearchEntityGrid items={results} kind="artist" onOpen={setDetail} /> : type === 'album' ? <SearchEntityGrid items={results} kind="album" onOpen={setDetail} /> : type === 'playlist' ? <SearchEntityGrid items={results} kind="playlist" onOpen={setDetail} /> : <SongList songs={results} empty={query ? '没有找到匹配的歌曲' : '输入关键词开始搜索'} />
  return <ViewFrame title="搜索音乐" subtitle="搜索歌曲、歌手、专辑与歌单"><section className="react-search-card t-bg-panel"><form className="react-search-form" onSubmit={submit}><label htmlFor="player-search" className="sr-only">搜索音乐</label><div className="react-search-input"><Icon name="search" /><input id="player-search" value={input} onChange={event => { setInput(event.target.value); setQuery(event.target.value) }} placeholder="搜索音乐、歌手、专辑或歌单" autoComplete="off" /><button type="button" aria-label="清空搜索" onClick={() => { setInput(''); setQuery('') }}><Icon name="xmark" /></button></div><select aria-label="音源" value={source} onChange={event => useSearchStore.setState({ source: event.target.value })}><option value="wy">网易云</option><option value="tx">QQ音乐</option></select><select aria-label="搜索类型" value={type} onChange={event => setType(event.target.value as SearchType)}><option value="song">歌曲</option><option value="singer">歌手</option><option value="album">专辑</option><option value="playlist">歌单</option></select><Button variant="primary" type="submit" disabled={loading}><Icon name="search" />搜索</Button></form>{!results.length && !query && <div className="react-hot-search"><h2>热门搜索</h2><div>{hot.slice(0, 20).map((item, index) => { const text = typeof item === 'string' ? item : String((item as Record<string, unknown>)?.name ?? (item as Record<string, unknown>)?.keyword ?? item); return <button type="button" key={`${text}-${index}`} onClick={() => { setInput(text); void search(text, 1) }}>{text}</button> })}</div></div>}</section><section className="react-content-card t-bg-panel"><div className="react-section-heading"><div><h2>{query ? `“${query}”的${label}结果` : '搜索结果'}</h2>{results.length > 0 && <p>共显示 {results.length} 条</p>}</div><div className="react-pagination"><button type="button" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => void search(query, page - 1)}><Icon name="chevron-left" /></button><span>第 {page} 页</span><button type="button" aria-label="下一页" disabled={!query || loading || results.length < 40} onClick={() => void search(query, page + 1)}><Icon name="chevron-right" /></button></div></div>{loading ? <Loading label="正在搜索…" /> : error ? <p className="react-error" role="alert">{error}</p> : resultView}</section></ViewFrame>
}

export function FavoritesView() {
  const data = useLibraryStore(state => state.data)
  const loading = useLibraryStore(state => state.loading)
  const removeSong = useLibraryStore(state => state.removeSong)
  const renameList = useLibraryStore(state => state.renameList)
  const deleteList = useLibraryStore(state => state.deleteList)
  const notify = usePlayerUiStore(state => state.notify)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const setFavoriteListId = usePlayerUiStore(state => state.setFavoriteListId)
  const [selectedList, setSelectedList] = useState(favoriteListId || 'love')
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSongs, setSelectedSongs] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const lists = [
    { id: 'default', key: 'default', name: '默认列表', list: data.defaultList ?? [] },
    { id: 'love', key: 'love', name: '我喜欢的音乐', list: data.loveList ?? [] },
    ...(data.userList ?? []).map((list, index) => ({ id: String(list.id), key: `${String(list.id)}-${index}`, name: list.name, list: list.list ?? [] })),
  ]
  const active = lists.find(list => String(list.id) === selectedList) ?? lists[0]
  useEffect(() => {
    if (lists.some(list => String(list.id) === favoriteListId)) setSelectedList(favoriteListId)
  }, [favoriteListId, lists.length])
  useEffect(() => { setSelectedSongs(new Set()) }, [active?.key])
  const toggleSong = (song: Song) => setSelectedSongs(current => { const next = new Set(current); const key = songKey(song); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const removeBatch = async () => {
    if (!active) return
    try { await Promise.all(active.list.filter(song => selectedSongs.has(songKey(song))).map(song => removeSong(active.id, song))); notify(`已从歌单移除 ${selectedSongs.size} 首歌曲`); setSelectedSongs(new Set()); setConfirmOpen(false) } catch (error) { notify(error instanceof Error ? error.message : '批量移除失败') }
  }
  const selectAll = () => setSelectedSongs(new Set(active?.list.map(songKey) ?? []))
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!renameTarget || !renameValue.trim()) return
    try { await renameList(renameTarget.id, renameValue.trim()); notify('歌单已重命名'); setRenameTarget(null) } catch (error) { notify(error instanceof Error ? error.message : '歌单重命名失败') }
  }
  const confirmDelete = async () => {
    if (!deleteTarget) return
    try { await deleteList(deleteTarget.id); setSelectedList('love'); setFavoriteListId('love'); setDeleteTarget(null); notify('歌单已删除') } catch (error) { notify(error instanceof Error ? error.message : '歌单删除失败') }
  }
  return <ViewFrame title="我的音乐" subtitle="管理收藏歌曲与个人歌单"><section className="react-favorites-layout"><aside className="react-list-sidebar"><h2>我的歌单</h2>{lists.map(list => <div className={`react-list-entry ${active?.key === list.key ? 'is-active' : ''}`} key={list.key}><button type="button" className="react-list-select" onClick={() => { const id = String(list.id); setSelectedList(id); setFavoriteListId(id); setSelectedSongs(new Set()); setBatchMode(false) }}><Icon name={list.id === 'love' ? 'heart' : 'music'} /><span>{list.name}</span><small>{list.list.length}</small></button>{list.id !== 'love' && <span className="react-list-actions"><button type="button" aria-label={`重命名歌单 ${list.name}`} title="重命名歌单" onClick={() => { setRenameTarget({ id: list.id, name: list.name }); setRenameValue(list.name) }}><Icon name="pen" /></button><button type="button" aria-label={`删除歌单 ${list.name}`} title="删除歌单" onClick={() => setDeleteTarget({ id: list.id, name: list.name })}><Icon name="trash" /></button></span>}</div>)}<CreateListButton /></aside><section className="react-content-card t-bg-panel react-favorites-content"><div className="react-section-heading"><div><h2>{active?.name ?? '我的歌单'}</h2><p>{active?.list.length ?? 0} 首歌曲{batchMode && selectedSongs.size ? ` · 已选择 ${selectedSongs.size} 首` : ''}</p></div><div className="react-dialog-actions">{batchMode && <><Button onClick={selectAll} disabled={!active?.list.length}>全选</Button><Button onClick={() => setSelectedSongs(new Set())} disabled={!selectedSongs.size}>取消选择</Button><Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!selectedSongs.size}>批量移除</Button></>}<Button onClick={() => { setBatchMode(value => !value); setSelectedSongs(new Set()) }}>{batchMode ? '退出多选' : '多选操作'}</Button></div></div>{loading ? <Loading /> : <SongList songs={active?.list ?? []} listId={active?.id ?? 'love'} selected={batchMode ? selectedSongs : undefined} onSelect={batchMode ? toggleSong : undefined} empty="歌单还是空的，去搜索音乐吧" />}<Modal open={confirmOpen} title="批量移除歌曲" onClose={() => setConfirmOpen(false)}><p>确定从“{active?.name ?? '当前歌单'}”移除选中的 {selectedSongs.size} 首歌曲吗？</p><div className="react-dialog-actions"><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button variant="danger" onClick={() => void removeBatch()}>确认移除</Button></div></Modal><Modal open={Boolean(renameTarget)} title="重命名歌单" onClose={() => setRenameTarget(null)}><form className="react-dialog-form" onSubmit={submitRename}><label htmlFor="rename-list-name">新的歌单名称</label><input id="rename-list-name" value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={80} required /><div className="react-dialog-actions"><Button type="button" onClick={() => setRenameTarget(null)}>取消</Button><Button variant="primary" type="submit">保存</Button></div></form></Modal><Modal open={Boolean(deleteTarget)} title="删除歌单" onClose={() => setDeleteTarget(null)}><p>确定删除歌单“{deleteTarget?.name ?? ''}”吗？其中的歌曲也会从该歌单移除。</p><div className="react-dialog-actions"><Button type="button" onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" type="button" onClick={() => void confirmDelete()}>确认删除</Button></div></Modal></section></section></ViewFrame>
}

function CreateListButton() { const setDialog = usePlayerUiStore(state => state.setDialog); return <button type="button" className="react-create-list" onClick={() => setDialog('createList')}><Icon name="plus" />新建歌单</button> }

function CustomSourcesContent() {
  const userName = useAuthStore(state => state.userName)
  const notify = usePlayerUiStore(state => state.notify)
  const [sources, setSources] = useState<CustomSource[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [confirmation, setConfirmation] = useState<CustomSource | null>(null)
  const load = async () => {
    setLoading(true); setError('')
    try { setSources(await playerApi.customSources(userName || undefined)) } catch (e) { setError(e instanceof Error ? e.message : '自定义源加载失败') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [userName])
  const toggle = async (source: CustomSource) => { try { await playerApi.toggleCustomSource(source.id, !source.enabled, source.owner === 'open' ? undefined : userName || undefined); notify(source.enabled ? '音源已禁用' : '音源已启用'); await load() } catch (e) { notify(e instanceof Error ? e.message : '切换音源失败') } }
  const remove = async () => { if (!confirmation) return; try { await playerApi.deleteCustomSource(confirmation.id, confirmation.owner); notify('自定义源已删除'); setConfirmation(null); await load() } catch (e) { notify(e instanceof Error ? e.message : '删除音源失败') } }
  const importSource = async (event: FormEvent) => { event.preventDefault(); if (!url.trim()) return; try { await playerApi.importCustomSource(url.trim(), undefined, userName || undefined); setUrl(''); notify('自定义源已导入'); await load() } catch (e) { notify(e instanceof Error ? e.message : '导入音源失败') } }
  const uploadSource = async (event: FormEvent) => { event.preventDefault(); if (!file) return; try { await playerApi.uploadCustomSource(file.name, await file.text(), file.name.endsWith('.json') ? 'json' : 'js', userName || undefined); setFile(null); notify('自定义源已上传'); await load() } catch (e) { notify(e instanceof Error ? e.message : '上传音源失败') } }
  return <section className="react-content-card t-bg-panel react-custom-sources"><div className="react-section-heading"><div><h2>自定义音源</h2><p>管理公开与当前账户可用的第三方音源脚本</p></div><Button onClick={() => void load()} disabled={loading}><Icon name="rotate" />刷新</Button></div>{error && <p className="react-error" role="alert">{error}</p>}<div className="react-custom-source-list">{loading ? <Loading /> : sources.length ? sources.map(source => <div className="react-custom-source-row" key={`${source.owner}-${source.id}`}><span><strong>{String(source.name || source.id)}</strong><small>{source.owner === 'open' || source.isPublic ? '公开' : '私有'}{source.version ? ` · v${String(source.version)}` : ''}{source.error ? ` · ${String(source.error)}` : ''}</small></span><div><Button onClick={() => void toggle(source)}>{source.enabled ? '禁用' : '启用'}</Button>{source.owner !== 'open' && <Button variant="danger" onClick={() => setConfirmation(source)}>删除</Button>}</div></div>) : <p className="react-empty-text">暂无自定义音源</p>}</div><div className="react-source-forms"><form onSubmit={importSource}><label htmlFor="custom-source-url">从 URL 导入</label><div><input id="custom-source-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/source.js" required /><Button variant="primary" type="submit">导入</Button></div></form><form onSubmit={uploadSource}><label htmlFor="custom-source-file">上传脚本</label><div><input id="custom-source-file" type="file" accept=".js,.json,application/javascript,application/json" onChange={event => setFile(event.target.files?.[0] ?? null)} /><Button type="submit" disabled={!file}>上传</Button></div></form></div><Modal open={Boolean(confirmation)} title="删除自定义源" onClose={() => setConfirmation(null)}><p>确定删除“{String(confirmation?.name || confirmation?.id || '')}”吗？</p><div className="react-dialog-actions"><Button onClick={() => setConfirmation(null)}>取消</Button><Button variant="primary" onClick={() => void remove()}>删除</Button></div></Modal></section>
}

function AudioEffectsPanel() {
  const settings = useSettingsStore(state => state.settings)
  const setSetting = useSettingsStore(state => state.setSetting)
  return <section className="react-content-card t-bg-panel react-audio-settings"><h2>音效与可视化</h2><div className="react-settings-form"><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableSoundEffects)} onChange={event => setSetting('enableSoundEffects', event.target.checked)} /><span>启用浏览器音效处理</span></label><label>音效预设<select value={String(settings.soundEffectsPreset ?? 'flat')} onChange={event => setSetting('soundEffectsPreset', event.target.value)}><option value="flat">均衡</option><option value="vocal">人声</option><option value="bass">低音增强</option><option value="focus">清晰度</option></select></label><label>音效增益<input type="range" min="0.5" max="1.5" step="0.05" value={Number(settings.soundEffectsGain ?? 1)} onChange={event => setSetting('soundEffectsGain', Number(event.target.value))} /><output>{Number(settings.soundEffectsGain ?? 1).toFixed(2)}×</output></label><p className="react-setting-hint">音效和底部可视化使用特性检测；不支持 Web Audio 的浏览器会自动回退到原生播放。</p></div></section>
}

function CustomSourcesPanel() {
  return <><CustomSourcesContent /><AudioEffectsPanel /></>
}

export function SettingsView() {
  const settings = useSettingsStore(state => state.settings)
  const setSetting = useSettingsStore(state => state.setSetting)
  const auth = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [accountError, setAccountError] = useState('')
  const login = async (event: FormEvent) => { event.preventDefault(); try { await auth.userLogin(username, password); setAccountError(''); useLibraryStore.getState().hydrate() } catch (e) { setAccountError(e instanceof Error ? e.message : '登录失败') } }
  const logout = async () => { await auth.userLogout(); useLibraryStore.setState({ data: { defaultList: [], loveList: [], userList: [] }, loading: false, error: '' }) }
  const toggle = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => setSetting(key, event.target.checked)
  return <ViewFrame title="设置" subtitle="调整播放器偏好、主题、缓存与账户"><section className="react-settings-grid"><section className="react-content-card t-bg-panel"><h2>外观与播放</h2><div className="react-settings-form"><label>主题<select value={String(settings.appearance ?? 'system')} onChange={event => setSetting('appearance', event.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>强调色<select value={String(settings.themeColor ?? 'netease')} onChange={event => setSetting('themeColor', event.target.value)}><option value="netease">网易红</option><option value="emerald">翡翠绿</option><option value="blue">海洋蓝</option><option value="violet">紫罗兰</option></select></label><label>默认音质<select value={String(settings.preferredQuality)} onChange={event => setSetting('preferredQuality', event.target.value)}><option value="128k">128K</option><option value="320k">320K</option><option value="flac">无损 FLAC</option><option value="hires">Hi-Res</option></select></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.autoResume)} onChange={toggle('autoResume')} /><span>自动恢复上次播放进度</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableKeyboardShortcuts)} onChange={toggle('enableKeyboardShortcuts')} /><span>启用键盘快捷键</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.showLyricTranslation)} onChange={toggle('showLyricTranslation')} /><span>显示歌词翻译</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.showLyricRoma)} onChange={toggle('showLyricRoma')} /><span>显示罗马音 / 逐字歌词</span></label></div></section><section className="react-content-card t-bg-panel"><h2>缓存与播放策略</h2><div className="react-settings-form"><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enablePreloader)} onChange={toggle('enablePreloader')} /><span>预取下一首歌曲</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableAutoDegradeQuality)} onChange={toggle('enableAutoDegradeQuality')} /><span>播放失败时自动降级音质</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableAutoSwitchSource)} onChange={toggle('enableAutoSwitchSource')} /><span>解析失败时自动换源</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableServerCache)} onChange={toggle('enableServerCache')} /><span>播放后加入服务器缓存</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableCrossfade)} onChange={toggle('enableCrossfade')} /><span>切歌淡入淡出</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.keepScreenAwake)} onChange={toggle('keepScreenAwake')} /><span>播放时保持屏幕唤醒</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.showFooterVisualizer)} onChange={toggle('showFooterVisualizer')} /><span>显示底部可视化</span></label></div></section><section className="react-content-card t-bg-panel"><h2>用户账户</h2>{auth.userAuthenticated ? <div className="react-account-state"><Icon name="circle-check" /><p>已登录为 <strong>{auth.userName}</strong></p><Button onClick={() => void logout()}>退出账户</Button></div> : <form className="react-settings-form" onSubmit={login}><label>用户名<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>{accountError && <p className="react-error" role="alert">{accountError}</p>}<Button variant="primary" type="submit">登录账户</Button></form>}</section><CustomSourcesPanel /></section></ViewFrame>
}

export function AboutView() {
  const [content, setContent] = useState('<p>加载中…</p>')
  useEffect(() => {
    let active = true
    void Promise.all([fetch('/music/about.md'), import('../../../shared/src/markdown')]).then(async ([response, markdown]) => {
      if (!response.ok) throw new Error('about request failed')
      const text = await response.text()
      if (active) setContent(markdown.renderSafeMarkdown(text))
    }).catch(() => { if (active) setContent('<p>加载关于页面失败</p>') })
    return () => { active = false }
  }, [])
  return <ViewFrame title="关于云音" subtitle="一个轻量、可自部署的 Web 音乐播放器"><section className="react-content-card t-bg-panel"><div className="react-about-content" dangerouslySetInnerHTML={{ __html: content }} /></section></ViewFrame>
}

export function ViewFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) { return <section id={`view-${title}`} className="player-main-view react-view"><header className="react-view-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section> }

export function ImmersiveLyricsView({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = usePlaybackStore(state => state.currentSong)
  const time = usePlaybackStore(state => state.currentTime)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const lines = useLyricStore(state => state.lines)
  const loading = useLyricStore(state => state.loading)
  const error = useLyricStore(state => state.error)
  const load = useLyricStore(state => state.load)
  const settings = useSettingsStore(state => state.settings)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => { if (open) void load(song) }, [load, open, song])
  const active = useMemo(() => lines.reduce((result, line, index) => line.time <= time ? index : result, -1), [lines, time])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      lastFocus.current = document.activeElement as HTMLElement | null
      dialog.showModal()
      dialog.querySelector<HTMLButtonElement>('[data-immersive-close]')?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
      lastFocus.current?.focus?.()
      lastFocus.current = null
    }
  }, [open])
  useEffect(() => {
    if (active < 0) return
    const line = lineRefs.current[active]
    if (!line) return
    line.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [active])
  const lyricStyle = { '--react-lyric-size': `${Math.max(.9, Number(settings.lyricFontSize || 1.25))}rem` } as CSSProperties
  const title = songTitle(song)
  return <dialog ref={dialogRef} className="react-immersive-lyrics-dialog" aria-labelledby="immersive-lyrics-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="react-immersive-lyrics" style={lyricStyle}>
      <header className="react-immersive-lyrics-header">
        <div><p className="react-eyebrow">正在播放</p><h2 id="immersive-lyrics-title">{song ? title : '歌词'}</h2>{song && <p>{songArtist(song)}</p>}</div>
        <button type="button" className="react-icon-button" data-immersive-close aria-label="关闭沉浸式歌词" onClick={onClose}><Icon name="xmark" /></button>
      </header>
      <div className="react-immersive-lyrics-grid">
        <section className="react-vinyl-panel" aria-label={song ? `${title}封面` : '暂无歌曲'}>
          <div className={`react-vinyl ${isPlaying ? 'is-spinning' : ''}`}><div className="react-vinyl-record"><span className="react-vinyl-label">云音</span></div><SafeImage className="react-vinyl-cover" src={songImage(song)} width="360" height="360" alt={song ? `${title}封面` : ''} /><span className="react-vinyl-hole" /></div>
          <div className="react-vinyl-meta"><strong>{song ? title : '选择一首歌曲开始播放'}</strong><span>{song ? songArtist(song) : '沉浸式歌词'}</span></div>
        </section>
        <section className="react-immersive-lyrics-list" aria-label="歌词" aria-live="polite">
          {loading ? <Loading label="正在加载歌词…" /> : error ? <p className="react-error" role="alert">{error}</p> : lines.length ? lines.map((line, index) => <button type="button" key={`${line.time}-${index}`} ref={element => { lineRefs.current[index] = element }} className={index === active ? 'is-active' : ''} aria-current={index === active ? 'true' : undefined} onClick={() => usePlaybackStore.getState().seek(line.time)}><span>{line.text}</span>{Boolean(settings.showLyricTranslation) && line.translation && <small>{line.translation}</small>}{Boolean(settings.showLyricRoma) && line.roma && <small>{line.roma}</small>}</button>) : <div className="react-empty"><Icon name="file-lines" /><p>暂无歌词</p></div>}
        </section>
      </div>
      <PlayerFooterBar embedded />
    </div>
  </dialog>
}

export function LyricsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <ImmersiveLyricsView open={open} onClose={onClose} />
}

function CommentItemView({ item, nested = false }: { item: CommentItem; nested?: boolean }) {
  const replies = Array.isArray(item.reply) ? item.reply : []
  const timestamp = item.timeStr || (item.time ? new Date(item.time).toLocaleString() : '')
  return <article className={`react-comment-item ${nested ? 'is-reply' : ''}`}><img src={safeImageUrl(item.avatar)} width="40" height="40" loading="lazy" alt={`${String(item.userName || '用户')}的头像`} /><div><header><strong>{String(item.userName || '用户')}</strong><small>{String(item.likedCount ?? 0)} 赞</small></header><p>{String(item.text || '')}</p><footer>{String(timestamp)}{item.location ? ` · ${String(item.location)}` : ''}</footer>{replies.length > 0 && <div className="react-comment-replies">{replies.map((reply, index) => <CommentItemView key={`${String(reply.userName)}-${index}`} item={reply} nested />)}</div>}</div></article>
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
  useEffect(() => { if (open) void load(song, type, 1) }, [load, open, song])
  return <Modal open={open} title={song ? `${songTitle(song)} · 评论` : '评论'} onClose={onClose}><div className="react-comments-dialog"><div className="react-comment-tabs" role="tablist"><button type="button" role="tab" aria-selected={type === 'hot'} className={type === 'hot' ? 'is-active' : ''} onClick={() => setType('hot')}>热门</button><button type="button" role="tab" aria-selected={type === 'new'} className={type === 'new' ? 'is-active' : ''} onClick={() => setType('new')}>最新</button><span>{total ? `${total} 条` : ''}</span></div>{loading ? <Loading label="正在加载评论…" /> : error ? <p className="react-error" role="alert">{error}</p> : items.length ? <div className="react-comment-list">{items.map((item, index) => <CommentItemView key={`${String(item.userName)}-${String(item.time)}-${index}`} item={item} />)}</div> : <div className="react-empty"><Icon name="comments" /><p>暂无评论</p></div>}<nav className="react-comment-pagination" aria-label="评论分页"><button type="button" onClick={previous} disabled={loading || page <= 1}>上一页</button><span>第 {page} / {maxPage} 页</span><button type="button" onClick={next} disabled={loading || page >= maxPage}>下一页</button></nav></div></Modal>
}

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const login = useAuthStore(state => state.login)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await login(password); onClose() } catch (e) { setError(e instanceof Error ? e.message : '登录失败') } }
  return <Modal open={open} title="访问播放器" onClose={onClose}><form className="react-dialog-form" onSubmit={submit}><label htmlFor="player-password">访问密码</label><input id="player-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />{error && <p className="react-error" role="alert">{error}</p>}<Button variant="primary" type="submit">进入播放器</Button></form></Modal>
}

export function UserLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const userLogin = useAuthStore(state => state.userLogin)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await userLogin(username, password); await useLibraryStore.getState().hydrate(); onClose() } catch (e) { setError(e instanceof Error ? e.message : '登录失败') } }
  return <Modal open={open} title="登录用户账户" onClose={onClose}><form className="react-dialog-form" onSubmit={submit}><label htmlFor="user-name">用户名</label><input id="user-name" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /><label htmlFor="user-password">密码</label><input id="user-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />{error && <p className="react-error" role="alert">{error}</p>}<Button variant="primary" type="submit">登录</Button></form></Modal>
}

export function CreateListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createList = useLibraryStore(state => state.createList)
  const notify = usePlayerUiStore(state => state.notify)
  const [name, setName] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; try { await createList(name.trim()); setName(''); onClose(); notify('歌单已创建') } catch (error) { notify(error instanceof Error ? error.message : '创建歌单失败') } }
  return <Modal open={open} title="新建歌单" onClose={onClose}><form className="react-dialog-form" onSubmit={submit}><label htmlFor="new-list-name">歌单名称</label><input id="new-list-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} /><Button variant="primary" type="submit">创建</Button></form></Modal>
}
