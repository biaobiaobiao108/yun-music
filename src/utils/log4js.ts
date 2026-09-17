import path from 'node:path'
import type { Log4js } from 'log4js'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const log4js: Log4js = require('log4js')

const createLogConfig = (logPath: string) => {
  return {
    appenders: {
      access: {
        type: 'file',
        filename: path.join(logPath, 'access.log'),
        maxLogSize: 1024 * 1024 * 10,
        category: 'access',
        // compress: true,
        keepFileExt: true,
        numBackups: 10,
      },
      app: {
        type: 'file',
        filename: path.join(logPath, 'app.log'),
        maxLogSize: 10485760,
        backups: 10,
        keepFileExt: true,
      },
      errorFile: {
        type: 'file',
        filename: path.join(logPath, 'errors.log'),
        maxLogSize: 10485760,
        backups: 10,
        keepFileExt: true,
      },
      errors: {
        type: 'logLevelFilter',
        level: 'ERROR',
        appender: 'errorFile',
      },
      console: {
        type: 'console',
      },
      login: {
        type: 'file',
        filename: path.join(logPath, 'login.log'),
        maxLogSize: 1024 * 1024 * 10,
        category: 'login',
        keepFileExt: true,
        numBackups: 10,
      },
    },
    categories: {
      default: { appenders: ['app', 'errors', 'console'], level: 'DEBUG' },
      access: { appenders: ['access'], level: 'ALL' },
      login: { appenders: ['login'], level: 'ALL' },
    },
  }
}


export const initLogger = () => {
  log4js.configure(createLogConfig(global.lx.logPath))
}


export const startupLog = log4js.getLogger('startup')
export const accessLog = log4js.getLogger('access')
export const loginLog = log4js.getLogger('login')
