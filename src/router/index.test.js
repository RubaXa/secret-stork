// Tests the router config: exact route table, the deliberate absence of a /login route
// (auth is a render gate in App.vue, not a route), and scrollBehavior resetting to top.
// vue-router's createWebHashHistory touches window.location — happy-dom provides it.

import { describe, it, expect } from 'vitest'
import router from './index.js'

const paths = () => router.getRoutes().map(r => r.path).sort()

describe('router route table', () => {
  it('registers exactly the expected paths', () => {
    expect(paths()).toEqual([
      '/',
      '/new-space',
      '/space/:id',
      '/space/:id/admin',
      '/space/:id/history',
      '/space/:id/results',
    ].sort())
  })

  it('has NO /login route (auth is a render gate, not a route)', () => {
    expect(paths()).not.toContain('/login')
    expect(router.hasRoute('login')).toBe(false)
    // No route resolves to a /login path either.
    expect(router.resolve('/login').matched.length).toBe(0)
  })

  it('resolves the home route', () => {
    expect(router.resolve('/').matched.length).toBeGreaterThan(0)
  })

  it('resolves a parameterised space route and captures :id', () => {
    const resolved = router.resolve('/space/abc123')
    expect(resolved.matched.length).toBeGreaterThan(0)
    expect(resolved.params.id).toBe('abc123')
  })

  it('uses hash history (routes are hash-based, not path-based)', () => {
    // createWebHashHistory yields hash-prefixed URLs; the resolved href for '/' contains '#'.
    expect(router.resolve('/').href).toContain('#')
  })
})

describe('router scrollBehavior', () => {
  it('always scrolls to the top', () => {
    expect(router.options.scrollBehavior()).toEqual({ top: 0 })
  })
})
