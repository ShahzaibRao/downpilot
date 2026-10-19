<template>
  <div class="app">
    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="{ active: active === tab.id }"
        @click="active = tab.id"
      >
        {{ tab.label }}
      </button>
      <span class="spacer"></span>
      <button class="bell" @click="showNotifications = !showNotifications" title="Notifications">
        🔔
        <span v-if="unreadCount > 0" class="badge-count">{{ unreadCount }}</span>
      </button>
    </nav>
    <!-- notifications dropdown -->
    <div v-if="showNotifications" class="notif-panel">
      <div class="notif-header">
        <strong>Notifications</strong>
        <span class="spacer"></span>
        <button class="btn secondary small" @click="markAllRead">Mark all read</button>
        <button class="btn secondary small" @click="clearAll">Clear</button>
        <button class="btn secondary small" @click="showNotifications = false">✕</button>
      </div>
      <div v-if="notifications.length === 0" class="muted" style="padding: 12px;">No notifications yet.</div>
      <div
        v-for="n in notifications"
        :key="n.id"
        class="notif-item"
        :class="{ unread: !n.read }"
        @click="openNotification(n)"
      >
        <span class="notif-dot" :class="{ read: n.read }"></span>
        <div class="notif-content">
          <div class="notif-title">{{ n.title }}</div>
          <div class="notif-body">{{ n.body }}</div>
          <div class="notif-time">{{ formatTime(n.createdAt) }}</div>
        </div>
      </div>
    </div>
    <main class="view">
      <DashboardView v-if="active === 'dashboard'" @goto="active = $event" />
      <QuickView v-else-if="active === 'quick'" />
      <QueueView v-else-if="active === 'queue'" />
      <ProspectView v-else-if="active === 'prospect'" />
      <HistoryView v-else-if="active === 'history'" />
      <SettingsView v-else />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import QuickView from './views/QuickView.vue'
import QueueView from './views/QueueView.vue'
import ProspectView from './views/ProspectView.vue'
import DashboardView from './views/DashboardView.vue'
import HistoryView from './views/HistoryView.vue'
import SettingsView from './views/SettingsView.vue'
import type { AppNotification } from './types'

const tabs = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'quick', label: 'Quick' },
  { id: 'queue', label: 'Queue' },
  { id: 'prospect', label: 'Prospect' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' }
] as const

type TabId = (typeof tabs)[number]['id']
const active = ref<TabId>('dashboard')

// notifications (Phase 3c)
const notifications = ref<AppNotification[]>([])
const showNotifications = ref(false)
const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length)

async function loadNotifications() {
  try {
    notifications.value = await window.dpApi.notifyList()
  } catch { /* ignore */ }
}

async function markAllRead() {
  await window.dpApi.notifyMarkAllRead()
  await loadNotifications()
}

async function clearAll() {
  await window.dpApi.notifyClear()
  await loadNotifications()
}

async function openNotification(n: AppNotification) {
  await window.dpApi.notifyMarkRead(n.id)
  if (n.prospectId) {
    try {
      await window.dpApi.shellOpenProspectFolder(n.prospectId)
    } catch { /* ignore */ }
  }
  await loadNotifications()
  showNotifications.value = false
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

function onNotifyUpdate(_e: any, items: AppNotification[]) {
  notifications.value = items
}

// lets views request a tab switch (e.g. Quick → Settings)
window.addEventListener('dp:goto', (e: Event) => {
  const id = (e as CustomEvent).detail as TabId
  if (tabs.some((t) => t.id === id)) active.value = id
})

onMounted(() => {
  loadNotifications()
  applyTheme()
  window.dpApi.onNotifyUpdate(onNotifyUpdate)
  // Listen for theme changes from Settings
  window.addEventListener('dp:theme', applyTheme)
})

onUnmounted(() => {
  window.dpApi.offNotifyUpdate(onNotifyUpdate)
  window.removeEventListener('dp:theme', applyTheme)
})

async function applyTheme() {
  try {
    const s = await window.dpApi.getSettings()
    let theme = s.theme || 'dark'
    if (theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.setProperty('--accent', s.accentColor || 'var(--accent)')
  } catch { /* ignore */ }
}
</script>

<style>
* { box-sizing: border-box; }

/* Theme variables - set by JS based on user preference */
:root {
  --accent: #f97316;
  --bg-app: var(--bg-app);
  --bg-tabs: var(--bg-tabs);
  --bg-card: var(--bg-card);
  --bg-input: var(--bg-input);
  --bg-hover: #22262e;
  --text: var(--text);
  --text-muted: var(--text-muted);
  --border: var(--border);
  --shadow: rgba(0,0,0,0.5);
}

[data-theme="light"] {
  --bg-app: #f5f5f7;
  --bg-tabs: #ffffff;
  --bg-card: #ffffff;
  --bg-input: #f0f0f3;
  --bg-hover: #e8e8ec;
  --text: #1a1a1e;
  --text-muted: #6b7280;
  --border: #e0e0e5;
  --shadow: rgba(0,0,0,0.1);
}

body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--bg-app); color: var(--text); }
.app { display: flex; flex-direction: column; height: 100vh; }
.tabs { display: flex; gap: 4px; padding: 10px 16px; background: var(--bg-tabs); border-bottom: 1px solid var(--border); }
.tabs button {
  background: none; border: none; color: var(--text-muted); font-size: 14px;
  padding: 8px 16px; border-radius: 8px; cursor: pointer;
}
.tabs button:hover { color: var(--text); background: var(--bg-input); }
.tabs button.active { color: #fff; background: var(--accent); }
.view { flex: 1; overflow-y: auto; padding: 24px; }
.card { background: var(--bg-tabs); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
.muted { color: var(--text-muted); }
.btn {
  background: var(--accent); color: #fff; border: none; border-radius: 8px;
  padding: 8px 16px; font-size: 14px; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.secondary { background: var(--border); }
.badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.badge.ok { background: #143d24; color: #4ade80; }
.badge.warn { background: #4a2f12; color: #fbbf24; }
.badge.err { background: #4a1518; color: #f87171; }
.badge.info { background: #1e2a4a; color: #93c5fd; }
.spacer { flex: 1; }
.bell {
  position: relative;
  background: none; border: none; color: var(--text-muted); font-size: 18px;
  padding: 8px 12px; border-radius: 8px; cursor: pointer;
}
.bell:hover { color: var(--text); background: var(--bg-input); }
.badge-count {
  position: absolute; top: 2px; right: 2px;
  background: #ef4444; color: white; font-size: 10px;
  min-width: 16px; height: 16px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 4px;
}
.notif-panel {
  position: absolute; top: 56px; right: 16px; width: 380px; max-height: 480px;
  overflow-y: auto; background: var(--bg-tabs); border: 1px solid var(--border);
  border-radius: 16px; z-index: 100; box-shadow: 0 12px 40px rgba(0,0,0,0.6);
}
.notif-header {
  display: flex; gap: 6px; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-tabs); border-radius: 16px 16px 0 0;
  font-weight: 600;
}
.notif-item {
  padding: 14px 16px; border-bottom: 1px solid var(--bg-input); cursor: pointer;
  display: flex; gap: 12px; align-items: flex-start;
  transition: background 0.15s;
}
.notif-item:hover { background: #22262e; }
.notif-item:last-child { border-bottom: none; }
.notif-item.unread { background: rgba(249, 115, 22, 0.08); }
.notif-item.unread:hover { background: rgba(249, 115, 22, 0.12); }
.notif-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  margin-top: 6px; flex-shrink: 0;
}
.notif-dot.read { background: #3a3f4a; }
.notif-content { flex: 1; min-width: 0; }
.notif-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.notif-body { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
.notif-time { font-size: 11px; color: #6b7280; margin-top: 4px; }
.btn.small { padding: 4px 10px; font-size: 12px; }
</style>
