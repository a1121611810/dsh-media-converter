<script setup lang="ts">
// The detail screen's action surface: a scannable grid of format targets and
// single-file tools. The panel itself still lives in App, opened by selection.
interface ActionItem {
  id: string;
  group: string;
  label: string;
  hint: string;
  off?: boolean;
  keys: string;
}
interface ActionGroup {
  key: string;
  label: string;
  items: ActionItem[];
}

defineProps<{
  groups: ActionGroup[];
  selected: string;
  disabled: boolean;
  t: (key: string) => string;
}>();

const emit = defineEmits<{
  toggle: [id: string];
}>();

const ICONS: Record<string, string> = {
  trim: 'M6 3v18M18 3v18M6 8l12 8M18 8 6 16',
  'extract-audio': 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  'extract-video': 'M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4',
  subs: 'M3 5h18v14H3zM7 11h7M7 15h10',
  meta: 'M12 8h.01M11 12h1v4h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  b64: 'm8 8-4 4 4 4M16 8l4 4-4 4M13 6l-2 12',
  more: 'm6 9 6 6 6-6',
  less: 'm6 15 6-6 6 6',
};

const isFormat = (id: string): boolean => id.startsWith('fmt:');
const formatOf = (id: string): string => id.slice(4).toUpperCase();
const iconOf = (id: string): string => ICONS[id] || '';
</script>

<template>
  <div class="mc-action-groups">
    <section v-for="group in groups" :key="group.key" class="mc-group">
      <div class="mc-group-title">{{ group.label }}</div>
      <div class="mc-grid">
        <button
          v-for="item in group.items"
          :key="item.id"
          type="button"
          class="mc-tile"
          :class="{ on: selected === item.id, off: item.off }"
          :disabled="item.off || disabled"
          :title="item.off ? t('hint.noAudio') : undefined"
          @click="emit('toggle', item.id)"
        >
          <span v-if="isFormat(item.id)" class="mc-tile-badge">{{ formatOf(item.id) }}</span>
          <svg
            v-else-if="iconOf(item.id)"
            class="mc-tile-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="iconOf(item.id)"></path>
          </svg>
          <span class="mc-tile-main">
            <span class="mc-tile-label">{{ item.label }}</span>
            <span class="mc-tile-hint">{{ item.off ? t('hint.noAudio') : item.hint }}</span>
          </span>
        </button>
      </div>
    </section>
  </div>
</template>
