<script setup lang="ts">
import { computed } from 'vue';
import type { PropType } from 'vue';
import { PLATFORM, formatSize, previewUrl } from '../lib.js';
import type { ResultPayload } from '../lib.js';
import type { UploadResponse } from '../../../index.js';

const props = defineProps({
  actionId: { type: String, required: true },
  jobAction: { type: String, default: '' },
  result: { type: Object as PropType<ResultPayload | null>, default: null },
  percent: { type: Number as PropType<number | null>, default: null },
  converting: { type: Boolean, default: false },
  cancelling: { type: Boolean, default: false },
  cancelled: { type: Boolean, default: false },
  file: { type: Object as PropType<UploadResponse | null>, default: null },
  t: { type: Function as PropType<(key: string) => string>, required: true },
});

defineEmits(['cancel', 'reveal', 'again']);

// The result lives inside the panel that started it, so cause and effect stay
// in one place.
const visible = computed(
  () => props.jobAction === props.actionId && Boolean(props.result || props.converting || props.cancelled),
);

const saved = computed(() => {
  if (!props.file || !props.result || !props.result.size) return '';
  if (!(props.file.size > props.result.size)) return '';
  return props.t('compare.saved') + ' ' + Math.round((1 - props.result.size / props.file.size) * 100) + '%';
});
</script>

<template>
  <div v-if="visible" class="mc-result">
    <div v-if="converting" style="display: flex; flex-direction: column; gap: 6px">
      <div class="mc-bar" :class="{ indet: percent === null }">
        <i v-if="percent !== null" :style="{ width: Math.max(2, percent) + '%' }"></i>
      </div>
      <div class="mc-row">
        <span class="mc-muted">{{ percent === null ? t('action.converting') : percent + '%' }}</span>
        <span class="mc-grow"></span>
        <span v-if="cancelling" class="mc-muted">{{ t('action.cancelling') }}</span>
        <button v-else class="mc-btn mc-btn-ghost" @click="$emit('cancel')">{{ t('action.cancel') }}</button>
      </div>
    </div>
    <span v-if="cancelled" class="mc-muted">{{ t('action.cancelled') }}</span>

    <template v-if="result">
      <span class="mc-ok">{{ t('result.done') }}</span>
      <span v-if="result.files && result.files.length > 1" class="mc-muted">
        {{ t('result.files').replace('%s', String(result.files.length)) }}
      </span>
      <video
        v-if="result.kind === 'video'"
        class="mc-player"
        :src="previewUrl(result.file)"
        controls
        playsinline
        preload="metadata"
      ></video>
      <audio
        v-if="result.kind === 'audio'"
        :src="previewUrl(result.file)"
        controls
        preload="metadata"
        style="width: 100%"
      ></audio>
      <pre v-if="result.kind === 'text' && result.text" class="mc-pre">{{ result.text.slice(0, 4000) }}</pre>
      <span class="mc-path">{{ result.file }}</span>
      <div class="mc-row">
        <button class="mc-btn mc-btn-primary" @click="$emit('reveal', result.file)">
          {{ t('action.reveal.' + PLATFORM) }}
        </button>
        <span v-if="saved" class="mc-muted">{{ t('result.size') }}: {{ formatSize(result.size) }} · {{ saved }}</span>
        <span class="mc-grow"></span>
        <button class="mc-btn mc-btn-ghost" @click="$emit('again')">{{ t('action.again') }}</button>
      </div>
    </template>
  </div>
</template>
