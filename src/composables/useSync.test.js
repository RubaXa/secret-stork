import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// useSync delegates to services/sync.js — mock it so we test the composable's own logic
// (status mapping + 30s throttle) without touching Firebase/IDB.
vi.mock('@/services/sync.js', () => ({
  drainOutbox: vi.fn(),
  syncSpacesFromFirestore: vi.fn(),
}))

import { drain, syncHome, resetSyncTimer, resetDrainFailureTracking, startPeriodicDrain, stopPeriodicDrain, syncStatus, pendingCount } from './useSync.js'
import { drainOutbox, syncSpacesFromFirestore } from '@/services/sync.js'
import { toasts } from './useToast.js'

beforeEach(() => {
  vi.clearAllMocks()
  resetSyncTimer()
  resetDrainFailureTracking()
  stopPeriodicDrain() // in case a previous test left a timer running
  syncStatus.value = 'ok'
  pendingCount.value = 0
  toasts.value = []
})

describe('drain — status mapping', () => {
  it('ok on a clean drain', async () => {
    drainOutbox.mockResolvedValue({ status: 'ok', remaining: 0 })
    await drain()
    expect(syncStatus.value).toBe('ok')
    expect(pendingCount.value).toBe(0)
  })

  it('pending when entries remain', async () => {
    drainOutbox.mockResolvedValue({ status: 'ok', remaining: 3 })
    await drain()
    expect(syncStatus.value).toBe('pending')
    expect(pendingCount.value).toBe(3)
  })

  it('error when drain failed with nothing left pending', async () => {
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 0 })
    await drain()
    expect(syncStatus.value).toBe('error')
  })

  it('leaves status untouched when there is no user', async () => {
    syncStatus.value = 'ok'
    drainOutbox.mockResolvedValue({ status: 'no-user', remaining: 0 })
    await drain()
    expect(syncStatus.value).toBe('ok')
  })

  it('pending (held-for-another-uid entries, not a real failure) does not count towards the failure toast', async () => {
    drainOutbox.mockResolvedValue({ status: 'ok', remaining: 2 })
    await drain(); await drain(); await drain()
    expect(toasts.value).toHaveLength(0)
  })
})

describe('drain — persistent-failure toast', () => {
  it('does NOT toast on a single failed drain (avoids spamming on a one-off blip)', async () => {
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 1 })
    await drain()
    await drain()
    expect(toasts.value).toHaveLength(0) // below PERSISTENT_FAILURE_THRESHOLD (3)
  })

  it('toasts once the failure persists across 3 consecutive drains', async () => {
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 1 })
    await drain(); await drain(); await drain()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].type).toBe('error')
  })

  it('does not toast again on further consecutive failures (warns only once)', async () => {
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 1 })
    await drain(); await drain(); await drain(); await drain(); await drain()
    expect(toasts.value).toHaveLength(1)
  })

  it('recovering to ok resets the counter — a later failure streak toasts again', async () => {
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 1 })
    await drain(); await drain(); await drain()
    expect(toasts.value).toHaveLength(1)

    drainOutbox.mockResolvedValue({ status: 'ok', remaining: 0 })
    await drain() // recovers — resets the consecutive-error counter and the warned flag

    toasts.value = [] // clear so the next assertion is unambiguous
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 1 })
    await drain(); await drain(); await drain()
    expect(toasts.value).toHaveLength(1) // warns again for the NEW failure streak
  })
})

describe('syncHome — 30s throttle', () => {
  it('runs the first call, throttles the second within 30s', async () => {
    syncSpacesFromFirestore.mockResolvedValue(true)
    expect(await syncHome('u1')).toBe(true)
    expect(await syncHome('u1')).toBe(false)
    expect(syncSpacesFromFirestore).toHaveBeenCalledTimes(1)
  })

  it('resetSyncTimer forces the next call to fetch again', async () => {
    syncSpacesFromFirestore.mockResolvedValue(false)
    await syncHome('u1')
    resetSyncTimer()
    await syncHome('u1')
    expect(syncSpacesFromFirestore).toHaveBeenCalledTimes(2)
  })
})

describe('startPeriodicDrain / stopPeriodicDrain', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { stopPeriodicDrain(); vi.useRealTimers() })

  it('retries a stuck outbox on its own, without any new user action', async () => {
    drainOutbox.mockResolvedValue({ status: 'error', remaining: 1 })
    startPeriodicDrain()

    expect(drainOutbox).not.toHaveBeenCalled() // no drain yet — timer hasn't fired

    await vi.advanceTimersByTimeAsync(30_000)
    expect(drainOutbox).toHaveBeenCalledTimes(1) // fired on its own — no vote/foreground/online event

    await vi.advanceTimersByTimeAsync(30_000)
    expect(drainOutbox).toHaveBeenCalledTimes(2) // keeps retrying
  })

  it('is idempotent — calling it twice does not start a second timer', async () => {
    drainOutbox.mockResolvedValue({ status: 'ok', remaining: 0 })
    startPeriodicDrain()
    startPeriodicDrain()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(drainOutbox).toHaveBeenCalledTimes(1) // would be 2 if a second timer had started
  })

  it('stopPeriodicDrain halts future retries', async () => {
    drainOutbox.mockResolvedValue({ status: 'ok', remaining: 0 })
    startPeriodicDrain()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(drainOutbox).toHaveBeenCalledTimes(1)

    stopPeriodicDrain()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(drainOutbox).toHaveBeenCalledTimes(1) // no further calls after stop
  })
})
