import { describe, it, expect, vi, beforeEach } from 'vitest'

// loadNames cascade: IDB cache → network fetch → static fallback. Mock the IDB layer so we
// exercise all three branches without a real IndexedDB.
vi.mock('./db.js', () => ({ getDB: vi.fn() }))

import { loadNames, getNames } from './names.js'
import { getDB } from './db.js'

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('loadNames cascade', () => {
  it('returns the IDB cache when present (no network)', async () => {
    getDB.mockResolvedValue({ getAll: vi.fn().mockResolvedValue([{ name: 'Анна', origin: 'X' }]) })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await loadNames()
    expect(r).toEqual([{ name: 'Анна', origin: 'X' }])
    expect(getNames()).toEqual(r)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches from network on cache miss and writes to IDB', async () => {
    const put = vi.fn()
    getDB.mockResolvedValue({
      getAll: vi.fn().mockResolvedValue([]),
      transaction: () => ({ store: { put }, done: Promise.resolve() }),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [{ name: 'Мария', origin: 'Y' }] }))
    const r = await loadNames()
    expect(r).toEqual([{ name: 'Мария', origin: 'Y' }])
    expect(put).toHaveBeenCalledWith({ name: 'Мария', origin: 'Y' })
  })

  it('falls back to ALL_NAMES (name-only) when IDB is empty and fetch fails', async () => {
    getDB.mockResolvedValue({
      getAll: vi.fn().mockResolvedValue([]),
      transaction: () => ({ store: { put: vi.fn() }, done: Promise.resolve() }),
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const r = await loadNames()
    expect(r.length).toBe(243)
    expect(r[0]).toHaveProperty('name')
    expect(r[0].origin).toBeUndefined() // fallback entries carry no origin metadata
  })
})
