<template>
  <div>
    <div class="hist-head">
      <div>
        <h2 style="margin: 0;">History</h2>
        <p class="muted" style="margin: 4px 0;">Last 100 finished downloads.</p>
      </div>
      <div class="filters">
        <button
          v-for="f in ['all', 'done', 'failed']"
          :key="f"
          class="filter-btn"
          :class="{ active: statusFilter === f }"
          @click="statusFilter = f"
        >
          {{ f }}
        </button>
      </div>
    </div>

    <div class="card" style="margin-bottom: 12px;">
      <input
        v-model="search"
        class="url-input"
        placeholder="🔍 Search filename or URL…"
        style="width: 100%;"
      />
    </div>

    <div v-if="filtered.length === 0" class="card">
      <p class="muted">{{ search ? 'No matches.' : 'Nothing here yet. Finished downloads land here automatically.' }}</p>
    </div>

    <div v-for="e in filtered" :key="e.id + '-' + e.completedAt" class="card">
      <div class="job-head">
        <span v-if="entryPlatform(e.url)" class="plat-dot" :style="{ background: platColor(entryPlatform(e.url)) }" :title="entryPlatform(e.url)"></span>
        <strong style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ e.filename || e.url }}</strong>
        <span v-if="e.engine" class="badge engine">{{ e.engine }}</span>
        <span v-if="e.status === 'done'" class="badge ok">done</span>
        <span v-else class="badge err">failed</span>
      </div>
      <div class="job-meta muted">
        <span>{{ formatDate(e.completedAt) }}</span>
        <span v-if="e.downloaded > 0">{{ formatBytes(e.downloaded) }}</span>
        <span v-if="e.prospectName" class="badge">@{{ e.prospectName }}</span>
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
import { onMounted, onUnmounted, ref, computed } from 'vue'
import type { HistoryEntry } from '../types'

const entries = ref<HistoryEntry[]>([])
const search = ref('')
const statusFilter = ref<'all' | 'done' | 'failed'>('all')
let unsubscribe: (() => void) | null = null

const filtered = computed(() => {
  let list = entries.value
  if (statusFilter.value !== 'all') {
    list = list.filter((e) => e.status === statusFilter.value)
  }
  const q = search.value.toLowerCase().trim()
  if (q) {
    list = list.filter((e) =>
      (e.filename || '').toLowerCase().includes(q) ||
      (e.url || '').toLowerCase().includes(q)
    )
  }
  return list
})

function entryPlatform(url: string): string {
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
.hist-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.filters { display: flex; gap: 6px; }
.filter-btn {
  background: #24282f; border: 1px solid #2a2e37; color: #9aa0aa;
  border-radius: 20px; padding: 6px 14px; font-size: 12px; cursor: pointer;
  text-transform: capitalize;
}
.filter-btn:hover { color: #e8eaed; }
.filter-btn.active { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.plat-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; word-break: break-all; }
.badge.engine { background: #2a2438; color: #c4b5fd; }
.job-meta { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 13px; }
.spacer { flex: 1; }
.btn.small { padding: 4px 12px; font-size: 12px; }
</style>
