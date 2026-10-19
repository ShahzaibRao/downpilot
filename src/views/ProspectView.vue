<template>
  <div class="pview">
    <div class="row" style="align-items: center;">
      <div>
        <h2 style="margin: 0;">Prospects</h2>
        <p class="muted" style="margin: 4px 0;">Creators to auto-watch. New content is downloaded automatically every 60 minutes.</p>
      </div>
      <span class="spacer"></span>
      <button class="btn secondary" :disabled="checking" @click="checkNow">
        {{ checking ? 'Checking…' : 'Check now' }}
      </button>
    </div>
    <div v-if="checkMsg" class="muted" style="font-size: 13px; margin-bottom: 8px;">{{ checkMsg }}</div>

    <!-- dashboard stats -->
    <div v-if="prospects.length > 0" class="stats">
      <div class="stat"><span class="stat-num">{{ stats.watching }}</span><span class="muted">watching</span></div>
      <div class="stat"><span class="stat-num">{{ stats.paused }}</span><span class="muted">paused</span></div>
      <div class="stat"><span class="stat-num">{{ stats.errors }}</span><span class="muted">errors</span></div>
      <div class="stat"><span class="stat-num">{{ stats.links }}</span><span class="muted">links</span></div>
    </div>

    <!-- add -->
    <div class="card">
      <h3>Add prospect</h3>
      <div class="row" style="align-items: center;">
        <div class="url-wrap" style="flex: 1;">
          <span v-if="newPlat" class="plat-badge" :style="{ background: platColor(newPlat) }">
            {{ platIcon(newPlat) }} {{ newPlat }}
          </span>
          <input v-model="newUrl" class="url-input" placeholder="Profile URL (e.g. https://www.tiktok.com/@someone)" style="border: none; background: transparent;" />
        </div>
        <input v-model="newName" class="url-input" style="max-width: 180px;" placeholder="Name (optional)" />
        <select v-model="newQuality" class="url-input" style="max-width: 110px; flex: none;">
          <option value="best">Best</option>
          <option value="4k">4K</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
        <select v-model.number="newInterval" class="url-input" style="max-width: 130px; flex: none;" title="Check every…">
          <option :value="15">15 min</option>
          <option :value="30">30 min</option>
          <option :value="60">60 min</option>
          <option :value="180">3 hours</option>
          <option :value="360">6 hours</option>
          <option :value="720">12 hours</option>
          <option :value="1440">24 hours</option>
        </select>
        <button class="btn" :disabled="adding || !newUrl.trim()" @click="addProspect">
          {{ adding ? 'Adding…' : 'Add' }}
        </button>
      </div>
      <div v-if="addMsg" class="muted" style="margin-top: 6px; font-size: 13px;">{{ addMsg }}</div>
    </div>

    <!-- list -->
    <div v-if="prospects.length === 0" class="card muted">No prospects yet. Add one above to start auto-watching.</div>
    <div v-else class="card" style="margin-bottom: 12px;">
      <input
        v-model="search"
        class="url-input"
        placeholder="🔍 Search prospects…"
        style="width: 100%;"
      />
    </div>
    <div v-if="filteredProspects.length === 0 && prospects.length > 0" class="card muted">
      No prospects match "{{ search }}".
    </div>
    <div v-for="p in filteredProspects" :key="p.id" class="card">
      <div class="row" style="align-items: center;">
        <template v-if="editingId === p.id">
          <input v-model="editName" class="url-input" style="max-width: 180px;" />
          <select v-model="editQuality" class="url-input" style="max-width: 110px; flex: none;">
            <option value="best">Best</option>
            <option value="4k">4K</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
          </select>
          <select v-model.number="editInterval" class="url-input" style="max-width: 120px; flex: none;">
            <option :value="15">15 min</option>
            <option :value="30">30 min</option>
            <option :value="60">60 min</option>
            <option :value="180">3 hours</option>
            <option :value="360">6 hours</option>
            <option :value="720">12 hours</option>
            <option :value="1440">24 hours</option>
          </select>
          <button class="btn small" @click="saveEdit(p.id)">Save</button>
          <button class="btn secondary small" @click="cancelEdit()">Cancel</button>
        </template>
        <template v-else>
          <strong style="font-size: 15px;">{{ p.name }}</strong>
          <span class="badge">{{ p.quality }}</span>
          <span class="badge info">every {{ formatInterval(p.intervalMinutes) }}</span>
        </template>
        <span v-if="p.status === 'ok'" class="badge ok">watching</span>
        <span v-else-if="p.status === 'paused'" class="badge">paused</span>
        <span v-else class="badge err">error</span>
        <span class="muted" style="font-size: 12px;">{{ p.links.length }} link{{ p.links.length === 1 ? '' : 's' }}</span>
        <span class="spacer"></span>
        <button class="btn secondary small" :disabled="checkingOne === p.id" @click="checkOne(p.id)">
          {{ checkingOne === p.id ? 'Checking…' : 'Check' }}
        </button>
        <button v-if="editingId !== p.id" class="btn secondary small" @click="startEdit(p)">Edit</button>
        <button v-if="p.status === 'paused'" class="btn secondary small" @click="unpause(p.id)">Resume</button>
        <button v-else class="btn secondary small" @click="setStatus(p.id, 'paused')">Pause</button>
        <button class="btn secondary small" @click="remove(p.id)">Remove</button>
      </div>
      <div v-if="p.lastError" class="muted" style="font-size: 12px;" :style="{ color: p.lastError.startsWith('Warning:') ? '#fbbf24' : '#f87171' }">{{ p.lastError }}{{ p.failCount > 0 && !p.lastError.startsWith('Warning:') ? ` (${p.failCount}/3)` : '' }}</div>
      <div class="muted" style="font-size: 12px; margin-top: 4px;">
        Folder: prospects/{{ p.folder }}
        <span v-if="p.lastCheck"> · Last check: {{ formatTime(p.lastCheck) }}</span>
        <span> · Next: {{ nextCheckIn(p) }}</span>
      </div>
      <!-- per-prospect download progress -->
      <div v-if="progressFor(p.id)" style="margin-top: 8px;">
        <div class="row" style="font-size: 12px; margin-bottom: 4px;">
          <span class="muted">
            {{ progressFor(p.id)!.done }}/{{ progressFor(p.id)!.total }} downloaded
            <span v-if="progressFor(p.id)!.active > 0"> · {{ progressFor(p.id)!.active }} active</span>
            <span v-if="progressFor(p.id)!.failed > 0" style="color: #f87171;"> · {{ progressFor(p.id)!.failed }} failed</span>
          </span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: Math.round(progressFor(p.id)!.done / progressFor(p.id)!.total * 100) + '%' }"></div>
        </div>
      </div>
      <!-- links -->
      <div class="preview" style="margin-top: 8px;">
        <div v-for="l in p.links" :key="l.id" class="preview-row">
          <span class="plat-badge" :style="{ background: platColor(l.platform) }">
            {{ platIcon(l.platform) }} {{ l.platform }}
          </span>
          <!-- Per-link status (Rao 2026-10-18) -->
          <span v-if="l.linkStatus === 'ok'" class="badge ok" title="Last check OK">✓</span>
          <span v-else-if="l.linkStatus === 'error'" class="badge err" :title="l.linkLastError || 'Error'">✗ ({{ l.linkFailCount }}/3)</span>
          <span v-else-if="l.linkStatus === 'paused'" class="badge err" :title="(l.linkLastError || 'Paused') + ' — click to resume'">⏸ paused</span>
          <button v-if="l.linkStatus === 'paused'" class="btn small secondary" @click="unpauseLink(p.id, l.id)" title="Resume this link">Resume</button>
          <template v-if="editingLinkId === l.id">
            <input v-model="editLinkUrl" class="url-input" style="font-size: 12px;" />
            <button class="btn small" @click="saveLink(p.id, l.id)">Save</button>
            <button class="btn secondary small" @click="editingLinkId = null">Cancel</button>
          </template>
          <template v-else>
            <span class="muted" style="font-size: 12px; overflow: hidden; text-overflow: ellipsis;" :title="l.linkLastError || l.url">{{ l.url }}</span>
            <span class="spacer"></span>
            <button v-if="editingId === p.id" class="btn secondary small" @click="startEditLink(l)">Edit</button>
            <button v-if="p.links.length > 1" class="btn secondary small" @click="removeLink(p.id, l.id)">✕</button>
          </template>
        </div>
        <template v-for="l in p.links" :key="'err-'+l.id">
          <div v-if="l.linkLastError && l.linkStatus !== 'ok'" class="preview-row">
            <span class="muted" style="font-size: 11px; color: #ff9a9a;">{{ l.platform }}: {{ l.linkLastError }}</span>
          </div>
        </template>
        <div class="preview-row">
          <input v-model="linkInputs[p.id]" class="url-input" style="font-size: 12px;" placeholder="Add another platform link for this creator…" />
          <button class="btn secondary small" :disabled="!linkInputs[p.id]?.trim()" @click="addLink(p.id)">Add link</button>
        </div>
      </div>
    </div>
    <!-- recent downloads -->
    <div v-if="recentDownloads.length > 0" class="card">
      <h3>Recent Downloads</h3>
      <div class="preview">
        <div v-for="h in recentDownloads" :key="h.id" class="preview-row">
          <span v-if="h.status === 'done'" class="badge ok">done</span>
          <span v-else class="badge err">failed</span>
          <span class="badge">{{ h.prospectName || 'prospect' }}</span>
          <span class="muted" style="font-size: 12px; overflow: hidden; text-overflow: ellipsis;">{{ h.filename }}</span>
          <span class="spacer"></span>
          <span class="muted" style="font-size: 11px;">{{ formatTime(new Date(h.completedAt).toISOString()) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import type { Prospect, CheckResult, HistoryEntry, Quality, QueueTask } from '../types'

const prospects = ref<Prospect[]>([])
const search = ref('')

const filteredProspects = computed(() => {
  const q = search.value.toLowerCase().trim()
  if (!q) return prospects.value
  return prospects.value.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    p.links.some((l) => l.url.toLowerCase().includes(q))
  )
})
const newUrl = ref('')
const newName = ref('')
const newQuality = ref<Quality>('best')
const newInterval = ref(60)
const adding = ref(false)
const addMsg = ref('')

// Platform auto-detect for new prospect URL
const newPlat = computed(() => {
  const u = newUrl.value.toLowerCase()
  if (!u) return ''
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('tiktok.com')) return 'tiktok'
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x'
  if (u.includes('snapchat.com')) return 'snapchat'
  if (u.includes('pinterest.com')) return 'pinterest'
  return ''
})
const PLAT_COLORS: Record<string, string> = {
  youtube: '#ff0000', tiktok: '#000000', instagram: '#e1306c',
  x: '#1d9bf0', snapchat: '#fffc00', pinterest: '#bd081c', facebook: '#1877f2'
}
const PLAT_ICONS: Record<string, string> = {
  youtube: '▶', tiktok: '♪', instagram: '📷',
  x: '𝕏', snapchat: '👻', pinterest: '📌', facebook: 'f'
}
function platColor(p: string) { return PLAT_COLORS[p] || '#666' }
function platIcon(p: string) { return PLAT_ICONS[p] || '🔗' }
const linkInputs = ref<Record<string, string>>({})
const checking = ref(false)
const checkMsg = ref('')
const checkingOne = ref<string | null>(null)
const editingId = ref<string | null>(null)
const editName = ref('')
const editQuality = ref<Quality>('best')
const editInterval = ref(60)
const editingLinkId = ref<string | null>(null)
const editLinkUrl = ref('')
const queueTasks = ref<QueueTask[]>([])

/** Aggregate queue tasks per prospect for progress bars. */
const prospectProgress = computed(() => {
  const map = new Map<string, { total: number; done: number; active: number; failed: number }>()
  for (const t of queueTasks.value) {
    if (!t.prospectId) continue
    let p = map.get(t.prospectId)
    if (!p) { p = { total: 0, done: 0, active: 0, failed: 0 }; map.set(t.prospectId, p) }
    p.total++
    if (t.status === 'done') p.done++
    else if (t.status === 'failed') p.failed++
    else if (t.status === 'running' || t.status === 'queued') p.active++
  }
  return map
})

function progressFor(prospectId: string) {
  return prospectProgress.value.get(prospectId)
}

/** Human-readable "next check in X" based on lastCheck + interval. */
function nextCheckIn(p: Prospect): string {
  if (p.status === 'paused') return 'paused'
  if (!p.lastCheck) return 'due soon'
  const next = new Date(p.lastCheck).getTime() + (p.intervalMinutes || 60) * 60 * 1000
  const ms = next - Date.now()
  if (ms <= 0) return 'due now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`
  return `in ${Math.floor(hrs / 24)}d`
}

const stats = computed(() => ({
  watching: prospects.value.filter((p) => p.status === 'ok').length,
  paused: prospects.value.filter((p) => p.status === 'paused').length,
  errors: prospects.value.filter((p) => p.status === 'error').length,
  links: prospects.value.reduce((n, p) => n + p.links.length, 0)
}))

const recentDownloads = ref<HistoryEntry[]>([])

async function loadRecent() {
  try {
    const all = await window.dpApi.historyList()
    recentDownloads.value = all.filter((h) => h.prospectId).slice(0, 10)
  } catch { /* ignore */ }
}

async function load() {
  try {
    prospects.value = await window.dpApi.prospectsList()
  } catch { /* ignore */ }
}

async function addProspect() {
  adding.value = true
  addMsg.value = ''
  try {
    await window.dpApi.prospectsAdd(newUrl.value.trim(), newName.value.trim() || undefined, newQuality.value, newInterval.value)
    newUrl.value = ''
    newName.value = ''
    addMsg.value = 'Prospect added ✓'
    await load()
  } catch (e) {
    addMsg.value = (e as Error).message
  } finally {
    adding.value = false
  }
}

async function addLink(prospectId: string) {
  const url = (linkInputs.value[prospectId] || '').trim()
  if (!url) return
  try {
    await window.dpApi.prospectsAddLink(prospectId, url)
    linkInputs.value[prospectId] = ''
    await load()
  } catch (e) {
    alert((e as Error).message)
  }
}

async function removeLink(prospectId: string, linkId: string) {
  if (!confirm('Remove this link?')) return
  await window.dpApi.prospectsRemoveLink(prospectId, linkId)
  await load()
}

async function remove(id: string) {
  if (!confirm('Remove this prospect? Seen history will be cleared.')) return
  await window.dpApi.prospectsRemove(id)
  await load()
}

async function setStatus(id: string, status: string) {
  await window.dpApi.prospectsSetStatus(id, status)
  await load()
}

async function unpause(id: string) {
  await window.dpApi.prospectsUnpause(id)
  await load()
}

async function unpauseLink(prospectId: string, linkId: string) {
  await window.dpApi.prospectsUnpauseLink(prospectId, linkId)
  await load()
}

async function checkOne(id: string) {
  checkingOne.value = id
  try {
    const r = await window.dpApi.prospectsCheckOne(id)
    if (r) {
      checkMsg.value = r.error
        ? `${r.prospectName}: ${r.error}`
        : `${r.prospectName}: ${r.newItems} new, ${r.queued} queued ✓`
    } else {
      checkMsg.value = 'A check is already running — try again in a moment'
    }
    await load()
    await loadRecent()
  } catch (e) {
    checkMsg.value = `Check failed: ${(e as Error).message}`
  } finally {
    checkingOne.value = null
  }
}

function startEdit(p: Prospect) {
  editingId.value = p.id
  editName.value = p.name
  editQuality.value = p.quality
  editInterval.value = p.intervalMinutes
  editingLinkId.value = null
}

function cancelEdit() {
  editingId.value = null
  editingLinkId.value = null
}

async function saveEdit(id: string) {
  try {
    if (editName.value.trim()) {
      await window.dpApi.prospectsRename(id, editName.value)
    }
    await window.dpApi.prospectsSetQuality(id, editQuality.value)
    await window.dpApi.prospectsSetInterval(id, editInterval.value)
    editingId.value = null
    await load()
  } catch (e) {
    alert((e as Error).message)
  }
}

function formatInterval(mins: number): string {
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${mins / 60}h`
  return `${mins / 1440}d`
}

function startEditLink(l: { id: string; url: string }) {
  editingLinkId.value = l.id
  editLinkUrl.value = l.url
}

async function saveLink(prospectId: string, linkId: string) {
  try {
    await window.dpApi.prospectsUpdateLink(prospectId, linkId, editLinkUrl.value)
    editingLinkId.value = null
    await load()
  } catch (e) {
    alert((e as Error).message)
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

async function checkNow() {
  checking.value = true
  checkMsg.value = ''
  try {
    const results: CheckResult[] = await window.dpApi.prospectsCheckNow()
    const totalNew = results.reduce((n, r) => n + r.newItems, 0)
    const totalQueued = results.reduce((n, r) => n + r.queued, 0)
    const errors = results.filter((r) => r.error)
    checkMsg.value = `Checked ${results.length} prospect(s): ${totalNew} new, ${totalQueued} queued` +
      (errors.length ? ` — ${errors.length} error(s): ${errors.map((e) => e.prospectName).join(', ')}` : ' ✓')
    await load()
  } catch (e) {
    checkMsg.value = `Check failed: ${(e as Error).message}`
  } finally {
    checking.value = false
  }
}

function onCheckDone(_e: Event, results: CheckResult[]) {
  const totalNew = results.reduce((n, r) => n + r.newItems, 0)
  if (totalNew > 0) {
    checkMsg.value = `Auto-check: ${totalNew} new item(s) queued ✓`
  }
  load()
}

let offQueueUpdate: (() => void) | null = null

onMounted(() => {
  load()
  loadRecent()
  loadQueue()
  window.dpApi.onProspectsCheckDone(onCheckDone)
  offQueueUpdate = window.dpApi.onQueueUpdate(onQueueUpdate)
})

onUnmounted(() => {
  window.dpApi.offProspectsCheckDone(onCheckDone)
  offQueueUpdate?.()
})

async function loadQueue() {
  try {
    queueTasks.value = await window.dpApi.queueList()
  } catch { /* ignore */ }
}

function onQueueUpdate(tasks: QueueTask[]) {
  queueTasks.value = tasks
}
</script>

<style scoped>
.pview { width: 100%; }
@media (max-width: 960px) {
  .pview { padding: 0 4px; }
}
.url-wrap {
  display: flex; align-items: center; gap: 8px;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px;
  padding: 0 8px 0 12px;
}
.url-wrap:focus-within { border-color: var(--accent); }
.url-wrap .url-input { border: none !important; background: transparent !important; }
.plat-badge {
  font-size: 11px; font-weight: 700; color: #fff;
  padding: 4px 10px; border-radius: 20px; white-space: nowrap;
  text-transform: capitalize; flex-shrink: 0;
}
.card {
  background: var(--bg-card);
  border: 1px solid #333;
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 12px;
}
.row { display: flex; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.url-input {
  flex: 1;
  min-width: 200px;
  background: #111;
  border: 1px solid #444;
  color: #eee;
  border-radius: 6px;
  padding: 8px 10px;
}
.btn {
  background: #4f46e5;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.secondary { background: #333; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.badge {
  background: #333;
  border-radius: 10px;
  padding: 2px 8px;
  font-size: 11px;
}
.badge.ok { background: #166534; }
.badge.err { background: #7f1d1d; }
.muted { color: #999; }
.spacer { flex: 1; }
.preview { margin-top: 4px; }
.preview-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
  border-top: 1px solid #2a2a2a;
}
.stats {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.stat {
  background: var(--bg-card);
  border: 1px solid #333;
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 90px;
}
.stat-num {
  font-size: 22px;
  font-weight: bold;
}
.progress-track {
  height: 6px;
  background: #1f2937;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
  border-radius: 3px;
  transition: width 0.3s ease;
}
</style>
