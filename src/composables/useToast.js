// @file: Vue composable — ephemeral toast notification queue.
// @consumers: ToastContainer.vue (reads toasts ref), any view (calls toast())

import { ref } from 'vue'

/** @purpose Reactive list of active toast notifications rendered by ToastContainer. */
export const toasts = ref([])
let _id = 0

/**
 * @purpose Push a toast message and auto-remove it after 3.2 seconds.
 * @param {string} msg Display message.
 * @param {string} [type=''] Visual variant: 'ok' | 'error' | '' (neutral).
 * @sideEffect Mutates toasts ref; schedules a setTimeout for removal.
 */
export function toast(msg, type = '') {
  const id = ++_id
  toasts.value.push({ id, msg, type })
  setTimeout(() => {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx !== -1) toasts.value.splice(idx, 1)
  }, 3200)
}
