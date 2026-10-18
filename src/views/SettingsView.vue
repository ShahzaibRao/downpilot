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
      <p class="muted" style="margin-top: 8px;">
        Max new items per prospect per check:
        <input v-model.number="maxNewPerCheck" type="number" min="1" max="50" class="quality" style="width: 70px;" @change="saveMaxNew" />
        <span style="font-size: 12px;">(1–50, default 20)</span>
      </p>
    </div>

    <div class="card">
      <h3>Smart Mode <span class="muted" style="font-weight: normal; font-size: 13px;">(proxy)</span></h3>
      <p class="muted">
        Route downloads through your proxy — only for the platforms you check, so proxy
        bandwidth isn't wasted. Everything else downloads direct.
      </p>
      <div class="row" style="margin-bottom: 10px; align-items: center;">
        <label class="muted" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input v-model="smartEnabled" type="checkbox" @change="saveSmart" /> Enable Smart Mode
        </label>
      </div>
      <div v-if="smartEnabled">
        <!-- saved proxies -->
        <div v-if="proxies.length > 0" class="preview" style="margin-bottom: 10px;">
          <div class="muted" style="font-size: 12px; margin-bottom: 4px;">
            Tick proxies to include in rotation — downloads round-robin across them.
          </div>
          <div v-for="p in proxies" :key="p.id" class="preview-row">
            <label class="muted chk" style="cursor: pointer;">
              <input type="checkbox" :checked="selectedProxyIds.includes(p.id)" @change="toggleProxySelected(p.id)" />
            </label>
            <strong>{{ p.name || 'Unnamed' }}</strong>
            <span class="muted">{{ p.protocol }}://{{ p.host }}:{{ p.port }}</span>
            <span v-if="selectedProxyIds.includes(p.id)" class="badge ok">in rotation</span>
            <span class="spacer"></span>
            <button class="btn secondary small" @click="editProxy(p)">Edit</button>
            <button class="btn secondary small" @click="deleteProxy(p.id)">Delete</button>
          </div>
        </div>
        <div v-else class="muted" style="margin-bottom: 10px; font-size: 13px;">
          No proxies saved yet — add one below.
        </div>

        <!-- add / edit form -->
        <div class="row" style="margin-bottom: 8px;">
          <input v-model="proxyName" class="url-input" placeholder="Name (e.g. Squid AWS)" />
          <select v-model="proxyProtocol" class="quality">
            <option value="http">http</option>
            <option value="https">https</option>
            <option value="socks4">socks4</option>
            <option value="socks5">socks5</option>
          </select>
        </div>
        <div class="row" style="margin-bottom: 8px;">
          <input v-model="proxyHost" class="url-input" placeholder="Host (e.g. 1.2.3.4)" />
          <input v-model.number="proxyPort" type="number" min="1" max="65535" class="url-input" style="max-width: 110px;" placeholder="Port" />
        </div>
        <div class="row" style="margin-bottom: 8px;">
          <input v-model="proxyUser" class="url-input" placeholder="Username (optional)" />
          <input v-model="proxyPass" type="password" class="url-input" placeholder="Password (optional)" />
        </div>
        <div class="row" style="margin-bottom: 10px; align-items: center;">
          <button class="btn" :disabled="!proxyHost.trim()" @click="saveProxy">
            {{ editingProxyId ? 'Update proxy' : 'Save proxy' }}
          </button>
          <button v-if="editingProxyId" class="btn secondary" @click="cancelEditProxy">Cancel</button>
          <span v-if="proxyFormMsg" class="muted">{{ proxyFormMsg }}</span>
        </div>

        <!-- platforms -->
        <div class="row" style="margin-bottom: 10px; flex-wrap: wrap; align-items: center;">
          <span class="muted">Use proxy for:</span>
          <label class="muted chk"><input type="checkbox" :checked="allPlatforms" @change="toggleAllPlatforms" /> All</label>
          <label v-for="p in smartPlatforms" :key="p" class="muted chk">
            <input type="checkbox" :checked="smartPlatformsChecked.includes(p)" @change="togglePlatform(p)" /> {{ p }}
          </label>
        </div>

        <!-- tests -->
        <div class="row" style="margin-bottom: 8px; align-items: center;">
          <button class="btn secondary" :disabled="proxyBusy || selectedProxyIds.length === 0" @click="doProxyTest">
            {{ proxyBusy ? 'Testing…' : `Test ${selectedProxyIds.length || ''} prox${selectedProxyIds.length === 1 ? 'y' : 'ies'}` }}
          </button>
          <input v-model="siteTestUrl" class="url-input" placeholder="Site URL to test (e.g. https://www.tiktok.com)" />
          <button class="btn secondary" :disabled="proxyBusy || selectedProxyIds.length === 0 || !siteTestUrl.trim()" @click="doSiteTest">
            Test site
          </button>
        </div>
        <div v-if="proxyResults.length > 0" class="preview" style="margin-bottom: 8px;">
          <div v-for="r in proxyResults" :key="r.id" class="preview-row">
            <strong>{{ r.name }}</strong>
            <span v-if="r.ok" class="badge ok">works{{ r.ip ? ' — ' + r.ip : '' }}{{ r.status ? ' (HTTP ' + r.status + ')' : '' }}</span>
            <span v-else class="badge err">failed</span>
            <span v-if="!r.ok" class="muted" style="font-size: 12px;">{{ r.error }}</span>
          </div>
        </div>
        <div v-if="proxyMsg" class="muted" style="font-size: 13px;">{{ proxyMsg }}</div>
      </div>
    </div>

    <div class="card">
      <h3>POT Server <span class="muted" style="font-weight: normal; font-size: 13px;">(YouTube bot-check)</span></h3>
      <p class="muted">
        Deno-powered token server for YouTube. Starts automatically on the first YouTube
        download — or control it here.
      </p>
      <div class="preview">
        <div class="preview-row">
          <span>Deno</span>
          <span v-if="potDeno" class="badge ok">installed</span>
          <span v-else class="badge err">missing</span>
          <span class="muted" style="font-size: 12px;">{{ potDeno ? '' : 'get it from Runtime dependencies' }}</span>
        </div>
        <div class="preview-row">
          <span>Server files</span>
          <span v-if="potFilesReady" class="badge ok">ready</span>
          <span v-else-if="potRunning && !potIsOurs" class="badge info">external</span>
          <span v-else class="badge">not set up</span>
          <span class="muted" style="font-size: 12px;">{{ potFilesReady ? '' : (potRunning && !potIsOurs ? 'using external server' : 'set up on first start') }}</span>
        </div>
        <div class="preview-row">
          <span>Server</span>
          <span v-if="potRunning" class="badge ok">running :{{ potPort }}{{ potVersion ? ' (v' + potVersion + ')' : '' }}{{ potIsOurs ? '' : ' (external)' }}</span>
          <span v-else class="badge">stopped</span>
          <span class="spacer"></span>
          <button v-if="!potRunning" class="btn secondary small" :disabled="potBusy || !potDeno" @click="doPotStart">Start</button>
          <button v-else-if="potIsOurs" class="btn secondary small" :disabled="potBusy" @click="doPotStop">Stop</button>
          <button v-else class="btn secondary small" :disabled="potBusy" @click="doPotForceStop" title="Kill the external process on :4416">Force stop</button>
          <button class="btn secondary small" :disabled="potBusy" @click="loadPotStatus">Refresh</button>
        </div>
      </div>
      <div v-if="potMsg" class="muted" style="font-size: 13px; margin-top: 8px;">{{ potMsg }}</div>
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

    <!-- App Updates (Phase 4) -->
    <div class="card">
      <h3>App Updates</h3>
      <p class="muted">
        DownPilot checks for updates on startup and daily. Updates download in the
        background — you'll be asked before restarting.
      </p>
      <div class="preview">
        <div class="preview-row">
          <span>Version</span>
          <span class="badge">{{ appVersion || '…' }}</span>
        </div>
        <div class="preview-row">
          <span>Status</span>
          <span v-if="updateStatus === 'checking'" class="badge">checking…</span>
          <span v-else-if="updateStatus === 'available'" class="badge ok">update available: {{ updateVersion }}</span>
          <span v-else-if="updateStatus === 'downloading'" class="badge ok">downloading {{ updatePercent }}%</span>
          <span v-else-if="updateStatus === 'downloaded'" class="badge ok">ready — restart to apply</span>
          <span v-else-if="updateStatus === 'up-to-date'" class="badge">up to date</span>
          <span v-else-if="updateStatus === 'error'" class="badge err">check failed</span>
          <span v-else class="badge">—</span>
        </div>
      </div>
      <div class="row" style="margin-top: 8px;">
        <button class="btn secondary" @click="checkUpdates">Check for updates</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import DepRow from '../components/DepRow.vue'
import type { DepResult, DepsProgressEvent, CookieProfileMeta, SmartModeConfig, ProxyEntry, ProxyProtocol, PotStatus, ProxyTestItemResult } from '../types'

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
const maxNewPerCheck = ref(20)

async function loadSettings() {
  try {
    const s = await window.dpApi.getSettings()
    downloadDir.value = s.downloadDir
    maxConcurrent.value = s.maxConcurrent
    maxNewPerCheck.value = s.maxNewPerCheck ?? 20
  } catch { /* ignore */ }
}

async function saveMaxNew() {
  try {
    const s = await window.dpApi.setSettings({ maxNewPerCheck: maxNewPerCheck.value })
    maxNewPerCheck.value = s.maxNewPerCheck
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

// ---- Smart Mode (Phase 2c) ----

const smartPlatforms = ['youtube', 'tiktok', 'x', 'instagram', 'snapchat', 'pinterest']
const smartEnabled = ref(false)
const proxies = ref<ProxyEntry[]>([])
const selectedProxyIds = ref<string[]>([])
const smartPlatformsChecked = ref<string[]>(['all'])
// proxy form
const proxyName = ref('')
const proxyProtocol = ref<ProxyProtocol>('http')
const proxyHost = ref('')
const proxyPort = ref(8080)
const proxyUser = ref('')
const proxyPass = ref('')
const editingProxyId = ref<string | null>(null)
const proxyFormMsg = ref('')
const proxyBusy = ref(false)
const proxyMsg = ref('')
const proxyResults = ref<ProxyTestItemResult[]>([])
const siteTestUrl = ref('')

const allPlatforms = computed(() => smartPlatformsChecked.value.includes('all'))

function newProxyId(): string {
  return 'proxy-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

async function loadSmart() {
  try {
    const s = await window.dpApi.getSettings()
    const sm: SmartModeConfig = s.smartMode ?? { enabled: false, proxies: [], selectedProxyIds: [], platforms: ['all'] }
    smartEnabled.value = sm.enabled
    proxies.value = sm.proxies ?? []
    selectedProxyIds.value = sm.selectedProxyIds ?? []
    smartPlatformsChecked.value = sm.platforms?.length ? sm.platforms : ['all']
  } catch { /* ignore */ }
}

async function persistSmart(): Promise<void> {
  // Deep-clone to plain objects: Vue reactive proxies cannot go through
  // Electron IPC (structured clone fails with "An object could not be cloned").
  const plainProxies: ProxyEntry[] = JSON.parse(JSON.stringify(proxies.value))
  await window.dpApi.setSettings({
    smartMode: {
      enabled: smartEnabled.value,
      proxies: plainProxies,
      selectedProxyIds: [...selectedProxyIds.value],
      platforms: [...smartPlatformsChecked.value]
    }
  })
}

async function saveSmart() {
  try { await persistSmart() } catch { /* ignore */ }
}

function clearProxyForm() {
  proxyName.value = ''
  proxyProtocol.value = 'http'
  proxyHost.value = ''
  proxyPort.value = 8080
  proxyUser.value = ''
  proxyPass.value = ''
  editingProxyId.value = null
  proxyFormMsg.value = ''
}

async function saveProxy() {
  proxyFormMsg.value = ''
  if (!proxyHost.value.trim()) {
    proxyFormMsg.value = 'Host is required.'
    return
  }
  try {
    if (editingProxyId.value) {
      const i = proxies.value.findIndex((p) => p.id === editingProxyId.value)
      if (i >= 0) {
        proxies.value[i] = {
          ...proxies.value[i],
          name: proxyName.value.trim() || 'Unnamed',
          protocol: proxyProtocol.value,
          host: proxyHost.value.trim(),
          port: proxyPort.value || 8080,
          username: proxyUser.value,
          password: proxyPass.value
        }
      }
      proxyFormMsg.value = 'Proxy updated ✓'
    } else {
      const entry: ProxyEntry = {
        id: newProxyId(),
        name: proxyName.value.trim() || 'Unnamed',
        protocol: proxyProtocol.value,
        host: proxyHost.value.trim(),
        port: proxyPort.value || 8080,
        username: proxyUser.value,
        password: proxyPass.value
      }
      proxies.value = [...proxies.value, entry]
      // newly added proxy joins the rotation pool automatically
      selectedProxyIds.value = [...selectedProxyIds.value, entry.id]
      proxyFormMsg.value = 'Proxy saved ✓'
    }
    await persistSmart()
    clearProxyForm()
  } catch (e) {
    proxyFormMsg.value = `Save failed: ${(e as Error).message}`
  }
}

function editProxy(p: ProxyEntry) {
  proxyName.value = p.name
  proxyProtocol.value = p.protocol
  proxyHost.value = p.host
  proxyPort.value = p.port
  proxyUser.value = p.username
  proxyPass.value = p.password
  editingProxyId.value = p.id
  proxyFormMsg.value = ''
}

function cancelEditProxy() {
  clearProxyForm()
}

async function deleteProxy(id: string) {
  proxies.value = proxies.value.filter((p) => p.id !== id)
  selectedProxyIds.value = selectedProxyIds.value.filter((x) => x !== id)
  if (editingProxyId.value === id) clearProxyForm()
  await saveSmart()
}

function toggleProxySelected(id: string) {
  if (selectedProxyIds.value.includes(id)) {
    selectedProxyIds.value = selectedProxyIds.value.filter((x) => x !== id)
  } else {
    selectedProxyIds.value = [...selectedProxyIds.value, id]
  }
  proxyResults.value = []
  saveSmart()
}

function togglePlatform(p: string) {
  const cur = smartPlatformsChecked.value.filter((x) => x !== 'all')
  if (cur.includes(p)) smartPlatformsChecked.value = cur.filter((x) => x !== p)
  else smartPlatformsChecked.value = [...cur, p]
  if (smartPlatformsChecked.value.length === 0) smartPlatformsChecked.value = ['all']
  saveSmart()
}

function toggleAllPlatforms() {
  smartPlatformsChecked.value = allPlatforms.value ? [] : ['all']
  saveSmart()
}

async function doProxyTest() {
  proxyBusy.value = true
  proxyMsg.value = ''
  proxyResults.value = []
  try {
    const results = await window.dpApi.proxyTest()
    proxyResults.value = results
    const okCount = results.filter((r) => r.ok).length
    proxyMsg.value = `${okCount}/${results.length} proxies work`
  } catch (e) {
    proxyMsg.value = `Proxy test: ${(e as Error).message}`
  } finally {
    proxyBusy.value = false
  }
}

async function doSiteTest() {
  proxyBusy.value = true
  proxyMsg.value = ''
  proxyResults.value = []
  try {
    const results = await window.dpApi.proxyTestSite(siteTestUrl.value)
    proxyResults.value = results
    const okCount = results.filter((r) => r.ok).length
    proxyMsg.value = `${okCount}/${results.length} proxies can reach the site`
  } catch (e) {
    proxyMsg.value = `Site test: ${(e as Error).message}`
  } finally {
    proxyBusy.value = false
  }
}

// ---- POT server status (Phase 2b panel) ----

const potDeno = ref(false)
const potFilesReady = ref(false)
const potRunning = ref(false)
const potIsOurs = ref(false)
const potVersion = ref<string | null>(null)
const potPort = ref(4416)
const potBusy = ref(false)
const potMsg = ref('')

async function loadPotStatus() {
  potMsg.value = ''
  try {
    const s: PotStatus = await window.dpApi.potStatus()
    potDeno.value = !!s.denoPath
    potFilesReady.value = s.filesReady
    potRunning.value = s.running
    potIsOurs.value = s.isOurs
    potVersion.value = s.version
    potPort.value = s.port
  } catch (e) {
    potMsg.value = `Status check failed: ${(e as Error).message}`
  }
}

async function doPotForceStop() {
  potBusy.value = true
  potMsg.value = 'Force-stopping external server…'
  try {
    await window.dpApi.potForceStop()
    potMsg.value = 'External server stopped — port :4416 is free. You can Start now.'
  } catch (e) {
    potMsg.value = `Force stop failed: ${(e as Error).message}`
  } finally {
    potBusy.value = false
    loadPotStatus()
  }
}

async function doPotStart() {
  potBusy.value = true
  potMsg.value = 'Starting… (first run installs dependencies, may take a minute)'
  try {
    await window.dpApi.potStart()
    potMsg.value = 'Server running ✓'
  } catch (e) {
    potMsg.value = `Start failed: ${(e as Error).message}`
  } finally {
    potBusy.value = false
    loadPotStatus()
  }
}

async function doPotStop() {
  potBusy.value = true
  try {
    await window.dpApi.potStop()
    potMsg.value = 'Server stopped.'
  } catch (e) {
    potMsg.value = `Stop failed: ${(e as Error).message}`
  } finally {
    potBusy.value = false
    loadPotStatus()
  }
}

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
  loadSmart()
  loadPotStatus()
  loadAppVersion()
  updaterUnsubscribe = (window as any).dpApi?.onUpdaterStatus?.((s: any) => {
    updateStatus.value = s.status
    updateVersion.value = s.version || ''
    updatePercent.value = s.percent || 0
  })
})

onUnmounted(() => {
  unsubscribe?.()
  cookiesUnsubscribe?.()
  updaterUnsubscribe?.()
})

// ---- App Updates (Phase 4) ----
const appVersion = ref('')
const updateStatus = ref('')
const updateVersion = ref('')
const updatePercent = ref(0)
let updaterUnsubscribe: (() => void) | null = null

async function loadAppVersion() {
  try {
    appVersion.value = await (window as any).dpApi?.updaterVersion?.() || ''
  } catch { /* ignore */ }
}
async function checkUpdates() {
  updateStatus.value = 'checking'
  try {
    await (window as any).dpApi?.updaterCheck?.()
  } catch {
    updateStatus.value = 'error'
  }
}
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
.chk { display: flex; align-items: center; gap: 4px; cursor: pointer; text-transform: capitalize; }
code { background: #24282f; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style>
