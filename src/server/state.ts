/**
 * 全局服务端运行时状态管理
 */
export interface ServerStatus {
  status: boolean
  message: string
  address: string[]
}

export const serverStatus: ServerStatus = {
  status: false,
  message: '',
  address: [],
}

export const getServerStatus = (): ServerStatus => serverStatus
