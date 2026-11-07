<script setup lang="ts">
// Add files by absolute path: the Host reads the disk, the browser never
// uploads a byte. A few hundred files register in one call, so the picker is
// the fast path for big batches; the native picker and drag-drop stay for
// ad-hoc files.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { BrowseEntry, ErrorResponse, UploadResponse } from '../../../index.js';
import { formatSize, readJson } from '../lib.js';

const props = defineProps<{ t: (key: string) => string }>();
const emit = defineEmits<{ close: []; added: [uploads: UploadResponse[]] }>();

const path = ref('~');
const parent = ref('');
const entries = ref<BrowseEntry[]>([]);
const selected = ref<Set<string>>(new Set());
const loading = ref(false);
const adding = ref(false);
const recursive = ref(false);
const error = ref('');

const dirs = computed(() => entries.value.filter((entry) => entry.dir));
const files = computed(() => entries.value.filter((entry) => !entry.dir));
const selectedCount = computed(() => selected.value.size);

async function load(target: string) {
  loading.value = true;
  error.value = '';
  try {
    const data = await readJson<{ ok: true; path: string; parent: string; entries: BrowseEntry[] } | ErrorResponse>(
      await fetch('/api/media-convert/browse?path=' + encodeURIComponent(target)),
    );
    if (!data.ok) {
      error.value = data.error || props.t('error.title');
      return;
    }
    path.value = data.path;
    parent.value = data.parent;
    entries.value = data.entries;
  } catch (err) {
    error.value = String((err && (err as Error).message) || err);
  } finally {
    loading.value = false;
  }
}

function open(entry: BrowseEntry) {
  if (!entry.dir) return;
  void load(entry.path);
}

function toggle(entry: BrowseEntry) {
  if (entry.dir) return;
  const next = new Set(selected.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else next.add(entry.path);
  selected.value = next;
}

async function register(body: Record<string, unknown>) {
  adding.value = true;
  error.value = '';
  try {
    const data = await readJson<
      { ok: true; uploads: UploadResponse[]; skipped: { path: string; reason: string }[] } | ErrorResponse
    >(
      await fetch('/api/media-convert/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!data.ok) {
      error.value = data.error || props.t('error.title');
      return;
    }
    if (data.skipped.length) {
      error.value = props.t('path.skipped').replace('%s', String(data.skipped.length));
    }
    if (data.uploads.length) {
      emit('added', data.uploads);
      selected.value = new Set();
    }
  } catch (err) {
    error.value = String((err && (err as Error).message) || err);
  } finally {
    adding.value = false;
  }
}

const addSelected = () => void register({ paths: [...selected.value] });
const addFolder = () => void register({ dir: path.value, recursive: recursive.value });

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  void load('~');
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="mc-modal" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="mc-modal-card">
      <div class="mc-modal-head">
        <strong>{{ t('path.title') }}</strong>
        <button type="button" class="mc-icon-btn" :aria-label="t('path.close')" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6 6 18"></path>
          </svg>
        </button>
      </div>
      <p class="mc-modal-hint">{{ t('path.hint') }}</p>
      <div class="mc-path-row">
        <input
          v-model="path"
          class="mc-input mc-path-input"
          :aria-label="t('path.title')"
          @keydown.enter="load(path)"
          @blur="load(path)"
        />
        <button type="button" class="mc-btn mc-btn-ghost" :disabled="loading" @click="load(parent)">
          {{ t('path.up') }}
        </button>
      </div>
      <label class="mc-field mc-path-recursive">
        <input v-model="recursive" type="checkbox" />
        {{ t('path.recursive') }}
      </label>
      <div class="mc-browse" :class="{ busy: loading }">
        <button
          v-for="entry in dirs"
          :key="entry.path"
          type="button"
          class="mc-browse-row is-dir"
          @dblclick="open(entry)"
          @click="open(entry)"
        >
          <span class="mc-browse-icon">▸</span>
          <span class="mc-browse-name">{{ entry.name }}</span>
        </button>
        <label v-for="entry in files" :key="entry.path" class="mc-browse-row">
          <input type="checkbox" :checked="selected.has(entry.path)" @change="toggle(entry)" />
          <span class="mc-browse-name">{{ entry.name }}</span>
          <span class="mc-muted">{{ formatSize(entry.size) }}</span>
        </label>
        <p v-if="!loading && !entries.length" class="mc-muted mc-browse-empty">{{ t('path.empty') }}</p>
      </div>
      <p v-if="error" class="mc-row-error">{{ error }}</p>
      <div class="mc-modal-foot">
        <span class="mc-muted">{{ t('path.selected').replace('%s', String(selectedCount)) }}</span>
        <span class="mc-grow"></span>
        <button type="button" class="mc-btn mc-btn-ghost" :disabled="adding" @click="addFolder">
          {{ t('path.addFolder') }}
        </button>
        <button type="button" class="mc-btn mc-btn-primary" :disabled="adding || !selectedCount" @click="addSelected">
          {{ t('path.add').replace('%s', String(selectedCount)) }}
        </button>
      </div>
    </div>
  </div>
</template>
