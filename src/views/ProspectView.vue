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

    <!-- add -->
    <div class="card">
      <h3>Add prospect</h3>
      <div class="row">
        <input v-model="newUrl" class="url-input" placeholder="Profile URL (e.g. https://www.tiktok.com/@someone)" />
        <input v-model="newName" class="url-input" style="max-width: 200px;" placeholder="Name (optional)" />
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
        <strong style="font-size: 15px;">{{ p.name }}</strong>
        <span v-if="p.status === 'ok'" class="badge ok">watching</span>
        <span v-else-if="p.status === 'paused'" class="badge">paused</span>
        <span v-else class="badge err">error</span>
        <span class="muted" style="font-size: 12px;">{{ p.links.length }} link{{ p.links.length === 1 ? '' : 's' }}</span>
        <span class="spacer"></span>
        <button v-if="p.status === 'paused'" class="btn secondary small" @click="unpause(p.id)">Resume</button>
        <button v-else class="btn secondary small" @click="setStatus(p.id, 'paused')">Pause</button>
        <button class="btn secondary small" @click="remove(p.id)">Remove</button>
      </div>
      <div v-if="p.lastError" class="muted" style="font-size: 12px; color: #f87171;">{{ p.lastError }}{{ p.failCount > 0 ? ` (${p.failCount}/3)` : '' }}</div>
      <div class="muted" style="font-size: 12px; margin-top: 4px;">
        Folder: prospects/{{ p.folder }}
        <span v-if="p.lastCheck"> · Last check: {{ formatTime(p.lastCheck) }}</span>
      </div>
      <!-- links -->
      <div class="preview" style="margin-top: 8px;">
        <div v-for="l in p.links" :key="l.id" class="preview-row">
          <span class="badge">{{ l.platform }}</span>
          <span class="muted" style="font-size: 12px; overflow: hidden; text-overflow: ellipsis;">{{ l.url }}</span>
          <span class="spacer"></span>
          <button v-if="p.links.length > 1" class="btn secondary small" @click="removeLink(p.id, l.id)">✕</button>
        </div>
        <div class="preview-row">
          <input v-model="linkInputs[p.id]" class="url-input" style="font-size: 12px;" placeholder="Add another platform link for this creator…" />
          <button class="btn secondary small" :disabled="!linkInputs[p.id]?.trim()" @click="addLink(p.id)">Add link</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { Prospect, CheckResult } from '../types'

const prospects = ref<Prospect[]>([])
const newUrl = ref('')
const newName = ref('')
const adding = ref(false)
const addMsg = ref('')
const linkInputs = ref<Record<string, string>>({})
const checking = ref(false)
const checkMsg = ref('')

async function load() {
  try {
    prospects.value = await window.dpApi.prospectsList()
  } catch { /* ignore */ }
}

async function addProspect() {
  adding.value = true
  addMsg.value = ''
  try {
    await window.dpApi.prospectsAdd(newUrl.value.trim(), newName.value.trim() || undefined)
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
</style>
