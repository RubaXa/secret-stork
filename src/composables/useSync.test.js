import { describe, it, expect, vi, beforeEach } from 'vitest'

// useSync delegates to services/sync.js — mock it so we test the composable's own logic
// (status mapping + 30s throttle) without touching Firebase/IDB.
vi.mock('@/services/sync.js', () => ({
  drainOutbox: vi.fn(),
  syncSpacesFromFirestore: vi.fn(),
}))

import { drain, syncHome, resetSyncTimer, syncStatus, pendingCount } from './useSync.js'
import { drainOutbox, syncSpacesFromFirestore } from '@/services/sync.js'

beforeEach(() => {
  vi.clearAllMocks()
  resetSyncTimer()
  syncStatus.value = 'ok'
  pendingCount.value = 0
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
