// @file: Vue composable — reactive auth state and one-time initialization.
// @consumers: router/index.js, App.vue, views (currentUser), services/sync.js (via setSyncUser)

import { ref, watch } from 'vue'
import { onAuthStateChanged, getE2EUser } from '@/services/auth.js'
import { setSyncUser } from '@/services/sync.js'
import { L, safeUid } from '@/services/logger.js'

/** @purpose Reactive Firebase user object; null before auth resolves or when signed out. */
export const currentUser = ref(null)

/** @purpose Reactive flag set to true once auth state has been determined (regardless of sign-in status). */
export const authReady = ref(false)

let _initialized = false

/**
 * @purpose Initialize the auth listener exactly once per app lifetime.
 * @invariant Idempotent — subsequent calls are no-ops; must be called from main.js before router mount.
 * @sideEffect Subscribes to Firebase auth state changes; in E2E mode bypasses Firebase entirely.
 */
export function initAuth() {
  if (_initialized) return
  _initialized = true

  // #region START_E2E_AUTH_BYPASS
  // purpose: E2E tests inject a fake user via ?e2e_user= to avoid real Firebase auth flows
  const e2eUser = getE2EUser()
  if (e2eUser) {
    currentUser.value = e2eUser
    setSyncUser(e2eUser)
    authReady.value = true
    L('auth', 'E2E user uid=' + safeUid(e2eUser.uid))
    return
  }
  // #endregion END_E2E_AUTH_BYPASS

  onAuthStateChanged(user => {
    L('auth', 'state change uid=' + safeUid(user?.uid))
    currentUser.value = user
    setSyncUser(user)
    authReady.value = true
  })
}

/**
 * @purpose Resolve once the auth state has been determined for the first time.
 * @invariant Must not be awaited before initAuth() is called — authReady will never flip.
 * @returns {Promise<void>}
 */
export function waitForAuth() {
  if (authReady.value) return Promise.resolve()
  return new Promise(resolve => {
    const unwatch = watch(authReady, ready => {
      if (ready) { unwatch(); resolve() }
    })
  })
}
