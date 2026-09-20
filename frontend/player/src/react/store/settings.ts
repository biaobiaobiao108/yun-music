import { create } from 'zustand'
import { playerApi, persistLegacySettings, readLegacySettings } from '../api'
import { usePlaybackStore } from './playback'
import { applyAppearance, DEFAULT_SETTINGS, type PlayerSettings } from './shared'

export type SettingsState = {
  settings: PlayerSettings
  setSetting: (key: string, value: unknown) => void
  hydrate: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: readLegacySettings(DEFAULT_SETTINGS) as PlayerSettings,
  setSetting: (key, value) => {
    const settings = { ...get().settings, [key]: value } as PlayerSettings
    set({ settings })
    persistLegacySettings(settings)
    applyAppearance(settings)
    void playerApi.saveSettings({ [key]: value }).catch(() => undefined)
  },
  hydrate: async () => {
    const local = readLegacySettings(DEFAULT_SETTINGS) as PlayerSettings
    set({ settings: local })
    applyAppearance(local)
    usePlaybackStore.getState().setQuality(String(local.preferredQuality || 'flac'))
    try {
      const remote = await playerApi.settings()
      if (remote && typeof remote === 'object') {
        const settings = { ...local, ...remote } as PlayerSettings
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
