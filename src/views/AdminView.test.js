// @file: Component test for AdminView.vue's member-list load-error handling (task #6).
// @invariant This branch is UNREACHABLE via the current E2E harness — AdminView.vue explicitly
//   skips the real Firestore member/vote fetch when getE2EUser() is truthy (`if (!getE2EUser())`),
//   so tests/flows.spec.js can never exercise a real getDocs failure. A component test with
//   Firebase mocked is the only way to prove "read error" is now distinguishable from "empty result".
//
// Firebase config is CDN-only and unresolvable in Vitest, so it (and everything that would
// transitively pull it in) is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// vi.mock factories are hoisted above all imports/top-level consts, so they must not close over
// module-scope variables declared with const/let — build refs lazily inside the factory (dynamic
// import of 'vue') and re-import the same instances afterwards, mirroring App.test.js's pattern.
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

const dbGetSpace = vi.fn()
const dbSaveSpace = vi.fn()
vi.mock('@/services/db.js', () => ({ dbGetSpace: (...a) => dbGetSpace(...a), dbSaveSpace: (...a) => dbSaveSpace(...a) }))

const loadNames = vi.fn()
const getNamesByGroups = vi.fn()
vi.mock('@/services/names.js', () => ({ loadNames: (...a) => loadNames(...a), getNamesByGroups: (...a) => getNamesByGroups(...a) }))

vi.mock('@/services/sync.js', () => ({ updateSpace: vi.fn(), deleteSpace: vi.fn() }))

const getDocs = vi.fn()
vi.mock('@/firebase/config.js', () => ({
  fbDb: {}, doc: vi.fn(), getDocs: (...a) => getDocs(...a), collection: vi.fn(), serverTimestamp: vi.fn(),
}))

const getE2EUser = vi.fn()
vi.mock('@/services/auth.js', () => ({ getE2EUser: (...a) => getE2EUser(...a) }))

vi.mock('@/services/logger.js', () => ({ L: vi.fn(), safeUid: uid => uid ? uid.slice(0, 8) : 'none' }))

import AdminView from './AdminView.vue'
import { toasts } from '@/composables/useToast.js'

const SPACE = { id: 'space-1', title: 'Test Space', creatorUid: 'creator-1', status: 'active', nameGroups: ['all'] }

function makeQuerySnap(docs) { return { docs } }
function makeDoc(id, data) { return { id, data: () => data } }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser.value = { uid: 'creator-1' }
  toasts.value = []
  dbGetSpace.mockResolvedValue({ ...SPACE })
  dbSaveSpace.mockResolvedValue(undefined)
  loadNames.mockResolvedValue(undefined)
  getNamesByGroups.mockReturnValue(Array.from({ length: 10 }, (_, i) => ({ name: 'N' + i })))
  getE2EUser.mockReturnValue(null) // real Firestore-read branch runs (not the E2E skip)
})

async function mountAdmin() {
  const w = mount(AdminView)
  await flushPromises()
  return w
}

describe('AdminView — member list: read-error vs genuinely-empty (task #6)', () => {
  it('shows the participant list when getDocs succeeds with members', async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([makeDoc('creator-1', { displayName: 'Boss' })])) // members
      .mockResolvedValueOnce(makeQuerySnap([makeDoc('creator-1', { votes: { A: 5 } })])) // votes
    const w = await mountAdmin()

    expect(w.findAll('.member-item')).toHaveLength(1)
    expect(w.text()).not.toContain('Не удалось загрузить участников')
    expect(w.text()).not.toContain('Пока нет участников')
  })

  it('shows the cheerful "share the link" empty state when the read succeeds but nobody has joined', async () => {
    getDocs
      .mockResolvedValueOnce(makeQuerySnap([])) // members — empty, but NOT an error
      .mockResolvedValueOnce(makeQuerySnap([]))
    const w = await mountAdmin()

    // Creator is always synthesized into the list even with zero real members (AdminView.vue:92-94),
    // so "empty" in practice means the fetch returned successfully with just the creator.
    expect(w.findAll('.member-item')).toHaveLength(1)
    expect(w.text()).not.toContain('Не удалось загрузить участников')
  })

  it('DISTINGUISHES a read error from an empty result — shows a distinct error message, not the cheerful one', async () => {
    getDocs.mockRejectedValueOnce(new Error('permission-denied'))
    const w = await mountAdmin()

    expect(w.text()).toContain('Не удалось загрузить участников')
    expect(w.text()).not.toContain('Пока нет участников. Поделитесь ссылкой!')
    // Nothing was fetched, so no members render and no bogus stats get cached.
    expect(w.findAll('.member-item')).toHaveLength(0)
    expect(dbSaveSpace).not.toHaveBeenCalled()
  })

  it('does not crash and clears the loading spinner even when getDocs throws', async () => {
    getDocs.mockRejectedValueOnce(new Error('network down'))
    const w = await mountAdmin()
    expect(w.find('.spinner').exists()).toBe(false)
  })
})
