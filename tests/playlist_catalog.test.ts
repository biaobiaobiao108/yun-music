import { expect, test } from 'bun:test'
import { filterPlaylistCatalog } from '../frontend/player/src/react/playlist_catalog'
import type { UserPlaylist } from '../frontend/player/src/react/api'

const lists: UserPlaylist[] = [
  { id: 'first', name: 'BGM 10', list: [{ id: 'song' }] },
  { id: 'second', name: 'BGM 2', list: [] },
  { id: 'third', name: '夜晚音乐' },
]

test('playlist search ignores case and surrounding spaces, with a clear no-match result', () => {
  expect(filterPlaylistCatalog(lists, ' bgm ', 'default').map(list => list.id)).toEqual(['first', 'second'])
  expect(filterPlaylistCatalog(lists, '夜晚', 'default').map(list => list.id)).toEqual(['third'])
  expect(filterPlaylistCatalog(lists, '不存在', 'default')).toEqual([])
})

test('playlist sorting keeps source data intact and supports numeric names and empty lists', () => {
  const named = filterPlaylistCatalog(lists, '', 'name').map(list => list.id)
  expect(named).toHaveLength(3)
  expect(named.indexOf('second')).toBeLessThan(named.indexOf('first'))
  expect(filterPlaylistCatalog(lists, '', 'songs').map(list => list.id)).toEqual(['first', 'second', 'third'])
  expect(filterPlaylistCatalog(lists, '', 'default').map(list => list.id)).toEqual(['first', 'second', 'third'])
  expect(lists.map(list => list.id)).toEqual(['first', 'second', 'third'])
})
