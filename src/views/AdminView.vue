<template>
  <NavBar title="Панель организатора" back-path="/" />
  <div class="admin-view view">
      <div class="admin-head">
        <div class="admin-space-name">{{ space?.title }}</div>
        <div class="admin-status-row">
          <span class="status-pill" :class="isClosed ? 'status-closed' : 'status-active'">
            {{ isClosed ? '○ Завершено' : '● Активно' }}
          </span>
          <button v-if="!isClosed" class="btn btn-ghost btn-sm" @click="router.push(`/space/${spaceId}`)">Голосовать →</button>
          <button v-if="isClosed" class="btn btn-primary btn-sm" @click="router.push(`/space/${spaceId}/results`)">Результаты →</button>
        </div>
        <div class="share-box">
          <div class="share-url">{{ shareUrl }}</div>
          <button class="btn btn-ghost btn-sm" @click="copyLink">Копировать</button>
        </div>
      </div>

      <div class="section-title">Участники</div>
      <div class="member-list">
        <div v-if="loadingMembers" class="spinner" style="margin:20px auto"></div>
        <template v-else>
          <div v-for="m in members" :key="m.uid" class="member-item">
            <div class="m-av">
              <img v-if="m.photoURL" :src="m.photoURL" alt="">
              <template v-else>{{ initials(m.displayName) }}</template>
            </div>
            <div class="m-name">{{ m.displayName || 'Участник' }}{{ m.uid === space?.creatorUid ? ' 👑' : '' }}</div>
            <div class="m-progress-wrap">
              <div class="m-progress-text">{{ progressMap[m.uid] || 0 }}/{{ totalNames }}</div>
              <div class="m-bar"><div class="m-bar-fill" :style="{ width: progressPct(m.uid) + '%' }"></div></div>
            </div>
          </div>
          <p v-if="loadError" style="color:var(--danger,#e53935);font-size:14px;padding:8px 0">
            Не удалось загрузить участников. Проверьте соединение и обновите страницу.
          </p>
          <p v-else-if="!members.length" style="color:var(--t2);font-size:14px;padding:8px 0">Пока нет участников. Поделитесь ссылкой!</p>
        </template>
      </div>

      <div class="admin-actions">
        <button v-if="!isClosed" class="btn btn-danger btn-full" id="btn-close" @click="closeSpace">Завершить голосование</button>
        <button v-else class="btn btn-success btn-full" @click="reopenSpace">Переоткрыть голосование</button>
        <button class="btn btn-ghost btn-full" style="margin-top:8px;color:var(--danger,#e53935)" @click="handleDelete">Удалить голосование</button>
      </div>
    </div>
</template>

<script setup>
import { ref, computed, onMounted, toRaw } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
import { currentUser } from '@/composables/useAuth.js'
import { dbGetSpace, dbSaveSpace } from '@/services/db.js'
import { loadNames, getNamesByGroups } from '@/services/names.js'
import { updateSpace, deleteSpace } from '@/services/sync.js'
import { fbDb, getDocs, collection } from '@/firebase/config.js'
import { getE2EUser } from '@/services/auth.js'
import { spaceUrl, initials } from '@/utils.js'
import { toast } from '@/composables/useToast.js'
import { L } from '@/services/logger.js'

const route = useRoute()
const router = useRouter()
const spaceId = route.params.id

const space = ref(null)
const members = ref([])
const progressMap = ref({})
const loadingMembers = ref(true)
// @purpose Distinguishes "couldn't read members/votes" (Firestore/network failure) from "zero
//   members joined yet" — both previously rendered as the same cheerful "share the link" message,
//   which silently hid real sync failures from the organizer (they'd think nobody had joined).
const loadError = ref(false)

const user = currentUser
const isClosed = computed(() => space.value?.status === 'closed')
const shareUrl = computed(() => spaceUrl(spaceId))
const totalNames = computed(() => getNamesByGroups(space.value?.nameGroups || ['all']).length || 243)

function progressPct(uid) {
  return Math.round((progressMap.value[uid] || 0) / totalNames.value * 100)
}

onMounted(async () => {
  await loadNames()
  space.value = await dbGetSpace(spaceId)
  if (!space.value) { router.replace('/'); return }
  if (space.value.creatorUid !== user.value?.uid) { toast('Нет доступа', 'error'); router.replace('/'); return }

  if (!getE2EUser()) {
    // @invariant This try/catch covers ONLY the read the organizer actually cares about (members +
    //   votes). Only a failure HERE sets loadError — see the separate cache-stat block below for why.
    try {
      const membersSnap = await getDocs(collection(fbDb, 'spaces', spaceId, 'members'))
      const votesSnap = await getDocs(collection(fbDb, 'spaces', spaceId, 'votes'))

      const pm = {}
      votesSnap.docs.forEach(d => { pm[d.id] = Object.keys(d.data().votes || {}).length })
      progressMap.value = pm

      const list = membersSnap.docs.map(d => ({ uid: d.id, ...d.data() }))
      if (!list.some(m => m.uid === space.value.creatorUid)) {
        list.unshift({ uid: space.value.creatorUid, displayName: space.value.creatorName || 'Организатор' })
      }
      members.value = list
    } catch (e) {
      loadError.value = true
      L('admin#members', 'load error', e.message)
    }

    // @invariant Best-effort cache write for HomeView's "👥 N / 📊 %" badges — deliberately a
    //   SEPARATE try/catch from the read above. Two real bugs shipped together here before this fix:
    //   (1) space.value is a Vue reactive Proxy (from `ref()` wrapping the plain object dbGetSpace
    //   returned); IndexedDB's structured-clone algorithm cannot clone a Proxy, so this write threw
    //   "DataCloneError: ... could not be cloned" on every single admin-panel visit. toRaw() unwraps
    //   it to the plain underlying object IndexedDB can actually store.
    //   (2) That exception was caught by the SAME catch block as the read above, which (after the
    //   read had already succeeded and rendered the correct participant list) set loadError=true —
    //   showing a false "не удалось загрузить участников" alarm UNDER a perfectly correct list.
    //   Failing to cache a stat for a DIFFERENT screen must never imply "couldn't load participants".
    if (!loadError.value) {
      try {
        space.value._memberCount = members.value.length
        const total = totalNames.value || 243
        space.value._avgProgress = members.value.length > 0
          ? (members.value.reduce((s, m) => s + (progressMap.value[m.uid] || 0), 0) / members.value.length / total) * 100
          : 0
        await dbSaveSpace(toRaw(space.value))
      } catch (e) {
        L('admin#cacheStats', 'save error', e.message) // best-effort — never surfaced to the user
      }
    }
  }
  loadingMembers.value = false
})

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    toast('Ссылка скопирована ✓', 'ok')
  } catch (_) {
    toast(shareUrl.value)
  }
}

async function closeSpace() {
  if (!confirm('Завершить голосование? Участники увидят результаты.')) return
  await updateSpace(spaceId, { status: 'closed' })
  router.push(`/space/${spaceId}/results`)
}

async function reopenSpace() {
  if (!confirm('Переоткрыть голосование?')) return
  await updateSpace(spaceId, { status: 'active' })
  space.value = { ...space.value, status: 'active' }
}

async function handleDelete() {
  if (!confirm(`Удалить голосование «${space.value?.title}»?\nЭто действие нельзя отменить.`)) return
  await deleteSpace(spaceId)
  router.replace('/')
}
</script>
