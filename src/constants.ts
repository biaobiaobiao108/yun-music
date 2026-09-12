export const ENV_PARAMS = [
  'PORT',
  'BIND_IP',
  'CONFIG_PATH',
  'LOG_PATH',
  'DATA_PATH',
  'PROXY_HEADER',
  'MAX_SNAPSHOT_NUM',
  'LIST_ADD_MUSIC_LOCATION_TYPE',
  'FRONTEND_PASSWORD',
  'USER_ENABLE_PATH',
  'USER_ENABLE_ROOT',
  'ENABLE_WEBPLAYER_AUTH',
  'WEBPLAYER_PASSWORD',
  'DISABLE_TELEMETRY',
  'ENABLE_PUBLIC_USER_RESTRICTION',
  'ENABLE_PUBLIC_NON_ADMIN_LOCAL_MUSIC',
  'ENABLE_PUBLIC_FAVORITES',
  'ENABLE_PUBLIC_NON_ADMIN_ACCESS',
  'ENABLE_LOGIN_USER_CACHE_RESTRICTION',
  'ENABLE_CACHE_SIZE_LIMIT',
  'CACHE_SIZE_LIMIT',
  'PROXY_ALL_ENABLED',
  'PROXY_ALL_ADDRESS',
  'ADMIN_PATH',
  'PLAYER_PATH',
  'SINGER_SOURCE_PRIORITY',
  'SERVER_NAME',
  'LX_USER_',
] as const

export const SPLIT_CHAR = {
  DISLIKE_NAME: '@',
  DISLIKE_NAME_ALIAS: '#',
} as const

export const LIST_IDS = {
  DEFAULT: 'default',
  LOVE: 'love',
  TEMP: 'temp',
  DOWNLOAD: 'download',
  PLAY_LATER: null,
} as const

export const File = {
  serverInfoJSON: 'serverInfo.json',
  userDir: 'users',
  userSettingsJSON: 'settings.json',
  userSoundEffectsJSON: 'soundEffects.json',
  userTokensJSON: 'token.json',
  listDir: 'list',
  listSnapshotDir: 'snapshot',
  listSnapshotInfoJSON: 'snapshotInfo.json',
  dislikeDir: 'dislike',
  dislikeSnapshotDir: 'snapshot',
  dislikeSnapshotInfoJSON: 'snapshotInfo.json',
} as const

export const FeaturesList = [
  'list',
  'dislike',
] as const
