<!--
  @file: Root component. Auth is a RENDER GATE, not a route.
  @invariant While signed out we render LoginView IN PLACE without touching the URL. So a shared deep
    link (e.g. #/space/xyz) is never lost: the URL the user opened stays put through sign-in, and the
    moment auth resolves RouterView renders that exact route. This deletes the whole /login-redirect +
    sessionStorage 'pendingRoute' round-trip — there is nothing to save or restore, hence nothing to
    lose or guess. That round-trip was the root cause of invited users landing on an empty home.
-->
<template>
  <div v-if="!authReady" class="loading-screen"><div class="spinner"></div></div>
  <LoginView v-else-if="!user" />
  <RouterView v-else />
  <ToastContainer />
</template>

<script setup>
import { RouterView } from 'vue-router'
import { currentUser, authReady } from '@/composables/useAuth.js'
import LoginView from '@/views/LoginView.vue'
import ToastContainer from '@/components/ToastContainer.vue'

const user = currentUser
</script>
