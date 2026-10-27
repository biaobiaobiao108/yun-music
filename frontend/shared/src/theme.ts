import { readJson, writeJson } from './storage'

export type Appearance = 'system' | 'light' | 'dark'
/** Legacy preference values remain readable for existing user settings. */
export type AccentTheme = 'netease' | 'emerald' | 'blue' | 'amber' | 'violet' | 'rose'

export type ThemePreferences = {
  appearance?: Appearance
  themeColor?: AccentTheme | string
  colorTheme?: AccentTheme | string
}

const SETTINGS_KEY = 'lx_settings'
const TITLE_BAR_COLORS = { light: '#ffffff', dark: '#171719' } as const
let appearanceChangeListener: (() => void) | null = null
let appearanceMedia: MediaQueryList | null = null
let storageSyncInstalled = false

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

export function readThemePreferences(): ThemePreferences {
  if (typeof localStorage === 'undefined') return {}
  return readJson<ThemePreferences>(localStorage, SETTINGS_KEY, {})
}

export function applyThemePreferences(preferences: ThemePreferences): void {
  const element = root()
  if (!element) return
  if (!storageSyncInstalled && typeof window !== 'undefined') {
    storageSyncInstalled = true
    window.addEventListener('storage', event => {
      if (event.key !== SETTINGS_KEY) return
      try {
        applyThemePreferences(event.newValue ? (JSON.parse(event.newValue) as ThemePreferences) : {})
      } catch {
        applyThemePreferences({})
      }
    })
  }
  const preference =
    preferences.appearance === 'dark' || preferences.appearance === 'light' ? preferences.appearance : 'system'
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  const applyResolvedAppearance = () => {
    const appearance =
      preference === 'system' && media?.matches ? 'dark' : preference === 'system' ? 'light' : preference
    element.dataset.appearance = appearance
    element.dataset.appearancePreference = preference
    element.style.colorScheme = appearance
    const color = TITLE_BAR_COLORS[appearance]
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = color
  }
  if (appearanceChangeListener && appearanceMedia)
    appearanceMedia.removeEventListener('change', appearanceChangeListener)
  appearanceChangeListener = preference === 'system' && media ? applyResolvedAppearance : null
  appearanceMedia = appearanceChangeListener ? media : null
  if (appearanceChangeListener && appearanceMedia) appearanceMedia.addEventListener('change', appearanceChangeListener)
  applyResolvedAppearance()
  // Keep the historic data attribute stable while the shared design system
  // now uses one fixed red accent. Old custom accent preferences are retained
  // in storage, but intentionally no longer affect the UI.
  element.dataset.theme = 'netease'
}

export function updateThemePreferences(next: Partial<ThemePreferences>): ThemePreferences {
  const current = readThemePreferences()
  const merged = { ...current, ...next }
  if (typeof localStorage !== 'undefined') writeJson(localStorage, SETTINGS_KEY, merged)
  applyThemePreferences(merged)
  return merged
}

export function toggleAppearance(current: Appearance): Appearance {
  return current === 'dark' ? 'light' : 'dark'
}
