import { createRouter, createWebHashHistory } from 'vue-router'

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

// View Transitions API — wired in VotingView per-card only;
// global page transitions handled by <Transition> in App.vue

export default router
