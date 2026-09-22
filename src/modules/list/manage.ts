import { type UserDataManage } from '@/user'
import { SnapshotDataManage } from './snapshotDataManage'
import { ListDataManage } from './listDataManage'
import { toMD5 } from '@/utils'

export class ListManage {
  snapshotDataManage: SnapshotDataManage
  listDataManage: ListDataManage
  private snapshotQueue: Promise<string> = Promise.resolve('')

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
    await this.listDataManage.restore(listData)

    this.snapshotDataManage.setLatest(name)
  }

  removeSnapshot = async (name: string) => {
    await this.snapshotDataManage.removeSnapshot(name)
  }

  saveSnapshotWithTime = async (name: string, data: string, time: number) => {
    await this.snapshotDataManage.saveSnapshotWithTime(name, data, time)
  }
}
