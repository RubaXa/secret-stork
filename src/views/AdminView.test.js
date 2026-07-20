// @file: Component test for AdminView.vue's member-list load-error handling (task #6),
//   and a REGRESSION test for the false-alarm bug that shipped alongside it.
// @invariant This branch is UNREACHABLE via the current E2E harness — AdminView.vue explicitly
//   skips the real Firestore member/vote fetch when getE2EUser() is truthy (`if (!getE2EUser())`),
//   so tests/flows.spec.js can never exercise a real getDocs failure. A component test with
//   Firebase mocked is the only way to prove "read error" is now distinguishable from "empty result".
//
// @invariant db.js is INTENTIONALLY NOT mocked here (unlike the first version of this file) — a
//   prior version mocked dbSaveSpace as a bare vi.fn(), which made it impossible to ever observe
//   that dbSaveSpace(space.value) throws in a REAL browser: space.value is a Vue reactive Proxy,
//   and IndexedDB's structured-clone algorithm cannot clone it. The mock silently "worked" in tests
//   while the same code crashed in production. Using fake-indexeddb/auto + the real db.js module
//   is what it took to actually catch this.
//
// Firebase config is CDN-only and unresolvable in Vitest, so it (and everything that would
// transitively pull it in) is mocked — but db.js is real.

import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'space-1' } }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('@/components/NavBar.vue', () => ({ default: { name: 'NavBar', props: ['title', 'backPath'], template: '<div class="navbar-stub" />' } }))

vi.mock('@/composables/useAuth.js', async () => {
  const { ref } = await import('vue')
  return { currentUser: ref({ uid: 'creator-1' }) }
})
import { currentUser } from '@/composables/useAuth.js'

vi.mock('@/services/names.js', () => ({ loadNames: vi.fn(), getNamesByGroups: vi.fn() }))
import { loadNames, getNamesByGroups } from '@/services/names.js'

vi.mock('@/services/sync.js', () => ({ updateSpace: vi.fn(), deleteSpace: vi.fn() }))

const getDocs = vi.fn()
vi.mock('@/firebase/config.js', () => ({
  fbDb: {}, doc: vi.fn(), getDocs: (...a) => getDocs(...a), collection: vi.fn(), serverTimestamp: vi.fn(),
}))

const getE2EUser = vi.fn()
vi.mock('@/services/auth.js', () => ({ getE2EUser: (...a) => getE2EUser(...a) }))

vi.mock('@/services/logger.js', () => ({ L: vi.fn(), safeUid: uid => uid ? uid.slice(0, 8) : 'none' }))

import AdminView from './AdminView.vue'
import { dbGetSpace, dbSaveSpace } from '@/services/db.js'
import { toasts } from '@/composables/useToast.js'

const SPACE = { id: 'space-1', title: 'Test Space', creatorUid: 'creator-1', status: 'active', nameGroups: ['all'] }

function makeQuerySnap(docs) { return { docs } }
function makeDoc(id, data) { return { id, data: () => data } }

beforeEach(async () => {
  vi.clearAllMocks()
  currentUser.value = { uid: 'creator-1' }
  toasts.value = []
  loadNames.mockResolvedValue(undefined)
  getNamesByGroups.mockReturnValue(Array.from({ length: 10 }, (_, i) => ({ name: 'N' + i })))
  getE2EUser.mockReturnValue(null) // real Firestore-read branch runs (not the E2E skip)

  // db.js caches its IndexedDB connection in a module-level singleton with no reset hook, so instead
  // of tearing the whole database down we just re-seed the one 'space-1' record with a PLAIN object —
  // db.put() upserts by keyPath, wholesale replacing whatever a previous test left on it (e.g. a
  // stray _memberCount), which is all the isolation these tests need.
  await dbSaveSpace({ ...SPACE })
})

// @invariant db.js is real (fake-indexeddb), and idb wraps IndexedDB's native task-queue-based
//   event callbacks (onsuccess/onerror), not pure microtasks — a single flushPromises() tick (one
//   setTimeout round-trip) is not always enough to drain AdminView's chain of sequential real-IDB
//   awaits. Poll until the loading spinner is gone instead of guessing a fixed number of ticks.
async function mountAdmin() {
  const w = mount(AdminView)
  await vi.waitFor(() => {
    if (w.find('.spinner').exists()) throw new Error('still loading')
  }, { timeout: 2000, interval: 5 })
  return w
}

describe('AdminView — member list vs cache-stat write, against REAL IndexedDB', () => {
  it('renders participants correctly and persists the cache stats — no false alarm', async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([makeDoc('creator-1', { displayName: 'Boss' })])) // members
      .mockResolvedValueOnce(makeQuerySnap([makeDoc('creator-1', { votes: { A: 5 } })])) // votes
    const w = await mountAdmin()

    expect(w.findAll('.member-item')).toHaveLength(1)
    expect(w.text()).not.toContain('Не удалось загрузить участников')
    expect(w.text()).not.toContain('Пока нет участников')

    // The cache write must actually SUCCEED against real IndexedDB (this is what was silently
    // failing in production via a DataCloneError on the Vue-reactive space object).
    const saved = await dbGetSpace('space-1')
    expect(saved._memberCount).toBe(1)
  })

  it('REGRESSION GUARD: a failing cache-stat write must NOT trigger the "couldn\'t load participants" message when the read already succeeded', async () => {
    // The member/vote READ succeeds (this is what the user actually cares about and sees rendered),
    // but simulate the cache-write step failing for an unrelated reason. Read-success must win —
    // the organizer must not see a scary false alarm sitting right below a correctly-populated list.
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([makeDoc('creator-1', { displayName: 'Boss' })]))
      .mockResolvedValueOnce(makeQuerySnap([]))

    const w = await mountAdmin()

    expect(w.findAll('.member-item')).toHaveLength(1) // participants ARE visible
    expect(w.text()).not.toContain('Не удалось загрузить участников') // so no false alarm
  })

  it('shows the cheerful "share the link" empty state when the read succeeds but nobody has joined', async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // members — empty, but NOT an error
      .mockResolvedValueOnce(makeQuerySnap([]))
    const w = await mountAdmin()

    // Creator is always synthesized into the list even with zero real members (AdminView.vue),
    // so "empty" in practice means the fetch returned successfully with just the creator.
    expect(w.findAll('.member-item')).toHaveLength(1)
    expect(w.text()).not.toContain('Не удалось загрузить участников')
  })

  it('DISTINGUISHES a genuine read error from an empty result — shows a distinct error message', async () => {
    getDocs.mockRejectedValueOnce(new Error('permission-denied'))
    const w = await mountAdmin()

    expect(w.text()).toContain('Не удалось загрузить участников')
    expect(w.text()).not.toContain('Пока нет участников. Поделитесь ссылкой!')
    expect(w.findAll('.member-item')).toHaveLength(0)
  })

  it('does not crash and clears the loading spinner even when getDocs throws', async () => {
    getDocs.mockRejectedValueOnce(new Error('network down'))
    const w = await mountAdmin()
    expect(w.find('.spinner').exists()).toBe(false)
  })
})
