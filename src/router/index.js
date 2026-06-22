// @file: Vue Router configuration — hash history, lazy-loaded views, auth guard.
// @consumers: main.js

import { createRouter, createWebHashHistory } from 'vue-router'
import { authReady, currentUser, waitForAuth } from '@/composables/useAuth.js'

const routes = [
  { path: '/',                      component: () => import('@/views/HomeView.vue') },
  { path: '/login',                 component: () => import('@/views/LoginView.vue') },
  { path: '/new-space',             component: () => import('@/views/NewSpaceView.vue') },
  { path: '/space/:id',             component: () => import('@/views/VotingView.vue') },
  { path: '/space/:id/admin',       component: () => import('@/views/AdminView.vue') },
  { path: '/space/:id/history',     component: () => import('@/views/HistoryView.vue') },
  { path: '/space/:id/results',     component: () => import('@/views/ResultsView.vue') },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

/**
 * @purpose Global auth guard — block unauthenticated navigation and restore post-login deep links.
 * @invariant waitForAuth() must resolve before any route check; authReady is set by initAuth() in main.js.
 * @sideEffect Reads/writes sessionStorage 'pendingRoute' key for deep-link restoration.
 */
router.beforeEach(async (to) => {
  await waitForAuth()

  // #region START_UNAUTHENTICATED_REDIRECT
  // purpose: redirect to /login and save the intended route so it can be restored after sign-in
  if (to.path !== '/login' && !currentUser.value) {
    if (to.path !== '/') sessionStorage.setItem('pendingRoute', '#' + to.fullPath)
    return '/login'
  }
  // #endregion END_UNAUTHENTICATED_REDIRECT

  // #region START_POST_LOGIN_REDIRECT
  // purpose: restore the deep-link the user originally tried to visit before being forced to /login
  if (to.path === '/login' && currentUser.value) {
    const pending = sessionStorage.getItem('pendingRoute')
    if (pending) {
      sessionStorage.removeItem('pendingRoute')
      return pending.replace(/^#/, '') || '/'
    }
    return '/'
  }
  // #endregion END_POST_LOGIN_REDIRECT
})

export default router
