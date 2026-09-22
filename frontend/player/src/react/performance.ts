/**
 * Lightweight, opt-in performance marks for the player.
 *
 * The browser keeps the measurements local to the current page. Nothing is
 * sent to the server, so this is useful for diagnosing slow Safari paths
 * without adding telemetry traffic to the playback flow.
 */
export function markPlayerPerformance(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(name)
  } catch {
    // A malformed or overlong browser-specific mark must never affect playback.
  }
}

export function measurePlayerPerformance(name: string, startMark: string, endMark: string, clearStart = true): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
  try {
    performance.measure(name, startMark, endMark)
    if (clearStart) performance.clearMarks(startMark)
    performance.clearMarks(endMark)
  } catch {
    // The corresponding start mark may have been cleared after a fast source
    // switch. Performance diagnostics are deliberately best-effort.
  }
}

export function clearPlayerPerformanceMark(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.clearMarks !== 'function') return
  try {
    performance.clearMarks(name)
  } catch {
    // Ignore unsupported or already-cleared marks.
  }
}
