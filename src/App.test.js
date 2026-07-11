// Tests App.vue's auth render gate: loading spinner → LoginView → RouterView.
// useAuth is mocked with controllable refs so we can drive authReady/currentUser directly.
// The child components are stubbed so nothing pulls in Firebase/router internals.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// The mock factory must not close over module-scope refs (vi.mock is hoisted above imports),
// so build the composable mock lazily inside the factory and re-import the refs afterwards.
vi.mock('@/composables/useAuth.js', async () => {
  const { ref } = await import('vue')
  return { currentUser: ref(null), authReady: ref(false) }
})

// Pull the same ref instances the component will consume.
import { currentUser, authReady } from '@/composables/useAuth.js'
vi.mock('@/views/LoginView.vue', () => ({ default: { name: 'LoginView', template: '<div class="login-view-stub" />' } }))
vi.mock('@/components/ToastContainer.vue', () => ({ default: { name: 'ToastContainer', template: '<div class="toast-stub" />' } }))

import App from './App.vue'

const RouterViewStub = { name: 'RouterView', template: '<div class="router-view-stub" />' }

function mountApp() {
  return mount(App, { global: { stubs: { RouterView: RouterViewStub } } })
}

beforeEach(() => {
  currentUser.value = null
  authReady.value = false
})

describe('App.vue auth render gate', () => {
  it('shows the loading screen while auth is not ready', () => {
    authReady.value = false
    const w = mountApp()
    expect(w.find('.loading-screen').exists()).toBe(true)
    expect(w.find('.loading-screen .spinner').exists()).toBe(true)
    expect(w.findComponent(RouterViewStub).exists()).toBe(false)
    expect(w.find('.login-view-stub').exists()).toBe(false)
  })

  it('renders LoginView when auth is ready but there is no user', () => {
    authReady.value = true
    currentUser.value = null
    const w = mountApp()
    expect(w.find('.loading-screen').exists()).toBe(false)
    expect(w.find('.login-view-stub').exists()).toBe(true)
    expect(w.findComponent(RouterViewStub).exists()).toBe(false)
  })

  it('renders RouterView when auth is ready and a user is signed in', () => {
    authReady.value = true
    currentUser.value = { uid: 'u1' }
    const w = mountApp()
    expect(w.find('.loading-screen').exists()).toBe(false)
    expect(w.find('.login-view-stub').exists()).toBe(false)
    expect(w.findComponent(RouterViewStub).exists()).toBe(true)
  })

  it('always renders ToastContainer regardless of gate state', () => {
    const w = mountApp()
    expect(w.find('.toast-stub').exists()).toBe(true)
  })

  it('reactively transitions loading → login → app as auth resolves', async () => {
    const w = mountApp()
    expect(w.find('.loading-screen').exists()).toBe(true)

    // Auth resolves with no user → login gate.
    authReady.value = true
    await nextTick()
    expect(w.find('.login-view-stub').exists()).toBe(true)

    // User signs in → app renders.
    currentUser.value = { uid: 'u1' }
    await nextTick()
    expect(w.findComponent(RouterViewStub).exists()).toBe(true)
    expect(w.find('.login-view-stub').exists()).toBe(false)
  })
})
