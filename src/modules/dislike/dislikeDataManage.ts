import { SPLIT_CHAR } from '@/constants'
import { getDb } from '@/database'
import { type UserDataManage } from '@/user/data'
import { filterRules } from './utils'

const filterRulesToString = (rules: string) => Array.from(filterRules(rules)).join('\n')

export class DislikeDataManage {
  readonly userDataManage: UserDataManage
  dislikeRules = ''
  private ready: Promise<void> | null = null

  constructor(userDataManage: UserDataManage) {
    this.userDataManage = userDataManage
  }

  private ensureReady = (): Promise<void> => {
    if (!this.ready) {
      this.ready = Promise.resolve().then(() => {
        const row = getDb()
          .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
          .get(this.userDataManage.userName, 'dislike_rules')
        if (row) this.dislikeRules = filterRulesToString(row.value)
      })
    }
    return this.ready
  }

  private save = (): void => {
    getDb().run(
      `INSERT INTO user_settings (user_name, key, value, updated_at)
       VALUES (?, 'dislike_rules', ?, ?)
       ON CONFLICT(user_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [this.userDataManage.userName, this.dislikeRules, Date.now()],
    )
  }

  getDislikeRules = async (): Promise<LX.Dislike.DislikeRules> => {
    await this.ensureReady()
    return this.dislikeRules
  }

  addDislikeInfo = async (infos: LX.Dislike.DislikeMusicInfo[]) => {
    await this.ensureReady()
    this.dislikeRules = filterRulesToString(
      this.dislikeRules +
        '\n' +
        infos.map(info => `${info.name ?? ''}${SPLIT_CHAR.DISLIKE_NAME}${info.singer ?? ''}`).join('\n'),
    )
    this.save()
    return this.dislikeRules
  }

  overwirteDislikeInfo = async (rules: string) => {
    await this.ensureReady()
    this.dislikeRules = filterRulesToString(rules)
    this.save()
    return this.dislikeRules
  }
}
