export type {
  DownloadResolver,
  QueueInput,
  ResolveResult,
  ServerDownloadStatus,
  ServerDownloadTask,
} from './services/downloadQueue/types'
export {
  MAX_BACKGROUND_CONCURRENT,
  MAX_HISTORY_PER_USER,
  MAX_PENDING_TASKS_PER_USER,
  MAX_QUEUE_SNAPSHOT_BYTES,
  MAX_TASK_SNAPSHOT_BYTES,
  MAX_TOTAL_TASKS,
} from './services/downloadQueue/types'
export {
  deduplicateDownloadTasks,
  filterPersistedTasksForUsers,
  isDownloadTaskRunnable,
  markDownloadTaskPausedIfAborted,
  pruneDownloadHistory,
  serializeDownloadTask,
} from './services/downloadQueue/model'
export {
  getActiveTaskCount,
  getConcurrency,
  initialize,
  releaseAll,
  releaseUser,
  setConcurrency,
  shutdownDownloadQueue,
  suspendAll,
  suspendUser,
} from './services/downloadQueue/scheduler'
export {
  enqueue,
  getActiveTaskProgress,
  getProgressForUser,
  pause,
  pauseBySongKey,
  reconcileRestoredQueue,
  remove,
  removeUser,
  renameUser,
  resume,
} from './services/downloadQueue/queue'
export { flushDownloadQueue, list, subscribe } from './services/downloadQueue/store'
