export const MUSIC_SOURCE_OPTIONS: ReadonlyArray<{ value: 'wy' | 'tx'; label: string }> = [
  { value: 'wy', label: '网易云音乐' },
  { value: 'tx', label: 'QQ 音乐' },
]

export type MusicSource = (typeof MUSIC_SOURCE_OPTIONS)[number]['value']

export const PLAYBACK_SETTINGS_DEFAULTS = {
  defaultSource: 'wy',
  preferredQuality: 'flac',
  enableAutoSwitchSource: true,
  enableAutoDegradeQuality: true,
  enableServerCache: true,
  enableServerLyricCache: true,
  embedLyricToFile: true,
} as const

export type PlaybackSettings = {
  defaultSource: MusicSource
  preferredQuality: string
  enableAutoSwitchSource: boolean
  enableAutoDegradeQuality: boolean
  enableServerCache: boolean
  enableServerLyricCache: boolean
  embedLyricToFile: boolean
}

const QUALITY_VALUES = new Set(['128k', '320k', 'flac', 'hires'])

export function normalizeMusicSource(value: unknown): MusicSource {
  return value === 'tx' ? 'tx' : 'wy'
}

export function normalizePreferredQuality(value: unknown): string {
  const quality = String(value || '')
  return QUALITY_VALUES.has(quality) ? quality : PLAYBACK_SETTINGS_DEFAULTS.preferredQuality
}

export function normalizePlaybackSettings(value: unknown): PlaybackSettings {
  const settings = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const record = settings as Record<string, unknown>
  return {
    defaultSource: normalizeMusicSource(record.defaultSource),
    preferredQuality: normalizePreferredQuality(record.preferredQuality),
    enableAutoSwitchSource: record.enableAutoSwitchSource !== false,
    enableAutoDegradeQuality: record.enableAutoDegradeQuality !== false,
    enableServerCache: record.enableServerCache !== false,
    enableServerLyricCache: record.enableServerLyricCache !== false,
    embedLyricToFile: record.embedLyricToFile !== false,
  }
}
