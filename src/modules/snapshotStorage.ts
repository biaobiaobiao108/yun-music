import { getDb } from '@/database'
import { getUserConfig } from '@/user/data'

export interface SnapshotInfo {
  latest: string | null
  time: number
  list: string[]
}

interface SnapshotRow {
  id: string
  size: number
  created_at: number
}

export const MAX_SNAPSHOT_ID_BYTES = 256
export const MAX_SNAPSHOT_DATA_BYTES = 20 * 1024 * 1024
/** Keep the history bounded even if a legacy/configured count is set very high. */
export const MAX_STORED_SNAPSHOT_COUNT = 100
/** Bound each user/module history independently from the configured count. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024

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
  'SELECT id, size, created_at FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC, id DESC'
).all(userName, module)

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
export const pruneSnapshots = (userName: string, module: string): void => {
  const db = getDb()
  const rows = getSnapshotRows(userName, module)
  if (rows.length === 0) {
    db.run('DELETE FROM snapshot_meta WHERE user_name = ? AND module = ?', [userName, module])
    return
  }

  const configuredCount = Number(getUserConfig(userName).maxSnapshotNum)
  const maxSnapshots = Number.isFinite(configuredCount)
    ? Math.max(1, Math.min(MAX_STORED_SNAPSHOT_COUNT, Math.floor(configuredCount)))
    : 10
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

  for (const row of rows) {
    if (keep.has(row.id) || keep.size >= maxSnapshots) continue
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
    db.run('DELETE FROM snapshots WHERE user_name = ? AND module = ? AND id = ?', [userName, module, id])
    const meta = db.query<{ latest_id: string | null }, [string, string]>(
      'SELECT latest_id FROM snapshot_meta WHERE user_name = ? AND module = ?'
    ).get(userName, module)
    if (meta?.latest_id === id) {
      const next = db.query<{ id: string; created_at: number }, [string, string]>(
        'SELECT id, created_at FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC, id DESC LIMIT 1'
      ).get(userName, module)
      if (next) {
        db.run(
          'UPDATE snapshot_meta SET latest_id = ?, updated_at = ? WHERE user_name = ? AND module = ?',
          [next.id, next.created_at || Date.now(), userName, module],
        )
      } else {
        db.run('DELETE FROM snapshot_meta WHERE user_name = ? AND module = ?', [userName, module])
      }
    }
  })()
}
