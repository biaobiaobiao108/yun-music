import { applyThemePreferences } from '../../../../shared/src/theme'
import { readString } from '../../../../shared/src/storage'

export function browserStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export const DEFAULT_SETTINGS = {
  appearance: 'system',
  themeColor: 'netease',
  defaultEntry: 'favorites',
  defaultSource: 'wy',
  preferredQuality: 'flac',
  defaultDownloadTarget: 'server',
  defaultDownloadQuality: 'flac',
  enablePublicSources: true,
  downloadConcurrency: 3,
  hotSearchLimit: 20,
  lyricFontSize: 1.25,
  lyricFontFamily: '',
  autoResume: true,
  showSidebarSongInfo: false,
  enableCrossfade: true,
  keepScreenAwake: true,
  enableKeyboardShortcuts: true,
  showLyricTranslation: true,
  showLyricRoma: false,
  enableAutoSwitchSource: true,
  enableAutoDegradeQuality: true,
  enablePreloader: true,
  enableLyricGlow: true,
  playerBackground: 'blur',
  saveAccountSettingsToFile: true,
  serverCacheLocation: 'root',
  serverCacheNamingPattern: 'simple',
  switchPlaylistOnSearchPlay: true,
  switchPlaylistOnSongListPlay: true,
  enableOnlyDownloadMode: true,
  enableServerCache: true,
  enableServerLyricCache: true,
  embedLyricToFile: true,
  enableLyricCache: true,
  enableSongUrlCache: true,
  preferServerCache: true,
} as const

export type MusicSource = 'wy' | 'tx'

export const MUSIC_SOURCE_OPTIONS: ReadonlyArray<{ value: MusicSource; label: string }> = [
  { value: 'wy', label: '网易云音乐' },
  { value: 'tx', label: 'QQ 音乐' },
]

export function normalizeMusicSource(value: unknown): MusicSource {
  return value === 'tx' ? 'tx' : 'wy'
}

export function musicSourceLabel(value: unknown): string {
  const source = normalizeMusicSource(value)
  return MUSIC_SOURCE_OPTIONS.find(option => option.value === source)?.label ?? '网易云音乐'
}

type WidenSetting<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T
export type PlayerSettings = {
  [K in keyof typeof DEFAULT_SETTINGS]: WidenSetting<(typeof DEFAULT_SETTINGS)[K]>
} & Record<string, unknown>

export function applyAppearance(settings: Record<string, unknown>): void {
  applyThemePreferences({
    appearance: settings.appearance === 'dark' || settings.appearance === 'light' ? settings.appearance : 'system',
    themeColor: String(settings.themeColor || settings.colorTheme || 'netease'),
  })
}

export function initialUserName(): string | null {
  return readString(browserStorage(), 'lx_user_name') || null
}
