<template>
  <div>
    <h2>Settings</h2>

    <div class="card">
      <h3>Downloads</h3>
      <p class="muted">Folder: <code>{{ downloadDir }}</code></p>
      <button class="btn secondary" @click="changeDir">Change folder…</button>
      <p class="muted" style="margin-top: 12px;">
        Simultaneous downloads:
        <select v-model.number="maxConcurrent" class="quality" @change="saveConcurrent">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
          <option :value="4">4</option>
        </select>
      </p>
    </div>

    <div class="card">
      <h3>Runtime dependencies</h3>
      <p class="muted">Managed by the <code>dp-deps</code> sidecar. Missing tools are downloaded with SHA-256 verification.</p>

      <div v-if="loading" class="muted">Detecting…</div>
      <div v-else-if="error" class="badge err">{{ error }}</div>
      <div v-else>
        <DepRow
          v-for="dep in deps"
          :key="dep.kind"
          :dep="dep"
          :busy="busy === dep.kind"
          :progress="progress[dep.kind]"
          @download="downloadDep(dep.kind)"
        />
        <div style="margin-top: 12px; display: flex; gap: 8px;">
          <button class="btn" :disabled="busy !== null" @click="downloadAll">Download / update all</button>
          <button class="btn secondary" :disabled="busy !== null" @click="refresh">Re-detect</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import DepRow from '../components/DepRow.vue'
import type { DepResult, DepsProgressEvent } from '../types'

const deps = ref<DepResult[]>([])
const loading = ref(true)
const error = ref('')
const busy = ref<string | null>(null) // kind being downloaded, or '__all__'
const progress = reactive<Record<string, number>>({})

let unsubscribe: (() => void) | null = null

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const status = await window.dpApi.getDepsStatus()
    deps.value = status.results
  } catch (e) {
    error.value = `Sidecar not reachable: ${(e as Error).message}. Did you run "npm run sidecar:build"?`
  } finally {
    loading.value = false
  }
}

async function downloadDep(kind: string) {
  busy.value = kind
  progress[kind] = 0
  try {
    await window.dpApi.fetchDeps([kind])
  } finally {
    busy.value = null
    delete progress[kind]
    await refresh()
  }
}

async function downloadAll() {
  busy.value = '__all__'
  try {
    await window.dpApi.fetchDeps()
  } finally {
    busy.value = null
    for (const k of Object.keys(progress)) delete progress[k]
    await refresh()
  }
}

function onProgress(evt: DepsProgressEvent) {
  if (evt.event === 'progress' && evt.tool && evt.total) {
    progress[evt.tool] = Math.round(((evt.downloaded ?? 0) / evt.total) * 100)
  }
}

const downloadDir = ref('')
const maxConcurrent = ref(1)

async function loadSettings() {
  try {
    const s = await window.dpApi.getSettings()
    downloadDir.value = s.downloadDir
    maxConcurrent.value = s.maxConcurrent
  } catch { /* ignore */ }
}

async function saveConcurrent() {
  try {
    maxConcurrent.value = (await window.dpApi.setSettings({ maxConcurrent: maxConcurrent.value })).maxConcurrent
  } catch { /* ignore */ }
}

async function changeDir() {
  const dir = await window.dpApi.pickDownloadDir()
  if (dir) {
    downloadDir.value = (await window.dpApi.setSettings({ downloadDir: dir })).downloadDir
  }
}

onMounted(() => {
  unsubscribe = window.dpApi.onDepsProgress(onProgress)
  refresh()
  loadSettings()
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>
