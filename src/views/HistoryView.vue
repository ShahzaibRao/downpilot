<template>
  <div>
    <h2>History</h2>
    <p class="muted">Last 100 finished downloads.</p>

    <div v-if="entries.length === 0" class="card">
      <p class="muted">Nothing here yet. Finished downloads land here automatically.</p>
    </div>

    <div v-for="e in entries" :key="e.id + '-' + e.completedAt" class="card">
      <div class="job-head">
        <strong>{{ e.filename || e.url }}</strong>
        <span v-if="e.engine" class="badge engine">{{ e.engine }}</span>
        <span v-if="e.status === 'done'" class="badge ok">done</span>
        <span v-else class="badge err">failed</span>
      </div>
      <div class="job-meta muted">
        <span>{{ formatDate(e.completedAt) }}</span>
        <span v-if="e.downloaded > 0">{{ formatBytes(e.downloaded) }}</span>
        <span class="spacer"></span>
        <button class="btn secondary small" @click="redownload(e)">Download again</button>
      </div>
      <div v-if="e.error" class="badge err" style="margin-top: 8px;">{{ e.error }}</div>
    </div>

    <div v-if="entries.length > 0" class="card row" style="justify-content: flex-end;">
      <button class="btn secondary small" @click="clear">Clear history</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { HistoryEntry } from '../types'

const entries = ref<HistoryEntry[]>([])
let unsubscribe: (() => void) | null = null

async function redownload(e: HistoryEntry) {
  try {
    await window.dpApi.queueAdd({ url: e.url, quality: e.quality })
    window.dispatchEvent(new CustomEvent('dp:goto', { detail: 'quick' }))
  } catch {
    /* queue add failed — user sees the error in Quick tab */
  }
}

async function clear() {
  await window.dpApi.historyClear()
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`
}

onMounted(async () => {
  unsubscribe = window.dpApi.onHistoryUpdate((h) => { entries.value = h })
  try {
    entries.value = await window.dpApi.historyList()
  } catch { /* ignore */ }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.row { display: flex; gap: 8px; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; word-break: break-all; }
.badge.engine { background: #2a2438; color: #c4b5fd; }
.job-meta { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 13px; }
.spacer { flex: 1; }
.btn.small { padding: 4px 12px; font-size: 12px; }
</style>
