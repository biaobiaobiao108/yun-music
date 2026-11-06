import { type UserDataManage } from '@/user'
import { ListDataManage } from './listDataManage'

export class ListManage {
  listDataManage: ListDataManage
  private operationQueue: Promise<unknown> = Promise.resolve()

  constructor(userDataManage: UserDataManage) {
    this.listDataManage = new ListDataManage(userDataManage)
  }

  /** Serialize list mutations and persist each successful change once. */
  runWithPersistence = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const task = this.operationQueue.then(async () => {
      const previous = structuredClone(await this.getListData())
      try {
        const result = await operation()
        if (result !== null) await this.listDataManage.save()
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
    this.operationQueue = task.catch(() => undefined)
    return task
  }

  getListData = async () => this.listDataManage.getListData()
}
