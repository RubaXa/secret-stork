// Tests for the reactive auth composable (module singletons: currentUser, authReady, _initialized).
// Uses vi.resetModules() per case so each test gets a fresh singleton state.
// services/auth.js and services/sync.js are mocked so nothing touches Firebase/IDB.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getE2EUser = vi.fn()
const onAuthStateChanged = vi.fn()
const setSyncUser = vi.fn()

vi.mock('@/services/auth.js', () => ({ getE2EUser, onAuthStateChanged }))
vi.mock('@/services/sync.js', () => ({ setSyncUser }))
// logger.js has no Firebase import, but mock it to keep console quiet + deterministic.
vi.mock('@/services/logger.js', () => ({ L: vi.fn(), safeUid: uid => uid ? uid.slice(0, 8) : 'none' }))

// Each test needs a fresh copy of the module singletons (currentUser/authReady/_initialized).
// Mocks are reset in beforeEach (not here) so per-test mockReturnValue/mockImplementation
// set before freshModule() survive.
async function freshModule() {
  vi.resetModules()
  return import('./useAuth.js')
}

beforeEach(() => {
  getE2EUser.mockReset()
  onAuthStateChanged.mockReset()
  setSyncUser.mockReset()
  getE2EUser.mockReturnValue(null)
})

describe('initAuth — E2E-user path', () => {
  it('sets currentUser + authReady and bypasses Firebase (no onAuthStateChanged)', async () => {
    const e2eUser = { uid: 'e2e-1' }
    getE2EUser.mockReturnValue(e2eUser)
    const m = await freshModule()

    m.initAuth()

    // ref assignment wraps the object in a reactive proxy → compare by value, not identity.
    expect(m.currentUser.value).toEqual(e2eUser)
    expect(m.authReady.value).toBe(true)
    expect(setSyncUser).toHaveBeenCalledWith(e2eUser)
    expect(onAuthStateChanged).not.toHaveBeenCalled()
  })
})

describe('initAuth — Firebase path', () => {
  it('subscribes to onAuthStateChanged and leaves authReady false until the callback fires', async () => {
    const m = await freshModule()

    m.initAuth()

    expect(onAuthStateChanged).toHaveBeenCalledTimes(1)
    expect(m.authReady.value).toBe(false)
    expect(m.currentUser.value).toBeNull()
  })

  it('sets currentUser + authReady when the auth callback fires with a user', async () => {
    let captured
    onAuthStateChanged.mockImplementation(cb => { captured = cb })
    const m = await freshModule()

    m.initAuth()
    const user = { uid: 'firebase-abc' }
    captured(user)

    // ref assignment wraps the object in a reactive proxy → compare by value, not identity.
    expect(m.currentUser.value).toEqual(user)
    expect(m.authReady.value).toBe(true)
    expect(setSyncUser).toHaveBeenCalledWith(user)
  })

  it('sets authReady=true with currentUser=null when the callback fires with null (signed out)', async () => {
    let captured
    onAuthStateChanged.mockImplementation(cb => { captured = cb })
    const m = await freshModule()

    m.initAuth()
    captured(null)

    expect(m.currentUser.value).toBeNull()
    expect(m.authReady.value).toBe(true)
    expect(setSyncUser).toHaveBeenCalledWith(null)
  })
})

describe('initAuth — idempotency', () => {
  it('is a no-op on the second call (does not re-subscribe)', async () => {
    const m = await freshModule()

    m.initAuth()
    m.initAuth()

    expect(onAuthStateChanged).toHaveBeenCalledTimes(1)
  })

  it('a second call does not re-run the E2E bypass either', async () => {
    getE2EUser.mockReturnValue({ uid: 'e2e-1' })
    const m = await freshModule()

    m.initAuth()
    m.initAuth()

    // getE2EUser called exactly once — second call returned early before reaching it.
    expect(getE2EUser).toHaveBeenCalledTimes(1)
    expect(setSyncUser).toHaveBeenCalledTimes(1)
  })
})

describe('waitForAuth', () => {
  it('resolves immediately when authReady is already true', async () => {
    const m = await freshModule()
    m.authReady.value = true
    await expect(m.waitForAuth()).resolves.toBeUndefined()
  })

  it('resolves once authReady flips to true', async () => {
    const m = await freshModule()
    let resolved = false
    const p = m.waitForAuth().then(() => { resolved = true })

    // Not resolved yet — auth still pending.
    await Promise.resolve()
    expect(resolved).toBe(false)

    m.authReady.value = true
    await p
    expect(resolved).toBe(true)
  })

  it('resolves when the onAuthStateChanged callback flips authReady', async () => {
    let captured
    onAuthStateChanged.mockImplementation(cb => { captured = cb })
    const m = await freshModule()

    m.initAuth()
    const p = m.waitForAuth()
    captured({ uid: 'u1' })
    await expect(p).resolves.toBeUndefined()
  })
})
