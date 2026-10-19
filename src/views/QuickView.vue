<template>
  <div>
    <h2>Quick download</h2>

    <div class="card">
      <div class="row url-row">
        <div class="url-wrap">
          <span v-if="detectedPlatform" class="plat-badge" :style="{ background: platColor(detectedPlatform) }">
            {{ platIcon(detectedPlatform) }} {{ detectedPlatform }}
          </span>
          <input
            v-model="url"
            class="url-input"
            type="url"
            placeholder="Paste a video link… (YouTube, TikTok, Instagram, …)"
            @keyup.enter="add"
          />
          <button v-if="url" class="icon-btn" @click="url = ''" title="Clear">✕</button>
        </div>
        <button class="btn secondary" @click="pasteFromClipboard" title="Paste from clipboard">📋</button>
        <select v-model="quality" class="quality">
          <option value="best">Best</option>
          <option value="4k">4K</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
        <select v-model="scope" class="quality" title="Download scope">
          <option value="single">Single</option>
          <option value="playlist">Playlist</option>
          <option value="channel">Channel</option>
        </select>
        <button class="btn" :disabled="adding || !url.trim()" @click="add">
          {{ adding ? 'Adding…' : 'Download' }}
        </button>
      </div>
      <div v-if="scope !== 'single'" class="row scope-opts">
        <label class="muted">Max items
          <input v-model.number="maxItems" type="number" min="1" max="500" class="num" />
        </label>
        <label class="muted"><input v-model="order" type="radio" value="latest" /> Latest</label>
        <label class="muted"><input v-model="order" type="radio" value="oldest" /> Oldest</label>
        <label class="muted"><input v-model="order" type="radio" value="popular" /> Popular</label>
      </div>
      <div v-if="scope === 'channel'" class="row scope-opts">
        <span class="muted">Content (YouTube):</span>
        <label class="muted"><input v-model="content" type="radio" value="all" /> All</label>
        <label class="muted"><input v-model="content" type="radio" value="videos" /> Videos only</label>
        <label class="muted"><input v-model="content" type="radio" value="shorts" /> Shorts only</label>
      </div>
      <div v-if="error" class="badge err" style="margin-top: 8px;">{{ error }}</div>
      <p class="muted" style="margin: 8px 0 0;">Saves to: <code>{{ downloadDir }}</code> <a href="#" @click.prevent="goSettings">(change)</a></p>
      <div style="margin-top: 8px;">
        <button class="btn secondary small" @click="showBulk = !showBulk">
          {{ showBulk ? 'Hide bulk add' : 'Bulk add' }}
        </button>
      </div>
      <div v-if="showBulk" class="bulk">
        <textarea
          v-model="bulkText"
          rows="5"
          class="url-input"
          placeholder="One link per line…"
        ></textarea>
        <div v-if="bulkPreview.length > 0" class="preview">
          <div v-for="p in bulkPreview" :key="p.url" class="preview-row">
            <span class="preview-url">{{ p.url }}</span>
            <span v-if="p.dup" class="badge">duplicate — skipped</span>
            <span v-else class="badge info">new</span>
          </div>
        </div>
        <div class="row" style="margin-top: 8px; align-items: center;">
          <button class="btn" :disabled="addingBulk || bulkNewCount === 0" @click="addBulk">
            {{ addingBulk ? 'Adding…' : `Add ${bulkNewCount} to queue` }}
          </button>
          <span v-if="bulkResult" class="muted">{{ bulkResult }}</span>
        </div>
      </div>
    </div>

    <div v-if="queueCount > 0" class="card row" style="justify-content: space-between; align-items: center;">
      <span class="muted">{{ queueCount }} task(s) in queue</span>
      <button class="btn secondary small" @click="goQueue">Open Queue →</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import type { QueueTask, Quality, Scope, Order, ContentFilter, ScopeOpts } from '../types'

const url = ref('')
const quality = ref<Quality>('best')
const scope = ref<Scope>('single')
const maxItems = ref(50)
const order = ref<Order>('latest')
const content = ref<ContentFilter>('all')
const adding = ref(false)
const error = ref('')
const tasks = ref<QueueTask[]>([])
const downloadDir = ref('')

// bulk add
const showBulk = ref(false)
const bulkText = ref('')
const addingBulk = ref(false)
const bulkResult = ref('')

let unsubscribe: (() => void) | null = null

const queueCount = computed(() => tasks.value.length)

// Platform auto-detection
const detectedPlatform = computed(() => {
  const u = url.value.toLowerCase()
  if (!u) return ''
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('tiktok.com')) return 'tiktok'
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x'
  if (u.includes('snapchat.com')) return 'snapchat'
  if (u.includes('pinterest.com')) return 'pinterest'
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook'
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

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (text) url.value = text.trim()
  } catch {
    error.value = 'Clipboard access denied'
  }
}

function currentScopeOpts(): ScopeOpts {
  return {
    scope: scope.value,
    maxItems: Math.min(500, Math.max(1, Math.floor(maxItems.value) || 50)),
    order: order.value,
    content: content.value
  }
}

async function add() {
  const u = url.value.trim()
  if (!u) return
  adding.value = true
  error.value = ''
  try {
    await window.dpApi.queueAdd({ url: u, quality: quality.value, scopeOpts: currentScopeOpts() })
    url.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    adding.value = false
  }
}

function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/$/, '')
}

const bulkPreview = computed(() => {
  const lines = bulkText.value.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s))
  const inQueue = new Set(tasks.value.map((t) => normalizeUrl(t.url)))
  const seen = new Set<string>()
  return lines.map((u) => {
    const n = normalizeUrl(u)
    const dup = seen.has(n) || inQueue.has(n)
    seen.add(n)
    return { url: u, dup }
  })
})

const bulkNewCount = computed(() => bulkPreview.value.filter((p) => !p.dup).length)

async function addBulk() {
  const items = bulkPreview.value
    .filter((p) => !p.dup)
    .map((p) => ({ url: p.url, quality: quality.value, scopeOpts: currentScopeOpts() }))
  if (items.length === 0) return
  addingBulk.value = true
  bulkResult.value = ''
  try {
    const res = await window.dpApi.queueAddBulk(items)
    bulkResult.value = `Added ${res.added}, skipped ${res.skipped} duplicate(s).`
    bulkText.value = ''
  } catch (e) {
    bulkResult.value = (e as Error).message
  } finally {
    addingBulk.value = false
  }
}

function goSettings() {
  window.dispatchEvent(new CustomEvent('dp:goto', { detail: 'settings' }))
}

function goQueue() {
  window.dispatchEvent(new CustomEvent('dp:goto', { detail: 'queue' }))
}

onMounted(async () => {
  unsubscribe = window.dpApi.onQueueUpdate((t) => { tasks.value = t })
  try {
    tasks.value = await window.dpApi.queueList()
    downloadDir.value = (await window.dpApi.getSettings()).downloadDir
  } catch { /* ignore */ }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.row { display: flex; gap: 8px; }
.url-row { align-items: center; }
.url-wrap {
  flex: 1; display: flex; align-items: center; gap: 8px;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px;
  padding: 0 8px 0 12px;
}
.url-wrap:focus-within { border-color: var(--accent); }
.url-wrap .url-input {
  flex: 1; background: transparent; border: none; color: var(--text);
  padding: 10px 0; font-size: 14px;
}
.url-wrap .url-input:focus { outline: none; }
.plat-badge {
  font-size: 11px; font-weight: 700; color: #fff;
  padding: 4px 10px; border-radius: 20px; white-space: nowrap;
  text-transform: capitalize;
}
.icon-btn {
  background: transparent; border: none; color: var(--text-muted);
  font-size: 14px; cursor: pointer; padding: 4px 8px; border-radius: 4px;
}
.icon-btn:hover { color: var(--text); background: var(--border); }
.url-input {
  flex: 1; background: var(--bg-input); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 10px 12px; font-size: 14px;
}
.url-input:focus { outline: none; border-color: var(--accent); }
.quality {
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 10px; font-size: 14px;
}
.num {
  width: 70px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text);
  border-radius: 6px; padding: 6px 8px; font-size: 13px; margin-left: 4px;
}
.scope-opts { align-items: center; margin-top: 8px; }
.scope-opts label { display: flex; align-items: center; gap: 4px; }
.bulk { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.bulk textarea { width: 100%; resize: vertical; }
.preview { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.preview-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.preview-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa0a6; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; word-break: break-all; }
.progress { height: 8px; background: var(--bg-input); border-radius: 4px; overflow: hidden; }
.progress .bar { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
.progress.indeterminate .bar {
  width: 30% !important;
  background: linear-gradient(90deg, var(--accent) 25%, #6ea8ff 50%, var(--accent) 75%);
  background-size: 200% 100%;
  animation: slide 1.2s linear infinite;
}
@keyframes slide { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.badge.engine { background: #2a2438; color: #c4b5fd; }
.job-meta { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 13px; }
.spacer { flex: 1; }
.btn.small { padding: 4px 12px; font-size: 12px; }
a { color: #93c5fd; }
</style>
