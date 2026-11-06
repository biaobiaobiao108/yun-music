import { expect, test } from 'bun:test'
import tx from '../src/modules/utils/musicSdk/tx/leaderboard'
import wy from '../src/modules/utils/musicSdk/wy/leaderboard'

test('wy leaderboard keeps the upstream cover art', () => {
  const list = wy.filterBoardsData([
    { id: 19723756, name: '飙升榜', coverImgUrl: 'https://p1.music.126.net/wy-cover.jpg' },
  ])
  expect(list[0]).toMatchObject({
    id: 'wy__19723756',
    name: '飙升榜',
    bangid: '19723756',
    img: 'https://p1.music.126.net/wy-cover.jpg',
  })
})

test('tx leaderboard keeps the upstream cover art', () => {
  const list = tx.filterBoardsData([{ id: 4, topTitle: '巅峰榜·流行指数', picUrl: 'https://y.gtimg.cn/tx-cover.jpg' }])
  expect(list[0]).toMatchObject({
    id: 'tx__4',
    name: '流行指数榜',
    bangid: '4',
    img: 'https://y.gtimg.cn/tx-cover.jpg',
  })
})
