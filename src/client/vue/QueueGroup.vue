<script setup lang="ts">
// One kind section of the mixed batch queue: a labelled header with its own
// target/quality/select-all, then the shared row list.
import { computed, ref, watch } from 'vue';
import FileQueue from './FileQueue.vue';
import type { QueueRow } from '../lib.js';
import { BITRATE_OPTIONS } from '../lib.js';
import type { MediaKind } from '../../../lib/plan.js';

const props = defineProps<{
  kind: MediaKind | 'pending';
  label: string;
  items: QueueRow[];
  selectable: boolean;
  targetable: boolean;
  formatOptions: string[];
  target: string;
  targets: Record<string, string>;
  targetOptions: Record<string, string[]>;
  showTargets: boolean;
  quality: number;
  showQuality: boolean;
  bitrate: number;
  showBitrate: boolean;
  note: string;
  disabled: boolean;
  t: (key: string) => string;
}>();

const emit = defineEmits<{
  'toggle-group': [checked: boolean];
  'update:target': [value: string];
  'update:quality': [value: number];
  'update:bitrate': [value: number];
  toggle: [key: string];
  open: [key: string];
  reveal: [file: string];
  remove: [key: string];
  'update:row-target': [key: string, value: string];
  thumb: [key: string];
}>();

const box = ref<HTMLInputElement | null>(null);
const checkedCount = computed(
  () => props.items.filter((item) => Boolean((item as { checked?: boolean }).checked)).length,
);
const all = computed(() => props.selectable && props.items.length > 0 && checkedCount.value === props.items.length);
const some = computed(() => props.selectable && checkedCount.value > 0 && !all.value);
watch([all, some], () => {
  if (box.value) box.value.indeterminate = some.value;
});
const setGroup = (event: Event) => emit('toggle-group', (event.target as HTMLInputElement).checked);
const setTarget = (event: Event) => emit('update:target', (event.target as HTMLSelectElement).value);
const setRowTarget = (key: string, value: string) => emit('update:row-target', key, value);
const setQuality = (event: Event) => emit('update:quality', Number((event.target as HTMLInputElement).value));
const setBitrate = (event: Event) => emit('update:bitrate', Number((event.target as HTMLSelectElement).value));
</script>

<template>
  <section class="mc-group" :class="'kind-' + kind">
    <div class="mc-group-head">
      <label class="mc-check mc-group-check">
        <input
          ref="box"
          type="checkbox"
          :checked="all"
          :disabled="disabled || !selectable"
          :aria-label="t('queue.selectGroup').replace('%s', label)"
          @change="setGroup"
        />
        <span class="mc-group-label">{{ label }}</span>
        <span class="mc-group-count">{{ items.length }}</span>
      </label>
      <span class="mc-grow"></span>
      <label v-if="targetable" class="mc-field mc-group-target">
        <span>{{ t('queue.defaultTarget') }}</span>
        <select class="mc-select" :value="target" :disabled="disabled" @change="setTarget">
          <option v-for="option in formatOptions" :key="option" :value="option">{{ option.toUpperCase() }}</option>
        </select>
      </label>
      <label v-if="showQuality" class="mc-field mc-quality">
        <span>{{ t('batch.quality') }}</span>
        <input
          type="range"
          min="10"
          max="100"
          step="5"
          :value="quality"
          :disabled="disabled"
          :aria-label="t('batch.quality')"
          @input="setQuality"
        />
        <span class="mc-muted">{{ quality }}</span>
      </label>
      <label v-if="showBitrate" class="mc-field mc-bitrate">
        <span>{{ t('batch.bitrate') }}</span>
        <select
          class="mc-select"
          :value="bitrate"
          :disabled="disabled"
          :aria-label="t('batch.bitrate')"
          @change="setBitrate"
        >
          <option :value="0">{{ t('bitrate.default') }}</option>
          <option v-for="option in BITRATE_OPTIONS" :key="option" :value="option">{{ option }} kbps</option>
        </select>
      </label>
      <span v-if="!selectable" class="mc-hint">{{ note }}</span>
    </div>
    <FileQueue
      :items="items"
      :selectable="selectable"
      :head="false"
      :targets="targets"
      :target-options="targetOptions"
      :show-targets="showTargets"
      :disabled="disabled"
      :t="t"
      @update:target="setRowTarget"
      @toggle="emit('toggle', $event)"
      @open="emit('open', $event)"
      @reveal="emit('reveal', $event)"
      @remove="emit('remove', $event)"
      @thumb="emit('thumb', $event)"
    />
  </section>
</template>
