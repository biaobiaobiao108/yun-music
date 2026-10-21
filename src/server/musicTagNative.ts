import crypto from 'node:crypto'

export type MusicTagNative = {
  MusicTagger: new () => any
  MetaPicture: new (mime: string, data: Uint8Array, type: string) => any
}

let musicTagNative: MusicTagNative | null = null
export const getMusicTagNative = (): MusicTagNative => {
  if (!musicTagNative) musicTagNative = require('music-tag-native') as MusicTagNative
  return musicTagNative
}
