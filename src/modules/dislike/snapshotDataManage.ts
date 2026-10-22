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
  writeSnapshot,
  type SnapshotInfo,
} from '@/modules/snapshotStorage'

export { MAX_SNAPSHOT_DATA_BYTES, MAX_SNAPSHOT_ID_BYTES }
export type { SnapshotInfo }

export class SnapshotDataManage {
  readonly userDataManage: UserDataManage
  readonly module = 'dislike'

  getSnapshotInfo = async (): Promise<SnapshotInfo> => readSnapshotInfo(this.userDataManage.userName, this.module)

  saveSnapshotInfo = (info: SnapshotInfo): void => {
    if (!info.latest) return
    assertSnapshotId(info.latest)
    getDb().run('INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)', [
      this.userDataManage.userName,
      this.module,
      info.latest,
      info.time || Date.now(),
    ])
    pruneSnapshots(this.userDataManage.userName, this.module)
  }

  getSnapshot = async (name: string): Promise<LX.Dislike.DislikeRules | null> => {
    assertSnapshotId(name)
    const row = getDb()
      .query<{ data: string }, [string, string, string]>(
        'SELECT data FROM snapshots WHERE user_name = ? AND module = ? AND id = ?',
      )
      .get(this.userDataManage.userName, this.module, name)
    return row?.data ?? null
  }

  saveSnapshot = async (name: string, data: string): Promise<void> => {
    writeSnapshot(this.userDataManage.userName, this.module, name, data, Date.now())
  }

  saveSnapshotWithTime = async (name: string, data: string, time: number): Promise<void> => {
    writeSnapshot(this.userDataManage.userName, this.module, name, data, time, { prune: true })
  }

  removeSnapshot = async (name: string): Promise<void> => {
    assertSnapshotId(name)
    removeStoredSnapshot(this.userDataManage.userName, this.module, name)
  }

  getSnapshotListWithMeta = async (): Promise<Array<{ id: string; time: number; size: number }>> => {
    pruneSnapshots(this.userDataManage.userName, this.module)
    const rows = getDb()
      .query<{ id: string; created_at: number; size: number }, [string, string]>(
        'SELECT id, created_at, size FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC',
      )
      .all(this.userDataManage.userName, this.module)
    return rows.map(row => ({ id: row.id, time: row.created_at, size: row.size }))
  }

  setLatest = (name: string): void => {
    assertSnapshotId(name)
    getDb().run('INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)', [
      this.userDataManage.userName,
      this.module,
      name,
      Date.now(),
    ])
  }

  constructor(userDataManage: UserDataManage) {
    this.userDataManage = userDataManage
  }
}
