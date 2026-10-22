import { decodeName } from '@renderer/utils'

export interface SingerNameItem {
  name?: string | null
  [key: string]: unknown
}

export const formatSingerName = (singers: unknown, nameKey = 'name', join = '、'): string => {
  if (Array.isArray(singers)) {
    const names = singers
      .map((item: any) => (typeof item === 'object' && item !== null ? (item as SingerNameItem)[nameKey] : item))
      .filter((name): name is string | number => typeof name === 'string' || typeof name === 'number')
    return decodeName(names.join(join))
  }
  return decodeName(String(singers ?? ''))
}
