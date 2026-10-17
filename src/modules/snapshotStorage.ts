import { getDb } from '@/database'
import { getMaxSnapshotNum } from '@/user/data'

export interface SnapshotInfo {
  latest: string | null
  time: number
  list: string[]
}

interface SnapshotRow {
  id: string
  size: number
  created_at: number
  stored_at: number
}

export const MAX_SNAPSHOT_ID_BYTES = 256
export const MAX_SNAPSHOT_DATA_BYTES = 20 * 1024 * 1024
/** Keep the history bounded even if a legacy/configured count is set very high. */
export const MAX_STORED_SNAPSHOT_COUNT = 100
/** Bound each user/module history independently from the configured count. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024

export class SnapshotConflictError extends Error {}

export function assertSnapshotId(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > MAX_SNAPSHOT_ID_BYTES || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('快照标识无效')
  }
}

export function assertSnapshotData(data: unknown): asserts data is string {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_SNAPSHOT_DATA_BYTES) {
    throw new Error('快照数据过大或格式无效')
  }
}

const getSnapshotRows = (userName: string, module: string): SnapshotRow[] => getDb().query<SnapshotRow, [string, string]>(
  // Prune order is "most recently stored", not "newest display timestamp":
  // an imported backup keeps its old mtime and must not be treated as stale.
  // Rows migrated from v4 have stored_at backfilled from created_at, so their
  // previous order is preserved.
  'SELECT id, size, created_at, stored_at FROM snapshots WHERE user_name = ? AND module = ? ORDER BY stored_at DESC, created_at DESC, id DESC'
).all(userName, module)

/** Strictly increasing per user/module, so two writes in the same ms still order. */
const nextStoredAt = (userName: string, module: string): number => {
  const row = getDb().query<{ value: number | null }, [string, string]>(
    'SELECT max(stored_at) AS value FROM snapshots WHERE user_name = ? AND module = ?'
  ).get(userName, module)
  return Math.max(Date.now(), (Number(row?.value) || 0) + 1)
}

/**
 * 写入一条快照。createdAt 是展示时间（导入备份时为文件 mtime），
 * 裁剪顺序用的是这里写入的 stored_at，两者必须分开，否则导入的旧备份
 * 会被同一请求里的 pruneSnapshots 立刻删除。
 */
export const writeSnapshot = (
  userName: string,
  module: string,
  id: string,
  data: string,
  createdAt: number,
  options: { prune?: boolean } = {},
): void => {
  assertSnapshotId(id)
  assertSnapshotData(data)
  const db = getDb()
  db.transaction(() => {
    // Importing history must not overwrite the only durable copy of live data.
    if (options.prune) {
      const current = db.query<{ data: string }, [string, string, string]>(
        'SELECT s.data FROM snapshots s JOIN snapshot_meta m ON s.user_name = m.user_name AND s.module = m.module AND s.id = m.latest_id WHERE s.user_name = ? AND s.module = ? AND s.id = ?'
      ).get(userName, module, id)
      if (current && current.data !== data) throw new SnapshotConflictError('不能覆盖当前使用的快照，请更换文件名后上传')
    }
    db.run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userName, module, data, Buffer.byteLength(data, 'utf8'), createdAt || Date.now(), nextStoredAt(userName, module)],
    )
    if (!options.prune) return
    pruneSnapshots(userName, module, { protectIds: [id] })
    const stored = getDb().query<{ id: string }, [string, string, string]>(
      'SELECT id FROM snapshots WHERE user_name = ? AND module = ? AND id = ?'
    ).get(userName, module, id)
    if (!stored) throw new Error('快照写入后未能在历史中保留，请检查快照数量/容量上限')
  })()
}

const repairLatestSnapshot = (userName: string, module: string, rows: SnapshotRow[], latestId: string | null | undefined, updatedAt = Date.now()): string | null => {
  // Absence of metadata is meaningful: imported history should not become the
  // current snapshot until the caller explicitly sets it.
  if (latestId === undefined) return null
  const nextLatest = latestId && rows.some(row => row.id === latestId) ? latestId : (rows[0]?.id ?? null)
  if (nextLatest === latestId) return nextLatest

  const db = getDb()
  if (nextLatest) {
    db.run(
      'INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)',
      [userName, module, nextLatest, rows.find(row => row.id === nextLatest)?.created_at || updatedAt],
    )
  } else {
    db.run('DELETE FROM snapshot_meta WHERE user_name = ? AND module = ?', [userName, module])
  }
  return nextLatest
}

export const getSnapshotInfo = (userName: string, module: string): SnapshotInfo => {
  const db = getDb()
  const rows = getSnapshotRows(userName, module)
  const meta = db.query<{ latest_id: string | null; updated_at: number }, [string, string]>(
    'SELECT latest_id, updated_at FROM snapshot_meta WHERE user_name = ? AND module = ?'
  ).get(userName, module)
  const latest = repairLatestSnapshot(userName, module, rows, meta?.latest_id, meta?.updated_at)
  return {
    latest,
    time: latest === meta?.latest_id ? (meta?.updated_at ?? 0) : (rows.find(row => row.id === latest)?.created_at ?? 0),
    list: rows.map(row => row.id),
  }
}

/** Enforce both the configured history count and a hard per-module byte budget. */
export const pruneSnapshots = (
  userName: string,
  module: string,
  options: { protectIds?: readonly string[] } = {},
): void => {
  const db = getDb()
  const rows = getSnapshotRows(userName, module)
  if (rows.length === 0) {
    db.run('DELETE FROM snapshot_meta WHERE user_name = ? AND module = ?', [userName, module])
    return
  }

  const maxSnapshots = Math.max(1, Math.min(MAX_STORED_SNAPSHOT_COUNT, Math.floor(getMaxSnapshotNum(userName))))
  const latestMeta = db.query<{ latest_id: string | null }, [string, string]>(
    'SELECT latest_id FROM snapshot_meta WHERE user_name = ? AND module = ?'
  ).get(userName, module)
  const latestId = latestMeta?.latest_id

  const keep = new Set<string>()
  let keptBytes = 0
  const keepRow = (row: SnapshotRow): void => {
    keep.add(row.id)
    keptBytes += Math.max(0, Number(row.size) || 0)
  }

  // Never prune the current snapshot solely because it was imported with an old timestamp.
  const latestRow = latestId ? rows.find(row => row.id === latestId) : undefined
  if (latestRow) keepRow(latestRow)

  // Callers may pin the row they just wrote. Without this, importing a backup
  // whose file mtime is older than the newest N snapshots deleted the imported
  // row inside the same request while still returning success (CODE_REVIEW P0-2).
  // Pinned rows count toward the limits, so an older snapshot is evicted instead.
  for (const id of options.protectIds ?? []) {
    const row = rows.find(item => item.id === id)
    if (row && !keep.has(row.id)) keepRow(row)
  }

  // Reject atomically instead of acknowledging an import that the next read
  // would evict. The current snapshot counts toward the configured limit.
  if (keep.size > maxSnapshots || keptBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
    throw new SnapshotConflictError('快照保留空间不足，请提高快照数量上限或先删除历史快照后重试')
  }

  for (const row of rows) {
    if (keep.has(row.id)) continue
    if (keep.size >= maxSnapshots) break
    if (keep.size > 0 && keptBytes + Math.max(0, Number(row.size) || 0) > MAX_SNAPSHOT_TOTAL_BYTES) continue
    keepRow(row)
  }

  db.transaction(() => {
    for (const row of rows) {
      if (!keep.has(row.id)) {
        db.run('DELETE FROM snapshots WHERE user_name = ? AND module = ? AND id = ?', [userName, module, row.id])
      }
    }

    // Legacy/imported data may contain a stale latest pointer. Repair it after pruning.
    repairLatestSnapshot(userName, module, rows.filter(row => keep.has(row.id)), latestId)
  })()
}

export const removeSnapshot = (userName: string, module: string, id: string): void => {
  const db = getDb()
  db.transaction(() => {
    const meta = db.query<{ latest_id: string | null }, [string, string]>(
      'SELECT latest_id FROM snapshot_meta WHERE user_name = ? AND module = ?'
    ).get(userName, module)
    if (meta?.latest_id === id) {
      throw new SnapshotConflictError('不能删除当前使用的快照，请先恢复其他快照或保存新的歌单')
    }
    db.run('DELETE FROM snapshots WHERE user_name = ? AND module = ? AND id = ?', [userName, module, id])
  })()
}
