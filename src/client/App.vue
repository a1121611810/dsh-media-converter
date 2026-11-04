<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  PLATFORM, TAG_KEYS, downloadText, formatClock, formatDuration, formatSize,
  previewUrl, readJson, trimWindow, unavailableTarget,
} from './lib.js';
import CompareSlider from './vue/CompareSlider.vue';
import ResultBlock from './vue/ResultBlock.vue';

const props = defineProps({ t: { type: Function, default: null } });
const t = (key) => (props.t ? props.t(key) : key);

const status = ref(null);
const rawFile = ref(null);
const blobUrl = ref('');
const file = ref(null);
const format = ref('');
const outputName = ref('');
const quality = ref(90);
const phase = ref('idle');
const percent = ref(null);
const result = ref(null);
const error = ref('');
const dragging = ref(false);
const jobId = ref(null);
const jobAction = ref('');
const trimStart = ref('');
const trimEnd = ref('');
const b64 = ref(null);
const cancelled = ref(false);
const cancelling = ref(false);
const metaTags = ref({});
const livePreview = ref('');
const compareMode = ref('side');
const b64Busy = ref(false);
const decodeInput = ref('');
const decoded = ref(null);
const decodeBusy = ref(false);
const copied = ref(false);
const query = ref('');
const action = ref('');
const panelOpen = ref(false);
const moreFormats = ref(false);

const inputEl = ref(null);
const mediaEl = ref(null);
const searchEl = ref(null);

let closeTimer = 0;
let uploadAbort = null;
let pollTimer = 0;
let stopAt = null;
let objectUrl = '';
let liveTimer = 0;
let disposed = false;

const busy = computed(() => phase.value === 'uploading' || phase.value === 'converting');
const meta = computed(() => (file.value ? file.value.meta : null));
const formats = computed(() => (status.value && file.value && status.value.formats[file.value.kind] ? status.value.formats[file.value.kind] : []));
const trim = computed(() => trimWindow({ file: file.value, trimStart: trimStart.value, trimEnd: trimEnd.value, t }));
const trimSummary = computed(() => (trim.value.error
  ? ''
  : trim.value.active
    ? formatClock(trim.value.start) + ' – ' + formatClock(trim.value.end) + ' · ' + formatClock(trim.value.end - trim.value.start)
    : t('trim.full') + (file.value && file.value.duration ? ' ' + formatClock(file.value.duration) : '')));
const usesQuality = computed(() => Boolean(file.value && file.value.kind === 'image' && (format.value === 'jpg' || format.value === 'webp')));
const canExtractAudio = computed(() => Boolean(file.value && file.value.kind === 'video' && file.value.streams && file.value.streams.audio));
const canExtractVideo = computed(() => Boolean(file.value && file.value.kind === 'video' && file.value.streams && file.value.streams.video));
const afterSrc = computed(() => (result.value && result.value.kind === 'image' ? previewUrl(result.value.file) : livePreview.value));
const afterLabel = computed(() => (result.value && result.value.kind === 'image'
  ? t('compare.after') + ' · ' + formatSize(result.value.size)
  : livePreview.value
    ? t('compare.live') + ' · ' + (format.value ? format.value.toUpperCase() : '') + (usesQuality.value ? ' ' + quality.value : '')
    : t('compare.slot')));

const joinParts = (parts) => parts.filter(Boolean).join(' · ');
const typeLabel = (type) => t('meta.type.' + (['video', 'audio', 'subtitle', 'data', 'attachment'].includes(type) ? type : 'data'));
const describeStream = (stream) => joinParts([
  stream.codec + (stream.profile ? ' ' + stream.profile : ''),
  stream.tag,
  stream.width ? stream.width + '×' + stream.height : '',
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

const containerRows = computed(() => (meta.value
  ? [
      [t('meta.container'), meta.value.format || '—'],
      [t('meta.duration'), meta.value.duration ? formatClock(meta.value.duration) + ' · ' + meta.value.duration.toFixed(2) + 's' : '—'],
      [t('meta.bitrate'), meta.value.bitrate ? meta.value.bitrate + ' kb/s' : '—'],
      [t('meta.size'), formatSize(file.value.size) || '—'],
      [t('meta.start'), (meta.value.start || 0).toFixed(3) + ' s'],
    ]
  : []));
const trackRows = computed(() => (meta.value ? meta.value.streams.map((stream) => ['#' + stream.index + ' ' + typeLabel(stream.type), describeStream(stream)]) : []));
const chapterRows = computed(() => (meta.value && meta.value.chapters.length
  ? meta.value.chapters.map((chapter, index) => [
      t('meta.chapter') + ' ' + (index + 1),
      joinParts([chapter.tags.title, formatClock(chapter.start) + ' – ' + formatClock(chapter.end)]),
    ])
  : []));
const tagRows = computed(() => (meta.value ? Object.entries(meta.value.tags) : []));

// Every action this file can offer, before the search filter.
const actions = computed(() => {
  const list = [];
  const searching = query.value.trim().length > 0;
  const showAll = moreFormats.value || searching;
  const popular = formats.value.slice(0, 4);
  const extra = formats.value.slice(4);
  for (const f of (showAll ? formats.value : popular)) {
    list.push({ id: 'fmt:' + f, group: 'convert', label: t('action.toFormat').replace('%s', f.toUpperCase()), hint: t('hint.' + f), off: unavailableTarget(file.value, f), keys: f });
  }
  if (extra.length && !searching) {
    list.push(moreFormats.value
      ? { id: 'less', group: 'convert', label: t('action.less'), hint: '', keys: '' }
      : { id: 'more', group: 'convert', label: t('action.moreFormats'), hint: extra.length + ' 种', keys: 'format' });
  }
  if (file.value && file.value.kind !== 'image') {
    list.push({ id: 'trim', group: 'edit', label: t('action.trim'), hint: t('trim.full') + ' ' + formatClock(file.value.duration || 0), keys: 'trim cut 裁剪' });
  }
  if (canExtractAudio.value) list.push({ id: 'extract-audio', group: 'edit', label: t('action.extractAudio'), hint: t('extract.note'), keys: 'extract audio 音轨' });
  if (canExtractVideo.value) list.push({ id: 'extract-video', group: 'edit', label: t('action.extractVideo'), hint: t('extract.note'), keys: 'extract video 画面' });
  if (meta.value && meta.value.subtitles.length) list.push({ id: 'subs', group: 'view', label: t('action.subs'), hint: meta.value.subtitles.length + ' 条', keys: 'subtitle srt 字幕' });
  list.push({ id: 'meta', group: 'view', label: t('action.meta'), hint: joinParts([meta.value ? meta.value.video && meta.value.video.codec : '', meta.value ? meta.value.audio && meta.value.audio.codec : '']), keys: 'metadata info 元数据' });
  list.push({ id: 'b64', group: 'view', label: t('action.b64'), hint: '', keys: 'base64 编码' });
  return list;
});
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle ? actions.value.filter((a) => (a.label + ' ' + a.keys).toLowerCase().includes(needle)) : actions.value;
});
const groups = computed(() => [
  ['convert', t('group.convert'), '⇄'],
  ['edit', t('group.edit'), '✂'],
  ['view', t('group.view'), '☰'],
]);
const itemsOf = (key) => visible.value.filter((item) => item.group === key);

async function fetchStatus() {
  try {
    const data = await readJson(await fetch('/api/media-convert/status'));
    if (!data.ok) return null;
    status.value = data;
    if (error.value === t('error.network')) error.value = '';
    return data;
  } catch {
    return null;
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
  if (!disposed && !status.value) error.value = t('error.network');
}

function resetResult() {
  if (!result.value) return;
  result.value = null;
  percent.value = null;
  phase.value = 'ready';
}

async function pick(picked) {
  if (!picked) return;
  error.value = '';
  result.value = null;
  percent.value = null;
  b64.value = null;
  decoded.value = null;
  trimStart.value = '';
  trimEnd.value = '';
  action.value = '';
  panelOpen.value = false;
  query.value = '';
  moreFormats.value = false;
  cancelled.value = false;
  rawFile.value = picked;
  phase.value = 'uploading';
  const controller = new AbortController();
  uploadAbort = controller;
  try {
    const data = await readJson(await fetch('/api/media-convert/upload?name=' + encodeURIComponent(picked.name), {
      method: 'POST',
      body: picked,
      signal: controller.signal,
    }));
    if (!data.ok) throw new Error(data.error || t('error.title'));
    file.value = data;
    outputName.value = String(data.name || '').replace(/\.[^.]*$/, '');
    metaTags.value = Object.fromEntries(TAG_KEYS.map((key) => [key, (data.meta && data.meta.tags && data.meta.tags[key]) || '']));
    // A Host that was still starting at mount left the format list empty; the
    // first successful pick fills it in.
    const active = status.value || (await fetchStatus());
    if (active && active.formats[data.kind]) format.value = active.formats[data.kind][0];
    phase.value = 'ready';
  } catch (err) {
    if (!controller.signal.aborted) error.value = String((err && err.message) || err);
    rawFile.value = null;
    phase.value = 'idle';
  } finally {
    if (uploadAbort === controller) uploadAbort = null;
  }
}

function cancelUpload() {
  if (uploadAbort) uploadAbort.abort();
}

async function runJob(body, forAction) {
  error.value = '';
  result.value = null;
  percent.value = null;
  cancelled.value = false;
  cancelling.value = false;
  jobAction.value = forAction;
  phase.value = 'converting';
  try {
    const data = await readJson(await fetch('/api/media-convert/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: file.value.id, name: outputName.value.trim() || undefined, ...body }),
    }));
    if (!data.ok) throw new Error(data.error || t('error.title'));
    jobId.value = data.job.id;
  } catch (err) {
    error.value = String((err && err.message) || err);
    phase.value = 'ready';
  }
}

async function cancelJob() {
  if (!jobId.value) return;
  cancelling.value = true;
  try {
    await readJson(await fetch('/api/media-convert/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: jobId.value }),
    }));
  } catch {
    /* the poll reports the final state anyway */
  }
}

function convert() {
  if (!file.value || !format.value) return;
  const withQuality = file.value.kind === 'image' && (format.value === 'jpg' || format.value === 'webp');
  runJob({ format: format.value, quality: withQuality ? quality.value : undefined }, 'fmt:' + format.value);
}

function applyTrim() {
  const window = trim.value;
  if (window.error) { error.value = window.error; return; }
  if (!window.active) { error.value = t('trim.full'); return; }
  runJob({ format: format.value, quality: file.value.kind === 'image' ? quality.value : undefined, trim: { start: window.start, end: window.end } }, 'trim');
}

function extract(which) {
  if (!file.value) return;
  runJob({ mode: which === 'audio' ? 'extract-audio' : 'extract-video' }, 'extract-' + which);
}

async function reveal(target) {
  try {
    const data = await readJson(await fetch('/api/media-convert/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: target }),
    }));
    if (!data.ok) error.value = data.error || t('error.title');
  } catch (err) {
    error.value = String((err && err.message) || err);
  }
}

function setTrimFromPlayer(which) {
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
  const end = window.active ? window.end : (el.duration || 0);
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
  error.value = '';
  try {
    const data = await readJson(await fetch('/api/media-convert/base64', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: file.value.id }),
    }));
    if (!data.ok) throw new Error(data.error || t('error.title'));
    b64.value = data;
  } catch (err) {
    error.value = String((err && err.message) || err);
  } finally {
    b64Busy.value = false;
  }
}

async function decode() {
  decodeBusy.value = true;
  error.value = '';
  decoded.value = null;
  try {
    const data = await readJson(await fetch('/api/media-convert/decode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: decodeInput.value }),
    }));
    if (!data.ok) throw new Error(data.error || t('error.title'));
    decoded.value = data;
  } catch (err) {
    error.value = String((err && err.message) || err);
  } finally {
    decodeBusy.value = false;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    error.value = '复制失败，请手动选择文本';
  }
}

function onDrop(event) {
  dragging.value = false;
  if (busy.value) return;
  const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (dropped) pick(dropped);
}

function onPick(event) {
  pick(event.target.files && event.target.files[0]);
  event.target.value = '';
}

function openPicker() {
  if (inputEl.value) inputEl.value.click();
}

function onDropZoneKey(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPicker();
  }
}

function changeFile() {
  file.value = null;
  rawFile.value = null;
  format.value = '';
  outputName.value = '';
  result.value = null;
  error.value = '';
  b64.value = null;
  decoded.value = null;
  trimStart.value = '';
  trimEnd.value = '';
  action.value = '';
  panelOpen.value = false;
  query.value = '';
  moreFormats.value = false;
  cancelled.value = false;
  cancelling.value = false;
  phase.value = 'idle';
}

function closePanel() {
  panelOpen.value = false;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { action.value = ''; }, 200);
}

function openPanel(id) {
  clearTimeout(closeTimer);
  if (action.value) {
    // Switching panels keeps the box open; only the contents swap.
    action.value = id;
    panelOpen.value = true;
    return;
  }
  action.value = id;
  panelOpen.value = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { panelOpen.value = true; }));
}

function toggleAction(id) {
  if (id === 'more') { moreFormats.value = true; return; }
  if (id === 'less') { moreFormats.value = false; return; }
  if (id.startsWith('fmt:')) format.value = id.slice(4);
  if (action.value === id) closePanel();
  else openPanel(id);
}

function onSearchKey(event) {
  if (event.key === 'Enter') {
    const first = visible.value.find((item) => !item.off);
    if (first) toggleAction(first.id);
  } else if (event.key === 'Escape') {
    event.currentTarget.blur();
  }
}

function onWindowKey(event) {
  if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
    event.preventDefault();
    if (searchEl.value) searchEl.value.focus();
    return;
  }
  if (event.key === 'Escape') {
    query.value = '';
    if (action.value) closePanel();
  }
}

// The Host may still be starting when the panel mounts; retry instead of
// leaving a stale "cannot reach the service" line for the whole session.
onMounted(() => {
  window.addEventListener('keydown', onWindowKey);
  loadStatusWithRetry();
});

onBeforeUnmount(() => {
  disposed = true; // a retry that outlives the panel must stop asking
  window.removeEventListener('keydown', onWindowKey);
  clearTimeout(closeTimer);
  clearTimeout(liveTimer);
  clearInterval(pollTimer);
  if (uploadAbort) uploadAbort.abort();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (stopAt && mediaEl.value) mediaEl.value.removeEventListener('timeupdate', stopAt);
});

// Local object URL: the preview player never needs the Host for input.
watch(rawFile, (picked) => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = picked ? URL.createObjectURL(picked) : '';
  blobUrl.value = objectUrl;
});

// Real-time output preview: the browser re-encodes the picked image at the
// chosen format/quality, so the right half updates before any conversion.
watch([blobUrl, file, format, quality], () => {
  clearTimeout(liveTimer);
  if (!blobUrl.value || !file.value || file.value.kind !== 'image' || !format.value) {
    livePreview.value = '';
    return;
  }
  liveTimer = setTimeout(() => {
    const image = new Image();
    image.onload = () => {
      try {
        const width = image.naturalWidth || 1;
        const height = image.naturalHeight || 1;
        const scale = Math.min(1, 900 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        // GIF has no canvas encoder; a still frame is what the eye compares anyway.
        const mime = format.value === 'jpg' ? 'image/jpeg' : format.value === 'webp' ? 'image/webp' : 'image/png';
        livePreview.value = canvas.toDataURL(mime, Math.min(1, Math.max(0.05, quality.value / 100)));
      } catch {
        livePreview.value = '';
      }
    };
    image.onerror = () => { livePreview.value = ''; };
    image.src = blobUrl.value;
  }, 120);
});

// Poll the Host for the running job, and stop as soon as it is terminal.
watch([phase, jobId], () => {
  clearInterval(pollTimer);
  if (phase.value !== 'converting' || !jobId.value) return;
  pollTimer = setInterval(async () => {
    try {
      const data = await readJson(await fetch('/api/media-convert/job?id=' + encodeURIComponent(jobId.value)));
      if (!data.ok) return;
      if (data.percent !== null) percent.value = data.percent;
      if (data.state === 'done') {
        const done = { file: data.out, size: data.size, kind: data.kind };
        if (data.kind === 'text') {
          try {
            done.text = await (await fetch(previewUrl(data.out))).text();
          } catch {
            /* the path is still shown below */
          }
        }
        result.value = done;
        percent.value = 100;
        phase.value = 'done';
      } else if (data.state === 'error') {
        error.value = data.error || t('error.title');
        phase.value = 'ready';
      } else if (data.state === 'cancelling') {
        // ffmpeg is still winding down; keep polling until it is gone.
        cancelling.value = true;
      } else if (data.state === 'cancelled') {
        cancelling.value = false;
        cancelled.value = true;
        percent.value = null;
        phase.value = 'ready';
      }
    } catch {
      /* keep polling through transient errors */
    }
  }, 500);
});

// Keep the expanded panel in view on short windows.
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
  <div class="mc-page">
    <div v-if="status && !status.ffmpegPath" class="mc-warn">{{ t('error.noffmpeg') }}</div>

    <template v-if="!file">
      <div class="mc-head">
        <h2 class="mc-title">{{ t('page.title') }}</h2>
        <p class="mc-sub">{{ t('page.subtitle') }}</p>
      </div>
      <!-- A failed upload drops back to the picker, so the reason lives here too. -->
      <div v-if="error" class="mc-error">{{ t('error.title') }}：{{ error }}</div>
      <div
        class="mc-drop"
        :class="{ over: dragging }"
        role="button"
        tabindex="0"
        @click="openPicker"
        @keydown="onDropZoneKey"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <span class="mc-drop-title">{{ phase === 'uploading' ? t('status.uploading') : t('drop.title') }}</span>
        <span class="mc-drop-hint">{{ t('drop.hint') }}</span>
        <button
          v-if="phase === 'uploading'"
          class="mc-btn mc-btn-ghost"
          style="margin-top: 10px"
          @click.stop="cancelUpload"
        >{{ t('action.cancel') }}</button>
        <span class="mc-muted" style="margin-top: 10px; font-size: 12px">{{ t('page.caps') }}</span>
      </div>
    </template>

    <template v-else>
      <div class="mc-file">
        <div class="mc-file-main">
          <span class="mc-name" :title="file.name">{{ file.name }}</span>
          <span class="mc-muted">{{ [formatSize(file.size), formatDuration(file.duration)].filter(Boolean).join(' · ') }}</span>
        </div>
        <span class="mc-tag">{{ t('kind.' + file.kind) }}</span>
        <button class="mc-btn mc-btn-ghost" :disabled="busy" @click="changeFile">{{ t('action.change') }}</button>
      </div>

      <video v-if="blobUrl && file.kind === 'video'" ref="mediaEl" class="mc-player" :src="blobUrl" controls playsinline preload="metadata"></video>
      <audio v-else-if="blobUrl && file.kind === 'audio'" ref="mediaEl" :src="blobUrl" controls preload="metadata" style="width: 100%"></audio>

      <template v-if="blobUrl && file.kind === 'image'">
        <div class="mc-tools" style="justify-content: flex-end">
          <span class="mc-muted">{{ t('compare.mode') }}</span>
          <button class="mc-toggle" :class="{ on: compareMode === 'side' }" :aria-pressed="compareMode === 'side'" @click="compareMode = 'side'">{{ t('compare.side') }}</button>
          <button class="mc-toggle" :class="{ on: compareMode === 'slider' }" :aria-pressed="compareMode === 'slider'" @click="compareMode = 'slider'">{{ t('compare.slider') }}</button>
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
            <div v-else class="mc-fig-ph">{{ phase === 'converting' ? t('action.converting') + (percent === null ? '' : ' ' + percent + '%') : t('compare.pending') }}</div>
            <figcaption class="mc-cap">{{ afterLabel }}</figcaption>
          </figure>
        </div>
      </template>

      <div class="mc-search">
        <span class="mc-muted">⌘</span>
        <input ref="searchEl" v-model="query" :placeholder="t('search.placeholder')" :aria-label="t('search.placeholder')" @keydown="onSearchKey" />
        <span class="mc-muted" style="font-size: 11px; border: 1px solid currentColor; border-radius: 5px; padding: 0 6px">⌘K</span>
      </div>

      <div v-if="error" class="mc-error">{{ t('error.title') }}：{{ error }}</div>

      <template v-for="[key, label, icon] in groups" :key="key">
        <template v-if="itemsOf(key).length">
          <div class="mc-act-group">{{ label }}</div>
          <template v-for="item in itemsOf(key)" :key="item.id">
            <button
              class="mc-act"
              :class="{ on: action === item.id }"
              :disabled="Boolean(item.off) || busy"
              :title="item.off ? t('hint.noAudio') : undefined"
              @click="toggleAction(item.id)"
            >
              <span class="mc-act-icon">{{ icon }}</span>
              {{ item.label }}
              <span v-if="item.hint" class="mc-act-hint">{{ item.off ? t('hint.noAudio') : item.hint }}</span>
            </button>

            <div v-if="action === item.id" class="mc-collapse" :class="{ open: panelOpen }">
              <div class="mc-panel-clip">
                <div class="mc-panel">
                  <!-- convert to a format -->
                  <template v-if="item.id.startsWith('fmt:')">
                    <div class="mc-row">
                      <span class="mc-muted">{{ t('name.label') }}</span>
                      <input class="mc-name-input" v-model="outputName" :disabled="busy" :placeholder="String(file.name || '').replace(/\.[^.]*$/, '')" :aria-label="t('name.label')" />
                      <span class="mc-muted">{{ format ? '.' + format : '' }}</span>
                    </div>
                    <div v-if="usesQuality && item.id === 'fmt:' + format" class="mc-row">
                      <span class="mc-muted">{{ t('quality.label') }}</span>
                      <input type="range" min="10" max="100" step="5" v-model.number="quality" :disabled="busy" :aria-label="t('quality.label')" @input="resetResult" />
                      <span class="mc-muted">{{ quality }}</span>
                      <span class="mc-muted">{{ t('quality.hint') }}</span>
                    </div>
                    <div class="mc-row">
                      <button class="mc-btn mc-btn-primary" :disabled="busy || unavailableTarget(file, format)" @click="convert">{{ t('action.convert') }}</button>
                    </div>
                    <ResultBlock :action-id="item.id" :job-action="jobAction" :result="result" :percent="percent" :converting="phase === 'converting'" :cancelling="cancelling" :cancelled="cancelled" :file="file" :t="t" @cancel="cancelJob" @reveal="reveal" @again="resetResult" />
                  </template>

                  <!-- trim -->
                  <template v-else-if="item.id === 'trim'">
                    <div class="mc-row">
                      <span class="mc-muted">{{ t('trim.start') }}</span>
                      <input class="mc-time" v-model="trimStart" :disabled="busy" inputmode="decimal" placeholder="0:00" :aria-label="t('trim.start')" @input="resetResult" />
                      <span class="mc-muted">{{ t('trim.end') }}</span>
                      <input class="mc-time" v-model="trimEnd" :disabled="busy" inputmode="decimal" :placeholder="file.duration ? formatClock(file.duration) : '0:00'" :aria-label="t('trim.end')" @input="resetResult" />
                      <span class="mc-grow"></span>
                      <span :class="trim.error ? 'mc-error' : 'mc-muted'">{{ trim.error || trimSummary }}</span>
                    </div>
                    <div class="mc-tools">
                      <button class="mc-btn mc-btn-ghost" :disabled="busy" @click="setTrimFromPlayer('start')">{{ t('trim.setStart') }}</button>
                      <button class="mc-btn mc-btn-ghost" :disabled="busy" @click="setTrimFromPlayer('end')">{{ t('trim.setEnd') }}</button>
                      <button class="mc-btn mc-btn-ghost" :disabled="busy || Boolean(trim.error)" @click="playSelection">{{ t('trim.play') }}</button>
                    </div>
                    <div class="mc-row">
                      <span class="mc-muted">{{ t('hint.formats') }}</span>
                      <select class="mc-select" v-model="format" :disabled="busy">
                        <option v-for="f in formats" :key="f" :value="f" :disabled="unavailableTarget(file, f)">{{ f.toUpperCase() }}</option>
                      </select>
                      <button class="mc-btn mc-btn-primary" :disabled="busy || Boolean(trim.error) || !trim.active || unavailableTarget(file, format)" @click="applyTrim">{{ t('trim.apply') }}</button>
                    </div>
                    <ResultBlock :action-id="item.id" :job-action="jobAction" :result="result" :percent="percent" :converting="phase === 'converting'" :cancelling="cancelling" :cancelled="cancelled" :file="file" :t="t" @cancel="cancelJob" @reveal="reveal" @again="resetResult" />
                  </template>

                  <!-- extract a track -->
                  <template v-else-if="item.id === 'extract-audio' || item.id === 'extract-video'">
                    <div class="mc-row">
                      <span class="mc-muted">{{ t('name.label') }}</span>
                      <input class="mc-name-input" v-model="outputName" :disabled="busy" :placeholder="String(file.name || '').replace(/\.[^.]*$/, '')" :aria-label="t('name.label')" />
                    </div>
                    <div class="mc-row">
                      <button class="mc-btn mc-btn-primary" :disabled="busy" @click="extract(item.id === 'extract-audio' ? 'audio' : 'video')">{{ item.id === 'extract-audio' ? t('extract.audio') : t('extract.video') }}</button>
                      <span class="mc-muted">{{ t('extract.note') }}</span>
                    </div>
                    <ResultBlock :action-id="item.id" :job-action="jobAction" :result="result" :percent="percent" :converting="phase === 'converting'" :cancelling="cancelling" :cancelled="cancelled" :file="file" :t="t" @cancel="cancelJob" @reveal="reveal" @again="resetResult" />
                  </template>

                  <!-- subtitle tracks -->
                  <template v-else-if="item.id === 'subs'">
                    <div v-for="(track, index) in meta.subtitles" :key="index" class="mc-row">
                      <span>#{{ track.index }} · {{ track.language || '?' }} · {{ track.codec }}<template v-if="track.title"> · {{ track.title }}</template></span>
                      <button class="mc-btn mc-btn-ghost" style="margin-left: auto" :disabled="busy" @click="runJob({ mode: 'subtitle', stream: index }, 'subs')">{{ t('sub.extract') }}</button>
                    </div>
                    <ResultBlock :action-id="item.id" :job-action="jobAction" :result="result" :percent="percent" :converting="phase === 'converting'" :cancelling="cancelling" :cancelled="cancelled" :file="file" :t="t" @cancel="cancelJob" @reveal="reveal" @again="resetResult" />
                  </template>

                  <!-- metadata -->
                  <template v-else-if="item.id === 'meta'">
                    <div class="mc-meta-grid">
                      <template v-for="([label, value], index) in containerRows" :key="'c' + index">
                        <span>{{ label }}</span><span>{{ value || '—' }}</span>
                      </template>
                    </div>
                    <template v-if="chapterRows.length">
                      <div class="mc-meta-head">{{ t('meta.chapters') }}</div>
                      <div class="mc-meta-grid">
                        <template v-for="([label, value], index) in chapterRows" :key="'ch' + index">
                          <span>{{ label }}</span><span>{{ value || '—' }}</span>
                        </template>
                      </div>
                    </template>
                    <div class="mc-meta-head">{{ t('meta.tracks') }}</div>
                    <div class="mc-meta-grid">
                      <template v-for="([label, value], index) in trackRows" :key="'t' + index">
                        <span>{{ label }}</span><span>{{ value || '—' }}</span>
                      </template>
                    </div>
                    <template v-if="tagRows.length">
                      <div class="mc-meta-head">{{ t('meta.tags') }}</div>
                      <div class="mc-meta-grid">
                        <template v-for="([label, value], index) in tagRows" :key="'g' + index">
                          <span>{{ label }}</span><span>{{ value || '—' }}</span>
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
                      <button class="mc-btn mc-btn-primary" :disabled="busy" @click="runJob({ mode: 'meta', tags: metaTags }, 'meta')">{{ t('meta.save') }}</button>
                    </div>
                    <ResultBlock :action-id="item.id" :job-action="jobAction" :result="result" :percent="percent" :converting="phase === 'converting'" :cancelling="cancelling" :cancelled="cancelled" :file="file" :t="t" @cancel="cancelJob" @reveal="reveal" @again="resetResult" />
                  </template>

                  <!-- base64 -->
                  <template v-else-if="item.id === 'b64'">
                    <div class="mc-tools">
                      <button class="mc-btn mc-btn-ghost" :disabled="busy || b64Busy" @click="toBase64">{{ b64Busy ? t('b64.encoding') : t('b64.encode') }}</button>
                      <span v-if="b64" class="mc-muted">{{ formatSize(b64.size) }} · {{ b64.mime }}</span>
                    </div>
                    <template v-if="b64">
                      <textarea class="mc-b64" rows="4" readonly :value="b64.data"></textarea>
                      <div class="mc-tools">
                        <button class="mc-btn mc-btn-ghost" @click="copy(b64.data)">{{ copied ? t('b64.copied') : t('b64.copy') }}</button>
                        <button class="mc-btn mc-btn-ghost" @click="downloadText((file ? file.name : 'media') + '.base64.txt', b64.data)">{{ t('b64.save') }}</button>
                      </div>
                    </template>
                    <div class="mc-sep"></div>
                    <div class="mc-muted">{{ t('b64.decodeTitle') }}</div>
                    <textarea class="mc-b64" rows="3" v-model="decodeInput" :placeholder="t('b64.placeholder')"></textarea>
                    <div class="mc-tools">
                      <button class="mc-btn mc-btn-ghost" :disabled="decodeBusy || !decodeInput.trim()" @click="decode">{{ decodeBusy ? t('b64.decoding') : t('b64.decode') }}</button>
                    </div>
                    <template v-if="decoded && decoded.kind === 'text'">
                      <div class="mc-muted">{{ t('b64.textResult') }}</div>
                      <pre class="mc-pre">{{ decoded.text }}</pre>
                      <div class="mc-tools">
                        <button class="mc-btn mc-btn-ghost" @click="copy(decoded.text)">{{ copied ? t('b64.copied') : t('b64.copy') }}</button>
                        <button class="mc-btn mc-btn-ghost" @click="downloadText('decoded.txt', decoded.text)">{{ t('b64.save') }}</button>
                      </div>
                    </template>
                    <template v-if="decoded && decoded.kind !== 'text'">
                      <img v-if="decoded.kind === 'image'" class="mc-player" style="width: auto; max-width: 100%; background: transparent" :src="previewUrl(decoded.file)" alt="" />
                      <video v-if="decoded.kind === 'video'" class="mc-player" :src="previewUrl(decoded.file)" controls playsinline preload="metadata"></video>
                      <audio v-if="decoded.kind === 'audio'" :src="previewUrl(decoded.file)" controls preload="metadata" style="width: 100%"></audio>
                      <span class="mc-path">{{ decoded.file }}</span>
                      <div class="mc-row">
                        <button class="mc-btn mc-btn-primary" @click="reveal(decoded.file)">{{ t('action.reveal.' + PLATFORM) }}</button>
                      </div>
                    </template>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </template>
      </template>

      <div v-if="!visible.length" class="mc-muted" style="padding: 24px 0; text-align: center">{{ t('act.empty') }}</div>
    </template>

    <input ref="inputEl" type="file" hidden @change="onPick" />
    <div v-if="status && status.outputDir" class="mc-foot">
      <span>{{ t('footer.out') }}:</span><span>{{ status.outputDir }}</span>
    </div>
  </div>
</template>
