// Tests for the Firebase auth wrappers + E2E-user injection guard.
// firebase/config.js loads Firebase from https:// CDN URLs Vitest can't resolve, so it is fully mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/firebase/config.js', () => ({
  fbAuth: {},
  gProvider: {},
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  getRedirectResult: vi.fn(),
  fbSignOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  fbDb: {},
  doc: vi.fn(),
  setDoc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  collection: vi.fn(),
  serverTimestamp: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
}))

import { signIn, signOut, onAuthStateChanged, getE2EUser, completeRedirectSignIn } from './auth.js'
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  fbSignOut,
  fbAuth,
  gProvider,
  onAuthStateChanged as _onAuthStateChanged,
} from '@/firebase/config.js'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('getE2EUser', () => {
  const user = { uid: 'e2e-123', name: 'Test' }
  const validParam = () => btoa(JSON.stringify(user))

  it('returns the parsed user for a valid base64 ?e2e_user= on localhost', () => {
    vi.stubGlobal('location', { search: `?e2e_user=${validParam()}`, hostname: 'localhost' })
    expect(getE2EUser()).toEqual(user)
  })

  it('accepts 127.0.0.1 as a localhost host', () => {
    vi.stubGlobal('location', { search: `?e2e_user=${validParam()}`, hostname: '127.0.0.1' })
    expect(getE2EUser()).toEqual(user)
  })

  it('returns null on a non-localhost hostname (privilege-escalation guard)', () => {
    // Same valid payload, but a production-like host must never be honoured.
    vi.stubGlobal('location', { search: `?e2e_user=${validParam()}`, hostname: 'rubaxa.github.io' })
    expect(getE2EUser()).toBeNull()
  })

  it('returns null when the ?e2e_user= param is absent (even on localhost)', () => {
    vi.stubGlobal('location', { search: '', hostname: 'localhost' })
    expect(getE2EUser()).toBeNull()
  })

  it('returns null for a malformed base64 param on localhost', () => {
    // '@@@' is not valid base64 → atob throws → caught → null.
    vi.stubGlobal('location', { search: '?e2e_user=@@@not-base64@@@', hostname: 'localhost' })
    expect(getE2EUser()).toBeNull()
  })

  it('returns null when the decoded param is not valid JSON', () => {
    // Valid base64 that decodes to a non-JSON string → JSON.parse throws → caught → null.
    vi.stubGlobal('location', { search: `?e2e_user=${btoa('not json at all')}`, hostname: 'localhost' })
    expect(getE2EUser()).toBeNull()
  })
})

describe('signIn', () => {
  it('resolves on a successful popup sign-in', async () => {
    signInWithPopup.mockResolvedValue({ user: { uid: 'ok' } })
    await expect(signIn()).resolves.toBeUndefined()
    expect(signInWithPopup).toHaveBeenCalledWith(fbAuth, gProvider)
  })

  it('swallows auth/popup-closed-by-user (user cancelled — no throw)', async () => {
    const err = Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' })
    signInWithPopup.mockRejectedValue(err)
    await expect(signIn()).resolves.toBeUndefined()
  })

  it('re-throws any other Firebase auth error', async () => {
    const err = Object.assign(new Error('network'), { code: 'auth/network-request-failed' })
    signInWithPopup.mockRejectedValue(err)
    await expect(signIn()).rejects.toBe(err)
    expect(signInWithRedirect).not.toHaveBeenCalled()
  })

  // Mobile browsers and in-app messenger WebViews (how a shared link is actually opened) commonly
  // block window.open, so signInWithPopup fails with one of these codes — this is the likely #1
  // reason invited participants could never sign in and join a space.
  it.each([
    'auth/popup-blocked',
    'auth/operation-not-supported-in-this-environment',
  ])('falls back to signInWithRedirect when popup is unavailable (%s)', async (code) => {
    const err = Object.assign(new Error('no popup'), { code })
    signInWithPopup.mockRejectedValue(err)
    signInWithRedirect.mockResolvedValue(undefined)

    await expect(signIn()).resolves.toBeUndefined()

    expect(signInWithRedirect).toHaveBeenCalledWith(fbAuth, gProvider)
  })

  it('does NOT fall back to redirect when the user simply closes the popup', async () => {
    const err = Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' })
    signInWithPopup.mockRejectedValue(err)
    await signIn()
    expect(signInWithRedirect).not.toHaveBeenCalled()
  })
})

describe('completeRedirectSignIn', () => {
  it('resolves silently when there is no pending redirect (the common case — most sign-ins are via popup)', async () => {
    getRedirectResult.mockResolvedValue(null)
    await expect(completeRedirectSignIn()).resolves.toBeUndefined()
  })

  it('resolves when a redirect sign-in completed with a user', async () => {
    getRedirectResult.mockResolvedValue({ user: { uid: 'redirected-in' } })
    await expect(completeRedirectSignIn()).resolves.toBeUndefined()
  })

  it('never throws — a redirect-result error is caught, not propagated (must not hang app startup)', async () => {
    getRedirectResult.mockRejectedValue(Object.assign(new Error('boom'), { code: 'auth/some-error' }))
    await expect(completeRedirectSignIn()).resolves.toBeUndefined()
  })
})

describe('signOut', () => {
  it('delegates to Firebase fbSignOut with the auth instance', async () => {
    fbSignOut.mockResolvedValue(undefined)
    await expect(signOut()).resolves.toBeUndefined()
    expect(fbSignOut).toHaveBeenCalledWith(fbAuth)
  })
})

describe('onAuthStateChanged', () => {
  it('subscribes via the Firebase primitive and returns its unsubscribe function', () => {
    const unsub = vi.fn()
    _onAuthStateChanged.mockReturnValue(unsub)
    const cb = vi.fn()
    const result = onAuthStateChanged(cb)
    expect(_onAuthStateChanged).toHaveBeenCalledWith(fbAuth, cb)
    expect(result).toBe(unsub)
  })
})
