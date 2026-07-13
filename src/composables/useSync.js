// @file: Vue composable — reactive sync status and outbox drain trigger.
// @consumers: SyncDot.vue (reads syncStatus), VotingView.vue (calls drain), HomeView.vue (calls syncHome)

import { ref } from 'vue'
import { drainOutbox as _drain, syncSpacesFromFirestore } from '@/services/sync.js'
import { toast } from './useToast.js'

/** @purpose Reactive sync state: 'ok' | 'pending' | 'error'. Drives the SyncDot visual indicator. */
export const syncStatus = ref('ok')

/** @purpose Reactive count of outbox entries not yet confirmed by Firestore. */
export const pendingCount = ref(0)

// @invariant The SyncDot indicator alone was the only signal a user ever got when their vote/join
//   failed to reach Firestore — easy to miss, so an invitee could believe they'd voted while the
//   organizer's Firestore read came back empty. drain() runs often (every vote, every foreground/
//   online event), and 'error' can be a one-off network blip, so we must NOT toast on every single
//   failed attempt (that would spam constantly while offline). Instead we only toast once real
//   FAILURES (drainOutbox status:'error' — an actual write threw, not just held/offline entries)
//   persist across PERSISTENT_FAILURE_THRESHOLD consecutive drain() calls, and only once until the
//   status recovers.
const PERSISTENT_FAILURE_THRESHOLD = 3
let _consecutiveErrors = 0
let _warned = false

/**
 * @purpose Drain the outbox and update reactive sync status from the result.
 * @invariant 'pending' when remaining > 0 (Firebase blocked/unreachable, or entries held for another
 *   uid); 'error' on drain failure (an entry's Firestore write actually threw); 'ok' on clean drain.
 * @sideEffect Triggers Firestore writes via drainOutbox; mutates syncStatus and pendingCount; may
 *   show a one-time toast to the user if failures persist (see PERSISTENT_FAILURE_THRESHOLD).
 */
export async function drain() {
  const result = await _drain()
  if (result && result.status !== 'no-user') {
    syncStatus.value = result.remaining > 0 ? 'pending' : result.status === 'error' ? 'error' : 'ok'
    pendingCount.value = result.remaining

    if (result.status === 'error') {
      _consecutiveErrors++
      if (_consecutiveErrors >= PERSISTENT_FAILURE_THRESHOLD && !_warned) {
        _warned = true
        toast('Не удалось сохранить данные — проверьте соединение', 'error')
      }
    } else {
      _consecutiveErrors = 0
      _warned = false
    }
  }
}

/**
 * @purpose Reset the persistent-failure toast tracking. Exposed for tests.
 * @sideEffect Mutates module-level _consecutiveErrors/_warned.
 */
export function resetDrainFailureTracking() {
  _consecutiveErrors = 0
  _warned = false
}

const DRAIN_RETRY_INTERVAL = 30_000
let _drainIntervalId = null

/**
 * @purpose Periodically retry draining the outbox so a transient failure (an invitee's vote/join
 *   that couldn't reach Firestore on the first attempt) doesn't get stuck until the user happens
 *   to trigger another drain themselves (voting again, foregrounding the tab, coming back online).
 * @invariant Idempotent — a second call while already running does not start a second timer.
 * @sideEffect Starts a repeating timer that calls drain() every DRAIN_RETRY_INTERVAL.
 */
export function startPeriodicDrain() {
  if (_drainIntervalId !== null) return
  _drainIntervalId = setInterval(drain, DRAIN_RETRY_INTERVAL)
}

/**
 * @purpose Stop the periodic drain retry timer. Exposed for tests/cleanup.
 * @sideEffect Clears the interval started by startPeriodicDrain(), if any.
 */
export function stopPeriodicDrain() {
  if (_drainIntervalId !== null) {
    clearInterval(_drainIntervalId)
    _drainIntervalId = null
  }
}

const HOME_SYNC_INTERVAL = 30_000
let _lastSync = 0

/**
 * @purpose Sync spaces from Firestore at most once per 30 seconds.
 * @invariant Throttled — repeated calls within HOME_SYNC_INTERVAL are no-ops returning false.
 * @param {string} uid Firebase UID.
 * @returns {Promise<boolean>} True if new or updated spaces were found and saved to IDB.
 * @sideEffect Firestore reads; IDB writes via syncSpacesFromFirestore.
 */
export async function syncHome(uid) {
  const now = Date.now()
  if (now - _lastSync < HOME_SYNC_INTERVAL) return false
  _lastSync = now
  return syncSpacesFromFirestore(uid)
}

/**
 * @purpose Reset the sync throttle timer, forcing the next syncHome call to fetch immediately.
 * @sideEffect Mutates module-level _lastSync.
 */
export function resetSyncTimer() {
  _lastSync = 0
}
