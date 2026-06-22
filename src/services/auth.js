// @file: Firebase Authentication wrappers and E2E test user injection.
// @consumers: composables/useAuth.js

import { L } from './logger.js'
import { fbAuth, gProvider, signInWithPopup, fbSignOut, onAuthStateChanged as _onAuthStateChanged } from '@/firebase/config.js'

/**
 * @purpose Trigger Google sign-in popup and authenticate with Firebase.
 * @throws {Error} Re-throws all Firebase auth errors except auth/popup-closed-by-user (user cancel).
 * @sideEffect Network: Firebase OAuth popup; updates Firebase auth state.
 */
export async function signIn() {
  L('auth', 'signIn attempt')
  try {
    await signInWithPopup(fbAuth, gProvider)
    L('auth', 'signIn success')
  } catch (e) {
    L('auth', 'signIn error', e.code, e.message)
    if (e.code !== 'auth/popup-closed-by-user') throw e
  }
}

/**
 * @purpose Sign out the current Firebase user.
 * @sideEffect Network: Firebase sign-out; clears Firebase auth state.
 */
export async function signOut() {
  L('auth', 'signOut')
  await fbSignOut(fbAuth)
}

/**
 * @purpose Subscribe to Firebase auth state changes.
 * @param {(user: object|null) => void} callback Invoked with the new user or null on every auth state change.
 * @returns {() => void} Unsubscribe function.
 */
export function onAuthStateChanged(callback) {
  return _onAuthStateChanged(fbAuth, callback)
}

/**
 * @purpose Extract an injected E2E test user from the ?e2e_user= URL param.
 * @invariant Active only on localhost/127.0.0.1 — returns null in production to prevent privilege escalation.
 * @returns {object|null} Parsed user object, or null if param is absent, invalid, or not on localhost.
 */
export function getE2EUser() {
  const param = new URLSearchParams(location.search).get('e2e_user')
  if (!param || !['localhost', '127.0.0.1'].includes(location.hostname)) return null
  try { return JSON.parse(atob(param)) } catch (_) { return null }
}
