export const BUILTIN_ONLINE_SOURCES = ['wy', 'tx'] as const

export const RETIRED_ONLINE_SOURCES = ['kg', 'kw', 'mg', 'bd', 'xm'] as const

export type RetiredOnlineSource = (typeof RETIRED_ONLINE_SOURCES)[number]

export type BuiltinOnlineSource = (typeof BUILTIN_ONLINE_SOURCES)[number]

export const DEFAULT_ONLINE_SOURCES: readonly BuiltinOnlineSource[] = ['wy', 'tx']

export const isBuiltinOnlineSource = (value: unknown): value is BuiltinOnlineSource =>
  typeof value === 'string' && (BUILTIN_ONLINE_SOURCES as readonly string[]).includes(value)

export const isRetiredOnlineSource = (value: unknown): value is RetiredOnlineSource =>
  typeof value === 'string' && (RETIRED_ONLINE_SOURCES as readonly string[]).includes(value)

export const normalizeOnlineSources = (
  value: unknown,
  fallback: readonly BuiltinOnlineSource[] = DEFAULT_ONLINE_SOURCES,
): BuiltinOnlineSource[] => {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',')
  const sources = values
    .map(source => String(source).trim())
    .filter(isBuiltinOnlineSource)
    .filter((source, index, list) => list.indexOf(source) === index)
  return sources.length > 0 ? sources : [...fallback]
}

export class UnsupportedSourceError extends Error {
  readonly source: string

  constructor(source: string) {
    super(`Source ${source} is not supported`)
    this.name = 'UnsupportedSourceError'
    this.source = source
  }
}

export const assertBuiltinOnlineSource = (value: unknown): BuiltinOnlineSource => {
  if (!isBuiltinOnlineSource(value)) throw new UnsupportedSourceError(String(value ?? ''))
  return value
}
