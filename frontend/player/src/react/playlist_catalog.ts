import type { UserPlaylist } from './api'

export type PlaylistSort = 'default' | 'name' | 'songs'

export function filterPlaylistCatalog(lists: UserPlaylist[], keyword: string, sort: PlaylistSort): UserPlaylist[] {
  const query = keyword.trim().toLocaleLowerCase()
  const result = lists.filter(list => list.name.toLocaleLowerCase().includes(query))
  if (sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  if (sort === 'songs') result.sort((a, b) => (b.list?.length ?? 0) - (a.list?.length ?? 0))
  return result
}
