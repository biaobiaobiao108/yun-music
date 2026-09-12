/* eslint-disable no-var */
declare global {
  interface Lx {
    logPath: string
    dataPath: string
    userPath: string
    config: LX.Config
    staticPath: string
    saveConfig: () => void
    lastCpuSample?: { idle: number, total: number }
    lastProcessSample?: { cpu: NodeJS.CpuUsage, time: number }
  }

  // var envParams: LX.EnvParams
  var lx: Lx
}

export { }
