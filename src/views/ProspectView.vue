<template>
  <div class="view">
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
      <div class="row">
        <input v-model="newUrl" class="url-input" placeholder="Profile URL (e.g. https://www.tiktok.com/@someone)" />
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
    <div v-for="p in prospects" :key="p.id" class="card">
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
      </div>
      <!-- links -->
      <div class="preview" style="margin-top: 8px;">
        <div v-for="l in p.links" :key="l.id" class="preview-row">
          <span class="badge">{{ l.platform }}</span>
          <template v-if="editingLinkId === l.id">
            <input v-model="editLinkUrl" class="url-input" style="font-size: 12px;" />
            <button class="btn small" @click="saveLink(p.id, l.id)">Save</button>
            <button class="btn secondary small" @click="editingLinkId = null">Cancel</button>
          </template>
          <template v-else>
            <span class="muted" style="font-size: 12px; overflow: hidden; text-overflow: ellipsis;">{{ l.url }}</span>
            <span class="spacer"></span>
            <button v-if="editingId === p.id" class="btn secondary small" @click="startEditLink(l)">Edit</button>
            <button v-if="p.links.length > 1" class="btn secondary small" @click="removeLink(p.id, l.id)">✕</button>
          </template>
        </div>
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
import type { Prospect, CheckResult, HistoryEntry, Quality } from '../types'

const prospects = ref<Prospect[]>([])
const newUrl = ref('')
const newName = ref('')
const newQuality = ref<Quality>('best')
const newInterval = ref(60)
const adding = ref(false)
const addMsg = ref('')
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

async function checkOne(id: string) {
  checkingOne.value = id
  try {
    const r = await window.dpApi.prospectsCheckOne(id)
    if (r) {
      checkMsg.value = r.error
        ? `${r.prospectName}: ${r.error}`
        : `${r.prospectName}: ${r.newItems} new, ${r.queued} queued ✓`
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

onMounted(() => {
  load()
  loadRecent()
  window.dpApi.onProspectsCheckDone(onCheckDone)
})

onUnmounted(() => {
  window.dpApi.offProspectsCheckDone(onCheckDone)
})
</script>

<style scoped>
.view { max-width: 860px; }
.card {
  background: #1e1e2e;
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
  background: #1e1e2e;
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
</style>
