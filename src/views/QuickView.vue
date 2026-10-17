<template>
  <div>
    <h2>Quick download</h2>

    <div class="card">
      <div class="row">
        <input
          v-model="url"
          class="url-input"
          type="url"
          placeholder="Paste a video link… (YouTube, TikTok, Instagram, …)"
          @keyup.enter="add"
        />
        <select v-model="quality" class="quality">
          <option value="best">Best</option>
          <option value="4k">4K</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
        <select v-model="scope" class="quality" title="Download scope">
          <option value="single">Single</option>
          <option value="playlist">Playlist</option>
          <option value="channel">Channel</option>
        </select>
        <button class="btn" :disabled="adding || !url.trim()" @click="add">
          {{ adding ? 'Adding…' : 'Download' }}
        </button>
      </div>
      <div v-if="scope !== 'single'" class="row scope-opts">
        <label class="muted">Max items
          <input v-model.number="maxItems" type="number" min="1" max="500" class="num" />
        </label>
        <label class="muted"><input v-model="order" type="radio" value="latest" /> Latest</label>
        <label class="muted"><input v-model="order" type="radio" value="oldest" /> Oldest</label>
        <label class="muted"><input v-model="order" type="radio" value="popular" /> Popular</label>
      </div>
      <div v-if="error" class="badge err" style="margin-top: 8px;">{{ error }}</div>
      <p class="muted" style="margin: 8px 0 0;">Saves to: <code>{{ downloadDir }}</code> <a href="#" @click.prevent="goSettings">(change)</a></p>
      <div style="margin-top: 8px;">
        <button class="btn secondary small" @click="showBulk = !showBulk">
          {{ showBulk ? 'Hide bulk add' : 'Bulk add' }}
        </button>
      </div>
      <div v-if="showBulk" class="bulk">
        <textarea
          v-model="bulkText"
          rows="5"
          class="url-input"
          placeholder="One link per line…"
        ></textarea>
        <div v-if="bulkPreview.length > 0" class="preview">
          <div v-for="p in bulkPreview" :key="p.url" class="preview-row">
            <span class="preview-url">{{ p.url }}</span>
            <span v-if="p.dup" class="badge">duplicate — skipped</span>
            <span v-else class="badge info">new</span>
          </div>
        </div>
        <div class="row" style="margin-top: 8px; align-items: center;">
          <button class="btn" :disabled="addingBulk || bulkNewCount === 0" @click="addBulk">
            {{ addingBulk ? 'Adding…' : `Add ${bulkNewCount} to queue` }}
          </button>
          <span v-if="bulkResult" class="muted">{{ bulkResult }}</span>
        </div>
      </div>
    </div>

    <div v-if="tasks.length === 0" class="card">
      <p class="muted">Queue is empty. Paste a link above — tasks survive app restarts.</p>
    </div>

    <div v-for="task in tasks" :key="task.id" class="card">
      <div class="job-head">
        <strong>{{ task.filename || task.url }}</strong>
        <span v-if="task.engine" class="badge engine">{{ task.engine }}</span>
        <span v-if="task.scope !== 'single'" class="badge">{{ task.scope }}</span>
        <span v-if="task.status === 'queued'" class="badge">queued</span>
        <span v-else-if="task.status === 'running'" class="badge info">
          {{ task.percent < 0 ? 'working…' : 'downloading' }}
        </span>
        <span v-else-if="task.status === 'paused'" class="badge">paused</span>
        <span v-else-if="task.status === 'done'" class="badge ok">done</span>
        <span v-else class="badge err">failed</span>
      </div>
      <div class="progress" :class="{ indeterminate: task.percent < 0 }">
        <div class="bar" :style="{ width: Math.min(100, Math.max(0, task.percent)) + '%' }"></div>
      </div>
      <div class="job-meta muted">
        <span v-if="task.percent >= 0">{{ task.percent.toFixed(1) }}%</span>
        <span v-else>working…</span>
        <span v-if="task.speed">{{ task.speed }}</span>
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
import type { QueueTask, Quality, Scope, Order, ScopeOpts } from '../types'

const url = ref('')
const quality = ref<Quality>('best')
const scope = ref<Scope>('single')
const maxItems = ref(50)
const order = ref<Order>('latest')
const adding = ref(false)
const error = ref('')
const tasks = ref<QueueTask[]>([])
const downloadDir = ref('')

// bulk add
const showBulk = ref(false)
const bulkText = ref('')
const addingBulk = ref(false)
const bulkResult = ref('')

let unsubscribe: (() => void) | null = null

const hasFinished = computed(() => tasks.value.some((t) => t.status === 'done' || t.status === 'failed'))

function currentScopeOpts(): ScopeOpts {
  return {
    scope: scope.value,
    maxItems: Math.min(500, Math.max(1, Math.floor(maxItems.value) || 50)),
    order: order.value
  }
}

async function add() {
  const u = url.value.trim()
  if (!u) return
  adding.value = true
  error.value = ''
  try {
    await window.dpApi.queueAdd({ url: u, quality: quality.value, scopeOpts: currentScopeOpts() })
    url.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    adding.value = false
  }
}

function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/$/, '')
}

const bulkPreview = computed(() => {
  const lines = bulkText.value.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s))
  const inQueue = new Set(tasks.value.map((t) => normalizeUrl(t.url)))
  const seen = new Set<string>()
  return lines.map((u) => {
    const n = normalizeUrl(u)
    const dup = seen.has(n) || inQueue.has(n)
    seen.add(n)
    return { url: u, dup }
  })
})

const bulkNewCount = computed(() => bulkPreview.value.filter((p) => !p.dup).length)

async function addBulk() {
  const items = bulkPreview.value
    .filter((p) => !p.dup)
    .map((p) => ({ url: p.url, quality: quality.value, scopeOpts: currentScopeOpts() }))
  if (items.length === 0) return
  addingBulk.value = true
  bulkResult.value = ''
  try {
    const res = await window.dpApi.queueAddBulk(items)
    bulkResult.value = `Added ${res.added}, skipped ${res.skipped} duplicate(s).`
    bulkText.value = ''
  } catch (e) {
    bulkResult.value = (e as Error).message
  } finally {
    addingBulk.value = false
  }
}

async function pause(id: string) { await window.dpApi.queuePause(id) }
async function resume(id: string) { await window.dpApi.queueResume(id) }
async function retry(id: string) { await window.dpApi.queueRetry(id) }
async function remove(id: string) { await window.dpApi.queueCancel(id) }
async function clearDone() { await window.dpApi.queueClearDone() }

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`
}

function goSettings() {
  window.dispatchEvent(new CustomEvent('dp:goto', { detail: 'settings' }))
}

onMounted(async () => {
  unsubscribe = window.dpApi.onQueueUpdate((t) => { tasks.value = t })
  try {
    tasks.value = await window.dpApi.queueList()
    downloadDir.value = (await window.dpApi.getSettings()).downloadDir
  } catch { /* ignore */ }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.row { display: flex; gap: 8px; }
.url-input {
  flex: 1; background: #24282f; border: 1px solid #2a2e37; color: #e8eaed;
  border-radius: 8px; padding: 10px 12px; font-size: 14px;
}
.url-input:focus { outline: none; border-color: #2f6fed; }
.quality {
  background: #24282f; border: 1px solid #2a2e37; color: #e8eaed;
  border-radius: 8px; padding: 10px; font-size: 14px;
}
.num {
  width: 70px; background: #24282f; border: 1px solid #2a2e37; color: #e8eaed;
  border-radius: 6px; padding: 6px 8px; font-size: 13px; margin-left: 4px;
}
.scope-opts { align-items: center; margin-top: 8px; }
.scope-opts label { display: flex; align-items: center; gap: 4px; }
.bulk { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.bulk textarea { width: 100%; resize: vertical; }
.preview { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.preview-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.preview-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa0a6; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; word-break: break-all; }
.progress { height: 8px; background: #24282f; border-radius: 4px; overflow: hidden; }
.progress .bar { height: 100%; background: #2f6fed; border-radius: 4px; transition: width 0.3s; }
.progress.indeterminate .bar {
  width: 30% !important;
  background: linear-gradient(90deg, #2f6fed 25%, #6ea8ff 50%, #2f6fed 75%);
  background-size: 200% 100%;
  animation: slide 1.2s linear infinite;
}
@keyframes slide { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.badge.engine { background: #2a2438; color: #c4b5fd; }
.job-meta { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 13px; }
.spacer { flex: 1; }
.btn.small { padding: 4px 12px; font-size: 12px; }
a { color: #93c5fd; }
</style>
