<script setup lang="ts">
// Presentational queue rows for the batch workbench. All state lives in App;
// this component only renders and reports intent.
import { formatDuration, formatSize } from '../lib.js';
import type { QueueRow } from '../lib.js';

const props = defineProps<{
  items: QueueRow[];
  selectable: boolean;
  head: boolean;
  targets: Record<string, string>;
  targetOptions: Record<string, string[]>;
  showTargets: boolean;
  disabled: boolean;
  t: (key: string) => string;
}>();

const emit = defineEmits<{
  toggle: [key: string];
  open: [key: string];
  reveal: [file: string];
  remove: [key: string];
  'update:target': [key: string, value: string];
}>();

const nameOf = (item: QueueRow): string => item.upload?.name || item.file.name;
const kindOf = (item: QueueRow): string => item.upload?.kind || '';
const kindLabel = (item: QueueRow): string => {
  const kind = kindOf(item);
  return kind ? props.t('kind.' + kind) : '';
};
const setTarget = (key: string, event: Event) => emit('update:target', key, (event.target as HTMLSelectElement).value);

const savedOf = (item: QueueRow): number => {
  if (!item.result || !item.upload || item.upload.size <= item.result.size) return 0;
  return Math.min(99, Math.round((1 - item.result.size / item.upload.size) * 100));
};
const dotOf = (item: QueueRow): string => {
  if (item.state === 'done') return 'ok';
  if (item.state === 'error') return 'error';
  if (item.state === 'skipped') return 'warn';
  if (item.state === 'converting' || item.state === 'cancelling') return 'busy';
  return 'idle';
};
const statusOf = (item: QueueRow): string => {
  switch (item.state) {
    case 'uploading':
      return props.t('item.uploading');
    case 'ready':
      return props.t('item.ready');
    case 'converting':
      return item.percent === null ? props.t('item.converting') : item.percent + '%';
    case 'cancelling':
      return props.t('item.cancelling');
    case 'cancelled':
      return props.t('item.cancelled');
    case 'skipped':
      return props.t('item.skipped');
    case 'error':
      return props.t('item.failed');
    default: {
      const size = item.result ? formatSize(item.result.size) : '';
      const saved = savedOf(item);
      const how = item.result?.copy ? props.t('item.copy') : item.result?.hardware ? props.t('item.gpu') : '';
      return [props.t('item.done'), size, saved ? '-' + saved + '%' : '', how].filter(Boolean).join(' · ');
    }
  }
};
</script>

<template>
  <div class="mc-list-wrap">
    <div v-if="head" class="mc-list-head" aria-hidden="true">
      <span></span>
      <span></span>
      <span>{{ t('queue.file') }}</span>
      <span>{{ t('queue.kind') }}</span>
      <span class="mc-num">{{ t('queue.duration') }}</span>
      <span class="mc-num">{{ t('queue.size') }}</span>
      <span>{{ t('queue.status') }}</span>
      <span></span>
    </div>
    <ul class="mc-list">
      <li v-for="item in items" :key="item.key" class="mc-item" :class="'is-' + item.state">
        <label class="mc-check">
          <input
            type="checkbox"
            :checked="item.checked"
            :disabled="disabled || !selectable"
            :aria-label="t('queue.select').replace('%s', nameOf(item))"
            @change="emit('toggle', item.key)"
          />
        </label>
        <span class="mc-thumb" aria-hidden="true">
          <img v-if="kindOf(item) === 'image' && item.thumb" :src="item.thumb" alt="" />
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <template v-if="kindOf(item) === 'video'">
              <rect x="3" y="5" width="18" height="14" rx="2"></rect>
              <path d="m10 9 5 3-5 3z"></path>
            </template>
            <template v-else-if="kindOf(item) === 'audio'">
              <path d="M4 12v2M8 9v6M12 6v12M16 9v6M20 12v2"></path>
            </template>
            <template v-else-if="kindOf(item) === 'image'">
              <rect x="3" y="5" width="18" height="14" rx="2"></rect>
              <circle cx="9" cy="10" r="1.5"></circle>
              <path d="m21 15-5-5L5 21"></path>
            </template>
            <template v-else>
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path>
              <path d="M14 3v5h5"></path>
            </template>
          </svg>
        </span>
        <span class="mc-item-name" :title="nameOf(item)">{{ nameOf(item) }}</span>
        <span class="mc-kind">
          <span>{{ kindLabel(item) }}</span>
          <select
            v-if="showTargets && selectable"
            class="mc-select mc-row-target"
            :value="targets[item.key] || ''"
            :disabled="disabled"
            :aria-label="t('queue.rowTargetFor').replace('%s', nameOf(item))"
            @change="setTarget(item.key, $event)"
          >
            <option v-for="format in targetOptions[kindOf(item)] || []" :key="format" :value="format">
              {{ format.toUpperCase() }}
            </option>
          </select>
        </span>
        <span class="mc-num">{{ item.upload ? formatDuration(item.upload.duration) : '' }}</span>
        <span class="mc-num">{{ item.upload ? formatSize(item.upload.size) : formatSize(item.file.size) }}</span>
        <span class="mc-status">
          <span class="mc-dot" :class="'dot-' + dotOf(item)" aria-hidden="true"></span>
          <span class="mc-status-text" :title="statusOf(item)">{{ statusOf(item) }}</span>
        </span>
        <span class="mc-row-actions">
          <button type="button" class="mc-link" @click="emit('open', item.key)">{{ t('item.details') }}</button>
          <button v-if="item.result" type="button" class="mc-link" @click="emit('reveal', item.result.file)">
            {{ t('item.reveal') }}
          </button>
          <button
            type="button"
            class="mc-icon-btn"
            :disabled="disabled"
            :aria-label="t('item.remove').replace('%s', nameOf(item))"
            @click="emit('remove', item.key)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6 6 18"></path>
            </svg>
          </button>
        </span>
        <div
          v-if="item.state === 'converting'"
          class="mc-rowbar"
          :class="{ indet: item.percent === null }"
          role="progressbar"
          :aria-valuenow="item.percent ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <i :style="{ width: item.percent === null ? '38%' : Math.max(2, item.percent) + '%' }"></i>
        </div>
        <p v-if="item.error" class="mc-row-error" :title="item.error">{{ item.error }}</p>
      </li>
    </ul>
  </div>
</template>
