import { type UserDataManage } from '@/user/data'
import { getDb } from '@/database'
import {
  assertSnapshotData,
  assertSnapshotId,
  getSnapshotInfo as readSnapshotInfo,
  MAX_SNAPSHOT_DATA_BYTES,
  MAX_SNAPSHOT_ID_BYTES,
  pruneSnapshots,
  removeSnapshot as removeStoredSnapshot,
  type SnapshotInfo,
} from '@/modules/snapshotStorage'

export { MAX_SNAPSHOT_DATA_BYTES, MAX_SNAPSHOT_ID_BYTES }
export { assertSnapshotData, assertSnapshotId }
export type { SnapshotInfo }

export class SnapshotDataManage {
  readonly userDataManage: UserDataManage
  readonly module = 'list'

  getSnapshotInfo = async (): Promise<SnapshotInfo> => readSnapshotInfo(this.userDataManage.userName, this.module)

  saveSnapshotInfo = (info: SnapshotInfo): void => {
    if (!info.latest) return
    assertSnapshotId(info.latest)
    getDb().run(
      'INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)',
      [this.userDataManage.userName, this.module, info.latest, info.time || Date.now()]
    )
    pruneSnapshots(this.userDataManage.userName, this.module)
  }

  getSnapshot = async (name: string): Promise<LX.List.ListData | null> => {
    assertSnapshotId(name)
    const row = getDb().query<{ data: string }, [string, string, string]>(
      'SELECT data FROM snapshots WHERE user_name = ? AND module = ? AND id = ?'
    ).get(this.userDataManage.userName, this.module, name)
    if (!row) return null
    try {
      return JSON.parse(row.data) as LX.List.ListData
    } catch {
      return null
    }
  }

  saveSnapshot = async (name: string, data: string): Promise<void> => {
    assertSnapshotId(name)
    assertSnapshotData(data)
    getDb().run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [name, this.userDataManage.userName, this.module, data, Buffer.byteLength(data, 'utf8'), Date.now()]
    )
  }

  saveSnapshotWithTime = async (name: string, data: string, time: number): Promise<void> => {
    assertSnapshotId(name)
    assertSnapshotData(data)
    getDb().run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [name, this.userDataManage.userName, this.module, data, Buffer.byteLength(data, 'utf8'), time || Date.now()]
    )
    pruneSnapshots(this.userDataManage.userName, this.module)
  }

  removeSnapshot = async (name: string): Promise<void> => {
    assertSnapshotId(name)
    removeStoredSnapshot(this.userDataManage.userName, this.module, name)
  }

  getSnapshotListWithMeta = async (): Promise<Array<{ id: string; time: number; size: number }>> => {
    pruneSnapshots(this.userDataManage.userName, this.module)
    const rows = getDb().query<{ id: string; created_at: number; size: number }, [string, string]>(
      'SELECT id, created_at, size FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC'
    ).all(this.userDataManage.userName, this.module)
    return rows.map(row => ({ id: row.id, time: row.created_at, size: row.size }))
  }

  setLatest = (name: string): void => {
    assertSnapshotId(name)
    getDb().run(
      'INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)',
      [this.userDataManage.userName, this.module, name, Date.now()]
    )
  }

  constructor(userDataManage: UserDataManage) {
    this.userDataManage = userDataManage
  }
}
