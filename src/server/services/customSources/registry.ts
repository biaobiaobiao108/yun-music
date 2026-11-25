import type { UserApiInfo } from './metadata'

// 加载的 API 实例
export const loadedApis = new Map<string, any>()
export const apiStatus = new Map<string, { status: 'success' | 'failed'; error?: string }>()

export function getApiStatus(owner: string, id: string) {
  return apiStatus.get(`${owner}_${id}`)
}

export function getLoadedApis(): Array<UserApiInfo & Record<string, unknown>> {
  return Array.from(loadedApis.values()).map(api => api.info)
}
