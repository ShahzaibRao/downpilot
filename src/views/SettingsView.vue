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
      <h3>Cookie profiles</h3>
      <p class="muted">
        Log in to the site in your browser, export a <code>cookies.txt</code> (Netscape format),
        and paste it here. Values are encrypted with your OS keychain — DownPilot never
        shows them again. Downloads from that platform automatically use its cookies
        (both yt-dlp and gallery-dl).
      </p>
      <div class="row" style="margin-bottom: 8px;">
        <select v-model="cookiePlatform" class="quality">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="youtube">YouTube</option>
          <option value="x">X</option>
          <option value="facebook">Facebook</option>
          <option value="snapchat">Snapchat</option>
          <option value="pinterest">Pinterest</option>
        </select>
        <input v-model="cookieTestUrl" class="url-input" type="url" placeholder="Test URL (optional — e.g. a post link)" />
      </div>
      <textarea v-model="cookieContent" rows="4" class="url-input" style="width: 100%;"
        placeholder="Paste cookies.txt content here…"></textarea>
      <div class="row" style="margin-top: 8px; align-items: center;">
        <button class="btn" :disabled="cookieBusy || !cookieContent.trim()" @click="addCookies">
          {{ cookieBusy ? 'Saving…' : 'Save profile' }}
        </button>
        <span v-if="cookieMsg" class="muted">{{ cookieMsg }}</span>
      </div>
      <div v-if="cookieProfiles.length > 0" class="preview" style="margin-top: 12px;">
        <div v-for="p in cookieProfiles" :key="p.platform" class="preview-row">
          <strong>{{ p.platform }}</strong>
          <span class="muted">added {{ formatDate(p.addedAt) }}</span>
          <span v-if="p.expired" class="badge err">expired</span>
          <span v-else-if="p.lastTestOk" class="badge ok">tested OK</span>
          <span v-else class="badge">saved</span>
          <span class="spacer"></span>
          <button class="btn secondary small" :disabled="cookieBusy" @click="testCookies(p.platform)">Test</button>
          <button class="btn secondary small" :disabled="cookieBusy" @click="removeCookies(p.platform)">Remove</button>
        </div>
      </div>
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
import type { DepResult, DepsProgressEvent, CookieProfileMeta } from '../types'

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

// ---- cookie profiles (Phase 2a) ----

const cookiePlatform = ref('instagram')
const cookieContent = ref('')
const cookieTestUrl = ref('')
const cookieProfiles = ref<CookieProfileMeta[]>([])
const cookieBusy = ref(false)
const cookieMsg = ref('')

async function loadCookies() {
  try {
    cookieProfiles.value = await window.dpApi.cookiesList()
  } catch { /* ignore */ }
}

async function addCookies() {
  cookieBusy.value = true
  cookieMsg.value = ''
  try {
    await window.dpApi.cookiesAdd({ platform: cookiePlatform.value, content: cookieContent.value })
    cookieContent.value = ''
    cookieMsg.value = `Saved — ${countMsg()}`
  } catch (e) {
    cookieMsg.value = (e as Error).message
  } finally {
    cookieBusy.value = false
  }
}

function countMsg(): string {
  return `${cookieProfiles.value.length} profile(s). Paste a test URL above and hit Test to verify live.`
}

async function testCookies(platform: string) {
  cookieBusy.value = true
  cookieMsg.value = ''
  try {
    await window.dpApi.cookiesTest({ platform, testUrl: cookieTestUrl.value })
    cookieMsg.value = `${platform}: cookies work ✓`
  } catch (e) {
    cookieMsg.value = `${platform}: ${(e as Error).message}`
  } finally {
    cookieBusy.value = false
  }
}

async function removeCookies(platform: string) {
  cookieBusy.value = true
  try {
    await window.dpApi.cookiesRemove(platform)
    cookieMsg.value = `${platform} profile removed.`
  } finally {
    cookieBusy.value = false
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString()
}

let cookiesUnsubscribe: (() => void) | null = null

async function changeDir() {
  const dir = await window.dpApi.pickDownloadDir()
  if (dir) {
    downloadDir.value = (await window.dpApi.setSettings({ downloadDir: dir })).downloadDir
  }
}

onMounted(() => {
  unsubscribe = window.dpApi.onDepsProgress(onProgress)
  cookiesUnsubscribe = window.dpApi.onCookiesUpdate((m) => { cookieProfiles.value = m })
  refresh()
  loadSettings()
  loadCookies()
})

onUnmounted(() => {
  unsubscribe?.()
  cookiesUnsubscribe?.()
})
</script>

<style scoped>
.row { display: flex; gap: 8px; }
.url-input {
  flex: 1; background: #24282f; border: 1px solid #2a2e37; color: #e8eaed;
  border-radius: 8px; padding: 10px 12px; font-size: 14px;
}
.url-input:focus { outline: none; border-color: #2f6fed; }
textarea.url-input { width: 100%; resize: vertical; font-family: monospace; font-size: 12px; }
.quality {
  background: #24282f; border: 1px solid #2a2e37; color: #e8eaed;
  border-radius: 8px; padding: 10px; font-size: 14px;
}
.preview { display: flex; flex-direction: column; gap: 8px; }
.preview-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.spacer { flex: 1; }
.btn.small { padding: 4px 12px; font-size: 12px; }
code { background: #24282f; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style>
