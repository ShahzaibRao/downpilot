<template>
  <div class="dash">
    <div class="dash-head">
      <h2>Dashboard</h2>
      <span class="muted">DownPilot v{{ version }}</span>
    </div>

    <!-- Stat cards -->
    <div class="cards">
      <div class="card stat">
        <div class="stat-num accent">{{ fmtNum(stats.totalDownloads) }}</div>
        <div class="stat-label">Downloads</div>
      </div>
      <div class="card stat">
        <div class="stat-num accent">{{ fmtBytes(stats.totalBytes) }}</div>
        <div class="stat-label">Downloaded</div>
      </div>
      <div class="card stat">
        <div class="stat-num">{{ fmtSpeed(stats.topSpeed) }}</div>
        <div class="stat-label">Top speed</div>
      </div>
      <div class="card stat">
        <div class="stat-num">{{ stats.successRate }}%</div>
        <div class="stat-label">Success rate</div>
      </div>
    </div>

    <!-- Queue snapshot -->
    <div class="card">
      <div class="row-between">
        <h3>Queue</h3>
        <span class="muted">{{ stats.queue.pending }} pending · {{ stats.queue.active }} active<span v-if="stats.queue.etaSeconds"> · ~{{ fmtEta(stats.queue.etaSeconds) }} left</span></span>
      </div>
      <div class="progress"><div class="progress-fill" :style="{ width: queuePct + '%' }"></div></div>
      <div class="btn-row">
        <button class="btn" @click="goQueue">Open Queue</button>
        <button v-if="stats.queue.failed > 0" class="btn secondary" @click="retryFailed">Retry {{ stats.queue.failed }} failed</button>
      </div>
    </div>

    <!-- Live speed -->
    <div class="card">
      <h3>Live speed <span class="muted font-normal">(last 60s)</span></h3>
      <svg viewBox="0 0 400 70" class="chart">
        <defs>
          <linearGradient id="spd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#2f6fed" stop-opacity="0.35"/>
            <stop offset="1" stop-color="#2f6fed" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path :d="speedArea" fill="url(#spd)"/>
        <path :d="speedLine" fill="none" stroke="#2f6fed" stroke-width="2"/>
      </svg>
      <div class="muted small">Current: {{ fmtSpeed(stats.currentSpeed || 0) }}</div>
    </div>

    <div class="grid2">
      <!-- By platform -->
      <div class="card">
        <h3>By platform</h3>
        <div class="donut-row">
          <svg viewBox="0 0 80 80" class="donut">
            <circle v-for="(s, i) in donutSegs" :key="i"
              cx="40" cy="40" r="28" fill="none"
              :stroke="s.color" stroke-width="11"
              :stroke-dasharray="`${s.len} 176`"
              :stroke-dashoffset="s.off"
              transform="rotate(-90 40 40)"/>
          </svg>
          <div class="legend">
            <div v-for="p in stats.byPlatform.slice(0, 4)" :key="p.platform">
              <span class="dot" :style="{ background: platColor(p.platform) }"></span>
              {{ cap(p.platform) }} {{ pct(p.count, stats.totalDownloads) }}%
            </div>
          </div>
        </div>
      </div>
      <!-- Top creators -->
      <div class="card">
        <h3>Top creators</h3>
        <div v-if="stats.topCreators.length === 0" class="muted">No prospect downloads yet.</div>
        <div v-for="c in stats.topCreators" :key="c.name" class="kv">
          <span>@{{ c.name }}</span><span class="muted">{{ c.count }}</span>
        </div>
      </div>
    </div>

    <div class="grid2">
      <!-- Last 7 days -->
      <div class="card">
        <h3>Last 7 days</h3>
        <div class="bars">
          <div v-for="d in stats.last7Days" :key="d.date" class="bar-col">
            <div class="bar" :style="{ height: barH(d.count) + '%' }" :title="`${d.date}: ${d.count}`"></div>
          </div>
        </div>
        <div class="bar-labels">
          <span v-for="d in stats.last7Days" :key="d.date">{{ dayName(d.date) }}</span>
        </div>
      </div>
      <!-- Storage -->
      <div class="card">
        <h3>Storage</h3>
        <div class="progress"><div class="progress-fill grad" :style="{ width: '62%' }"></div></div>
        <div class="muted small">{{ fmtBytes(stats.totalBytes) }} downloaded</div>
        <div class="muted small" style="margin-top:4px">Video {{ fmtBytes(stats.videoBytes) }} · Image {{ fmtBytes(stats.imageBytes) }}</div>
      </div>
    </div>

    <!-- Recent activity -->
    <div class="card">
      <h3>Recent activity</h3>
      <div v-if="stats.recentActivity.length === 0" class="muted">Nothing yet.</div>
      <div v-for="a in stats.recentActivity" :key="a.id" class="act">
        <span :class="a.kind === 'ok' ? 'green' : 'warn'">●</span>
        <span class="act-text">{{ a.text }}</span>
        <span class="muted small">{{ ago(a.time) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{ version?: string }>()
const emit = defineEmits(['goto'])

const stats = ref<any>({
  totalDownloads: 0, totalBytes: 0, successRate: 100, topSpeed: 0,
  currentSpeed: 0, speedHistory: new Array(60).fill(0),
  byPlatform: [], last7Days: [], topCreators: [],
  videoBytes: 0, imageBytes: 0, recentActivity: [],
  queue: { pending: 0, active: 0, failed: 0, etaSeconds: null },
  prospects: { watching: 0, paused: 0, error: 0 }
})
const version = ref('')

let unsubHistory: (() => void) | null = null
let refreshTimer: any = null

const PLAT_COLORS: Record<string, string> = {
  youtube: '#2f6fed', tiktok: '#22c55e', instagram: '#f59e0b',
  x: '#8b5cf6', snapchat: '#ef4444', pinterest: '#ec4899', other: '#6b7280'
}
function platColor(p: string) { return PLAT_COLORS[p] || PLAT_COLORS.other }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }
function pct(n: number, total: number) { return total > 0 ? Math.round((n / total) * 100) : 0 }

function fmtNum(n: number) { return n.toLocaleString() }
function fmtBytes(b: number) {
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB'
  return (b / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}
function fmtSpeed(bps: number) {
  if (bps <= 0) return '—'
  return fmtBytes(bps) + '/s'
}
function fmtEta(s: number) {
  if (s < 60) return s + 's'
  return Math.round(s / 60) + 'm'
}
function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}
function dayName(iso: string) {
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(iso + 'T12:00:00').getDay()]
}
function barH(n: number) {
  const max = Math.max(1, ...stats.value.last7Days.map((d: any) => d.count))
  return Math.round((n / max) * 100)
}

// Speed chart path (from backend speedHistory)
const speedLine = computed(() => {
  const h = stats.value.speedHistory || new Array(60).fill(0)
  const max = Math.max(1, ...h)
  const pts = h.map((v: number, i: number) => `${(i / (h.length - 1)) * 400},${65 - (v / max) * 60}`)
  return 'M' + pts.join(' L')
})
const speedArea = computed(() => speedLine.value + ' L400,70 L0,70 Z')

// Donut segments
const donutSegs = computed(() => {
  const items = stats.value.byPlatform.slice(0, 4)
  const total = items.reduce((s: number, p: any) => s + p.count, 0) || 1
  let acc = 0
  return items.map((p: any) => {
    const len = (p.count / total) * 176
    const seg = { color: platColor(p.platform), len: len.toFixed(1), off: (25 - acc).toFixed(1) }
    acc += len
    return seg
  })
})

const queuePct = computed(() => {
  const q = stats.value.queue
  const total = q.pending + q.active
  if (total === 0) return 100
  return Math.round((q.active / (total + q.active)) * 100)
})

async function load() {
  try {
    stats.value = await window.dpApi.statsGet() || stats.value
    version.value = await window.dpApi.updaterVersion() || ''
  } catch { /* ignore */ }
}

function goQueue() { emit('goto', 'queue') }
async function retryFailed() {
  // retry all failed queue tasks
  const tasks = await (window as any).dpApi?.queueList?.() || []
  for (const t of tasks.filter((x: any) => x.status === 'failed')) {
    await (window as any).dpApi?.queueRetry?.(t.id)
  }
  await load()
}

onMounted(() => {
  load()
  refreshTimer = setInterval(load, 2000) // refresh every 2s for live speed graph
  // Refresh stats immediately when a download completes
  unsubHistory = window.dpApi.onHistoryUpdate(() => {
    load()
  })
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  unsubHistory?.()
})
</script>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 12px; }
.dash-head { display: flex; align-items: baseline; justify-content: space-between; }
.dash-head h2 { margin: 0; font-size: 20px; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.card { background: #1c2027; border: 1px solid #2a2e37; border-radius: 12px; padding: 14px; }
.card h3 { margin: 0 0 10px; font-size: 14px; }
.stat { text-align: center; }
.stat-num { font-size: 24px; font-weight: 700; }
.stat-num.accent { color: #2f6fed; }
.stat-num.green { color: #22c55e; }
.stat-label { font-size: 11px; color: #9aa0aa; margin-top: 4px; }
.row-between { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.row-between h3 { margin: 0; }
.progress { height: 8px; background: #2a2e37; border-radius: 4px; overflow: hidden; margin-bottom: 10px; }
.progress-fill { height: 100%; background: #2f6fed; border-radius: 4px; transition: width 0.3s; }
.progress-fill.grad { background: linear-gradient(90deg, #2f6fed, #22c55e); }
.btn-row { display: flex; gap: 8px; }
.btn { background: #2f6fed; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.secondary { background: #2a2e37; color: #e8eaed; }
.chart { width: 100%; height: 70px; display: block; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.donut-row { display: flex; align-items: center; gap: 12px; }
.donut { width: 80px; height: 80px; flex-shrink: 0; }
.legend { font-size: 12px; line-height: 1.9; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.kv { display: flex; justify-content: space-between; font-size: 13px; line-height: 2; }
.bars { display: flex; align-items: flex-end; gap: 6px; height: 80px; }
.bar-col { flex: 1; display: flex; align-items: flex-end; height: 100%; }
.bar { width: 100%; background: #2f6fed; border-radius: 4px; min-height: 4px; }
.bar-labels { display: flex; gap: 6px; font-size: 10px; color: #9aa0aa; margin-top: 4px; }
.bar-labels span { flex: 1; text-align: center; }
.act { display: flex; gap: 8px; align-items: center; font-size: 12px; line-height: 2; }
.act-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.green { color: #22c55e; }
.warn { color: #f59e0b; }
.muted { color: #9aa0aa; }
.small { font-size: 11px; }
.font-normal { font-weight: 400; }
</style>
