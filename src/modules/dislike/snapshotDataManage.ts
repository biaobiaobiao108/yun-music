import { getUserConfig, type UserDataManage } from '@/user/data'
import { getDb } from '@/database'

export interface SnapshotInfo {
  latest: string | null
  time: number
  list: string[]
}

export class SnapshotDataManage {
  readonly userDataManage: UserDataManage
  readonly module = 'dislike'

  private clearOldSnapshot = (): void => {
    const db = getDb()
    const maxSnapshots = getUserConfig(this.userDataManage.userName).maxSnapshotNum
    const snapshots = db.query<{ id: string }, [string, string]>(
      'SELECT id FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC'
    ).all(this.userDataManage.userName, this.module)
    for (const snapshot of snapshots.slice(maxSnapshots)) {
      db.run('DELETE FROM snapshots WHERE user_name = ? AND module = ? AND id = ?', [this.userDataManage.userName, this.module, snapshot.id])
    }
  }

  getSnapshotInfo = async (): Promise<SnapshotInfo> => {
    const db = getDb()
    const meta = db.query<{ latest_id: string; updated_at: number }, [string, string]>(
      'SELECT latest_id, updated_at FROM snapshot_meta WHERE user_name = ? AND module = ?'
    ).get(this.userDataManage.userName, this.module)
    const rows = db.query<{ id: string }, [string, string]>(
      'SELECT id FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC'
    ).all(this.userDataManage.userName, this.module)
    return { latest: meta?.latest_id ?? null, time: meta?.updated_at ?? 0, list: rows.map(row => row.id) }
  }

  saveSnapshotInfo = (info: SnapshotInfo): void => {
    if (!info.latest) return
    getDb().run(
      'INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)',
      [this.userDataManage.userName, this.module, info.latest, info.time || Date.now()]
    )
    this.clearOldSnapshot()
  }

  getSnapshot = async (name: string): Promise<LX.Dislike.DislikeRules | null> => {
    const row = getDb().query<{ data: string }, [string, string, string]>(
      'SELECT data FROM snapshots WHERE user_name = ? AND module = ? AND id = ?'
    ).get(this.userDataManage.userName, this.module, name)
    return row?.data ?? null
  }

  saveSnapshot = async (name: string, data: string): Promise<void> => {
    getDb().run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [name, this.userDataManage.userName, this.module, data, Buffer.byteLength(data, 'utf8'), Date.now()]
    )
  }

  saveSnapshotWithTime = async (name: string, data: string, time: number): Promise<void> => {
    getDb().run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [name, this.userDataManage.userName, this.module, data, Buffer.byteLength(data, 'utf8'), time || Date.now()]
    )
  }

  removeSnapshot = async (name: string): Promise<void> => {
    getDb().run('DELETE FROM snapshots WHERE user_name = ? AND module = ? AND id = ?', [this.userDataManage.userName, this.module, name])
  }

  getSnapshotListWithMeta = async (): Promise<Array<{ id: string; time: number; size: number }>> => {
    const rows = getDb().query<{ id: string; created_at: number; size: number }, [string, string]>(
      'SELECT id, created_at, size FROM snapshots WHERE user_name = ? AND module = ? ORDER BY created_at DESC'
    ).all(this.userDataManage.userName, this.module)
    return rows.map(row => ({ id: row.id, time: row.created_at, size: row.size }))
  }

  setLatest = (name: string): void => {
    getDb().run(
      'INSERT OR REPLACE INTO snapshot_meta (user_name, module, latest_id, updated_at) VALUES (?, ?, ?, ?)',
      [this.userDataManage.userName, this.module, name, Date.now()]
    )
  }

  constructor(userDataManage: UserDataManage) {
    this.userDataManage = userDataManage
  }
}
