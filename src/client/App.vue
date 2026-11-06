<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PropType } from 'vue';
import {
  CONVERTIBLE_KINDS,
  PLATFORM,
  PREVIEW_MAX,
  TAG_KEYS,
  THUMB_MAX,
  defaultTargets,
  downloadText,
  fitPreview,
  formatClock,
  formatDuration,
  formatSize,
  isConvertible,
  previewMime,
  previewUrl,
  readJson,
  rowPlan,
  trimWindow,
  unavailableTarget,
} from './lib.js';
import type { ConvertRequest, ConvertibleKind, DecodedPayload, QueueRow } from './lib.js';
import type { MediaKind, StreamMeta } from '../../lib/plan.js';
import type {
  Base64Response,
  BatchProgress,
  BatchResponse,
  ErrorResponse,
  Job,
  ModelsResponse,
  PtcModelOption,
  StatusResponse,
  UploadResponse,
} from '../../index.js';
import CompareSlider from './vue/CompareSlider.vue';
import ResultBlock from './vue/ResultBlock.vue';
import BatchCard from './vue/BatchCard.vue';
import QueueGroup from './vue/QueueGroup.vue';
import ActionGrid from './vue/ActionGrid.vue';

const props = defineProps({
  t: { type: Function as PropType<((key: string) => string) | null>, default: null },
});
const t = (key: string): string => (props.t ? props.t(key) : key);

type View = 'queue' | 'detail';
type Operation = 'convert' | 'audio' | 'video';
type ItemState = 'uploading' | 'ready' | 'converting' | 'cancelling' | 'cancelled' | 'done' | 'error' | 'skipped';
type Phase = 'idle' | 'uploading' | 'converting' | 'ready' | 'done';

interface Item extends QueueRow {
  state: ItemState;
  jobAction: string;
}
type PtcProgressResponse = BatchProgress & { ok: true };

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
const usePtc = ref(false);
const useGpu = ref(false);
const GPU_FORMATS = new Set(['mp4', 'mov', 'mkv', 'flv', 'ts']);
const ptcModels = ref<PtcModelOption[]>([]);
const ptcDefaultModel = ref<ModelsResponse['default']>(null);
const ptcModelKey = ref('');
const ptcProgress = ref<BatchProgress | null>(null);
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
const query = ref('');
const format = ref('');
const outputName = ref('');
const quality = ref(90);
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
const dragging = ref(false);
const runKeys = ref<string[]>([]);
const runIndeterminate = ref(false);
const lastRun = ref<{ done: number; failed: number; skipped: number; cancelled: number } | null>(null);

const pageEl = ref<HTMLDivElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const selectAllEl = ref<HTMLInputElement | null>(null);
const mediaEl = ref<HTMLMediaElement | null>(null);

let uploadAbort: AbortController | null = null;
let currentJobId = '';
let ptcAbort: AbortController | null = null;
let stopRequested = false;
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
const showGpu = computed(
  () =>
    operation.value === 'convert' &&
    Boolean(status.value?.hardware?.h264) &&
    batchTargets.value.some((item) => item.upload!.kind === 'video' && GPU_FORMATS.has(effectiveTarget(item))),
);
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
          convertible === 'image' &&
          operation.value === 'convert' &&
          groupItems.some((item) => {
            const target = effectiveTarget(item);
            return target === 'jpg' || target === 'webp';
          }),
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
  const progress = ptcProgress.value;
  if (progress?.stage === 'planning') {
    const seconds = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
    return t('ptc.planning').replace('%s', String(seconds)).replace('%s', String(progress.modelChars));
  }
  if (progress?.stage === 'converting') {
    const done = progress.items.filter((item) => item.state === 'done').length;
    return t('ptc.converting').replace('%s', String(done)).replace('%s', String(progress.items.length));
  }
  if (runIndeterminate.value) return t('ptc.running');
  return t('batch.running').replace('%s', String(finishedRunCount.value)).replace('%s', String(runKeys.value.length));
});
const batchProgressPercent = computed(() => {
  if (!batchRunning.value || runIndeterminate.value || !runKeys.value.length) return null;
  const progress = ptcProgress.value;
  if (progress?.stage === 'converting') {
    const done = progress.items.filter((item) => item.state === 'done').length;
    return Math.round((done / progress.items.length) * 100);
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
  Boolean(file.value && file.value.kind === 'image' && (format.value === 'jpg' || format.value === 'webp')),
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
  while (!disposed) {
    const data = await fetchStatus();
    if (data || attempt >= 9 || disposed) break;
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 400 * attempt)));
  }
  if (!disposed && !status.value) {
    networkError.value = statusError ? t('error.service').replace('%s', statusError) : t('error.network');
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

// The queue shows a 36px thumbnail; decoding the full picture for it keeps a
// 96 MB bitmap per row alive. One decode at a time keeps a big drop safe.
function queueThumb(item: Item) {
  thumbChain = thumbChain
    .then(async () => {
      if (disposed || !items.value.some((row) => row.key === item.key)) return;
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
    .catch(() => {});
}

async function addFiles(picked: File[]) {
  if (!picked.length || busy.value) return;
  batchError.value = '';
  if (!status.value) await fetchStatus();
  const added = picked.map(makeItem);
  items.value.push(...added);
  // Mutate the reactive proxies from the array, not the raw objects pushed in:
  // assigning to the raw copies would update the data but never re-render.
  const created = items.value.slice(-added.length);
  const controller = new AbortController();
  uploadAbort = controller;
  for (const item of created) {
    if (controller.signal.aborted) {
      removeItem(item.key, true);
      continue;
    }
    try {
      const data = await readJson<UploadResponse | ErrorResponse>(
        await fetch('/api/media-convert/upload?name=' + encodeURIComponent(item.file.name), {
          method: 'POST',
          body: item.file,
          signal: controller.signal,
        }),
      );
      if (!data.ok) throw new Error(data.error || t('error.title'));
      item.upload = data;
      item.state = 'ready';
      if (data.kind === 'image') queueThumb(item);
      if (data.kind === 'text') item.checked = false;
    } catch (err) {
      if (controller.signal.aborted) removeItem(item.key, true);
      else {
        item.state = 'error';
        item.error = String((err && (err as Error).message) || err);
      }
    }
  }
  if (uploadAbort === controller) uploadAbort = null;
  ensureTargets();
}

function cancelUploads() {
  if (uploadAbort) uploadAbort.abort();
}

function removeItem(key: string, force = false) {
  if (busy.value && !force) return;
  const index = items.value.findIndex((item) => item.key === key);
  if (index < 0) return;
  const [item] = items.value.splice(index, 1);
  delete rowTargets.value[key];
  URL.revokeObjectURL(item.url);
  if (item.thumb) URL.revokeObjectURL(item.thumb);
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

function clearQueue() {
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
  items.value.forEach((item) => {
    URL.revokeObjectURL(item.url);
    if (item.thumb) URL.revokeObjectURL(item.thumb);
  });
  items.value = [];
  rowTargets.value = {};
  detailKey.value = '';
  view.value = 'queue';
  batchError.value = '';
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
  outputName.value = (item.upload?.name || item.file.name).replace(/\.[^.]*$/, '');
  trimStart.value = '';
  trimEnd.value = '';
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
  if (ptcAbort) {
    ptcAbort.abort();
    return;
  }
  if (!currentJobId) return;
  fetch('/api/media-convert/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: currentJobId }),
  }).catch(() => {});
}

function cancelBatch() {
  stopRequested = true;
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

async function runSequential(rows: Item[]) {
  const audioKeys = new Set(audioTargets.value.map((item) => item.key));
  const videoKeys = new Set(videoTargets.value.map((item) => item.key));
  for (const item of rows) {
    if (stopRequested) break;
    let body: Record<string, unknown> | null = null;
    if (operation.value === 'convert') {
      const row = planByKey.value.get(item.key);
      if (!row || row.error) {
        item.state = 'skipped';
        item.error = row?.error ? t(row.error) : '';
        continue;
      }
      body = {
        format: row.target,
        quality: row.target === 'jpg' || row.target === 'webp' ? batchQuality.value : undefined,
        hardware: useGpu.value || undefined,
      };
    } else if (operation.value === 'audio') {
      if (!audioKeys.has(item.key)) {
        item.state = 'skipped';
        item.error = item.upload!.kind === 'video' ? t('hint.noAudio') : t('batch.notApplicable');
        continue;
      }
      body = { mode: 'extract-audio' };
    } else {
      if (!videoKeys.has(item.key)) {
        item.state = 'skipped';
        item.error = t('batch.notApplicable');
        continue;
      }
      body = { mode: 'extract-video' };
    }
    item.state = 'converting';
    item.percent = null;
    item.error = '';
    try {
      await postConvert(item.upload!.id, body);
      const job = await pollJob(currentJobId, (value) => {
        item.percent = value;
      });
      if (job.state === 'error') throw new Error(job.error || t('error.title'));
      if (job.state === 'cancelled') {
        item.state = 'cancelled';
        item.percent = null;
        continue;
      }
      item.result = { file: job.out, size: job.size, kind: job.kind, copy: job.copy, hardware: job.hardware };
      item.state = 'done';
      item.percent = 100;
      item.jobAction = 'batch';
    } catch (err) {
      item.state = stopRequested ? 'cancelled' : 'error';
      item.error = stopRequested ? '' : String((err && (err as Error).message) || err);
    } finally {
      currentJobId = '';
      if (item.state !== 'done') item.percent = null;
    }
  }
}

async function runPtc(rows: Item[]) {
  const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const controller = new AbortController();
  ptcAbort = controller;
  ptcProgress.value = null;
  rows.forEach((item) => {
    item.state = 'converting';
    item.percent = null;
  });
  const poll = setInterval(async () => {
    try {
      const data = await readJson<PtcProgressResponse | ErrorResponse>(
        await fetch('/api/media-convert/batch/progress?id=' + encodeURIComponent(runId)),
      );
      if (!data.ok) return;
      ptcProgress.value = data;
      runIndeterminate.value = data.stage === 'planning';
      for (const row of data.items) {
        const item = rows.find((candidate) => candidate.upload?.id === row.id);
        if (!item) continue;
        if (row.state === 'converting') {
          item.state = 'converting';
          item.percent = row.percent;
        } else if (row.state === 'done') {
          item.percent = 100;
        }
      }
    } catch {
      // A missed poll is fine; the next one catches up.
    }
  }, 500);
  try {
    const data = await readJson<BatchResponse | ErrorResponse>(
      await fetch('/api/media-convert/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: rows.map((item) => {
            const kind = item.upload!.kind;
            return {
              id: item.upload!.id,
              format: isConvertible(kind) ? effectiveTarget(item) : '',
              quality: kind === 'image' ? batchQuality.value : undefined,
            };
          }),
          quality: batchQuality.value,
          model: ptcModel.value || undefined,
          hardware: useGpu.value || undefined,
          runId,
        }),
        signal: controller.signal,
      }),
    );
    if (!data.ok) throw new Error(data.error || t('error.title'));
    ptcTiming.value = { modelMs: data.modelMs, runMs: data.runMs };
    const byId = new Map(data.results.map((row) => [row.id, row]));
    rows.forEach((item) => {
      const row = byId.get(item.upload!.id);
      if (row && !row.error && row.output) {
        item.result = {
          file: row.output,
          size: row.size || 0,
          kind: row.kind || item.upload!.kind,
          copy: row.copy,
          hardware: row.hardware,
        };
        item.state = 'done';
        item.percent = 100;
        item.jobAction = 'batch';
      } else {
        item.state = 'error';
        item.error = row?.error || t('batch.missing');
      }
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    rows.forEach((item) => {
      if (item.state === 'converting') {
        item.state = aborted ? 'cancelled' : 'ready';
        item.percent = null;
      }
    });
    if (!aborted) batchError.value = String((err && (err as Error).message) || err);
  } finally {
    clearInterval(poll);
    ptcProgress.value = null;
    ptcAbort = null;
  }
}

async function startBatch() {
  if (busy.value || !batchTargets.value.length) return;
  batchError.value = '';
  lastRun.value = null;
  ptcTiming.value = null;
  const rows = batchTargets.value.slice();
  runKeys.value = rows.map((item) => item.key);
  runIndeterminate.value = false;
  batchRunning.value = true;
  stopRequested = false;
  rows.forEach((item) => {
    item.result = null;
    item.error = '';
    item.percent = null;
    item.state = 'ready';
    item.jobAction = '';
  });
  try {
    if (operation.value === 'convert' && usePtc.value && rows.length >= 2) {
      runIndeterminate.value = true;
      await runPtc(rows);
    } else {
      await runSequential(rows);
    }
  } finally {
    batchRunning.value = false;
    runIndeterminate.value = false;
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
    currentJobId = '';
  }
}

function convert() {
  if (!file.value || !format.value) return;
  const withQuality = file.value.kind === 'image' && (format.value === 'jpg' || format.value === 'webp');
  runCurrent({ format: format.value, quality: withQuality ? quality.value : undefined }, 'fmt:' + format.value);
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
  loadStatusWithRetry();
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('keydown', onWindowKey);
  clearTimeout(liveTimer);
  clearTimeout(clearTimer);
  if (uploadAbort) uploadAbort.abort();
  if (ptcAbort) ptcAbort.abort();
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

watch(
  () => batchTargets.value.length,
  (count) => {
    if (usePtc.value && count < 2) usePtc.value = false;
  },
);

watch([operation, batchQuality, usePtc, useGpu], () => {
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

    <template v-if="view === 'queue'">
      <div class="mc-head">
        <h2 class="mc-title">{{ t('page.title') }}</h2>
        <p class="mc-sub">{{ t('page.subtitle') }}</p>
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
            @gpu="useGpu = $event"
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
              :note="group.note"
              :disabled="busy"
              :t="t"
              @toggle-group="toggleGroup(group, $event)"
              @update:target="group.kind !== 'pending' && setTarget(group.kind as ConvertibleKind, $event)"
              @update:row-target="setRowTarget"
              @update:quality="batchQuality = $event"
              @toggle="toggleChecked"
              @open="openDetail"
              @reveal="reveal"
              @remove="removeItem"
            />
          </div>

          <div v-if="dragging" class="mc-drop-overlay">{{ t('queue.dropNow') }}</div>
        </template>
      </div>
    </template>

    <template v-else-if="detailItem">
      <div class="mc-detail-head">
        <button type="button" class="mc-back" @click="backToQueue">← {{ t('detail.back') }}</button>
        <span class="mc-grow"></span>
        <span v-if="file" class="mc-tag">{{ t('kind.' + file.kind) }}</span>
      </div>

      <div class="mc-detail-title">
        <h2 class="mc-detail-name" :title="detailItem.upload?.name || detailItem.file.name">
          {{ detailItem.upload?.name || detailItem.file.name }}
        </h2>
        <p class="mc-sub">
          {{
            [file ? formatSize(file.size) : formatSize(detailItem.file.size), file ? formatDuration(file.duration) : '']
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
              <div v-for="(track, index) in meta!.subtitles" :key="index" class="mc-row">
                <span>
                  #{{ track.index }} · {{ track.language || '?' }} · {{ track.codec
                  }}<template v-if="track.title"> · {{ track.title }}</template>
                </span>
                <button
                  class="mc-btn mc-btn-ghost"
                  style="margin-left: auto"
                  :disabled="busy"
                  @click="runCurrent({ mode: 'subtitle', stream: index }, 'subs')"
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
    <div v-if="status && status.outputDir" class="mc-foot">
      <span>{{ t('footer.out') }}:</span><span>{{ status.outputDir }}</span>
    </div>
  </div>
</template>
