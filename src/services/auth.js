// @file: Firebase Authentication wrappers and E2E test user injection.
// @consumers: composables/useAuth.js

import { L } from './logger.js'
import { fbAuth, gProvider, signInWithPopup, signInWithRedirect, getRedirectResult, fbSignOut, onAuthStateChanged as _onAuthStateChanged } from '@/firebase/config.js'

// @invariant Codes meaning the popup literally could not open (blocked, or the environment doesn't
//   support window.open at all — e.g. an in-app browser inside a messenger app). These are the ONLY
//   codes that fall back to redirect; anything else (e.g. the user closing the popup) must not.
const POPUP_UNAVAILABLE_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
])

/**
 * @purpose Trigger Google sign-in: popup first, falling back to a full-page redirect when the
 *   popup itself could not open (mobile browsers and in-app messenger WebViews commonly block it —
 *   this was the likely #1 reason invited participants could never sign in and join a space).
 * @invariant On redirect fallback, signInWithRedirect() navigates the page away — nothing after
 *   that call runs in this session. The App.vue render-gate means the URL the user was on (e.g. a
 *   shared #/space/xyz link) is preserved through the whole round-trip; see completeRedirectSignIn.
 * @throws {Error} Re-throws all Firebase auth errors except auth/popup-closed-by-user (user cancel).
 * @sideEffect Network: Firebase OAuth popup or full-page redirect; updates Firebase auth state.
 */
export async function signIn() {
  L('auth', 'signIn attempt (popup)')
  try {
    await signInWithPopup(fbAuth, gProvider)
    L('auth', 'signIn success (popup)')
  } catch (e) {
    L('auth', 'signIn popup error', e.code, e.message)
    if (e.code === 'auth/popup-closed-by-user') return
    if (POPUP_UNAVAILABLE_CODES.has(e.code)) {
      L('auth', 'popup unavailable, falling back to redirect')
      await signInWithRedirect(fbAuth, gProvider)
      return
    }
    throw e
  }
}

/**
 * @purpose Complete a signInWithRedirect() round-trip after the page reloads. Call once at startup.
 * @invariant Must never throw or hang startup — a stale/absent redirect result (the common case,
 *   since most sign-ins are via popup) resolves to null and this is a no-op.
 * @sideEffect Network: reads any pending Firebase redirect result.
 */
export async function completeRedirectSignIn() {
  try {
    const result = await getRedirectResult(fbAuth)
    if (result?.user) L('auth', 'signIn success (redirect)')
  } catch (e) {
    L('auth', 'redirect result error', e.code, e.message)
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
