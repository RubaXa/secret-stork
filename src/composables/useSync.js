// @file: Vue composable — reactive sync status and outbox drain trigger.
// @consumers: SyncDot.vue (reads syncStatus), VotingView.vue (calls drain), HomeView.vue (calls syncHome)

import { ref } from 'vue'
import { drainOutbox as _drain, syncSpacesFromFirestore } from '@/services/sync.js'

/** @purpose Reactive sync state: 'ok' | 'pending' | 'error'. Drives the SyncDot visual indicator. */
export const syncStatus = ref('ok')

/** @purpose Reactive count of outbox entries not yet confirmed by Firestore. */
export const pendingCount = ref(0)

/**
 * @purpose Drain the outbox and update reactive sync status from the result.
 * @invariant 'pending' when remaining > 0 (Firebase blocked or unreachable); 'error' on drain failure; 'ok' on clean drain.
 * @sideEffect Triggers Firestore writes via drainOutbox; mutates syncStatus and pendingCount.
 */
export async function drain() {
  const result = await _drain()
  if (result && result.status !== 'no-user') {
    syncStatus.value = result.remaining > 0 ? 'pending' : result.status === 'error' ? 'error' : 'ok'
    pendingCount.value = result.remaining
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
