import { applyThemePreferences } from '../../../../shared/src/theme'
import { readString } from '../../../../shared/src/storage'

export function browserStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export const DEFAULT_SETTINGS = {
  appearance: 'system',
  themeColor: 'netease',
  defaultEntry: 'favorites',
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

type WidenSetting<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T
export type PlayerSettings = { [K in keyof typeof DEFAULT_SETTINGS]: WidenSetting<(typeof DEFAULT_SETTINGS)[K]> } & Record<string, unknown>

export function applyAppearance(settings: Record<string, unknown>): void {
  applyThemePreferences({
    appearance: String(settings.appearance || settings.theme || 'system') as 'system' | 'light' | 'dark',
    themeColor: String(settings.themeColor || settings.colorTheme || 'netease'),
  })
}

export function initialUserName(): string | null {
  return readString(browserStorage(), 'lx_user_name') || null
}
