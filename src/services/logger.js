// @file: Lightweight in-memory debug logger with timestamped entries and console.debug output.
// @consumers: all services and composables

export const LOG_BUFFER = []

/**
 * @purpose Truncate a Firebase UID to a safe short form for log messages.
 * @param {string|null} uid Full Firebase UID or null.
 * @returns {string} 8-char prefix with ellipsis, or 'none'.
 */
export const safeUid = uid => uid ? uid.slice(0, 8) + '…' : 'none'

/**
 * @purpose Append a timestamped log entry to LOG_BUFFER and emit to console.debug.
 * @invariant Buffer capped at 500 entries; oldest entry evicted on overflow.
 * @param {string} anchor Trace prefix, e.g. 'db#saveSpace'.
 * @param {...*} args Primitive values or objects to serialize into the message.
 * @sideEffect Writes to module-level LOG_BUFFER; calls console.debug.
 */
export function L(anchor, ...args) {
  const now = new Date()
  const ts = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0')
  const msg = args.map(a => {
    if (a === null || a === undefined) return String(a)
    if (typeof a !== 'object') return String(a)
    try { return JSON.stringify(a) } catch (_) { return '[obj]' }
  }).join(' ')
  const line = `[${ts}][${anchor}] ${msg}`
  LOG_BUFFER.push(line)
  if (LOG_BUFFER.length > 500) LOG_BUFFER.shift()
  console.debug(`%c${line}`, 'color:#64b5f6;font-size:11px')
}
