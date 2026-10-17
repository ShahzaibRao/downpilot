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
          @keyup.enter="start"
        />
        <select v-model="quality" class="quality">
          <option value="best">Best</option>
          <option value="4k">4K</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
        <button class="btn" :disabled="starting || !url.trim()" @click="start">
          {{ starting ? 'Starting…' : 'Download' }}
        </button>
      </div>
      <div v-if="error" class="badge err" style="margin-top: 8px;">{{ error }}</div>
      <p class="muted" style="margin: 8px 0 0;">Saves to: <code>{{ downloadDir }}</code> <a href="#" @click.prevent="goSettings">(change)</a></p>
    </div>

    <div v-if="jobs.length === 0" class="card">
      <p class="muted">No downloads yet. Paste a link above to start.</p>
    </div>

    <div v-for="job in jobs" :key="job.id" class="card">
      <div class="job-head">
        <strong>{{ job.filename || job.url }}</strong>
        <span v-if="job.engine" class="badge engine">{{ job.engine }}</span>
        <span v-if="job.status === 'downloading'" class="badge info">downloading</span>
        <span v-else-if="job.status === 'merging'" class="badge info">merging…</span>
        <span v-else-if="job.status === 'done'" class="badge ok">done</span>
        <span v-else class="badge err">failed</span>
      </div>
      <div class="progress" :class="{ indeterminate: job.percent < 0 }">
        <div class="bar" :style="{ width: Math.min(100, Math.max(0, job.percent)) + '%' }"></div>
      </div>
      <div class="job-meta muted">
        <span v-if="job.percent >= 0">{{ job.percent.toFixed(1) }}%</span>
        <span v-else>working…</span>
        <span v-if="job.speed">{{ job.speed }}</span>
        <span v-if="job.eta">ETA {{ job.eta }}</span>
        <span v-if="job.total">{{ formatBytes(job.downloaded) }} / {{ formatBytes(job.total) }}</span>
        <button
          v-if="job.status === 'downloading' || job.status === 'merging'"
          class="btn secondary small"
          @click="cancel(job.id)"
        >Cancel</button>
      </div>
      <div v-if="job.error" class="badge err" style="margin-top: 8px;">{{ job.error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { DownloadProgress, Quality } from '../types'

interface Job extends DownloadProgress {
  url: string
}

const url = ref('')
const quality = ref<Quality>('best')
const starting = ref(false)
const error = ref('')
const jobs = ref<Job[]>([])
const downloadDir = ref('')

let unsubscribe: (() => void) | null = null

async function start() {
  const u = url.value.trim()
  if (!u) return
  starting.value = true
  error.value = ''
  try {
    const id = await window.dpApi.startDownload({ url: u, quality: quality.value })
    jobs.value.unshift({
      id, url: u, status: 'downloading', percent: 0,
      downloaded: 0, total: null, speed: '', eta: '', filename: '', engine: ''
    })
    url.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    starting.value = false
  }
}

async function cancel(id: string) {
  await window.dpApi.cancelDownload(id)
  jobs.value = jobs.value.filter((j) => j.id !== id)
}

function onProgress(evt: DownloadProgress) {
  const job = jobs.value.find((j) => j.id === evt.id)
  if (job) Object.assign(job, evt)
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`
}

function goSettings() {
  // simple tab switch via custom event — App listens for it
  window.dispatchEvent(new CustomEvent('dp:goto', { detail: 'settings' }))
}

onMounted(async () => {
  unsubscribe = window.dpApi.onDownloadProgress(onProgress)
  try {
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
.btn.small { padding: 4px 12px; font-size: 12px; margin-left: auto; }
a { color: #93c5fd; }
</style>
