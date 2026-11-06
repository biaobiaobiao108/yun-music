import { type UserDataManage } from '@/user'
import { DislikeDataManage } from './dislikeDataManage'

export class DislikeManage {
  dislikeDataManage: DislikeDataManage

  constructor(userDataManage: UserDataManage) {
    this.dislikeDataManage = new DislikeDataManage(userDataManage)
  }

  getDislikeRules = async () => this.dislikeDataManage.getDislikeRules()
}
