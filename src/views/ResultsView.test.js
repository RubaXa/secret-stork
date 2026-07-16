// @file: Component test for ResultsView.vue — clamped rating lookups (task #11 / M18 finding).
// @invariant This view is 0% unit-covered otherwise; Firebase config is CDN-only and unresolvable
//   in Vitest, so it (and everything that transitively pulls it in) is mocked, mirroring
//   AdminView.test.js's proven pattern.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

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
vi.mock('@/services/db.js', () => ({ dbGetSpace: (...a) => dbGetSpace(...a) }))

const loadNames = vi.fn()
const getNames = vi.fn()
vi.mock('@/services/names.js', () => ({ loadNames: (...a) => loadNames(...a), getNames: (...a) => getNames(...a) }))

const getDocs = vi.fn()
vi.mock('@/firebase/config.js', () => ({ fbDb: {}, getDocs: (...a) => getDocs(...a), collection: vi.fn() }))

import ResultsView from './ResultsView.vue'

const SPACE = { id: 'space-1', title: 'Test Space', creatorUid: 'creator-1', status: 'closed', nameGroups: ['all'] }

function makeQuerySnap(docs) { return { docs } }
function makeDoc(id, data) { return { id, data: () => data } }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser.value = { uid: 'creator-1' }
  dbGetSpace.mockResolvedValue({ ...SPACE })
  loadNames.mockResolvedValue(undefined)
  getNames.mockReturnValue([{ name: 'Аврора', origin: 'Тест', popularity: 0.5 }])
})

async function mountResults() {
  const w = mount(ResultsView)
  await flushPromises()
  return w
}

describe('ResultsView — rating lookups survive a corrupt/out-of-range score (task #11 / M18)', () => {
  it('renders normally for a valid score (sanity baseline)', async () => {
    getDocs.mockResolvedValue(makeQuerySnap([makeDoc('creator-1', { votes: { 'Аврора': 5 } })]))
    const w = await mountResults()
    expect(w.find('.lik-row').exists()).toBe(true)
  })

  it('does NOT crash when a stored vote score is out of range (6) — likert view', async () => {
    getDocs.mockResolvedValue(makeQuerySnap([makeDoc('creator-1', { votes: { 'Аврора': 6 } })]))
    await expect(mountResults()).resolves.toBeTruthy()
  })

  it('does NOT crash on an out-of-range score — heat view', async () => {
    getDocs.mockResolvedValue(makeQuerySnap([makeDoc('creator-1', { votes: { 'Аврора': 6 } })]))
    const w = await mountResults()
    await w.findAll('.viz-btn')[1].trigger('click') // ⊞ Карта
    expect(w.find('.heat-table').exists()).toBe(true)
  })

  it('does NOT crash on an out-of-range score — strip view', async () => {
    getDocs.mockResolvedValue(makeQuerySnap([makeDoc('creator-1', { votes: { 'Аврора': 6 } })]))
    const w = await mountResults()
    await w.findAll('.viz-btn')[2].trigger('click') // · Точки
    expect(w.find('.strip-row').exists()).toBe(true)
  })
})
