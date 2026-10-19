<template>
  <div class="dep-row">
    <div class="dep-info">
      <strong>{{ dep.kind }}</strong>
      <span v-if="dep.version" class="muted">{{ dep.version }}</span>
      <span v-if="dep.source" class="badge info">{{ dep.source }}</span>
      <span v-if="dep.optional" class="badge info">optional</span>
      <span v-if="dep.found" class="badge ok">found</span>
      <span v-else class="badge err">missing</span>
      <span v-if="dep.stale" class="badge warn">update available</span>
    </div>
    <div class="dep-actions">
      <div v-if="busy && progress !== undefined" class="progress">
        <div class="bar" :style="{ width: progress + '%' }"></div>
        <span>{{ progress }}%</span>
      </div>
      <button
        v-else
        class="btn secondary"
        :disabled="busy"
        @click="$emit('download')"
      >
        {{ dep.found ? (dep.stale ? 'Update' : 'Re-download') : 'Download' }}
      </button>
    </div>
    <div v-if="dep.reason && !dep.found" class="dep-reason muted">{{ dep.reason }}</div>
  </div>
</template>

<script setup lang="ts">
import type { DepResult } from '../types'

defineProps<{
  dep: DepResult
  busy: boolean
  progress?: number
}>()

defineEmits<{
  (e: 'download'): void
}>()
</script>

<style scoped>
.dep-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 12px 0; border-bottom: 1px solid #2a2e37;
}
.dep-row:last-child { border-bottom: none; }
.dep-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 240px; }
.dep-actions { display: flex; align-items: center; }
.dep-reason { flex-basis: 100%; font-size: 12px; }
.progress { display: flex; align-items: center; gap: 8px; min-width: 200px; }
.progress .bar { height: 8px; background: #f97316; border-radius: 4px; transition: width 0.2s; flex: 1; }
</style>
