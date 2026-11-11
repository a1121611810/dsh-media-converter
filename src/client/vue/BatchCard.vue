<script setup lang="ts">
// The one job card of the queue workbench: operation, target, quality, the
// optional PTC scheduler, and run/cancel. It owns no job state.
import { computed, ref, watch } from 'vue';
import type { PtcModelOption } from '../../../index.js';

type Operation = 'convert' | 'audio' | 'video';

const props = defineProps<{
  count: number;
  operation: Operation;
  usePtc: boolean;
  useGpu: boolean;
  showGpu: boolean;
  // The Host is still checking the graphics driver.
  gpuPending: boolean;
  // The backend the Host probed, e.g. "NVIDIA NVENC".
  gpuLabel: string;
  // The probed backend's HEVC sibling passed a real encode: the codec choice
  // is offered only then.
  gpuHevc: boolean;
  // The chosen GPU codec: 'h264' or 'hevc'.
  codec: string;
  models: PtcModelOption[];
  defaultModel: { provider: string; model: string; name: string } | null;
  modelKey: string;
  modelsLoading: boolean;
  modelsError: string;
  ptcAllowed: boolean;
  summary: string;
  resultText: string;
  error: string;
  running: boolean;
  progressText: string;
  progressPercent: number | null;
  canAudio: boolean;
  canVideo: boolean;
  // At least two checked rows share one media kind (video or audio): the
  // concat controls appear.
  concatable: boolean;
  disabled: boolean;
  t: (key: string) => string;
}>();

const emit = defineEmits<{
  'update:operation': [value: Operation];
  ptc: [value: boolean];
  gpu: [value: boolean];
  'update:codec': [value: string];
  'update:model-key': [value: string];
  run: [];
  cancel: [];
  concat: [how: string];
}>();

const showCopy = ref(false);
const concatHow = ref('copy');
watch(
  () => props.usePtc,
  (on) => {
    if (on) showCopy.value = true;
  },
);

const setOperation = (value: Operation) => emit('update:operation', value);
const setPtc = (event: Event) => emit('ptc', (event.target as HTMLInputElement).checked);
const setGpu = (event: Event) => emit('gpu', (event.target as HTMLInputElement).checked);
const setCodec = (event: Event) => emit('update:codec', (event.target as HTMLSelectElement).value);
// The switch names the backend the Host found, so "GPU" is never a lie about
// which encoder will run.
const gpuTitle = computed(() => props.t('batch.gpu').replace('%s', props.gpuLabel || 'GPU'));
const setModel = (event: Event) => emit('update:model-key', (event.target as HTMLSelectElement).value);
const setConcatHow = (event: Event) => {
  concatHow.value = (event.target as HTMLSelectElement).value;
};
const modelValue = (item: PtcModelOption) => item.provider + '\u0000' + item.id;
const modelGroups = computed(() => {
  const groups = new Map<string, { provider: string; label: string; items: PtcModelOption[] }>();
  for (const item of props.models) {
    const entry = groups.get(item.provider) || { provider: item.provider, label: item.providerName, items: [] };
    entry.items.push(item);
    groups.set(item.provider, entry);
  }
  return [...groups.values()];
});
const defaultLabel = computed(() => {
  const base = props.t('ptc.modelDefault');
  return props.defaultModel ? `${base}（${props.defaultModel.provider} · ${props.defaultModel.name}）` : base;
});
</script>

<template>
  <section class="mc-task" :aria-label="t('batch.title')">
    <div class="mc-task-head">
      <span class="mc-task-title">{{ t('batch.title') }}</span>
      <span class="mc-task-count">{{ t('batch.count').replace('%s', String(count)) }}</span>
    </div>

    <div class="mc-task-row">
      <div class="mc-seg" role="group" :aria-label="t('batch.operation')">
        <button
          type="button"
          :class="{ on: operation === 'convert' }"
          :aria-pressed="operation === 'convert'"
          :disabled="disabled"
          @click="setOperation('convert')"
        >
          {{ t('batch.convert') }}
        </button>
        <button
          type="button"
          :class="{ on: operation === 'audio' }"
          :aria-pressed="operation === 'audio'"
          :disabled="disabled || !canAudio"
          :title="!canAudio ? t('batch.noAudio') : undefined"
          @click="setOperation('audio')"
        >
          {{ t('batch.audio') }}
        </button>
        <button
          type="button"
          :class="{ on: operation === 'video' }"
          :aria-pressed="operation === 'video'"
          :disabled="disabled || !canVideo"
          :title="!canVideo ? t('batch.noVideo') : undefined"
          @click="setOperation('video')"
        >
          {{ t('batch.video') }}
        </button>
      </div>

      <span v-if="operation !== 'convert'" class="mc-muted mc-batch-note">
        {{ operation === 'audio' ? t('extract.note') : t('extract.visualNote') }}
      </span>
    </div>

    <p class="mc-summary" aria-live="polite">{{ summary }}</p>

    <template v-if="operation === 'convert'">
      <div class="mc-ptc-row">
        <label class="mc-check mc-ptc-check">
          <input type="checkbox" :checked="usePtc" :disabled="disabled || !ptcAllowed" @change="setPtc" />
          {{ t('ptc.label') }}
        </label>
        <button type="button" class="mc-link" @click="showCopy = !showCopy">{{ t('batch.ptcInfo') }}</button>
        <span v-if="!ptcAllowed" class="mc-hint">{{ t('batch.ptcOnlyBatch') }}</span>
        <span v-else-if="!usePtc && !showCopy" class="mc-hint">{{ t('batch.ptcOff') }}</span>
      </div>
      <div v-if="usePtc" class="mc-ptc-row mc-ptc-model">
        <label class="mc-field">
          <span>{{ t('ptc.model') }}</span>
          <select class="mc-select" :value="modelKey" :disabled="disabled || modelsLoading" @change="setModel">
            <option value="">{{ defaultLabel }}</option>
            <optgroup v-for="group in modelGroups" :key="group.provider" :label="group.label">
              <option v-for="item in group.items" :key="modelValue(item)" :value="modelValue(item)">
                {{ item.name }}
              </option>
            </optgroup>
          </select>
        </label>
        <span v-if="modelsLoading" class="mc-hint">{{ t('ptc.modelLoading') }}</span>
        <span v-else-if="modelsError" class="mc-hint">{{ t('ptc.modelFailed') }}</span>
        <span v-else class="mc-hint">{{ t('ptc.modelHint') }}</span>
      </div>
      <p v-if="showCopy" class="mc-ptc-copy">{{ t('ptc.note') }}</p>
      <div v-if="showGpu" class="mc-ptc-row">
        <label class="mc-check mc-ptc-check">
          <input type="checkbox" :checked="useGpu" :disabled="disabled" @change="setGpu" />
          {{ gpuTitle }}
        </label>
        <label v-if="useGpu && gpuHevc" class="mc-field mc-codec">
          <span>{{ t('batch.codec') }}</span>
          <select class="mc-select" :value="codec" :disabled="disabled" @change="setCodec">
            <option value="h264">H.264</option>
            <option value="hevc">HEVC</option>
          </select>
        </label>
        <span v-if="useGpu && gpuHevc" class="mc-hint">{{ t('batch.codecHint') }}</span>
        <span v-else class="mc-hint">{{ t('batch.gpuHint') }}</span>
      </div>
      <div v-else-if="gpuPending" class="mc-ptc-row">
        <span class="mc-hint">{{ t('batch.gpuDetecting') }}</span>
      </div>
      <div v-if="concatable" class="mc-ptc-row">
        <label class="mc-field">
          <span>{{ t('concat.mode') }}</span>
          <select class="mc-select" :value="concatHow" :disabled="disabled" @change="setConcatHow">
            <option value="copy">{{ t('concat.copy') }}</option>
            <option value="encode">{{ t('concat.encode') }}</option>
          </select>
        </label>
        <span class="mc-hint">{{ concatHow === 'copy' ? t('concat.copyHint') : t('concat.encodeHint') }}</span>
        <button type="button" class="mc-btn mc-btn-ghost" :disabled="disabled" @click="emit('concat', concatHow)">
          {{ t('concat.run') }}
        </button>
      </div>
    </template>

    <p v-if="error" class="mc-error" role="alert">{{ t('error.title') }}：{{ error }}</p>

    <div class="mc-task-foot">
      <div v-if="running" class="mc-batch-progress">
        <div
          class="mc-bar"
          :class="{ indet: progressPercent === null }"
          role="progressbar"
          :aria-valuenow="progressPercent ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <i :style="{ width: progressPercent === null ? '38%' : Math.max(2, progressPercent) + '%' }"></i>
        </div>
        <span>{{ progressText }}</span>
      </div>
      <span v-else-if="resultText" class="mc-batch-result" aria-live="polite">{{ resultText }}</span>
      <span class="mc-grow"></span>
      <button v-if="running" type="button" class="mc-btn mc-btn-ghost" @click="emit('cancel')">
        {{ t('batch.cancel') }}
      </button>
      <button
        v-else
        type="button"
        class="mc-btn mc-btn-primary"
        :disabled="
          disabled || count === 0 || (operation === 'audio' && !canAudio) || (operation === 'video' && !canVideo)
        "
        @click="emit('run')"
      >
        {{ t('batch.start').replace('%s', String(count)) }}
      </button>
    </div>
  </section>
</template>
