import { create } from 'zustand'
import { playerApi, persistLegacySettings, readLegacySettings } from '../api'
import { getSessionGeneration, getSessionScope } from '../session'
import { usePlaybackStore } from './playback'
import { applyAppearance, DEFAULT_SETTINGS, type PlayerSettings } from './shared'

let settingsRevision = 0
let settingsHydrationId = 0

export type SettingsState = {
  settings: PlayerSettings
  setSetting: (key: string, value: unknown) => void
  hydrate: () => Promise<void>
  reset: () => void
}

const REMOVED_SETTING_KEYS = ['showFooterVisualizer', 'enableSoundEffects', 'soundEffectsPreset', 'soundEffectsGain'] as const

function sanitizeSettings(value: Record<string, unknown>): PlayerSettings {
  const next = { ...value } as Record<string, unknown>
  for (const key of REMOVED_SETTING_KEYS) delete next[key]
  return next as PlayerSettings
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: sanitizeSettings(readLegacySettings(DEFAULT_SETTINGS)),
  setSetting: (key, value) => {
    if (REMOVED_SETTING_KEYS.includes(key as typeof REMOVED_SETTING_KEYS[number])) return
    settingsRevision += 1
    const settings = sanitizeSettings({ ...get().settings, [key]: value })
    set({ settings })
    persistLegacySettings(settings)
    applyAppearance(settings)
    void playerApi.saveSettings({ [key]: value }).catch(() => undefined)
  },
  hydrate: async () => {
    const hydrationId = ++settingsHydrationId
    const sessionScope = getSessionScope()
    const sessionGeneration = getSessionGeneration()
    const local = sanitizeSettings(readLegacySettings(DEFAULT_SETTINGS))
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
        const settings = sanitizeSettings({ ...local, ...remote })
        set({ settings })
        persistLegacySettings(settings)
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
    const settings = sanitizeSettings(DEFAULT_SETTINGS)
    set({ settings })
    applyAppearance(settings)
    usePlaybackStore.getState().setQuality(String(settings.preferredQuality || 'flac'))
  },
}))

export { DEFAULT_SETTINGS, type PlayerSettings }
