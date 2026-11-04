import { type UserDataManage } from '@/user'
import { SnapshotDataManage } from './snapshotDataManage'
import { ListDataManage } from './listDataManage'
import { toMD5 } from '@/utils'

export class ListManage {
  snapshotDataManage: SnapshotDataManage
  listDataManage: ListDataManage
  private snapshotQueue: Promise<string> = Promise.resolve('')
  private operationQueue: Promise<unknown> = Promise.resolve()

  constructor(userDataManage: UserDataManage) {
    this.snapshotDataManage = new SnapshotDataManage(userDataManage)
    this.listDataManage = new ListDataManage(this.snapshotDataManage)
  }

  private createSnapshotNow = async () => {
    const listData = JSON.stringify(await this.getListData())
    const md5 = toMD5(listData)
    const snapshotInfo = await this.snapshotDataManage.getSnapshotInfo()
    if (snapshotInfo.latest == md5) return md5
    if (snapshotInfo.list.includes(md5)) {
      snapshotInfo.list.splice(snapshotInfo.list.indexOf(md5), 1)
    } else await this.snapshotDataManage.saveSnapshot(md5, listData)
    if (snapshotInfo.latest) snapshotInfo.list.unshift(snapshotInfo.latest)
    snapshotInfo.latest = md5
    snapshotInfo.time = Date.now()
    this.snapshotDataManage.saveSnapshotInfo(snapshotInfo)
    return md5
  }

  /**
   * Serialize snapshot writes per user space. Favorite clicks can arrive in
   * bursts; running several JSON/SQLite snapshot writes concurrently only
   * adds contention and often produces the same final snapshot repeatedly.
   */
  createSnapshot = () => {
    const next = this.snapshotQueue.then(() => this.createSnapshotNow())
    this.snapshotQueue = next.catch(error => {
      console.error('[ListManage] Failed to create list snapshot:', error)
      return ''
    })
    return next
  }

  /**
   * Apply an in-memory list mutation and persist it as one logical operation.
   * If snapshot persistence fails, restore the previous lists so a failed
   * request cannot leave a phantom change that disappears after restart.
   */
  /** Serialize an operation with list mutations without creating a snapshot. */
  runSerialized = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const task = this.operationQueue.then(operation)
    this.operationQueue = task.catch(() => undefined)
    return task
  }

  runWithSnapshot = <T>(operation: () => Promise<T> | T): Promise<T> => {
    return this.runSerialized(async () => {
      const previous = JSON.parse(JSON.stringify(await this.getListData())) as LX.List.ListData
      try {
        const result = await operation()
        await this.createSnapshot()
        return result
      } catch (error) {
        try {
          await this.listDataManage.restore(previous)
        } catch (rollbackError) {
          console.error('[ListManage] Failed to roll back list mutation:', rollbackError)
        }
        throw error
      }
    })
  }

  getCurrentListInfoKey = async () => {
    const snapshotInfo = await this.snapshotDataManage.getSnapshotInfo()
    if (snapshotInfo.latest) return snapshotInfo.latest
    // snapshotInfo.latest = toMD5(JSON.stringify(await this.getListData()))
    // this.snapshotDataManage.saveSnapshotInfo(snapshotInfo)
    return this.createSnapshot()
  }

  getListData = async () => {
    return await this.listDataManage.getListData()
  }

  getSnapshotList = async () => {
    return this.snapshotDataManage.getSnapshotListWithMeta()
  }

  getSnapshot = async (name: string) => {
    return this.snapshotDataManage.getSnapshot(name)
  }

  restoreSnapshot = async (name: string) => {
    const listData = await this.snapshotDataManage.getSnapshot(name)
    if (!listData) throw new Error('Snapshot not found')
    // Serialize with add/delete mutations so a concurrent write cannot be
    // overwritten by the full-list restore, then point the latest pointer at
    // the restored snapshot instead of creating a duplicate history entry.
    await this.runSerialized(async () => {
      await this.listDataManage.restore(listData)
      this.snapshotDataManage.setLatest(name)
    })
  }

  removeSnapshot = async (name: string) => {
    await this.snapshotDataManage.removeSnapshot(name)
  }

  saveSnapshotWithTime = async (name: string, data: string, time: number) => {
    await this.snapshotDataManage.saveSnapshotWithTime(name, data, time)
  }

  saveSnapshotWithTimeData = async (name: string, data: string, parsedData: unknown, time: number) => {
    await this.snapshotDataManage.saveSnapshotWithTimeData(name, data, parsedData, time)
  }
}
