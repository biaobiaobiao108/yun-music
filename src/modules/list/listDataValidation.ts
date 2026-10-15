import { LIST_IDS } from '@/constants'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

/** Validate external backups before publishing any part of their state. */
export function assertListData(value: unknown): asserts value is LX.List.ListData {
  const isMusicList = (list: unknown): boolean => Array.isArray(list) && list.every(isRecord)
  if (!isRecord(value) || !isMusicList(value.defaultList) || !isMusicList(value.loveList) || !Array.isArray(value.userList)) {
    throw new Error('歌单数据格式无效')
  }
  const ids = new Set<string>([LIST_IDS.DEFAULT, LIST_IDS.LOVE, LIST_IDS.TEMP])
  for (const list of value.userList) {
    if (!isRecord(list) || typeof list.id !== 'string' || !list.id.trim() || ids.has(list.id)
      || typeof list.name !== 'string' || !isMusicList(list.list)) {
      throw new Error('歌单数据格式无效或包含重复 ID')
    }
    ids.add(list.id)
  }
}
