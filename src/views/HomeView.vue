<!--
  @file: Home page — space list + create flow.
  Uses <NavBar> with a static title and default props (no backPath — this is the root screen).
-->
<template>
  <NavBar title="✨ Назовём" />

    <div class="home-view view">
      <button class="home-create" @click="router.push('/new-space')">
        <div>
          <div class="home-create-text">Новое голосование</div>
          <div class="home-create-sub">Поделитесь ссылкой с семьёй</div>
        </div>
        <div class="home-create-icon">🎴</div>
      </button>

      <div class="home-tabs">
        <button class="home-tab" :class="{ active: tab === 'participating' }" @click="tab = 'participating'">
          Участвую{{ participatingSpaces.length ? ` (${participatingSpaces.length})` : '' }}
        </button>
        <button class="home-tab" :class="{ active: tab === 'mine' }" @click="tab = 'mine'">
          Мои голосования{{ mySpaces.length ? ` (${mySpaces.length})` : '' }}
        </button>
      </div>

      <div class="space-list">
        <template v-if="shownSpaces.length">
          <template v-if="tab === 'mine'">
            <div v-for="s in shownSpaces" :key="s.id" class="space-card" @click="router.push(`/space/${s.id}/admin`)">
              <div>
                <div class="space-card-name">{{ s.title }}</div>
                <div class="space-card-meta">
                  <span class="status-pill" :class="s.status === 'active' ? 'status-active' : 'status-closed'">
                    {{ s.status === 'active' ? '● Открыт' : '○ Закрыт' }}
                  </span>
                  <span>👥 {{ s._memberCount !== undefined ? s._memberCount : '?' }}</span>
                  <span v-if="s._avgProgress !== undefined">📊 {{ Math.round(s._avgProgress) }}%</span>
                </div>
              </div>
              <span class="space-chevron">›</span>
            </div>
          </template>
          <template v-else>
            <div v-for="s in shownSpaces" :key="s.id" class="space-card" @click="router.push(`/space/${s.id}`)">
              <div>
                <div class="space-card-name">{{ s.title }}</div>
                <div class="space-card-meta">
                  <span class="status-pill" :class="s.status === 'active' ? 'status-active' : 'status-closed'">
                    {{ s.status === 'active' ? '● Открыт' : '○ Закрыт' }}
                  </span>
                  <span v-if="s.creatorUid === user?.uid">👑 Автор</span>
                  <span v-if="s._progress">{{ s._progress }} оценено</span>
                </div>
              </div>
              <span class="space-chevron">›</span>
            </div>
          </template>
        </template>
        <div v-else class="empty-state">
          <div class="empty-icon">🎴</div>
          <p class="empty-text">{{ emptyText }}</p>
        </div>
      </div>

      <div class="home-footer"><a href="chart.html">📈 Аналитика имён 2015–2026</a></div>
    </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import NavBar from '@/components/NavBar.vue'
import { currentUser } from '@/composables/useAuth.js'
import { syncHome, drain } from '@/composables/useSync.js'
import { dbGetMySpaces } from '@/services/db.js'
import { loadNames as _loadNames } from '@/services/names.js'

const router = useRouter()
const user = currentUser
const tab = ref('participating')
const spaces = ref([])
let _syncInterval = null

const mySpaces = computed(() => spaces.value.filter(s => s.creatorUid === user.value?.uid))
// @invariant "Участвую" reflects whether I have actually cast a vote in a space (_progress > 0) —
//   NOT whether I created it. Creator and voter are NOT mutually exclusive roles: an organizer who
//   also votes in their own poll (the common case) must see that space under BOTH tabs. A space I
//   merely created but haven't voted in yet correctly stays absent from here (see "Мои голосования"
//   for that). _progress is set the instant a vote is cast (VotingView.vue saveVote), regardless of
//   whether the voter is the creator or an invited participant.
const participatingSpaces = computed(() => spaces.value.filter(s => (s._progress || 0) > 0))
const shownSpaces = computed(() => tab.value === 'mine' ? mySpaces.value : participatingSpaces.value)
const emptyText = computed(() =>
  tab.value === 'mine'
    ? 'Вы ещё не создавали голосований.\nНажмите «Новое голосование» выше.'
    : 'Нет активных голосований.\nСоздайте своё или попросите прислать ссылку.'
)

async function loadSpaces() {
  if (!user.value) return
  const all = await dbGetMySpaces(user.value.uid)
  spaces.value = all.filter(s => !s.deleted)
}

async function runSync() {
  if (!user.value) return
  const hadNew = await syncHome(user.value.uid)
  if (hadNew) await loadSpaces()
}

onMounted(async () => {
  await _loadNames()
  await loadSpaces()
  drain()
  runSync()
  _syncInterval = setInterval(runSync, 30_000)
})

onUnmounted(() => {
  clearInterval(_syncInterval)
})
</script>
