// @file: Vue Router configuration — hash history, lazy-loaded views.
// @consumers: main.js
// @invariant No auth guard here. Auth is a RENDER GATE in App.vue (LoginView shown in place while
//   signed out) so the URL never changes during sign-in and deep links can't be lost. There is
//   deliberately NO /login route and NO pendingRoute — see App.vue for why.

import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/',                      component: () => import('@/views/HomeView.vue') },
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

export default router
