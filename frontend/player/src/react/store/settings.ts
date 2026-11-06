import { create } from 'zustand'
import { playerApi, persistLocalSettings, readLocalSettings } from '../api'
import { getSessionGeneration, getSessionScope, scopedStorageKey } from '../session'
import { usePlaybackStore } from './playback'
import { applyAppearance, DEFAULT_SETTINGS, type PlayerSettings } from './shared'
import { readThemePreferences, updateThemePreferences } from '../../../../shared/src/theme'

let settingsRevision = 0
let settingsHydrationId = 0
let settingsSaveGeneration = 0
const pendingSettingSaves = new Map<string, Promise<void>>()
const settingSaveErrors = new Map<string, string>()

export type SettingsState = {
  settings: PlayerSettings
  saveError: string
  setSetting: (key: string, value: unknown) => void
  clearSaveError: () => void
  hydrate: () => Promise<void>
  reset: () => void
}

const REMOVED_SETTING_KEYS = [
  'showFooterVisualizer',
  'enableSoundEffects',
  'soundEffectsPreset',
  'soundEffectsGain',
] as const

function sanitizeSettings(value: Record<string, unknown>): PlayerSettings {
  const next = { ...value } as Record<string, unknown>
  for (const key of REMOVED_SETTING_KEYS) delete next[key]
  return next as PlayerSettings
}

function withSharedAppearance(settings: PlayerSettings): PlayerSettings {
  const sharedAppearance = readThemePreferences().appearance
  return { ...settings, appearance: sharedAppearance || settings.appearance || 'system' }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: withSharedAppearance(sanitizeSettings(readLocalSettings(DEFAULT_SETTINGS))),
  saveError: '',
  setSetting: (key, value) => {
    if (REMOVED_SETTING_KEYS.includes(key as (typeof REMOVED_SETTING_KEYS)[number])) return
    settingsRevision += 1
    const settings = sanitizeSettings({ ...get().settings, [key]: value })
    set({ settings })
    persistLocalSettings(settings)
    if (key === 'appearance')
      updateThemePreferences({ appearance: value === 'dark' || value === 'light' ? value : 'system' })
    applyAppearance(settings)
    if (key === 'preferredQuality') usePlaybackStore.getState().setQuality(String(settings.preferredQuality || 'flac'))
    const sessionGeneration = getSessionGeneration()
    const saveGeneration = settingsSaveGeneration
    const saveKey = `${sessionGeneration}:${key}`
    const save = () =>
      sessionGeneration === getSessionGeneration() ? playerApi.saveSettings({ [key]: value }) : Promise.resolve()
    const previous = pendingSettingSaves.get(saveKey)
    const pending = (previous ? previous.then(save) : save())
      .then(() => {
        if (
          sessionGeneration === getSessionGeneration() &&
          saveGeneration === settingsSaveGeneration &&
          pendingSettingSaves.get(saveKey) === pending
        ) {
          settingSaveErrors.delete(key)
          set({ saveError: settingSaveErrors.values().next().value || '' })
        }
      })
      .catch(error => {
        if (
          sessionGeneration === getSessionGeneration() &&
          saveGeneration === settingsSaveGeneration &&
          pendingSettingSaves.get(saveKey) === pending
        ) {
          settingSaveErrors.set(key, error instanceof Error ? error.message : '设置同步失败，请稍后重试')
          set({ saveError: settingSaveErrors.values().next().value || '' })
        }
      })
      .finally(() => {
        if (pendingSettingSaves.get(saveKey) === pending) pendingSettingSaves.delete(saveKey)
      })
    pendingSettingSaves.set(saveKey, pending)
  },
  clearSaveError: () => {
    settingSaveErrors.clear()
    set({ saveError: '' })
  },
  hydrate: async () => {
    const hydrationId = ++settingsHydrationId
    const sessionScope = getSessionScope()
    const sessionGeneration = getSessionGeneration()
    const local = withSharedAppearance(sanitizeSettings(readLocalSettings(DEFAULT_SETTINGS)))
    set({ settings: local })
    applyAppearance(local)
    usePlaybackStore.getState().setQuality(String(local.preferredQuality || 'flac'))
    const localRevision = settingsRevision
    try {
      const remote = await playerApi.settings()
      if (
        remote &&
        typeof remote === 'object' &&
        hydrationId === settingsHydrationId &&
        sessionScope === getSessionScope() &&
        sessionGeneration === getSessionGeneration() &&
        localRevision === settingsRevision
      ) {
        const settings = withSharedAppearance(sanitizeSettings({ ...local, ...remote }))
        set({ settings })
        persistLocalSettings(settings)
        applyAppearance(settings)
        usePlaybackStore.getState().setQuality(String(settings.preferredQuality || 'flac'))
      }
    } catch {
      // Public mode can legitimately reject private settings.
    }
  },
  reset: () => {
    settingsRevision += 1
    settingsHydrationId += 1
    settingsSaveGeneration += 1
    settingSaveErrors.clear()
    const settings = withSharedAppearance(sanitizeSettings(DEFAULT_SETTINGS))
    set({ settings, saveError: '' })
    applyAppearance(settings)
    // Session reset happens before playback hydration; preserve the saved queue.
    usePlaybackStore.setState({ quality: String(settings.preferredQuality || 'flac') })
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === scopedStorageKey('lx_settings')) {
      settingsRevision += 1
      const settings = withSharedAppearance(sanitizeSettings(readLocalSettings(DEFAULT_SETTINGS)))
      useSettingsStore.setState({ settings })
      applyAppearance(settings)
      usePlaybackStore.getState().setQuality(String(settings.preferredQuality || 'flac'))
      return
    }
    if (event.key !== 'lx_settings') return
    const settings = {
      ...useSettingsStore.getState().settings,
      appearance: readThemePreferences().appearance || 'system',
    }
    useSettingsStore.setState({ settings })
    applyAppearance(settings)
  })
}

export { DEFAULT_SETTINGS, type PlayerSettings }
