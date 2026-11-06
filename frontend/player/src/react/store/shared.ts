import { applyThemePreferences } from '../../../../shared/src/theme'
import { readString } from '../../../../shared/src/storage'
import {
  MUSIC_SOURCE_OPTIONS,
  normalizeMusicSource,
  PLAYBACK_SETTINGS_DEFAULTS,
} from '../../../../shared/src/playback-settings'

export { MUSIC_SOURCE_OPTIONS, normalizeMusicSource } from '../../../../shared/src/playback-settings'

export function browserStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export const DEFAULT_SETTINGS = {
  appearance: 'system',
  themeColor: 'netease',
  defaultEntry: 'favorites',
  ...PLAYBACK_SETTINGS_DEFAULTS,
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
  enablePreloader: true,
  enableLyricGlow: true,
  playerBackground: 'blur',
  saveAccountSettingsToFile: true,
  serverCacheLocation: 'root',
  serverCacheNamingPattern: 'simple',
  switchPlaylistOnSearchPlay: true,
  switchPlaylistOnSongListPlay: true,
  enableOnlyDownloadMode: true,
  enableLyricCache: true,
  enableSongUrlCache: true,
  preferServerCache: true,
} as const

export type MusicSource = (typeof MUSIC_SOURCE_OPTIONS)[number]['value']

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
