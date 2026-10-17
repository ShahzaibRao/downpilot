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
    </nav>
    <main class="view">
      <QuickView v-if="active === 'quick'" />
      <ProspectView v-else-if="active === 'prospect'" />
      <HistoryView v-else-if="active === 'history'" />
      <SettingsView v-else />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import QuickView from './views/QuickView.vue'
import ProspectView from './views/ProspectView.vue'
import HistoryView from './views/HistoryView.vue'
import SettingsView from './views/SettingsView.vue'

const tabs = [
  { id: 'quick', label: 'Quick' },
  { id: 'prospect', label: 'Prospect' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' }
] as const

type TabId = (typeof tabs)[number]['id']
const active = ref<TabId>('quick')
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
.tabs button.active { color: #fff; background: #2f6fed; }
.view { flex: 1; overflow-y: auto; padding: 24px; }
.card { background: #1b1e24; border: 1px solid #2a2e37; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
.muted { color: #9aa0ab; }
.btn {
  background: #2f6fed; color: #fff; border: none; border-radius: 8px;
  padding: 8px 16px; font-size: 14px; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.secondary { background: #2a2e37; }
.badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.badge.ok { background: #143d24; color: #4ade80; }
.badge.warn { background: #4a2f12; color: #fbbf24; }
.badge.err { background: #4a1518; color: #f87171; }
.badge.info { background: #1e2a4a; color: #93c5fd; }
</style>
