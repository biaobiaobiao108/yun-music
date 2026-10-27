import { httpFetch } from '../../request'
import { eapi } from './utils/crypto'
// import { decodeName } from '../..'

export function formatLyricTimestamp(value: number | string): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return ''
  const timeMs = Math.trunc(parsed)
  const minutes = Math.floor(timeMs / 60000)
    .toString()
    .padStart(2, '0')
  const seconds = Math.floor((timeMs % 60000) / 1000)
    .toString()
    .padStart(2, '0')
  const milliseconds = (timeMs % 1000).toString().padStart(3, '0')
  return `[${minutes}:${seconds}.${milliseconds}]`
}

export function parseLyricTimestamp(value: string): number {
  const match = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(value)
  if (!match) return 0
  return Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || '').padEnd(3, '0'))
}

// const parseLyric = (str: any, lrc: any) => {
//   if (!str) return ''

//   str = str.replace(/\r/g, '')

//   let lxlyric = str.replace(/\[((\d+),\d+)\].*/g, (str: any) => {
//     let result = str.match(/\[((\d+),\d+)\].*/)
//     let time = parseInt(result[2])
//     let ms = time % 1000
//     time /= 1000
//     let m = parseInt(time / 60).toString().padStart(2, '0')
//     time %= 60
//     let s = parseInt(time).toString().padStart(2, '0')
//     time = `${m}:${s}.${ms}`
//     str = str.replace(result[1], time)

//     let startTime = 0
//     str = str.replace(/\(0,1\) /g, ' ').replace(/\(\d+,\d+\)/g, (time: any) => {
//       const [start, end] = time.replace(/^\((\d+,\d+)\)$/, '$1').split(',')

//       time = `<${parseInt(startTime + parseInt(start))},${end}>`
//       startTime = parseInt(startTime + parseInt(end))
//       return time
//     })

//     return str
//   })

//   lxlyric = decodeName(lxlyric)
//   return lxlyric.trim()
// }

const eapiRequest = (url: any, data: any) => {
  return httpFetch('https://interface3.music.163.com/eapi/song/lyric/v1', {
    method: 'post',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      origin: 'https://music.163.com',
      // cookie: 'os=pc; deviceId=A9C064BB4584D038B1565B58CB05F95290998EE8B025AA2D07AE; osver=Microsoft-Windows-10-Home-China-build-19043-64bit; appver=2.5.2.197409; channel=netease; MUSIC_A=37a11f2eb9de9930cad479b2ad495b0e4c982367fb6f909d9a3f18f876c6b49faddb3081250c4980dd7e19d4bd9bf384e004602712cf2b2b8efaafaab164268a00b47359f85f22705cc95cb6180f3aee40f5be1ebf3148d888aa2d90636647d0c3061cd18d77b7a0; __csrf=05b50d54082694f945d7de75c210ef94; mode=Z7M-KP5(7)GZ; NMTID=00OZLp2VVgq9QdwokUgq3XNfOddQyIAAAF_6i8eJg; ntes_kaola_ad=1',
    },
    form: eapi(url, data),
  })
  // requestObj.promise = requestObj.promise.then(({ body }: any) => {
  //   // console.log(raw)
  //   console.log(body)
  //   // console.log(eapiDecrypt(raw))
  //   // return eapiDecrypt(raw)
  //   return body
  // })
  // return requestObj
}

export const parseTools = {
  rxps: {
    info: /^{"/,
    lineTime: /^\[(\d+),\d+\]/,
    wordTime: /\(\d+,\d+,\d+\)/,
    wordTimeAll: /(\(\d+,\d+,\d+\))/g,
  },
  msFormat: formatLyricTimestamp,
  parseLyric(lines: any) {
    const lxlrcLines: any[] = []
    const lrcLines: any[] = []

    for (let line of lines) {
      line = line.trim()
      let result = this.rxps.lineTime.exec(line)
      if (!result) {
        if (line.startsWith('[offset')) {
          lxlrcLines.push(line)
          lrcLines.push(line)
        }
        continue
      }

      const startMsTime = parseInt(result[1])
      const startTimeStr = this.msFormat(startMsTime)
      if (!startTimeStr) continue

      let words = line.replace(this.rxps.lineTime, '')

      lrcLines.push(`${startTimeStr}${words.replace(this.rxps.wordTimeAll, '')}`)

      let times = words.match(this.rxps.wordTimeAll)
      if (!times) continue
      times = times.map((time: any) => {
        const result = /\((\d+),(\d+),\d+\)/.exec(time)
        if (!result) return '<0,0>'
        return `<${Math.max(parseInt(result[1]) - startMsTime, 0)},${result[2]}>`
      })
      const wordArr = words.split(this.rxps.wordTime)
      wordArr.shift()
      const newWords = times.map((time: any, index: any) => `${time}${wordArr[index]}`).join('')
      lxlrcLines.push(`${startTimeStr}${newWords}`)
    }
    return {
      lyric: lrcLines.join('\n'),
      lxlyric: lxlrcLines.join('\n'),
    }
  },
  parseHeaderInfo(str: any) {
    str = str.trim()
    str = str.replace(/\r/g, '')
    if (!str) return null
    const lines = str.split('\n')
    return lines.map((line: any) => {
      if (!this.rxps.info.test(line)) return line
      try {
        const info = JSON.parse(line)
        const timeTag = this.msFormat(info.t)
        return timeTag ? `${timeTag}${info.c.map((t: any) => t.tx).join('')}` : ''
      } catch {
        return ''
      }
    })
  },
  getIntv(interval: any) {
    return parseLyricTimestamp(String(interval || ''))
  },
  fixTimeTag(lrc: any, targetlrc: any) {
    const timeRxp = /^\[([\d:.]+)\]/
    const readLines = (text: string) =>
      text.split(/\r?\n/).flatMap((line, index) => {
        const match = timeRxp.exec(line)
        const content = match ? line.slice(match[0].length).trim() : ''
        return match && content ? [{ index, time: this.getIntv(match[1]), tag: match[0], content }] : []
      })
    const source = readLines(String(lrc)).sort((a, b) => a.time - b.time)
    const target = readLines(String(targetlrc)).sort((a, b) => a.time - b.time)
    const candidates: { source: number; target: number; gap: number }[] = []
    let first = 0
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      const time = target[targetIndex]!.time
      while (first < source.length && source[first]!.time < time - 1500) first += 1
      for (
        let sourceIndex = first;
        sourceIndex < source.length && source[sourceIndex]!.time <= time + 1500;
        sourceIndex += 1
      ) {
        candidates.push({ source: sourceIndex, target: targetIndex, gap: Math.abs(source[sourceIndex]!.time - time) })
      }
    }
    candidates.sort((a, b) => a.gap - b.gap || a.source - b.source || a.target - b.target)
    const usedSource = new Set<number>()
    const usedTarget = new Set<number>()
    const matched: { index: number; line: string }[] = []
    for (const candidate of candidates) {
      if (usedSource.has(candidate.source) || usedTarget.has(candidate.target)) continue
      usedSource.add(candidate.source)
      usedTarget.add(candidate.target)
      const line = source[candidate.source]!
      matched.push({ index: line.index, line: `${line.tag}${target[candidate.target]!.content}` })
    }
    return matched
      .sort((a, b) => a.index - b.index)
      .map(item => item.line)
      .join('\n')
  },
  parse(ylrc: any, ytlrc: any, yrlrc: any, lrc: any, tlrc: any, rlrc: any) {
    const info = {
      lyric: '',
      tlyric: '',
      rlyric: '',
      lxlyric: '',
    }
    if (ylrc) {
      const lines = this.parseHeaderInfo(ylrc)
      const result = lines ? this.parseLyric(lines) : null
      if (lines && result?.lyric) {
        const align = (preferred: string, fallback: string) => {
          for (const candidate of [preferred, fallback]) {
            if (!candidate) continue
            const translated = this.parseHeaderInfo(candidate)
            if (!translated) continue
            const aligned = this.fixTimeTag(result.lyric, translated.join('\n'))
            if (aligned) return aligned
          }
          return ''
        }
        info.tlyric = align(ytlrc, tlrc)
        info.rlyric = align(yrlrc, rlrc)

        const timeRxp = /^\[[\d:.]+\]/
        const headers = lines.filter((l: any) => timeRxp.test(l)).join('\n')
        info.lyric = `${headers}\n${result.lyric}`
        info.lxlyric = result.lxlyric
        return info
      }
    }
    if (lrc) {
      const lines = this.parseHeaderInfo(lrc)
      if (lines) info.lyric = lines.join('\n')
    }
    if (tlrc) {
      const lines = this.parseHeaderInfo(tlrc)
      if (lines) info.tlyric = lines.join('\n')
    }
    if (rlrc) {
      const lines = this.parseHeaderInfo(rlrc)
      if (lines) info.rlyric = lines.join('\n')
    }

    return info
  },
}

// https://github.com/Binaryify/NeteaseCloudMusicApi/pull/1523/files
// export default (songmid: any) => {
//   const requestObj = httpFetch('https://music.163.com/api/linux/forward', {
//     method: 'post',
//     'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
//     form: linuxapi({
//       method: 'POST',
//       url: 'https://music.163.com/api/song/lyric?_nmclfl=1',
//       params: {
//         id: songmid,
//         tv: -1,
//         lv: -1,
//         rv: -1,
//         kv: -1,
//       },
//     }),
//   })
//   requestObj.promise = requestObj.promise.then(({ body }: any) => {
//     if (body.code !== 200 || !body?.lrc?.lyric) return Promise.reject(new Error('Get lyric failed'))
//     // console.log(body)
//     return {
//       lyric: body.lrc.lyric,
//       tlyric: body.tlyric?.lyric ?? '',
//       rlyric: body.romalrc?.lyric ?? '',
//       // lxlyric: parseLyric(body.klyric.lyric),
//     }
//   })
//   return requestObj
// }

// https://github.com/lyswhut/lx-music-mobile/issues/370
const fixTimeLabel = (lrc: any, tlrc: any, romalrc: any) => {
  if (lrc) {
    let newLrc = lrc.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, '[$1.$2]')
    let newTlrc = tlrc?.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, '[$1.$2]') ?? tlrc
    if (newLrc != lrc || newTlrc != tlrc) {
      lrc = newLrc
      tlrc = newTlrc
      if (romalrc)
        romalrc = romalrc.replace(/\[(\d{2}:\d{2}):(\d{2,3})]/g, '[$1.$2]').replace(/\[(\d{2}:\d{2}\.\d{2})0]/g, '[$1]')
    }
  }

  return { lrc, tlrc, romalrc }
}

// https://github.com/Binaryify/NeteaseCloudMusicApi/blob/master/module/lyric_new.js
export default (songmid: any) => {
  const requestObj = eapiRequest('/api/song/lyric/v1', {
    id: songmid,
    cp: false,
    tv: 0,
    lv: 0,
    rv: 0,
    kv: 0,
    yv: 0,
    ytv: 0,
    yrv: 0,
  })
  requestObj.promise = requestObj.promise.then(({ body }: any) => {
    // console.log(body)
    if (body.code !== 200 || (!body?.lrc?.lyric && !body?.yrc?.lyric))
      return Promise.reject(new Error('Get lyric failed'))
    const fixTimeLabelLrc = fixTimeLabel(body.lrc?.lyric || '', body.tlyric?.lyric, body.romalrc?.lyric)
    const info = parseTools.parse(
      body.yrc?.lyric,
      body.ytlrc?.lyric,
      body.yromalrc?.lyric,
      fixTimeLabelLrc.lrc,
      fixTimeLabelLrc.tlrc,
      fixTimeLabelLrc.romalrc,
    )
    // console.log(info)
    if (!info.lyric) return Promise.reject(new Error('Get lyric failed'))
    return info
  })
  return requestObj
}
