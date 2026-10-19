<template>
  <div>
    <div class="queue-head">
      <h2>Queue</h2>
      <div class="filters">
        <button
          v-for="f in ['all', 'active', 'done', 'failed']"
          :key="f"
          class="filter-btn"
          :class="{ active: filter === f }"
          @click="filter = f"
        >
          {{ f }} ({{ counts[f] }})
        </button>
      </div>
    </div>

    <div v-if="filtered.length === 0" class="card">
      <p class="muted">
        {{ filter === 'all' ? 'Queue is empty. Add downloads from the Quick tab.' : `No ${filter} tasks.` }}
      </p>
    </div>

    <div v-for="task in filtered" :key="task.id" class="card task-card">
      <div class="job-head">
        <span v-if="taskPlatform(task.url)" class="plat-dot" :style="{ background: platColor(taskPlatform(task.url)) }" :title="taskPlatform(task.url)"></span>
        <strong class="task-title">{{ task.filename || task.url }}</strong>
        <span v-if="task.engine" class="badge engine">{{ task.engine }}</span>
        <span v-if="task.scope !== 'single'" class="badge">{{ task.scope }}</span>
        <span v-if="statusBadge(task.status)" class="badge" :class="statusClass(task.status)">{{ statusBadge(task.status) }}</span>
      </div>
      <div class="progress" :class="{ indeterminate: task.percent < 0 && isActive(task.status) }">
        <div class="bar" :style="{ width: progressWidth(task) }"></div>
      </div>
      <div class="job-meta muted">
        <span v-if="task.percent >= 0">{{ task.percent.toFixed(1) }}%</span>
        <span v-else-if="isActive(task.status)">working…</span>
        <span v-if="task.speed" class="speed">{{ task.speed }}</span>
        <span v-if="task.eta">ETA {{ task.eta }}</span>
        <span v-if="task.total">{{ formatBytes(task.downloaded) }} / {{ formatBytes(task.total) }}</span>
        <span class="spacer"></span>
        <button v-if="task.status === 'running'" class="btn secondary small" @click="pause(task.id)">Pause</button>
        <button v-if="task.status === 'paused'" class="btn secondary small" @click="resume(task.id)">Resume</button>
        <button v-if="task.status === 'failed'" class="btn secondary small" @click="retry(task.id)">Retry</button>
        <button v-if="task.status !== 'running'" class="btn secondary small" @click="remove(task.id)">✕</button>
      </div>
      <div v-if="task.error" class="badge err" style="margin-top: 8px;">{{ task.error }}</div>
    </div>

    <div v-if="hasFinished" class="card row" style="justify-content: flex-end;">
      <button class="btn secondary small" @click="clearDone">Clear completed</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import type { QueueTask } from '../types'

const tasks = ref<QueueTask[]>([])
const filter = ref<'all' | 'active' | 'done' | 'failed'>('all')
let unsubscribe: (() => void) | null = null

const counts = computed(() => ({
  all: tasks.value.length,
  active: tasks.value.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'paused').length,
  done: tasks.value.filter((t) => t.status === 'done').length,
  failed: tasks.value.filter((t) => t.status === 'failed').length
}))

const filtered = computed(() => {
  if (filter.value === 'all') return tasks.value
  if (filter.value === 'active') return tasks.value.filter((t) => ['running', 'queued', 'paused'].includes(t.status))
  return tasks.value.filter((t) => t.status === filter.value)
})

const hasFinished = computed(() => tasks.value.some((t) => t.status === 'done' || t.status === 'failed'))

function isActive(s: string) { return s === 'running' || s === 'queued' }

function statusBadge(s: string): string {
  if (s === 'queued') return 'queued'
  if (s === 'running') return 'downloading'
  if (s === 'paused') return 'paused'
  if (s === 'done') return 'done'
  if (s === 'failed') return 'failed'
  return s
}

function statusClass(s: string): string {
  if (s === 'running') return 'info'
  if (s === 'done') return 'ok'
  if (s === 'failed') return 'err'
  return ''
}

function progressWidth(task: QueueTask): string {
  if (task.status === 'done') return '100%'
  if (task.percent < 0) return '30%'
  return Math.min(100, Math.max(0, task.percent)) + '%'
}

function taskPlatform(url: string): string {
  const u = (url || '').toLowerCase()
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('tiktok.com')) return 'tiktok'
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x'
  if (u.includes('snapchat.com') || u.includes('sc-cdn.net')) return 'snapchat'
  if (u.includes('pinterest.com')) return 'pinterest'
  return ''
}

const PLAT_COLORS: Record<string, string> = {
  youtube: '#ff0000', tiktok: '#000', instagram: '#e1306c',
  x: '#1d9bf0', snapchat: '#fffc00', pinterest: '#bd081c'
}
function platColor(p: string) { return PLAT_COLORS[p] || '#666' }

async function pause(id: string) { await window.dpApi.queuePause(id) }
async function resume(id: string) { await window.dpApi.queueResume(id) }
async function retry(id: string) { await window.dpApi.queueRetry(id) }
async function remove(id: string) { await window.dpApi.queueCancel(id) }
async function clearDone() { await window.dpApi.queueClearDone() }

function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`
}

onMounted(async () => {
  unsubscribe = window.dpApi.onQueueUpdate((t) => { tasks.value = t as QueueTask[] })
  try {
    tasks.value = await window.dpApi.queueList()
  } catch { /* ignore */ }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.queue-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.queue-head h2 { margin: 0; }
.filters { display: flex; gap: 6px; }
.filter-btn {
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-muted);
  border-radius: 20px; padding: 6px 14px; font-size: 12px; cursor: pointer;
  text-transform: capitalize;
}
.filter-btn:hover { color: var(--text); }
.filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.task-card { transition: border-color 0.2s; }
.task-card:hover { border-color: #3a3f4a; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.plat-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.task-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
.progress .bar { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
.progress.indeterminate .bar { animation: slide 1.5s infinite; width: 30% !important; }
@keyframes slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.job-meta { display: flex; gap: 12px; align-items: center; font-size: 12px; }
.job-meta .speed { color: #22c55e; font-weight: 600; }
.spacer { flex: 1; }
</style>
