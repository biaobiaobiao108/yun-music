import { create } from 'zustand'
import { playerApi, persistLegacySettings, readLegacySettings } from '../api'
import { usePlaybackStore } from './playback'
import { applyAppearance, DEFAULT_SETTINGS, type PlayerSettings } from './shared'

export type SettingsState = {
  settings: PlayerSettings
  setSetting: (key: string, value: unknown) => void
  hydrate: () => Promise<void>
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
    const settings = sanitizeSettings({ ...get().settings, [key]: value })
    set({ settings })
    persistLegacySettings(settings)
    applyAppearance(settings)
    void playerApi.saveSettings({ [key]: value }).catch(() => undefined)
  },
  hydrate: async () => {
    const local = sanitizeSettings(readLegacySettings(DEFAULT_SETTINGS))
    set({ settings: local })
    applyAppearance(local)
    usePlaybackStore.getState().setQuality(String(local.preferredQuality || 'flac'))
    try {
      const remote = await playerApi.settings()
      if (remote && typeof remote === 'object') {
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
}))

export { DEFAULT_SETTINGS, type PlayerSettings }
