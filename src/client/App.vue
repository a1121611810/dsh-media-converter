<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PropType } from 'vue';
import {
  BITRATE_OPTIONS,
  CHANNEL_OPTIONS,
  CONVERTIBLE_KINDS,
  PLATFORM,
  PREVIEW_MAX,
  RATE_OPTIONS,
  TAG_KEYS,
  THUMB_MAX,
  defaultTargets,
  downloadText,
  fitPreview,
  formatClock,
  formatDuration,
  formatSize,
  isConvertible,
  jobPatch,
  previewMime,
  previewUrl,
  readJson,
  removeUploadRow,
  rowPlan,
  runItemPatch,
  sourceUrl,
  supportsAudioTune,
  supportsBitrate,
  supportsQuality,
  supportsVideoTune,
  trimWindow,
  unavailableTarget,
  withoutKnownUploads,
} from './lib.js';
import type { ConvertRequest, ConvertibleKind, DecodedPayload, QueueRow, ServerJob } from './lib.js';
import type { MediaKind, StreamMeta } from '../../lib/plan.js';
import type {
  Base64Response,
  ErrorResponse,
  HistoryDeleteResponse,
  HistoryItem,
  HistoryResponse,
  Job,
  ModelsResponse,
  PtcModelOption,
  RunInfo,
  StatusResponse,
  UploadDeleteResponse,
  UploadResponse,
} from '../../index.js';
import CompareSlider from './vue/CompareSlider.vue';
import ResultBlock from './vue/ResultBlock.vue';
import BatchCard from './vue/BatchCard.vue';
import QueueGroup from './vue/QueueGroup.vue';
import PathPicker from './vue/PathPicker.vue';
import ActionGrid from './vue/ActionGrid.vue';

const props = defineProps({
  t: { type: Function as PropType<((key: string) => string) | null>, default: null },
});
const t = (key: string): string => (props.t ? props.t(key) : key);

type View = 'queue' | 'detail' | 'history';
type Operation = 'convert' | 'audio' | 'video';
type ItemState = 'uploading' | 'ready' | 'converting' | 'cancelling' | 'cancelled' | 'done' | 'error' | 'skipped';
type Phase = 'idle' | 'uploading' | 'converting' | 'ready' | 'done';

interface Item extends QueueRow {
  state: ItemState;
  jobAction: string;
  // The server job this row is polling, so a restored page can re-attach.
  jobId: string;
}

interface ActionItem {
  id: string;
  group: string;
  label: string;
  hint: string;
  off?: boolean;
  keys: string;
}

const status = ref<StatusResponse | null>(null);
const items = ref<Item[]>([]);
const view = ref<View>('queue');
const detailKey = ref('');
const operation = ref<Operation>('convert');
const targets = ref<Record<ConvertibleKind, string>>(defaultTargets({}));
const rowTargets = ref<Record<string, string>>({});
const batchQuality = ref(90);
const batchBitrate = ref(0);
const batchChannels = ref(0);
const batchSampleRate = ref(0);
const usePtc = ref(false);
// On by default whenever the batch can use the media engine (see showGpu);
// the user can still turn it off, after which the auto-default never overrides.
const useGpu = ref(false);
let gpuTouched = false;
const onGpuToggle = (value: boolean) => {
  gpuTouched = true;
  useGpu.value = value;
};
// True while the panel waits for the Host's graphics driver check to land.
const gpuWaiting = ref(false);
const GPU_FORMATS = new Set(['mp4', 'mov', 'mkv', 'flv', 'ts']);
const ptcModels = ref<PtcModelOption[]>([]);
const ptcDefaultModel = ref<ModelsResponse['default']>(null);
const ptcModelKey = ref('');
// The live run's stage: 'planning' while the model decides formats, then
// 'converting'. Empty when no batch is running.
const runStage = ref<'' | 'planning' | 'converting'>('');
const runStartedAt = ref(0);
const planningTick = ref(0);
// Estimated wall time for the running batch (from the Host) and how long it
// has been going, so the panel can show a live "about N left".
const runEstimate = ref(0);
const runTick = ref(0);
const ptcTiming = ref<{ modelMs?: number; runMs?: number } | null>(null);
const modelsLoading = ref(false);
const modelsError = ref('');
const ptcModel = computed<{ provider: string; model: string } | null>(() => {
  const found = ptcModels.value.find((item) => item.provider + '\u0000' + item.id === ptcModelKey.value);
  return found ? { provider: found.provider, model: found.id } : null;
});
const batchError = ref('');
const detailError = ref('');
const networkError = ref('');
const restartNotice = ref(false);
const INSTANCE_KEY = 'media-toolbox-instance';

// The status payload carries a fresh id per DSH start. The first fetch only
// remembers it; a later fetch seeing a different id means DSH restarted and
// the in-memory queue is gone, so say so until the user acknowledges.
function checkRestart(data: StatusResponse): void {
  const seen = sessionStorage.getItem(INSTANCE_KEY);
  if (seen === null) {
    sessionStorage.setItem(INSTANCE_KEY, data.instanceId);
  } else if (seen !== data.instanceId) {
    restartNotice.value = true;
  }
}

function dismissRestartNotice(): void {
  sessionStorage.setItem(INSTANCE_KEY, status.value?.instanceId ?? '');
  restartNotice.value = false;
}

// The settled-jobs ledger, newest first, paged in place. Fetched on entry and
// extended from the tail; a grey row means the output file is gone.
const historyItems = ref<HistoryItem[]>([]);
const historyTotal = ref(0);
const historyLoading = ref(false);
const HISTORY_PAGE = 50;

async function loadHistory(reset: boolean): Promise<void> {
  if (historyLoading.value) return;
  historyLoading.value = true;
  try {
    const offset = reset ? 0 : historyItems.value.length;
    const data = await readJson<HistoryResponse | ErrorResponse>(
      await fetch(`/api/media-convert/history?offset=${offset}&limit=${HISTORY_PAGE}`),
    );
    if (!data.ok) throw new Error(data.error || t('error.title'));
    historyItems.value = reset ? data.items : [...historyItems.value, ...data.items];
    historyTotal.value = data.total;
  } catch {
    // A failed page keeps the rows already loaded; the next tap retries.
  } finally {
    historyLoading.value = false;
  }
}

function openHistory(): void {
  view.value = 'history';
  void loadHistory(true);
}

// Row affordances: the dot and the chip share one state class so a settled
// job reads the same in both places. Deleted files grey the whole row out.
function historyStateClass(item: HistoryItem): string {
  if (item.deleted) return 'is-gone';
  return item.state === 'done' ? 'is-done' : item.state === 'error' ? 'is-error' : 'is-cancelled';
}

function historyStateLabel(item: HistoryItem): string {
  return t(item.deleted ? 'history.deleted' : `history.state.${item.state}`);
}

// Row selection for batch delete, the file toggle, and a two-step confirm that
// doubles as the "the real file goes too" warning. Keys are the row's at:out,
// the same composite the list keys by.
const historySel = ref<Set<string>>(new Set());
const historyDeleteFiles = ref(false);
const historyConfirmKey = ref('');
const historyError = ref('');
let historyConfirmTimer: ReturnType<typeof setTimeout> | 0 = 0;

const historyKey = (item: HistoryItem): string => `${item.at}:${item.out}`;
const selectedHistory = computed(() => historyItems.value.filter((item) => historySel.value.has(historyKey(item))));
const historyAllSelected = computed(
  () => historyItems.value.length > 0 && selectedHistory.value.length === historyItems.value.length,
);

function toggleHistorySelect(item: HistoryItem, on: boolean): void {
  const next = new Set(historySel.value);
  if (on) next.add(historyKey(item));
  else next.delete(historyKey(item));
  historySel.value = next;
}

function toggleAllHistory(on: boolean): void {
  historySel.value = on ? new Set(historyItems.value.map(historyKey)) : new Set();
}

async function deleteHistory(items: HistoryItem[]): Promise<void> {
  if (!items.length) return;
  try {
    const data = await readJson<HistoryDeleteResponse | ErrorResponse>(
      await fetch('/api/media-convert/history/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: items.map(({ at, out }) => ({ at, out })),
          deleteFiles: historyDeleteFiles.value,
        }),
      }),
    );
    if (!data.ok) {
      historyError.value = data.error || t('error.title');
      return;
    }
    historyError.value = '';
    const gone = new Set(items.map(historyKey));
    historyItems.value = historyItems.value.filter((item) => !gone.has(historyKey(item)));
    historySel.value = new Set([...historySel.value].filter((key) => !gone.has(key)));
    historyTotal.value = Math.max(0, historyTotal.value - data.removed);
  } catch {
    historyError.value = t('error.title');
  }
}

function requestHistoryDelete(key: string, items: HistoryItem[]): void {
  if (historyConfirmKey.value !== key) {
    historyConfirmKey.value = key;
    clearTimeout(historyConfirmTimer);
    historyConfirmTimer = setTimeout(() => {
      historyConfirmKey.value = '';
    }, 4000);
    return;
  }
  historyConfirmKey.value = '';
  clearTimeout(historyConfirmTimer);
  void deleteHistory(items);
}

function historyConfirmLabel(): string {
  return t(historyDeleteFiles.value ? 'history.confirmFiles' : 'history.confirm');
}
const query = ref('');
const format = ref('');
const outputName = ref('');
const quality = ref(90);
const bitrate = ref(0);
const channels = ref(0);
const sampleRate = ref(0);
// Video fps/width knobs: 0 means "unset" (gif falls back to 12fps/640px,
// other video containers keep the source), sent as undefined.
const gifFps = ref(0);
const gifWidth = ref(0);
const subtitleFormat = ref('srt');
const batchGifFps = ref(0);
const batchGifWidth = ref(0);
const trimStart = ref('');
const trimEnd = ref('');
const metaTags = ref<Record<string, string>>({});
const b64 = ref<Base64Response | null>(null);
const b64Busy = ref(false);
const copied = ref(false);
const decodeInput = ref('');
const decoded = ref<DecodedPayload | null>(null);
const decodeBusy = ref(false);
const compareMode = ref<'side' | 'slider'>('side');
const livePreview = ref('');
const action = ref('');
const panelOpen = ref(false);
const moreFormats = ref(false);
const batchRunning = ref(false);
const confirmClear = ref(false);
const showPathPicker = ref(false);
const dragging = ref(false);
const runKeys = ref<string[]>([]);
const lastRun = ref<{ done: number; failed: number; skipped: number; cancelled: number } | null>(null);

const pageEl = ref<HTMLDivElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const selectAllEl = ref<HTMLInputElement | null>(null);
const mediaEl = ref<HTMLMediaElement | null>(null);

let uploadAbort: AbortController | null = null;
let currentJobId = '';
let liveTimer: ReturnType<typeof setTimeout> | 0 = 0;
let clearTimer: ReturnType<typeof setTimeout> | 0 = 0;
let stopAt: ((this: HTMLMediaElement, ev: Event) => void) | null = null;
let disposed = false;
let itemSeq = 0;
let statusError = '';
let previewToken = 0;
let liveUrl = '';

const detailItem = computed(() => items.value.find((item) => item.key === detailKey.value) || null);
const file = computed<UploadResponse | null>(() => detailItem.value?.upload || null);
const blobUrl = computed(() => detailItem.value?.url || '');
const meta = computed(() => (file.value ? file.value.meta : null));
const formatTable = computed<Record<string, string[]>>(() =>
  status.value ? (status.value.formats as Record<string, string[]>) : {},
);

const anyUploading = computed(() => items.value.some((item) => item.state === 'uploading'));
const busy = computed(
  () =>
    batchRunning.value ||
    gpuWaiting.value ||
    anyUploading.value ||
    items.value.some((item) => item.state === 'converting' || item.state === 'cancelling'),
);
const selectableRows = computed(() => items.value.filter((item) => item.upload && isConvertible(item.upload.kind)));
const selectedCount = computed(() => selectableRows.value.filter((item) => item.checked).length);
const allChecked = computed(
  () => selectableRows.value.length > 0 && selectableRows.value.every((item) => item.checked),
);
const someChecked = computed(() => selectableRows.value.some((item) => item.checked) && !allChecked.value);
const checkedItems = computed(() =>
  items.value.filter((item) => item.checked && item.upload && isConvertible(item.upload.kind)),
);
const effectiveTarget = (item: Item): string => {
  const kind = item.upload?.kind;
  if (!kind || !isConvertible(kind)) return '';
  return rowTargets.value[item.key] || targets.value[kind];
};
const rowTargetValues = computed(() => {
  const map: Record<string, string> = {};
  for (const item of selectableRows.value) map[item.key] = effectiveTarget(item);
  return map;
});
const batchTargets = computed(() => checkedItems.value.filter((item) => item.state !== 'uploading'));
const planRows = computed(() =>
  rowPlan(
    batchTargets.value.map((item) => ({ key: item.key, kind: item.upload!.kind, streams: item.upload!.streams })),
    targets.value,
    rowTargets.value,
  ),
);
const planByKey = computed(() => new Map(planRows.value.map((row) => [row.key, row])));
const audioTargets = computed(() =>
  batchTargets.value.filter((item) => item.upload!.kind === 'video' && item.upload!.streams.audio),
);
const videoTargets = computed(() => batchTargets.value.filter((item) => item.upload!.kind === 'video'));
const canAudio = computed(() => audioTargets.value.length > 0);
const canVideo = computed(() => videoTargets.value.length > 0);
const ptcAllowed = computed(() => operation.value === 'convert' && batchTargets.value.length >= 2);
// The batch holds a video whose target the GPU can encode: only then is the
// GPU switch worth showing.
const gpuRelevant = computed(
  () =>
    operation.value === 'convert' &&
    batchTargets.value.some((item) => item.upload!.kind === 'video' && GPU_FORMATS.has(effectiveTarget(item))),
);
const showGpu = computed(() => gpuRelevant.value && Boolean(status.value?.hardware?.h264));
// The Host is still checking the graphics driver: the switch waits for it.
const showGpuPending = computed(() => gpuRelevant.value && Boolean(status.value?.hardware?.detecting));
// The probed backend's HEVC sibling really encodes: only then is the codec
// choice shown.
const gpuHevc = computed(() => Boolean(status.value?.hardware?.hevc));
// The backend the Host probed (NVIDIA NVENC, Intel Quick Sync, AMD AMF, …).
const gpuLabel = computed(() => status.value?.hardware?.backendLabel || 'GPU');
// The GPU codec choice riding the batch: HEVC only makes sense with the GPU
// on. The Host whitelists the value, so a plain string is enough here.
const codec = ref('h264');
const batchSummary = computed(() => {
  const counts: Record<ConvertibleKind, number> = { video: 0, audio: 0, image: 0 };
  for (const item of batchTargets.value) {
    const kind = item.upload!.kind;
    if (isConvertible(kind)) counts[kind] += 1;
  }
  const parts = CONVERTIBLE_KINDS.filter((kind) => counts[kind]).map((kind) => `${t('kind.' + kind)} ${counts[kind]}`);
  const textCount = items.value.filter((item) => item.upload?.kind === 'text').length;
  if (textCount) parts.push(`${t('kind.text')} ${textCount} ${t('batch.notConvert')}`);
  return parts.length ? parts.join(' · ') : t('batch.none');
});
const QUEUE_ORDER = ['pending', 'video', 'audio', 'image', 'text'] as const;
interface QueueSection {
  key: string;
  kind: MediaKind | 'pending';
  label: string;
  items: Item[];
  selectable: boolean;
  targetable: boolean;
  formatOptions: string[];
  target: string;
  targets: Record<string, string>;
  targetOptions: Record<string, string[]>;
  showTargets: boolean;
  showQuality: boolean;
  showBitrate: boolean;
  showAudioTune: boolean;
  showVideoTune: boolean;
  note: string;
}
const queueGroups = computed<QueueSection[]>(() => {
  const buckets: Record<string, Item[]> = { pending: [], video: [], audio: [], image: [], text: [] };
  for (const item of items.value) {
    const kind = item.upload?.kind;
    const key = kind === 'video' || kind === 'audio' || kind === 'image' || kind === 'text' ? kind : 'pending';
    buckets[key].push(item);
  }
  return QUEUE_ORDER.flatMap((key) => {
    const groupItems = buckets[key];
    if (!groupItems.length) return [];
    const media = key === 'pending' ? null : (key as MediaKind);
    const convertible = media && isConvertible(media) ? media : null;
    return [
      {
        key,
        kind: media || 'pending',
        label: key === 'pending' ? t('queue.pending') : t('kind.' + key),
        items: groupItems,
        selectable: Boolean(convertible),
        targetable: Boolean(convertible) && operation.value === 'convert',
        formatOptions: convertible ? formatTable.value[convertible] || [] : [],
        target: convertible ? targets.value[convertible] : '',
        targets: rowTargetValues.value,
        targetOptions: formatTable.value,
        showTargets: Boolean(convertible) && operation.value === 'convert',
        showQuality: Boolean(
          convertible &&
          operation.value === 'convert' &&
          groupItems.some((item) => supportsQuality(convertible, effectiveTarget(item))),
        ),
        showBitrate: Boolean(
          convertible &&
          operation.value === 'convert' &&
          groupItems.some((item) => supportsBitrate(convertible, effectiveTarget(item))),
        ),
        showAudioTune: Boolean(
          convertible &&
          operation.value === 'convert' &&
          groupItems.some((item) => supportsAudioTune(convertible, effectiveTarget(item))),
        ),
        showVideoTune: Boolean(
          convertible === 'video' &&
          operation.value === 'convert' &&
          groupItems.some((item) => supportsVideoTune(convertible, effectiveTarget(item))),
        ),
        note: key === 'pending' ? t('queue.pendingNote') : key === 'text' ? t('queue.textNoBatch') : '',
      },
    ];
  });
});
const batchResultText = computed(() => {
  const run = lastRun.value;
  if (!run) return '';
  const parts: string[] = [];
  if (run.done) parts.push(`${t('item.done')} ${run.done}`);
  if (run.failed) parts.push(`${t('item.failed')} ${run.failed}`);
  if (run.skipped) parts.push(`${t('item.skipped')} ${run.skipped}`);
  if (run.cancelled) parts.push(`${t('item.cancelled')} ${run.cancelled}`);
  const timing = ptcTiming.value;
  if (timing && (timing.modelMs !== undefined || timing.runMs !== undefined)) {
    parts.push(
      t('batch.timing')
        .replace('%s', ((timing.modelMs || 0) / 1000).toFixed(1))
        .replace('%s', ((timing.runMs || 0) / 1000).toFixed(1)),
    );
  }
  return parts.join(' · ');
});
const finishedRunCount = computed(
  () =>
    runKeys.value.filter((key) => {
      const item = items.value.find((candidate) => candidate.key === key);
      return item && ['done', 'error', 'skipped', 'cancelled'].includes(item.state);
    }).length,
);
const batchProgressText = computed(() => {
  if (!batchRunning.value) return '';
  if (runStage.value === 'planning') return t('ptc.planning').replace('%s', String(planningTick.value));
  const text = t('batch.running')
    .replace('%s', String(finishedRunCount.value))
    .replace('%s', String(runKeys.value.length));
  const remaining = Math.round(runEstimate.value / 1000) - runTick.value;
  return remaining > 0 ? text + ' · ' + t('batch.eta').replace('%s', formatClock(remaining)) : text;
});
const batchProgressPercent = computed(() => {
  if (!batchRunning.value || runStage.value === 'planning' || !runKeys.value.length) {
    return null;
  }
  return Math.round((finishedRunCount.value / runKeys.value.length) * 100);
});

const detailSaved = computed(() => {
  const item = detailItem.value;
  if (!item?.result || !item.upload || item.upload.size <= item.result.size) return 0;
  return Math.min(99, Math.round((1 - item.result.size / item.upload.size) * 100));
});
const phase = computed<Phase>(() => {
  const item = detailItem.value;
  if (!item) return 'idle';
  if (item.state === 'uploading') return 'uploading';
  if (item.state === 'converting' || item.state === 'cancelling') return 'converting';
  if (item.state === 'done') return 'done';
  return 'ready';
});
const result = computed(() => detailItem.value?.result || null);
const percent = computed(() => detailItem.value?.percent ?? null);
const jobAction = computed(() => detailItem.value?.jobAction || '');
const cancelling = computed(() => detailItem.value?.state === 'cancelling');
const cancelled = computed(() => detailItem.value?.state === 'cancelled');
const viewError = computed(() => detailError.value || detailItem.value?.error || '');

const formats = computed(() => (file.value ? formatTable.value[file.value.kind] || [] : []));
const trim = computed(() => trimWindow({ file: file.value, trimStart: trimStart.value, trimEnd: trimEnd.value, t }));
const trimSummary = computed(() =>
  trim.value.error
    ? ''
    : trim.value.active
      ? formatClock(trim.value.start) +
        ' – ' +
        formatClock(trim.value.end) +
        ' · ' +
        formatClock(trim.value.end - trim.value.start)
      : t('trim.full') + (file.value && file.value.duration ? ' ' + formatClock(file.value.duration) : ''),
);
const usesQuality = computed(() =>
  Boolean(file.value && format.value && supportsQuality(file.value.kind, format.value)),
);
const usesBitrate = computed(() =>
  Boolean(file.value && format.value && supportsBitrate(file.value.kind, format.value)),
);
const usesAudioTune = computed(() =>
  Boolean(file.value && format.value && supportsAudioTune(file.value.kind, format.value)),
);
// Video targets carry the fps/width controls; gif just happens to be one.
const usesVideoTune = computed(() =>
  Boolean(file.value && format.value && supportsVideoTune(file.value.kind, format.value)),
);
const canExtractAudio = computed(() =>
  Boolean(file.value && file.value.kind === 'video' && file.value.streams && file.value.streams.audio),
);
const canExtractVideo = computed(() =>
  Boolean(file.value && file.value.kind === 'video' && file.value.streams && file.value.streams.video),
);
const afterSrc = computed(() =>
  result.value && result.value.kind === 'image' ? previewUrl(result.value.file) : livePreview.value,
);
const afterLabel = computed(() =>
  result.value && result.value.kind === 'image'
    ? t('compare.after') + ' · ' + formatSize(result.value.size)
    : livePreview.value
      ? t('compare.live') +
        ' · ' +
        (format.value ? format.value.toUpperCase() : '') +
        (usesQuality.value ? ' ' + quality.value : '')
      : t('compare.slot'),
);

const joinParts = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
const typeLabel = (type: string) =>
  t('meta.type.' + (['video', 'audio', 'subtitle', 'data', 'attachment'].includes(type) ? type : 'data'));
const describeStream = (stream: StreamMeta) =>
  joinParts([
    stream.codec + (stream.profile ? ' ' + stream.profile : ''),
    stream.tag,
    stream.width ? stream.width + '×' + stream.height! : '',
    stream.pixFmt,
    stream.aspect ? 'SAR ' + stream.aspect : '',
    stream.displayAspect ? 'DAR ' + stream.displayAspect : '',
    stream.fps ? stream.fps + ' fps' : '',
    stream.sampleRate ? stream.sampleRate + ' Hz' : '',
    stream.channels,
    stream.sampleFmt,
    stream.bitrate ? stream.bitrate + ' kb/s' : '',
    stream.language,
    stream.tags && stream.tags.title ? '“' + stream.tags.title + '”' : '',
    ...(stream.flags || []),
  ]);

const containerRows = computed(() =>
  meta.value
    ? [
        [t('meta.container'), meta.value.format || '—'],
        [
          t('meta.duration'),
          meta.value.duration ? formatClock(meta.value.duration) + ' · ' + meta.value.duration.toFixed(2) + 's' : '—',
        ],
        [t('meta.bitrate'), meta.value.bitrate ? meta.value.bitrate + ' kb/s' : '—'],
        [t('meta.size'), formatSize(file.value!.size) || '—'],
        [t('meta.start'), (meta.value.start || 0).toFixed(3) + ' s'],
      ]
    : [],
);
const trackRows = computed(() =>
  meta.value
    ? meta.value.streams.map((stream) => ['#' + stream.index + ' ' + typeLabel(stream.type), describeStream(stream)])
    : [],
);
const chapterRows = computed(() =>
  meta.value && meta.value.chapters.length
    ? meta.value.chapters.map((chapter, index) => [
        t('meta.chapter') + ' ' + (index + 1),
        joinParts([chapter.tags.title, formatClock(chapter.start) + ' – ' + formatClock(chapter.end)]),
      ])
    : [],
);
const tagRows = computed(() => (meta.value ? Object.entries(meta.value.tags) : []));

const actions = computed(() => {
  const list: ActionItem[] = [];
  const searching = query.value.trim().length > 0;
  const showAll = moreFormats.value || searching;
  const popular = formats.value.slice(0, 4);
  const extra = formats.value.slice(4);
  for (const f of showAll ? formats.value : popular) {
    list.push({
      id: 'fmt:' + f,
      group: 'convert',
      label: t('action.toFormat').replace('%s', f.toUpperCase()),
      hint: t('hint.' + f),
      off: unavailableTarget(file.value, f),
      keys: f,
    });
  }
  if (extra.length && !searching) {
    list.push(
      moreFormats.value
        ? { id: 'less', group: 'convert', label: t('action.less'), hint: '', keys: '' }
        : {
            id: 'more',
            group: 'convert',
            label: t('action.moreFormats'),
            hint: t('action.moreFormatsCount').replace('%s', String(extra.length)),
            keys: 'format',
          },
    );
  }
  if (file.value && (file.value.kind === 'video' || file.value.kind === 'audio')) {
    list.push({
      id: 'trim',
      group: 'edit',
      label: t('action.trim'),
      hint: t('trim.full') + ' ' + formatClock(file.value.duration || 0),
      keys: 'trim cut 裁剪',
    });
  }
  if (canExtractAudio.value)
    list.push({
      id: 'extract-audio',
      group: 'edit',
      label: t('action.extractAudio'),
      hint: t('extract.note'),
      keys: 'extract audio 音轨',
    });
  if (canExtractVideo.value)
    list.push({
      id: 'extract-video',
      group: 'edit',
      label: t('action.extractVideo'),
      hint: t('extract.note'),
      keys: 'extract video 画面',
    });
  if (meta.value && meta.value.subtitles.length)
    list.push({
      id: 'subs',
      group: 'view',
      label: t('action.subs'),
      hint: meta.value.subtitles.length + ' 条',
      keys: 'subtitle srt 字幕',
    });
  if (file.value && file.value.kind !== 'text' && file.value.kind !== 'file') {
    list.push({
      id: 'meta',
      group: 'view',
      label: t('action.meta'),
      hint: joinParts([
        meta.value ? meta.value.video && meta.value.video.codec : '',
        meta.value ? meta.value.audio && meta.value.audio.codec : '',
      ]),
      keys: 'metadata info 元数据',
    });
  }
  list.push({ id: 'b64', group: 'view', label: t('action.b64'), hint: '', keys: 'base64 编码' });
  return list;
});
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle ? actions.value.filter((a) => (a.label + ' ' + a.keys).toLowerCase().includes(needle)) : actions.value;
});
const GROUP_DEFS: [string, string, string][] = [
  ['convert', 'group.convert', '⇄'],
  ['edit', 'group.edit', '✂'],
  ['view', 'group.view', '☰'],
];
const groups = computed(() => {
  const order = status.value?.groups ?? GROUP_DEFS.map(([key]) => key);
  return order
    .map((key) => GROUP_DEFS.find(([defKey]) => defKey === key))
    .filter((def): def is [string, string, string] => Boolean(def))
    .map(([key, labelKey, icon]) => [key, t(labelKey), icon]);
});
const itemsOf = (key: string) => visible.value.filter((item) => item.group === key);
const currentAction = computed(() => visible.value.find((item) => item.id === action.value) || null);
const gridGroups = computed(() =>
  groups.value.map(([key, label]) => ({ key, label, items: itemsOf(key) })).filter((group) => group.items.length),
);

// The toolbox setting: keep the queue across page close/reopen. When on, the
// queue is rebuilt from the server — uploads and jobs are the single source of
// truth, so every mount (first load, a rebuilt page, a second window) shows the
// same files and the same running jobs. When off the page behaves as before.
const persistOn = computed(() => status.value?.persistState === true);

interface ServerQueueItem {
  upload: UploadResponse;
  job: ServerJob | null;
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void loadServerQueue();
}

// Rebuild the queue from the server. Rows keep their identity (and their
// checked state) when the same upload is already on screen, so a poll that is
// already driving a row is never replaced under it. The browser File is gone,
// so previews stream from /source.
async function loadServerQueue() {
  if (!persistOn.value) return;
  let list: ServerQueueItem[] = [];
  try {
    const data = await readJson<{ ok: true; items: ServerQueueItem[] } | ErrorResponse>(
      await fetch('/api/media-convert/queue'),
    );
    if (!data.ok) return;
    list = data.items;
  } catch {
    return;
  }
  if (disposed) return;
  const current = items.value.slice();
  const known = new Map(current.filter((i) => i.upload).map((i) => [i.upload!.id, i]));
  const seen = new Set<string>();
  const next: Item[] = [];
  for (const { upload, job } of list) {
    seen.add(upload.id);
    const prev = known.get(upload.id);
    if (prev) {
      prev.upload = markRaw(upload);
      applyServerJob(prev, job);
      next.push(prev);
    } else {
      next.push(serverRow(upload, job));
    }
  }
  // A row the server does not know yet is still uploading, so it keeps its
  // place instead of flickering away mid-upload.
  for (const item of current) if (!item.upload || !seen.has(item.upload.id)) next.push(item);
  items.value = next;
  ensureTargets();
  await restoreRun();
  // A row attached to a single job (the detail page's convert) polls that job
  // itself; batch rows are already driven by the run record above.
  for (const item of items.value) {
    if ((item.state === 'converting' || item.state === 'cancelling') && !runUploads.has(item.upload?.id || '')) {
      void resumeItem(item);
    }
  }
}

// The batch the Host is walking for the page that started it. A rebuilt page
// restores its rows and summary from this record, so switching sessions or
// closing the panel does not reset the batch to "ready".
let activeRunId = '';
let runUploads = new Set<string>();
const runPolls = new Set<string>();

async function restoreRun() {
  let run: RunInfo | null = null;
  try {
    const data = await readJson<{ ok: true; run: RunInfo | null } | ErrorResponse>(
      await fetch('/api/media-convert/run'),
    );
    if (!data.ok) return;
    run = data.run;
  } catch {
    return;
  }
  // Only a live run is restored: a finished one is already reflected in the
  // per-row jobs /queue returned, and re-applying it could overwrite a newer
  // conversion the user started afterwards.
  if (disposed || !run || run.state !== 'running') return;
  applyRun(run);
  void pollRun(run.id);
}

// One server run -> the rows on screen. `waiting` items are the batch's queue,
// which the panel shows as "ready" just like a file that has not started.
function applyRun(run: RunInfo): void {
  const byUpload = new Map(items.value.filter((i) => i.upload).map((i) => [i.upload!.id, i]));
  runUploads = new Set(run.items.map((item) => item.id));
  const keys: string[] = [];
  for (const entry of run.items) {
    const row = byUpload.get(entry.id);
    if (!row) continue;
    keys.push(row.key);
    const patch = runItemPatch(entry);
    row.state = patch.state as ItemState;
    row.percent = patch.percent;
    // A skipped row's reason is a locale key the panel wrote when it handed
    // the batch over, so it reads in the user's language after a rebuild.
    row.error = entry.state === 'skipped' && patch.error ? t(patch.error) : patch.error;
    if (patch.result !== undefined) row.result = patch.result;
    row.jobAction = patch.jobAction;
    if (entry.jobId) row.jobId = entry.jobId;
  }
  if (run.state === 'running') {
    activeRunId = run.id;
    batchRunning.value = true;
    runKeys.value = keys;
    runStage.value = run.stage === 'planning' ? 'planning' : run.kind === 'ptc' ? 'converting' : '';
    runStartedAt.value = run.at;
    // The planning line and the ETA count seconds; assigning the same number
    // would not re-render, so a changed tick is what keeps them alive.
    planningTick.value = Math.max(0, Math.round((Date.now() - run.at) / 1000));
    runTick.value = planningTick.value;
    runEstimate.value = run.estimatedMs || 0;
    return;
  }
  activeRunId = '';
  batchRunning.value = false;
  runStage.value = '';
  runEstimate.value = 0;
  runTick.value = 0;
  if (run.kind === 'ptc' && (run.modelMs !== undefined || run.runMs !== undefined)) {
    ptcTiming.value = { modelMs: run.modelMs, runMs: run.runMs };
  }
  if (run.error) batchError.value = run.error;
  const count = (state: string) => run.items.filter((item) => item.state === state).length;
  lastRun.value = {
    done: count('done'),
    failed: count('error'),
    skipped: count('skipped'),
    cancelled: count('cancelled'),
  };
}

async function pollRun(id: string): Promise<void> {
  if (runPolls.has(id)) return;
  runPolls.add(id);
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (disposed || activeRunId !== id) return;
      let data: { ok: true; run: RunInfo | null } | ErrorResponse;
      try {
        data = await readJson<{ ok: true; run: RunInfo | null } | ErrorResponse>(
          await fetch('/api/media-convert/run?id=' + encodeURIComponent(id)),
        );
      } catch {
        continue; // a missed poll is fine; the next one catches up
      }
      if (!data.ok || !data.run) return;
      applyRun(data.run);
      if (data.run.state !== 'running') return;
    }
  } finally {
    runPolls.delete(id);
  }
}

function serverRow(upload: UploadResponse, job: ServerJob | null): Item {
  const patch = job ? jobPatch('converting', job) : null;
  return {
    key: 'i' + ++itemSeq,
    file: null,
    url: sourceUrl(upload.id),
    thumb: '',
    checked: upload.kind !== 'text',
    upload: markRaw(upload),
    state: (patch?.state as ItemState) || 'ready',
    percent: patch?.percent ?? null,
    result: patch?.result ?? null,
    error: patch?.error || '',
    jobAction: '',
    jobId: patch?.jobId || '',
  };
}

// Merge one server job into a row that is already on screen. A running job
// always wins; a finished one only rewrites a row that was itself mid-run, so
// a row the user reset never gets its old result back.
function applyServerJob(item: Item, job: ServerJob | null): void {
  if (!job) return;
  const patch = jobPatch(item.state, job);
  if (!patch) return;
  item.state = patch.state as ItemState;
  item.percent = patch.percent ?? null;
  if (patch.error !== undefined) item.error = patch.error;
  if (patch.result !== undefined) item.result = patch.result;
  if (patch.jobId) item.jobId = patch.jobId;
}

// A row attached to a running server job: keep polling it and apply the same
// terminal mapping runCurrent would. A 404 means the job is gone (DSH
// restarted, TTL), so the row falls back to ready.
const activePolls = new Set<string>();

async function resumeItem(item: Item) {
  if (!item.jobId || activePolls.has(item.jobId)) return;
  const jobId = item.jobId;
  activePolls.add(jobId);
  currentJobId = jobId;
  try {
    const job = await pollJob(jobId, (value) => {
      item.percent = value;
    });
    if (job.state === 'error') {
      item.state = 'error';
      item.error = job.error || t('error.title');
      item.percent = null;
    } else if (job.state === 'cancelled') {
      item.state = 'cancelled';
      item.percent = null;
    } else {
      item.result = { file: job.out, size: job.size, kind: job.kind, copy: job.copy, hardware: job.hardware };
      item.state = 'done';
      item.percent = 100;
    }
  } catch {
    item.state = 'ready';
    item.percent = null;
    item.error = '';
  } finally {
    item.jobId = '';
    activePolls.delete(jobId);
    if (currentJobId) currentJobId = '';
  }
}

async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    const data = await readJson<StatusResponse | ErrorResponse>(await fetch('/api/media-convert/status'));
    if (!data.ok) {
      statusError = data.error || '';
      return null;
    }
    statusError = '';
    status.value = data;
    networkError.value = '';
    checkRestart(data);
    return data;
  } catch {
    statusError = '';
    return null;
  }
}

async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    const data = await readJson<ModelsResponse | ErrorResponse>(await fetch('/api/media-convert/models'));
    if (!data.ok) throw new Error(data.error || t('error.title'));
    ptcModels.value = data.models;
    ptcDefaultModel.value = data.default;
  } catch (err) {
    modelsError.value = String((err && (err as Error).message) || err);
  } finally {
    modelsLoading.value = false;
  }
}

async function loadStatusWithRetry() {
  let attempt = 0;
  for (;;) {
    const data = await fetchStatus();
    if (disposed) return;
    if (!data) {
      // The Host is not answering yet: try again, a little slower each time.
      attempt += 1;
      if (attempt >= 9) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 400 * attempt)));
      continue;
    }
    // The graphics driver check runs in the background; ask again until it
    // lands, so the GPU switch shows up as soon as it is known.
    if (!data.hardware.detecting) break;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (!disposed && !status.value) {
    networkError.value = statusError ? t('error.service').replace('%s', statusError) : t('error.network');
  }
}

// Wait for the graphics driver check to land. The Host times the check out
// on its own, so this ends either way.
async function waitForGpu(): Promise<void> {
  for (let i = 0; i < 20 && showGpuPending.value; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (disposed) return;
    const data = await fetchStatus();
    if (!data) return;
  }
}

function ensureTargets() {
  const defaults = defaultTargets(formatTable.value);
  for (const kind of CONVERTIBLE_KINDS) {
    if (!(formatTable.value[kind] || []).includes(targets.value[kind])) targets.value[kind] = defaults[kind];
  }
}

function setTarget(kind: ConvertibleKind, value: string) {
  if (!(formatTable.value[kind] || []).includes(value)) return;
  targets.value[kind] = value;
  for (const item of items.value) {
    if (item.upload && isConvertible(item.upload.kind) && item.upload.kind === kind) {
      rowTargets.value[item.key] = value;
    }
  }
  lastRun.value = null;
  ptcTiming.value = null;
}

function setRowTarget(key: string, value: string) {
  const item = items.value.find((candidate) => candidate.key === key);
  if (!item?.upload || !isConvertible(item.upload.kind)) return;
  if (!(formatTable.value[item.upload.kind] || []).includes(value)) return;
  rowTargets.value[key] = value;
  lastRun.value = null;
  ptcTiming.value = null;
}

function toggleGroup(group: QueueSection, checked: boolean) {
  if (!group.selectable || busy.value) return;
  for (const item of group.items) item.checked = checked;
  lastRun.value = null;
}

function makeItem(picked: File): Item {
  itemSeq += 1;
  return {
    key: 'i' + itemSeq,
    file: picked,
    url: URL.createObjectURL(picked),
    thumb: '',
    checked: true,
    upload: null,
    state: 'uploading',
    percent: null,
    result: null,
    jobAction: '',
    jobId: '',
    error: '',
  };
}

// Decode, downscale and encode off the main thread. The old toDataURL path
// froze the panel for 177-461 ms on a 24 MP picture; createImageBitmap and
// convertToBlob do the same work on worker threads.
async function encodeImage(blob: Blob, max: number, type: string, quality: number): Promise<Blob> {
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitPreview(full.width, full.height, max);
    const small =
      width === full.width && height === full.height
        ? full
        : await createImageBitmap(full, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(small.width, small.height);
    canvas.getContext('2d')!.drawImage(small, 0, 0);
    if (small !== full) small.close();
    return canvas.convertToBlob({ type, quality });
  } finally {
    full.close();
  }
}

let thumbChain: Promise<unknown> = Promise.resolve();
// Rows the list reported as visible, and rows whose thumbnail is already being
// decoded. A few hundred files would otherwise decode every image up front.
const visibleThumbs = new Set<string>();
const queuedThumbs = new Set<string>();

// The queue shows a 36px thumbnail; decoding the full picture for it keeps a
// 96 MB bitmap per row alive. One decode at a time keeps a big drop safe.
function queueThumb(item: Item) {
  if (!item.file || item.thumb || queuedThumbs.has(item.key)) return;
  queuedThumbs.add(item.key);
  thumbChain = thumbChain
    .then(async () => {
      if (disposed || !item.file || !items.value.some((row) => row.key === item.key)) return;
      try {
        const url = URL.createObjectURL(await encodeImage(item.file, THUMB_MAX, 'image/webp', 0.8));
        if (disposed || !items.value.some((row) => row.key === item.key)) {
          URL.revokeObjectURL(url);
          return;
        }
        item.thumb = url;
      } catch {
        /* no decoder for this format: the row keeps its kind icon */
      }
    })
    .catch(() => {})
    .finally(() => queuedThumbs.delete(item.key));
}

// The list asks for a thumbnail when a row comes near the viewport. The upload
// may still be in flight; the flag lets it queue the decode once it lands.
function requestThumb(key: string) {
  visibleThumbs.add(key);
  const item = items.value.find((row) => row.key === key);
  if (item && item.file && item.upload?.kind === 'image') queueThumb(item);
}

const INGEST_CHUNK = 40;

// A few hundred rows must not mount in one long task: push them in slices
// across frames so the panel stays interactive while the list fills in.
async function pushRows(rows: Item[]) {
  for (let index = 0; index < rows.length; index += INGEST_CHUNK) {
    if (disposed) return;
    items.value.push(...rows.slice(index, index + INGEST_CHUNK));
    if (index + INGEST_CHUNK < rows.length) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  }
}
const UPLOAD_WORKERS = 3;

async function addFiles(picked: File[]) {
  if (!picked.length || busy.value) return;
  batchError.value = '';
  if (!status.value) await fetchStatus();
  const added = picked.map(makeItem);
  await pushRows(added);
  // Mutate the reactive proxies from the array, not the raw objects pushed in:
  // assigning to the raw copies would update the data but never re-render.
  const created = items.value.slice(-added.length);
  const controller = new AbortController();
  uploadAbort = controller;
  const uploadOne = async (item: Item) => {
    const file = item.file;
    if (!file || controller.signal.aborted) {
      removeItem(item.key, true);
      return;
    }
    try {
      const data = await readJson<UploadResponse | ErrorResponse>(
        await fetch('/api/media-convert/upload?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          body: file,
          signal: controller.signal,
        }),
      );
      if (!data.ok) throw new Error(data.error || t('error.title'));
      // The Host's answer is read-only; keeping it raw avoids a deep reactive
      // proxy (meta/streams/tags) for every one of a few hundred rows.
      item.upload = markRaw(data);
      item.state = 'ready';
      if (data.kind === 'image' && visibleThumbs.has(item.key)) requestThumb(item.key);
      if (data.kind === 'text') item.checked = false;
    } catch (err) {
      if (controller.signal.aborted) removeItem(item.key, true);
      else {
        item.state = 'error';
        item.error = String((err && (err as Error).message) || err);
      }
    }
  };
  // Each upload waits on a server-side ffmpeg probe, so a serial loop turns a
  // few hundred files into a long minute of nothing. Three at a time is safe.
  const pending = created.slice();
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_WORKERS, pending.length) }, async () => {
      for (;;) {
        const item = pending.shift();
        if (!item || controller.signal.aborted) return;
        await uploadOne(item);
      }
    }),
  );
  if (uploadAbort === controller) uploadAbort = null;
  ensureTargets();
}

// Rows registered by path: the Host probed the original file, so there is no
// browser File and no upload. Pushed in the same slices as a picked batch.
async function addRegistered(uploads: UploadResponse[]) {
  showPathPicker.value = false;
  // Re-adding a folder returns the records already in the queue; one row per
  // upload id, or the same files would be converted twice.
  const fresh = withoutKnownUploads(items.value, uploads);
  if (!fresh.length) return;
  const added: Item[] = fresh.map((upload) => ({
    key: 'i' + ++itemSeq,
    file: null,
    url: sourceUrl(upload.id),
    // The row shows a 36px picture; streaming a 24 MP original there would
    // decode it at full size. Big images keep the kind icon instead.
    thumb: upload.kind === 'image' && upload.size <= 512 * 1024 ? sourceUrl(upload.id) : '',
    checked: upload.kind !== 'text',
    upload: markRaw(upload),
    state: 'ready',
    percent: null,
    result: null,
    error: '',
    jobAction: '',
    jobId: '',
  }));
  await pushRows(added);
  ensureTargets();
}

function cancelUploads() {
  if (uploadAbort) uploadAbort.abort();
}

async function removeItem(key: string, force = false) {
  if (busy.value && !force) return;
  const item = items.value.find((entry) => entry.key === key);
  if (!item) return;
  // 移除 also drops the Host record: the row only goes away once the Host
  // agreed, so a rebuilt page cannot resurrect it. The removal itself lives
  // in removeUploadRow, which re-reads the live list after the await.
  const serverDelete =
    !force && item.upload
      ? async (id: string) =>
          readJson<UploadDeleteResponse | ErrorResponse>(
            await fetch('/api/media-convert/upload/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: [id] }),
            }),
          )
      : null;
  const result = await removeUploadRow(() => items.value, key, serverDelete);
  if (result.error) {
    batchError.value = result.error;
    return;
  }
  if (result.skipped) {
    batchError.value = t('remove.running');
    return;
  }
  if (!result.removed) return; // a racing second click already took it
  items.value = result.rows;
  delete rowTargets.value[key];
  visibleThumbs.delete(key);
  queuedThumbs.delete(key);
  URL.revokeObjectURL(result.removed.url);
  if (result.removed.thumb) URL.revokeObjectURL(result.removed.thumb);
  if (detailKey.value === key) {
    detailKey.value = '';
    view.value = 'queue';
  }
  if (!items.value.length) {
    lastRun.value = null;
    confirmClear.value = false;
  }
  ensureTargets();
}

async function clearQueue() {
  if (busy.value) return;
  if (!confirmClear.value) {
    confirmClear.value = true;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      confirmClear.value = false;
    }, 3000);
    return;
  }
  confirmClear.value = false;
  clearTimeout(clearTimer);
  // Same deal as removeItem: the Host records go with the rows, except the
  // ones a running job still reads — those rows stay.
  const ids = items.value.flatMap((item) => (item.upload ? [item.upload.id] : []));
  const skipped = new Set<string>();
  if (ids.length) {
    try {
      const data = await readJson<UploadDeleteResponse | ErrorResponse>(
        await fetch('/api/media-convert/upload/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids }),
        }),
      );
      if (!data.ok) throw new Error(data.error || t('error.title'));
      for (const id of data.skipped) skipped.add(id);
    } catch (err) {
      batchError.value = String((err && (err as Error).message) || err);
      return;
    }
  }
  const kept = items.value.filter((item) => item.upload && skipped.has(item.upload.id));
  const keptKeys = new Set(kept.map((item) => item.key));
  for (const item of items.value) {
    if (keptKeys.has(item.key)) continue;
    URL.revokeObjectURL(item.url);
    if (item.thumb) URL.revokeObjectURL(item.thumb);
  }
  items.value = kept;
  for (const key of Object.keys(rowTargets.value)) if (!keptKeys.has(key)) delete rowTargets.value[key];
  detailKey.value = '';
  view.value = 'queue';
  batchError.value = skipped.size ? t('remove.running') : '';
  lastRun.value = null;
}

function toggleChecked(key: string) {
  if (busy.value) return;
  const item = items.value.find((candidate) => candidate.key === key);
  if (!item || !item.upload || !isConvertible(item.upload.kind)) return;
  item.checked = !item.checked;
  lastRun.value = null;
}

function toggleAll() {
  if (busy.value) return;
  const next = !allChecked.value;
  selectableRows.value.forEach((item) => {
    item.checked = next;
  });
  lastRun.value = null;
}

function scrollTop() {
  nextTick(() => {
    if (pageEl.value) pageEl.value.scrollTop = 0;
  });
}

function initDetail(item: Item) {
  detailError.value = '';
  query.value = '';
  action.value = '';
  panelOpen.value = false;
  moreFormats.value = false;
  format.value = item.upload ? formatTable.value[item.upload.kind]?.[0] || '' : '';
  outputName.value = (item.upload?.name || item.file?.name || 'output').replace(/\.[^.]*$/, '');
  trimStart.value = '';
  trimEnd.value = '';
  gifFps.value = 0;
  gifWidth.value = 0;
  subtitleFormat.value = 'srt';
  metaTags.value = Object.fromEntries(
    TAG_KEYS.map((key) => [key, (item.upload?.meta?.tags && item.upload.meta.tags[key]) || '']),
  );
  b64.value = null;
  decoded.value = null;
  decodeInput.value = '';
  copied.value = false;
  compareMode.value = 'side';
  livePreview.value = '';
}

function openDetail(key: string) {
  const item = items.value.find((candidate) => candidate.key === key);
  if (!item) return;
  detailKey.value = key;
  view.value = 'detail';
  initDetail(item);
  scrollTop();
}

function backToQueue() {
  view.value = 'queue';
  detailKey.value = '';
  scrollTop();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollJob(id: string, onPercent: (value: number) => void): Promise<Job> {
  for (;;) {
    await sleep(500);
    const data = await readJson<(Job & { ok: true }) | ErrorResponse>(
      await fetch('/api/media-convert/job?id=' + encodeURIComponent(id)),
    );
    if (!data.ok) throw new Error(data.error || t('error.title'));
    if (data.percent !== null) onPercent(data.percent);
    if (data.state === 'done' || data.state === 'error' || data.state === 'cancelled') return data;
  }
}

async function postConvert(id: string, body: Record<string, unknown>): Promise<Job> {
  const data = await readJson<{ ok: true; job: Job } | ErrorResponse>(
    await fetch('/api/media-convert/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    }),
  );
  if (!data.ok) throw new Error(data.error || t('error.title'));
  currentJobId = data.job.id;
  return data.job;
}

function cancelRun() {
  if (!currentJobId) return;
  fetch('/api/media-convert/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: currentJobId }),
  }).catch(() => {});
}

function cancelBatch() {
  if (activeRunId) {
    // The run keeps the id: its next poll reports the cancelled rows.
    fetch('/api/media-convert/run/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: activeRunId }),
    }).catch(() => {});
    return;
  }
  cancelRun();
}

function summarizeRun() {
  const stateOf = (key: string) => items.value.find((item) => item.key === key)?.state;
  return {
    done: runKeys.value.filter((key) => stateOf(key) === 'done').length,
    failed: runKeys.value.filter((key) => stateOf(key) === 'error').length,
    skipped: runKeys.value.filter((key) => stateOf(key) === 'skipped').length,
    cancelled: runKeys.value.filter((key) => stateOf(key) === 'cancelled').length,
  };
}

// Hand the checked batch to the Host. The browser no longer walks the files:
// the run keeps converting after this panel is closed or replaced, and its
// record is what every later page instance restores from. A PTC run is the
// same shape — the Host asks the model for the plan and executes it in groups.
async function runServerBatch(rows: Item[], ptc = false) {
  const audioKeys = new Set(audioTargets.value.map((item) => item.key));
  const videoKeys = new Set(videoTargets.value.map((item) => item.key));
  const items = rows.map((item) => {
    const id = item.upload!.id;
    if (operation.value === 'audio') {
      return audioKeys.has(item.key)
        ? { id, mode: 'extract-audio' }
        : { id, skip: true, reason: item.upload!.kind === 'video' ? 'hint.noAudio' : 'batch.notApplicable' };
    }
    if (operation.value === 'video') {
      return videoKeys.has(item.key)
        ? { id, mode: 'extract-video' }
        : { id, skip: true, reason: 'batch.notApplicable' };
    }
    const row = planByKey.value.get(item.key);
    if (!row || row.error) return { id, skip: true, reason: row?.error || '' };
    return {
      id,
      format: row.target,
      quality: supportsQuality(item.upload!.kind, row.target) ? batchQuality.value : undefined,
      bitrate: supportsBitrate(item.upload!.kind, row.target) ? batchBitrate.value || undefined : undefined,
      channels: supportsAudioTune(item.upload!.kind, row.target) ? batchChannels.value || undefined : undefined,
      sampleRate: supportsAudioTune(item.upload!.kind, row.target) ? batchSampleRate.value || undefined : undefined,
      fps: supportsVideoTune(item.upload!.kind, row.target) ? batchGifFps.value || undefined : undefined,
      width: supportsVideoTune(item.upload!.kind, row.target) ? batchGifWidth.value || undefined : undefined,
      hardware: useGpu.value || undefined,
      codec: useGpu.value ? codec.value : undefined,
    };
  });
  let run: RunInfo;
  try {
    const data = await readJson<{ ok: true; run: RunInfo } | ErrorResponse>(
      await fetch('/api/media-convert/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items,
          quality: batchQuality.value,
          hardware: useGpu.value || undefined,
          ...(ptc ? { ptc: true, model: ptcModel.value || undefined } : {}),
        }),
      }),
    );
    if (!data.ok) throw new Error(data.error || t('error.title'));
    run = data.run;
  } catch (err) {
    batchError.value = String((err && (err as Error).message) || err);
    return;
  }
  applyRun(run);
  await pollRun(run.id);
}

async function startBatch() {
  if (busy.value || !batchTargets.value.length) return;
  // The backend is not known yet: wait for the driver check instead of
  // quietly converting on the CPU.
  if (showGpuPending.value) {
    gpuWaiting.value = true;
    try {
      await waitForGpu();
    } finally {
      gpuWaiting.value = false;
    }
    if (busy.value || disposed) return;
  }
  batchError.value = '';
  lastRun.value = null;
  ptcTiming.value = null;
  const rows = batchTargets.value.slice();
  const ptc = operation.value === 'convert' && usePtc.value && rows.length >= 2;
  runKeys.value = rows.map((item) => item.key);
  batchRunning.value = true;
  rows.forEach((item) => {
    item.result = null;
    item.error = '';
    item.percent = null;
    item.state = 'ready';
    item.jobAction = '';
  });
  try {
    await runServerBatch(rows, ptc);
  } finally {
    batchRunning.value = false;
    runStage.value = '';
    currentJobId = '';
    lastRun.value = summarizeRun();
  }
}

async function runCurrent(body: Partial<ConvertRequest>, forAction: string) {
  const item = detailItem.value;
  if (!item || !item.upload || busy.value) return;
  detailError.value = '';
  item.error = '';
  item.result = null;
  item.percent = null;
  item.state = 'converting';
  item.jobAction = forAction;
  try {
    await postConvert(item.upload.id, { name: outputName.value.trim() || undefined, ...body });
    item.jobId = currentJobId;
    activePolls.add(currentJobId);
    const job = await pollJob(currentJobId, (value) => {
      item.percent = value;
    });
    if (job.state === 'error') throw new Error(job.error || t('error.title'));
    if (job.state === 'cancelled') {
      item.state = 'cancelled';
      item.percent = null;
      return;
    }
    item.result = { file: job.out, size: job.size, kind: job.kind, copy: job.copy, hardware: job.hardware };
    item.state = 'done';
    item.percent = 100;
  } catch (err) {
    item.state = 'error';
    item.error = String((err && (err as Error).message) || err);
  } finally {
    activePolls.delete(item.jobId || currentJobId);
    currentJobId = '';
    item.jobId = '';
  }
}

function convert() {
  if (!file.value || !format.value) return;
  const withQuality = usesQuality.value;
  runCurrent(
    {
      format: format.value,
      quality: withQuality ? quality.value : undefined,
      bitrate: usesBitrate.value ? bitrate.value || undefined : undefined,
      channels: usesAudioTune.value ? channels.value || undefined : undefined,
      sampleRate: usesAudioTune.value ? sampleRate.value || undefined : undefined,
      fps: usesVideoTune.value ? gifFps.value || undefined : undefined,
      width: usesVideoTune.value ? gifWidth.value || undefined : undefined,
    },
    'fmt:' + format.value,
  );
}

function applyTrim() {
  const window = trim.value;
  if (window.error) {
    detailError.value = window.error;
    return;
  }
  if (!window.active) {
    detailError.value = t('trim.full');
    return;
  }
  if (!file.value) return;
  runCurrent(
    {
      format: format.value,
      quality: file.value.kind === 'image' ? quality.value : undefined,
      bitrate: usesBitrate.value ? bitrate.value || undefined : undefined,
      channels: usesAudioTune.value ? channels.value || undefined : undefined,
      sampleRate: usesAudioTune.value ? sampleRate.value || undefined : undefined,
      fps: usesVideoTune.value ? gifFps.value || undefined : undefined,
      width: usesVideoTune.value ? gifWidth.value || undefined : undefined,
      trim: { start: window.start, end: window.end },
    },
    'trim',
  );
}

function extract(which: 'audio' | 'video') {
  if (!file.value) return;
  runCurrent({ mode: which === 'audio' ? 'extract-audio' : 'extract-video' }, 'extract-' + which);
}

function resetResult() {
  const item = detailItem.value;
  if (!item || busy.value) return;
  item.result = null;
  item.percent = null;
  item.error = '';
  item.state = 'ready';
  detailError.value = '';
}

async function reveal(target: string) {
  try {
    const data = await readJson<{ ok: true } | ErrorResponse>(
      await fetch('/api/media-convert/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: target }),
      }),
    );
    if (!data.ok) {
      const message = data.error || t('error.title');
      if (view.value === 'detail') detailError.value = message;
      else batchError.value = message;
    }
  } catch (err) {
    const message = String((err && (err as Error).message) || err);
    if (view.value === 'detail') detailError.value = message;
    else batchError.value = message;
  }
}

function setTrimFromPlayer(which: 'start' | 'end') {
  const el = mediaEl.value;
  if (!el) return;
  const value = String(Math.round((el.currentTime || 0) * 10) / 10);
  resetResult();
  if (which === 'start') trimStart.value = value;
  else trimEnd.value = value;
}

function playSelection() {
  const el = mediaEl.value;
  if (!el) return;
  const window = trim.value;
  if (window.error) return;
  const start = window.active ? window.start : 0;
  const end = window.active ? window.end : el.duration || 0;
  if (stopAt) el.removeEventListener('timeupdate', stopAt);
  const stop = () => {
    if (el.currentTime >= end - 0.03) {
      el.pause();
      el.removeEventListener('timeupdate', stop);
      stopAt = null;
    }
  };
  stopAt = stop;
  el.currentTime = start;
  el.play().catch(() => {});
  el.addEventListener('timeupdate', stop);
}

async function toBase64() {
  if (!file.value) return;
  b64Busy.value = true;
  detailError.value = '';
  try {
    const data = await readJson<Base64Response | ErrorResponse>(
      await fetch('/api/media-convert/base64', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: file.value.id }),
      }),
    );
    if (!data.ok) throw new Error(data.error || t('error.title'));
    b64.value = data;
  } catch (err) {
    detailError.value = String((err && (err as Error).message) || err);
  } finally {
    b64Busy.value = false;
  }
}

async function decode() {
  decodeBusy.value = true;
  detailError.value = '';
  decoded.value = null;
  try {
    const data = await readJson<DecodedPayload | ErrorResponse>(
      await fetch('/api/media-convert/decode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: decodeInput.value }),
      }),
    );
    if (!data.ok) throw new Error(data.error || t('error.title'));
    decoded.value = data;
  } catch (err) {
    detailError.value = String((err && (err as Error).message) || err);
  } finally {
    decodeBusy.value = false;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    detailError.value = '复制失败，请手动选择文本';
  }
}

function openPicker() {
  if (busy.value) return;
  if (inputEl.value) inputEl.value.click();
}

function onPick(event: Event) {
  const el = event.target as HTMLInputElement;
  const picked = el.files ? [...el.files] : [];
  el.value = '';
  addFiles(picked);
}

function onDragOver() {
  if (view.value !== 'queue' || busy.value) return;
  dragging.value = true;
}

function onDragLeave() {
  dragging.value = false;
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (view.value !== 'queue' || busy.value) return;
  const picked = event.dataTransfer ? [...event.dataTransfer.files] : [];
  if (picked.length) addFiles(picked);
}

function closePanel() {
  action.value = '';
  panelOpen.value = false;
}

function openPanel(id: string) {
  action.value = id;
  panelOpen.value = true;
}

function toggleAction(id: string) {
  if (id === 'more') {
    moreFormats.value = true;
    return;
  }
  if (id === 'less') {
    moreFormats.value = false;
    return;
  }
  if (id.startsWith('fmt:')) format.value = id.slice(4);
  if (action.value === id) closePanel();
  else openPanel(id);
}

function onSearchKey(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    const first = visible.value.find((item) => !item.off);
    if (first) toggleAction(first.id);
  } else if (event.key === 'Escape') {
    (event.currentTarget as HTMLInputElement).blur();
  }
}

function onWindowKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
    if (view.value !== 'detail') return;
    event.preventDefault();
    if (searchEl.value) searchEl.value.focus();
    return;
  }
  if (event.key === 'Escape' && view.value === 'detail') {
    query.value = '';
    if (action.value) closePanel();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKey);
  document.addEventListener('visibilitychange', onVisibilityChange);
  loadStatusWithRetry();
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('keydown', onWindowKey);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  clearTimeout(liveTimer);
  clearTimeout(clearTimer);
  if (uploadAbort) uploadAbort.abort();
  if (stopAt && mediaEl.value) mediaEl.value.removeEventListener('timeupdate', stopAt);
  previewToken++;
  releaseLive();
  items.value.forEach((item) => {
    URL.revokeObjectURL(item.url);
    if (item.thumb) URL.revokeObjectURL(item.thumb);
  });
});

watch(
  () => detailItem.value?.upload,
  (upload) => {
    if (!upload || view.value !== 'detail') return;
    if (!format.value) format.value = formatTable.value[upload.kind]?.[0] || '';
    if (!outputName.value) outputName.value = upload.name.replace(/\.[^.]*$/, '');
    if (!Object.values(metaTags.value).some(Boolean)) {
      metaTags.value = Object.fromEntries(TAG_KEYS.map((key) => [key, upload.meta?.tags?.[key] || '']));
    }
  },
);

watch([status, () => detailItem.value?.upload], () => {
  if (view.value === 'detail' && file.value && !format.value) format.value = formats.value[0] || '';
});

watch([allChecked, someChecked], () => {
  if (selectAllEl.value) selectAllEl.value.indeterminate = someChecked.value;
});

watch(status, () => ensureTargets(), { immediate: true });

// Once the status arrives the panel knows whether persistence is on: rebuild
// the queue from the server, or leave the page as a plain workbench.
watch(status, (data) => {
  if (data?.persistState === true) void loadServerQueue();
});

watch(
  () => batchTargets.value.length,
  (count) => {
    if (usePtc.value && count < 2) usePtc.value = false;
  },
);

watch([operation, batchQuality, batchBitrate, usePtc, useGpu], () => {
  if (!batchRunning.value) lastRun.value = null;
  ptcTiming.value = null;
});
watch(
  targets,
  () => {
    if (!batchRunning.value) lastRun.value = null;
  },
  { deep: true },
);
watch(showGpu, (on) => {
  if (!on) useGpu.value = false;
  else if (!gpuTouched) useGpu.value = true;
});
watch(usePtc, (on) => {
  if (on && !ptcModels.value.length && !modelsLoading.value) void loadModels();
});

watch([view, detailKey], () => {
  scrollTop();
});

function releaseLive() {
  if (liveUrl) URL.revokeObjectURL(liveUrl);
  liveUrl = '';
  livePreview.value = '';
}

watch([file, format, quality], () => {
  clearTimeout(liveTimer);
  const picked = detailItem.value?.file;
  if (!picked || !file.value || file.value.kind !== 'image' || !format.value) {
    previewToken++; // a render still in flight must not land on the empty state
    releaseLive();
    return;
  }
  const token = ++previewToken;
  liveTimer = setTimeout(async () => {
    try {
      const blob = await encodeImage(
        picked,
        PREVIEW_MAX,
        previewMime(format.value),
        Math.min(1, Math.max(0.05, quality.value / 100)),
      );
      if (token !== previewToken) return;
      const previous = liveUrl;
      liveUrl = URL.createObjectURL(blob);
      livePreview.value = liveUrl;
      // Swap the <img> src before dropping the old URL, or it briefly breaks.
      await nextTick();
      if (previous) URL.revokeObjectURL(previous);
    } catch {
      if (token === previewToken) releaseLive();
    }
  }, 120);
});

watch([action, panelOpen], async () => {
  if (!action.value || !panelOpen.value) return;
  await nextTick();
  const el = document.querySelector('.mc-panel');
  if (!el) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }), 190);
});
</script>

<template>
  <div ref="pageEl" class="mc-page">
    <div v-if="networkError" class="mc-warn">{{ networkError }}</div>
    <div v-if="status && !status.ffmpegPath" class="mc-warn">{{ t('error.noffmpeg') }}</div>
    <div v-if="restartNotice" class="mc-warn">
      {{ t('restart.banner') }}
      <button type="button" class="mc-warn-dismiss" @click="dismissRestartNotice">
        {{ t('restart.dismiss') }}
      </button>
    </div>

    <template v-if="view === 'queue'">
      <div class="mc-head">
        <h2 class="mc-title">{{ t('page.title') }}</h2>
        <p class="mc-sub">{{ t('page.subtitle') }}</p>
        <div class="mc-tools">
          <button type="button" class="mc-btn mc-btn-ghost" @click="openHistory">{{ t('history.open') }}</button>
        </div>
      </div>

      <div class="mc-queue" @dragover.prevent="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop">
        <div v-if="!items.length" class="mc-empty" :class="{ over: dragging }" @click="openPicker">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="5" width="18" height="14" rx="2"></rect>
            <path d="M7 9h4M7 13h7M17 9l2 2-2 2"></path>
          </svg>
          <p class="mc-empty-title">{{ t('queue.emptyTitle') }}</p>
          <p class="mc-empty-hint">{{ t('queue.emptyHint') }}</p>
          <button type="button" class="mc-btn mc-btn-primary" @click.stop="openPicker">{{ t('queue.choose') }}</button>
          <button type="button" class="mc-btn mc-btn-ghost" @click.stop="showPathPicker = true">
            {{ t('queue.fromPath') }}
          </button>
          <p class="mc-empty-privacy">{{ t('queue.privacy') }}</p>
        </div>

        <template v-else>
          <div class="mc-toolbar">
            <label class="mc-check">
              <input ref="selectAllEl" type="checkbox" :checked="allChecked" :disabled="busy" @change="toggleAll" />
              {{ t('queue.all') }}
            </label>
            <span class="mc-muted">{{
              t('queue.selected').replace('%s', String(selectedCount)).replace('%s', String(items.length))
            }}</span>
            <span class="mc-grow"></span>
            <button v-if="anyUploading" type="button" class="mc-btn mc-btn-ghost" @click="cancelUploads">
              {{ t('queue.cancelUpload') }}
            </button>
            <button type="button" class="mc-btn mc-btn-ghost" :disabled="busy" @click="openPicker">
              {{ t('queue.add') }}
            </button>
            <button type="button" class="mc-btn mc-btn-ghost" :disabled="busy" @click="showPathPicker = true">
              {{ t('queue.fromPath') }}
            </button>
            <button
              type="button"
              class="mc-btn mc-btn-ghost"
              :class="{ 'mc-btn-danger': confirmClear }"
              :disabled="busy"
              @click="clearQueue"
            >
              {{ confirmClear ? t('queue.confirmClear') : t('queue.clear') }}
            </button>
          </div>

          <BatchCard
            v-model:operation="operation"
            :use-ptc="usePtc"
            :use-gpu="useGpu"
            :show-gpu="showGpu"
            :gpu-pending="showGpuPending"
            :gpu-label="gpuLabel"
            :gpu-hevc="gpuHevc"
            v-model:codec="codec"
            :models="ptcModels"
            :default-model="ptcDefaultModel"
            :model-key="ptcModelKey"
            :models-loading="modelsLoading"
            :models-error="modelsError"
            :count="batchTargets.length"
            :ptc-allowed="ptcAllowed"
            :summary="batchSummary"
            :result-text="batchResultText"
            :error="batchError"
            :running="batchRunning"
            :progress-text="batchProgressText"
            :progress-percent="batchProgressPercent"
            :can-audio="canAudio"
            :can-video="canVideo"
            :disabled="busy"
            :t="t"
            @ptc="usePtc = $event"
            @gpu="onGpuToggle"
            @update:model-key="ptcModelKey = $event"
            @run="startBatch"
            @cancel="cancelBatch"
          />

          <div class="mc-list-wrap">
            <div class="mc-list-head" aria-hidden="true">
              <span></span>
              <span></span>
              <span>{{ t('queue.file') }}</span>
              <span>{{ t('queue.kind') }}</span>
              <span class="mc-num">{{ t('queue.duration') }}</span>
              <span class="mc-num">{{ t('queue.size') }}</span>
              <span>{{ t('queue.status') }}</span>
              <span></span>
            </div>
            <QueueGroup
              v-for="group in queueGroups"
              :key="group.key"
              :kind="group.kind"
              :label="group.label"
              :items="group.items"
              :selectable="group.selectable"
              :targetable="group.targetable"
              :format-options="group.formatOptions"
              :target="group.target"
              :targets="group.targets"
              :target-options="group.targetOptions"
              :show-targets="group.showTargets"
              :quality="batchQuality"
              :show-quality="group.showQuality"
              :bitrate="batchBitrate"
              :show-bitrate="group.showBitrate"
              :channels="batchChannels"
              :sample-rate="batchSampleRate"
              :show-audio-tune="group.showAudioTune"
              :gif-fps="batchGifFps"
              :gif-width="batchGifWidth"
              :show-video-tune="group.showVideoTune"
              :note="group.note"
              :disabled="busy"
              :t="t"
              @toggle-group="toggleGroup(group, $event)"
              @update:target="group.kind !== 'pending' && setTarget(group.kind as ConvertibleKind, $event)"
              @update:row-target="setRowTarget"
              @update:quality="batchQuality = $event"
              @update:bitrate="batchBitrate = $event"
              @update:channels="batchChannels = $event"
              @update:sample-rate="batchSampleRate = $event"
              @update:gif-fps="batchGifFps = $event"
              @update:gif-width="batchGifWidth = $event"
              @toggle="toggleChecked"
              @open="openDetail"
              @reveal="reveal"
              @thumb="requestThumb"
              @remove="removeItem"
            />
          </div>

          <div v-if="dragging" class="mc-drop-overlay">{{ t('queue.dropNow') }}</div>
        </template>
      </div>
    </template>

    <template v-else-if="view === 'history'">
      <div class="mc-head">
        <div class="mc-tools">
          <button type="button" class="mc-btn mc-btn-ghost" @click="view = 'queue'">{{ t('history.back') }}</button>
          <h2 class="mc-title">{{ t('history.title') }}</h2>
        </div>
        <p class="mc-sub">{{ t('history.subtitle') }}</p>
      </div>

      <div v-if="!historyItems.length && !historyLoading" class="mc-history-empty">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
        <p class="mc-sub">{{ t('history.empty') }}</p>
      </div>

      <template v-else>
        <div class="mc-history-bar">
          <label class="mc-history-check">
            <input
              type="checkbox"
              :checked="historyAllSelected"
              @change="toggleAllHistory(($event.target as HTMLInputElement).checked)"
            />
            {{ t('history.selectAll') }}
          </label>
          <label class="mc-history-check">
            <input v-model="historyDeleteFiles" type="checkbox" />
            {{ t('history.deleteFiles') }}
          </label>
          <span class="mc-grow"></span>
          <button
            type="button"
            class="mc-btn mc-btn-ghost"
            :class="{ 'mc-btn-danger': historyConfirmKey === 'batch' }"
            :disabled="!selectedHistory.length"
            @click="requestHistoryDelete('batch', selectedHistory)"
          >
            {{
              historyConfirmKey === 'batch'
                ? historyConfirmLabel()
                : `${t('history.deleteSelected')} (${selectedHistory.length})`
            }}
          </button>
        </div>
        <p v-if="historyError" class="mc-history-err">{{ historyError }}</p>

        <ul class="mc-history">
          <li v-for="item in historyItems" :key="`${item.at}:${item.out}`" class="mc-history-row">
            <input
              type="checkbox"
              class="mc-history-check"
              :checked="historySel.has(`${item.at}:${item.out}`)"
              @change="toggleHistorySelect(item, ($event.target as HTMLInputElement).checked)"
            />
            <span class="mc-history-dot" :class="historyStateClass(item)" aria-hidden="true"></span>
            <div class="mc-history-main">
              <div class="mc-history-top">
                <span class="mc-history-name" :title="item.name">{{ item.name }}</span>
                <span class="mc-history-chip" :class="historyStateClass(item)">{{ historyStateLabel(item) }}</span>
              </div>
              <div class="mc-history-meta">
                <span class="mc-history-out" :title="item.out">{{ item.out }}</span>
                <span>{{ formatSize(item.size) }}</span>
                <span aria-hidden="true">·</span>
                <span>{{ new Date(item.at).toLocaleString() }}</span>
              </div>
              <div v-if="!item.deleted && item.error" class="mc-history-err" :title="item.error">
                {{ item.error }}
              </div>
            </div>
            <div class="mc-history-actions">
              <template v-if="!item.deleted">
                <a :href="previewUrl(item.out)" target="_blank" rel="noopener">{{ t('history.preview') }}</a>
                <button type="button" @click="reveal(item.out)">{{ t('history.reveal') }}</button>
              </template>
              <button
                type="button"
                :class="{ 'mc-btn-danger': historyConfirmKey === `${item.at}:${item.out}` }"
                @click="requestHistoryDelete(`${item.at}:${item.out}`, [item])"
              >
                {{ historyConfirmKey === `${item.at}:${item.out}` ? historyConfirmLabel() : t('history.delete') }}
              </button>
            </div>
          </li>
        </ul>
      </template>
      <button
        v-if="historyItems.length < historyTotal"
        type="button"
        class="mc-btn mc-btn-ghost mc-history-more"
        :disabled="historyLoading"
        @click="loadHistory(false)"
      >
        {{ t('history.loadMore') }}
      </button>
    </template>

    <template v-else-if="detailItem">
      <div class="mc-detail-head">
        <button type="button" class="mc-back" @click="backToQueue">← {{ t('detail.back') }}</button>
        <span class="mc-grow"></span>
        <span v-if="file" class="mc-tag">{{ t('kind.' + file.kind) }}</span>
      </div>

      <div class="mc-detail-title">
        <h2 class="mc-detail-name" :title="detailItem.upload?.name || detailItem.file?.name">
          {{ detailItem.upload?.name || detailItem.file?.name }}
        </h2>
        <p class="mc-sub">
          {{
            [
              file ? formatSize(file.size) : formatSize(detailItem.file?.size || 0),
              file ? formatDuration(file.duration) : '',
            ]
              .filter(Boolean)
              .join(' · ')
          }}
        </p>
      </div>

      <div v-if="detailItem.result" class="mc-recent">
        <span>{{ t('detail.recent') }}</span>
        <span>{{ formatSize(detailItem.result.size) }}</span>
        <span v-if="detailSaved" class="mc-muted">-{{ detailSaved }}%</span>
        <button type="button" class="mc-link" @click="reveal(detailItem.result.file)">{{ t('item.reveal') }}</button>
      </div>

      <div v-if="!file && detailItem.state === 'uploading'" class="mc-warn">{{ t('item.uploading') }}</div>
      <div v-if="viewError" class="mc-error">{{ t('error.title') }}：{{ viewError }}</div>

      <template v-if="file && blobUrl">
        <video
          v-if="file.kind === 'video'"
          ref="mediaEl"
          class="mc-player"
          :src="blobUrl"
          controls
          playsinline
          preload="metadata"
        ></video>
        <audio
          v-else-if="file.kind === 'audio'"
          ref="mediaEl"
          :src="blobUrl"
          controls
          preload="metadata"
          style="width: 100%"
        ></audio>
        <template v-else-if="file.kind === 'image'">
          <div class="mc-tools" style="justify-content: flex-end">
            <span class="mc-muted">{{ t('compare.mode') }}</span>
            <button
              class="mc-toggle"
              :class="{ on: compareMode === 'side' }"
              :aria-pressed="compareMode === 'side'"
              @click="compareMode = 'side'"
            >
              {{ t('compare.side') }}
            </button>
            <button
              class="mc-toggle"
              :class="{ on: compareMode === 'slider' }"
              :aria-pressed="compareMode === 'slider'"
              @click="compareMode = 'slider'"
            >
              {{ t('compare.slider') }}
            </button>
          </div>
          <CompareSlider
            v-if="compareMode === 'slider' && afterSrc"
            :before="blobUrl"
            :after="afterSrc"
            :left-label="t('compare.before') + ' · ' + formatSize(file.size)"
            :right-label="afterLabel"
          />
          <div v-else class="mc-compare">
            <figure class="mc-fig">
              <img :src="blobUrl" alt="" decoding="async" />
              <figcaption class="mc-cap">{{ t('compare.before') }} · {{ formatSize(file.size) }}</figcaption>
            </figure>
            <figure class="mc-fig">
              <img v-if="afterSrc" :key="afterSrc" :src="afterSrc" alt="" decoding="async" />
              <div v-else class="mc-fig-ph">
                {{
                  phase === 'converting'
                    ? t('action.converting') + (percent === null ? '' : ' ' + percent + '%')
                    : t('compare.pending')
                }}
              </div>
              <figcaption class="mc-cap">{{ afterLabel }}</figcaption>
            </figure>
          </div>
        </template>
      </template>

      <template v-if="file">
        <div class="mc-search">
          <span class="mc-muted">⌘</span>
          <input
            ref="searchEl"
            v-model="query"
            :placeholder="t('search.placeholder')"
            :aria-label="t('search.placeholder')"
            @keydown="onSearchKey"
          />
          <span
            class="mc-muted"
            style="font-size: 11px; border: 1px solid currentColor; border-radius: 5px; padding: 0 6px"
            >⌘K</span
          >
        </div>

        <ActionGrid
          v-if="visible.length"
          :groups="gridGroups"
          :selected="action"
          :t="t"
          :disabled="busy"
          @toggle="toggleAction"
        />
        <p v-else class="mc-muted mc-empty-actions">{{ t('act.empty') }}</p>

        <template v-if="currentAction">
          <div class="mc-panel">
            <template v-if="currentAction.id.startsWith('fmt:')">
              <div class="mc-row">
                <span class="mc-muted">{{ t('name.label') }}</span>
                <input
                  class="mc-name-input"
                  v-model="outputName"
                  :disabled="busy"
                  :placeholder="String(file.name || '').replace(/\.[^.]*$/, '')"
                  :aria-label="t('name.label')"
                />
                <span class="mc-muted">{{ format ? '.' + format : '' }}</span>
              </div>
              <div v-if="usesQuality && currentAction.id === 'fmt:' + format" class="mc-row">
                <span class="mc-muted">{{ t('quality.label') }}</span>
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="5"
                  v-model.number="quality"
                  :disabled="busy"
                  :aria-label="t('quality.label')"
                  @input="resetResult"
                />
                <span class="mc-muted">{{ quality }}</span>
                <span class="mc-muted">{{ t('quality.hint') }}</span>
              </div>
              <div v-if="usesBitrate && currentAction.id === 'fmt:' + format" class="mc-row">
                <span class="mc-muted">{{ t('bitrate.label') }}</span>
                <select
                  class="mc-select"
                  v-model.number="bitrate"
                  :disabled="busy"
                  :aria-label="t('bitrate.label')"
                  @change="resetResult"
                >
                  <option :value="0">{{ t('bitrate.default') }}</option>
                  <option v-for="option in BITRATE_OPTIONS" :key="option" :value="option">{{ option }} kbps</option>
                </select>
              </div>
              <div v-if="usesAudioTune && currentAction.id === 'fmt:' + format" class="mc-row">
                <span class="mc-muted">{{ t('audio.channels') }}</span>
                <select
                  class="mc-select"
                  v-model.number="channels"
                  :disabled="busy"
                  :aria-label="t('audio.channels')"
                  @change="resetResult"
                >
                  <option :value="0">{{ t('bitrate.default') }}</option>
                  <option v-for="option in CHANNEL_OPTIONS" :key="option" :value="option">
                    {{ option === 1 ? t('audio.mono') : t('audio.stereo') }}
                  </option>
                </select>
                <span class="mc-muted">{{ t('audio.rate') }}</span>
                <select
                  class="mc-select"
                  v-model.number="sampleRate"
                  :disabled="busy"
                  :aria-label="t('audio.rate')"
                  @change="resetResult"
                >
                  <option :value="0">{{ t('bitrate.default') }}</option>
                  <option v-for="option in RATE_OPTIONS" :key="option" :value="option">{{ option }} Hz</option>
                </select>
              </div>
              <div v-if="usesVideoTune && currentAction.id === 'fmt:' + format" class="mc-row">
                <span class="mc-muted">{{ t('gif.fps') }}</span>
                <input
                  class="mc-name-input"
                  style="width: 64px"
                  type="number"
                  min="1"
                  max="30"
                  v-model.number="gifFps"
                  :disabled="busy"
                  :placeholder="'12'"
                  :aria-label="t('gif.fps')"
                  @input="resetResult"
                />
                <span class="mc-muted">{{ t('gif.width') }}</span>
                <input
                  class="mc-name-input"
                  style="width: 72px"
                  type="number"
                  min="16"
                  v-model.number="gifWidth"
                  :disabled="busy"
                  :placeholder="'640'"
                  :aria-label="t('gif.width')"
                  @input="resetResult"
                />
                <span class="mc-muted">{{ format === 'gif' ? t('gif.hint') : t('video.tuneHint') }}</span>
              </div>
              <div class="mc-row">
                <button
                  class="mc-btn mc-btn-primary"
                  :disabled="busy || unavailableTarget(file, format)"
                  @click="convert"
                >
                  {{ t('action.convert') }}
                </button>
              </div>
              <ResultBlock
                :action-id="currentAction.id"
                :job-action="jobAction"
                :result="result"
                :percent="percent"
                :converting="phase === 'converting'"
                :cancelling="cancelling"
                :cancelled="cancelled"
                :file="file"
                :t="t"
                @cancel="cancelRun"
                @reveal="reveal"
                @again="resetResult"
              />
            </template>

            <template v-else-if="currentAction.id === 'trim'">
              <div class="mc-row">
                <span class="mc-muted">{{ t('trim.start') }}</span>
                <input
                  class="mc-time"
                  v-model="trimStart"
                  :disabled="busy"
                  inputmode="decimal"
                  placeholder="0:00"
                  :aria-label="t('trim.start')"
                  @input="resetResult"
                />
                <span class="mc-muted">{{ t('trim.end') }}</span>
                <input
                  class="mc-time"
                  v-model="trimEnd"
                  :disabled="busy"
                  inputmode="decimal"
                  :placeholder="file.duration ? formatClock(file.duration) : '0:00'"
                  :aria-label="t('trim.end')"
                  @input="resetResult"
                />
                <span class="mc-grow"></span>
                <span :class="trim.error ? 'mc-error' : 'mc-muted'">{{ trim.error || trimSummary }}</span>
              </div>
              <div class="mc-tools">
                <button class="mc-btn mc-btn-ghost" :disabled="busy" @click="setTrimFromPlayer('start')">
                  {{ t('trim.setStart') }}
                </button>
                <button class="mc-btn mc-btn-ghost" :disabled="busy" @click="setTrimFromPlayer('end')">
                  {{ t('trim.setEnd') }}
                </button>
                <button class="mc-btn mc-btn-ghost" :disabled="busy || Boolean(trim.error)" @click="playSelection">
                  {{ t('trim.play') }}
                </button>
              </div>
              <div class="mc-row">
                <span class="mc-muted">{{ t('hint.formats') }}</span>
                <select class="mc-select" v-model="format" :disabled="busy">
                  <option v-for="f in formats" :key="f" :value="f" :disabled="unavailableTarget(file, f)">
                    {{ f.toUpperCase() }}
                  </option>
                </select>
                <button
                  class="mc-btn mc-btn-primary"
                  :disabled="busy || Boolean(trim.error) || !trim.active || unavailableTarget(file, format)"
                  @click="applyTrim"
                >
                  {{ t('trim.apply') }}
                </button>
              </div>
              <ResultBlock
                :action-id="currentAction.id"
                :job-action="jobAction"
                :result="result"
                :percent="percent"
                :converting="phase === 'converting'"
                :cancelling="cancelling"
                :cancelled="cancelled"
                :file="file"
                :t="t"
                @cancel="cancelRun"
                @reveal="reveal"
                @again="resetResult"
              />
            </template>

            <template v-else-if="currentAction.id === 'extract-audio' || currentAction.id === 'extract-video'">
              <div class="mc-row">
                <span class="mc-muted">{{ t('name.label') }}</span>
                <input
                  class="mc-name-input"
                  v-model="outputName"
                  :disabled="busy"
                  :placeholder="String(file.name || '').replace(/\.[^.]*$/, '')"
                  :aria-label="t('name.label')"
                />
              </div>
              <div class="mc-row">
                <button
                  class="mc-btn mc-btn-primary"
                  :disabled="busy"
                  @click="extract(currentAction.id === 'extract-audio' ? 'audio' : 'video')"
                >
                  {{ currentAction.id === 'extract-audio' ? t('extract.audio') : t('extract.video') }}
                </button>
                <span class="mc-muted">{{ t('extract.note') }}</span>
              </div>
              <ResultBlock
                :action-id="currentAction.id"
                :job-action="jobAction"
                :result="result"
                :percent="percent"
                :converting="phase === 'converting'"
                :cancelling="cancelling"
                :cancelled="cancelled"
                :file="file"
                :t="t"
                @cancel="cancelRun"
                @reveal="reveal"
                @again="resetResult"
              />
            </template>

            <template v-else-if="currentAction.id === 'subs'">
              <div class="mc-row">
                <span class="mc-muted">{{ t('subs.format') }}</span>
                <select class="mc-select" v-model="subtitleFormat" :disabled="busy" :aria-label="t('subs.format')">
                  <option v-for="option in ['srt', 'ass', 'vtt']" :key="option" :value="option">
                    {{ option.toUpperCase() }}
                  </option>
                </select>
              </div>
              <div v-for="(track, index) in meta!.subtitles" :key="index" class="mc-row">
                <span>
                  #{{ track.index }} · {{ track.language || '?' }} · {{ track.codec
                  }}<template v-if="track.title"> · {{ track.title }}</template>
                </span>
                <button
                  class="mc-btn mc-btn-ghost"
                  style="margin-left: auto"
                  :disabled="busy"
                  @click="runCurrent({ mode: 'subtitle', stream: index, format: subtitleFormat }, 'subs')"
                >
                  {{ t('sub.extract') }}
                </button>
              </div>
              <ResultBlock
                :action-id="currentAction.id"
                :job-action="jobAction"
                :result="result"
                :percent="percent"
                :converting="phase === 'converting'"
                :cancelling="cancelling"
                :cancelled="cancelled"
                :file="file"
                :t="t"
                @cancel="cancelRun"
                @reveal="reveal"
                @again="resetResult"
              />
            </template>

            <template v-else-if="currentAction.id === 'meta'">
              <div class="mc-meta-grid">
                <template v-for="([label, value], index) in containerRows" :key="'c' + index">
                  <span>{{ label }}</span
                  ><span>{{ value || '—' }}</span>
                </template>
              </div>
              <template v-if="chapterRows.length">
                <div class="mc-meta-head">{{ t('meta.chapters') }}</div>
                <div class="mc-meta-grid">
                  <template v-for="([label, value], index) in chapterRows" :key="'ch' + index">
                    <span>{{ label }}</span
                    ><span>{{ value || '—' }}</span>
                  </template>
                </div>
              </template>
              <div class="mc-meta-head">{{ t('meta.tracks') }}</div>
              <div class="mc-meta-grid">
                <template v-for="([label, value], index) in trackRows" :key="'t' + index">
                  <span>{{ label }}</span
                  ><span>{{ value || '—' }}</span>
                </template>
              </div>
              <template v-if="tagRows.length">
                <div class="mc-meta-head">{{ t('meta.tags') }}</div>
                <div class="mc-meta-grid">
                  <template v-for="([label, value], index) in tagRows" :key="'g' + index">
                    <span>{{ label }}</span
                    ><span>{{ value || '—' }}</span>
                  </template>
                </div>
              </template>
              <div class="mc-muted">{{ t('meta.edit') }}</div>
              <div class="mc-meta-fields">
                <label v-for="key in TAG_KEYS" :key="key" class="mc-meta-field">
                  <span>{{ t('meta.key.' + key) }}</span>
                  <input class="mc-name-input" v-model="metaTags[key]" :disabled="busy" />
                </label>
              </div>
              <div class="mc-row">
                <button
                  class="mc-btn mc-btn-primary"
                  :disabled="busy"
                  @click="runCurrent({ mode: 'meta', tags: metaTags }, 'meta')"
                >
                  {{ t('meta.save') }}
                </button>
              </div>
              <ResultBlock
                :action-id="currentAction.id"
                :job-action="jobAction"
                :result="result"
                :percent="percent"
                :converting="phase === 'converting'"
                :cancelling="cancelling"
                :cancelled="cancelled"
                :file="file"
                :t="t"
                @cancel="cancelRun"
                @reveal="reveal"
                @again="resetResult"
              />
            </template>

            <template v-else-if="currentAction.id === 'b64'">
              <div class="mc-tools">
                <button class="mc-btn mc-btn-ghost" :disabled="busy || b64Busy" @click="toBase64">
                  {{ b64Busy ? t('b64.encoding') : t('b64.encode') }}
                </button>
                <span v-if="b64" class="mc-muted">{{ formatSize(b64.size) }} · {{ b64.mime }}</span>
              </div>
              <template v-if="b64">
                <textarea class="mc-b64" rows="4" readonly :value="b64.data"></textarea>
                <div class="mc-tools">
                  <button class="mc-btn mc-btn-ghost" @click="copy(b64.data)">
                    {{ copied ? t('b64.copied') : t('b64.copy') }}
                  </button>
                  <button
                    class="mc-btn mc-btn-ghost"
                    @click="downloadText((file ? file.name : 'media') + '.base64.txt', b64.data)"
                  >
                    {{ t('b64.save') }}
                  </button>
                </div>
              </template>
              <div class="mc-sep"></div>
              <div class="mc-muted">{{ t('b64.decodeTitle') }}</div>
              <textarea class="mc-b64" rows="3" v-model="decodeInput" :placeholder="t('b64.placeholder')"></textarea>
              <div class="mc-tools">
                <button class="mc-btn mc-btn-ghost" :disabled="decodeBusy || !decodeInput.trim()" @click="decode">
                  {{ decodeBusy ? t('b64.decoding') : t('b64.decode') }}
                </button>
              </div>
              <template v-if="decoded && decoded.kind === 'text'">
                <div class="mc-muted">{{ t('b64.textResult') }}</div>
                <pre class="mc-pre">{{ decoded.text }}</pre>
                <div class="mc-tools">
                  <button class="mc-btn mc-btn-ghost" @click="copy(decoded.text)">
                    {{ copied ? t('b64.copied') : t('b64.copy') }}
                  </button>
                  <button class="mc-btn mc-btn-ghost" @click="downloadText('decoded.txt', decoded.text)">
                    {{ t('b64.save') }}
                  </button>
                </div>
              </template>
              <template v-if="decoded && decoded.kind !== 'text'">
                <img
                  v-if="decoded.kind === 'image'"
                  class="mc-player"
                  style="width: auto; max-width: 100%; background: transparent"
                  :src="previewUrl(decoded.file)"
                  alt=""
                />
                <video
                  v-if="decoded.kind === 'video'"
                  class="mc-player"
                  :src="previewUrl(decoded.file)"
                  controls
                  playsinline
                  preload="metadata"
                ></video>
                <audio
                  v-if="decoded.kind === 'audio'"
                  :src="previewUrl(decoded.file)"
                  controls
                  preload="metadata"
                  style="width: 100%"
                ></audio>
                <span class="mc-path">{{ decoded.file }}</span>
                <div class="mc-row">
                  <button class="mc-btn mc-btn-primary" @click="reveal(decoded.file)">
                    {{ t('action.reveal.' + PLATFORM) }}
                  </button>
                </div>
              </template>
            </template>
          </div>
        </template>
      </template>
    </template>

    <input ref="inputEl" type="file" hidden multiple @change="onPick" />
    <PathPicker v-if="showPathPicker" :t="t" @close="showPathPicker = false" @added="addRegistered" />
    <div v-if="status && status.outputDir" class="mc-foot">
      <span>{{ t('footer.out') }}:</span><span>{{ status.outputDir }}</span>
    </div>
  </div>
</template>
