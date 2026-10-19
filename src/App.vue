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
  window.dpApi.onNotifyUpdate(onNotifyUpdate)
})

onUnmounted(() => {
  window.dpApi.offNotifyUpdate(onNotifyUpdate)
})
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #14161a; color: #e8eaed; }
.app { display: flex; flex-direction: column; height: 100vh; }
.tabs { display: flex; gap: 4px; padding: 10px 16px; background: #1b1e24; border-bottom: 1px solid #2a2e37; }
.tabs button {
  background: none; border: none; color: #9aa0ab; font-size: 14px;
  padding: 8px 16px; border-radius: 8px; cursor: pointer;
}
.tabs button:hover { color: #e8eaed; background: #24282f; }
.tabs button.active { color: #fff; background: #f97316; }
.view { flex: 1; overflow-y: auto; padding: 24px; }
.card { background: #1b1e24; border: 1px solid #2a2e37; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
.muted { color: #9aa0ab; }
.btn {
  background: #f97316; color: #fff; border: none; border-radius: 8px;
  padding: 8px 16px; font-size: 14px; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.secondary { background: #2a2e37; }
.badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.badge.ok { background: #143d24; color: #4ade80; }
.badge.warn { background: #4a2f12; color: #fbbf24; }
.badge.err { background: #4a1518; color: #f87171; }
.badge.info { background: #1e2a4a; color: #93c5fd; }
.spacer { flex: 1; }
.bell {
  position: relative;
  background: none; border: none; color: #9aa0ab; font-size: 18px;
  padding: 8px 12px; border-radius: 8px; cursor: pointer;
}
.bell:hover { color: #e8eaed; background: #24282f; }
.badge-count {
  position: absolute; top: 2px; right: 2px;
  background: #ef4444; color: white; font-size: 10px;
  min-width: 16px; height: 16px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 4px;
}
.notif-panel {
  position: absolute; top: 56px; right: 16px; width: 380px; max-height: 480px;
  overflow-y: auto; background: #1b1e24; border: 1px solid #2a2e37;
  border-radius: 16px; z-index: 100; box-shadow: 0 12px 40px rgba(0,0,0,0.6);
}
.notif-header {
  display: flex; gap: 6px; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid #2a2e37;
  position: sticky; top: 0; background: #1b1e24; border-radius: 16px 16px 0 0;
  font-weight: 600;
}
.notif-item {
  padding: 14px 16px; border-bottom: 1px solid #24282f; cursor: pointer;
  display: flex; gap: 12px; align-items: flex-start;
  transition: background 0.15s;
}
.notif-item:hover { background: #22262e; }
.notif-item:last-child { border-bottom: none; }
.notif-item.unread { background: rgba(249, 115, 22, 0.08); }
.notif-item.unread:hover { background: rgba(249, 115, 22, 0.12); }
.notif-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #f97316;
  margin-top: 6px; flex-shrink: 0;
}
.notif-dot.read { background: #3a3f4a; }
.notif-content { flex: 1; min-width: 0; }
.notif-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.notif-body { font-size: 12px; color: #9aa0aa; line-height: 1.4; }
.notif-time { font-size: 11px; color: #6b7280; margin-top: 4px; }
.btn.small { padding: 4px 10px; font-size: 12px; }
</style>
