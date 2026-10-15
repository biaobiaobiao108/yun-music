import { httpFetch } from '../../request'
import { releaseRequestWhenSettled } from '../requestLifecycle'
import { weapi } from './utils/crypto'
import { formatSingerName } from '../utils'

export default {
  requestObj: null as any,
  cancelTipSearch() {
    if (this.requestObj && this.requestObj.cancelHttp) this.requestObj.cancelHttp()
  },
  tipSearchBySong(str: any) {
    this.cancelTipSearch()
    this.requestObj = httpFetch('https://music.163.com/weapi/search/suggest/web', {
      method: 'POST',
      headers: {
        referer: 'https://music.163.com/',
        origin: 'https://music.163.com/',
      },
      form: weapi({
        s: str,
      }),
    })
    releaseRequestWhenSettled(this, 'requestObj')
    return this.requestObj.promise.then(({ statusCode, body }: any) => {
      if (statusCode != 200 || body.code != 200) return Promise.reject(new Error('请求失败'))
      return body.result.songs
    })
  },
  handleResult(rawData: any) {
    return rawData.map((info: any) => `${info.name} - ${formatSingerName(info.artists, 'name')}`)
  },
  async search(str: any) {
    return this.tipSearchBySong(str).then((result: any) => this.handleResult(result))
  },
}
