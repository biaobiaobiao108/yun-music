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
const TITLE_BAR_COLOR = '#ffffff'

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
  element.dataset.appearance = 'light'
  // Keep the historic data attribute stable while the shared design system
  // now uses one fixed red accent. Old custom accent preferences are retained
  // in storage, but intentionally no longer affect the UI.
  element.dataset.theme = 'netease'
  element.style.colorScheme = 'light'
  // The manifest color is only a fallback. Keep installed apps aligned with
  // the fixed light appearance.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = TITLE_BAR_COLOR
  }
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
