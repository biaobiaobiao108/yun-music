import { SPLIT_CHAR } from '@/constants'
import { type SnapshotDataManage } from './snapshotDataManage'
import { filterRules } from './utils'

const filterRulesToString = (rules: string) => {
  return Array.from(filterRules(rules)).join('\n')
}

export class DislikeDataManage {
  snapshotDataManage: SnapshotDataManage
  dislikeRules = ''
  private ready: Promise<void>

  constructor(snapshotDataManage: SnapshotDataManage) {
    this.snapshotDataManage = snapshotDataManage

    this.ready = this.snapshotDataManage
      .getSnapshotInfo()
      .then(async snapshotInfo => {
        const dislikeRules = snapshotInfo.latest ? await this.snapshotDataManage.getSnapshot(snapshotInfo.latest) : ''
        this.dislikeRules = dislikeRules || ''
      })
      .catch(error => {
        console.error('[Dislike] 快照初始化失败:', error)
      })
  }

  getDislikeRules = async (): Promise<LX.Dislike.DislikeRules> => {
    await this.ready
    return this.dislikeRules
  }

  addDislikeInfo = async (infos: LX.Dislike.DislikeMusicInfo[]) => {
    await this.ready
    this.dislikeRules = filterRulesToString(
      this.dislikeRules +
        '\n' +
        infos.map(info => `${info.name ?? ''}${SPLIT_CHAR.DISLIKE_NAME}${info.singer ?? ''}`).join('\n'),
    )
    return this.dislikeRules
  }

  overwirteDislikeInfo = async (rules: string) => {
    await this.ready
    this.dislikeRules = filterRulesToString(rules)
    return this.dislikeRules
  }
}
