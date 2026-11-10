// Framework-free helpers shared by the panel (App.vue) and its tests.
// Nothing here touches the DOM except downloadText/previewUrl consumers.
import type { MediaKind, TrimWindow } from '../../lib/plan.js';
import type { DecodeResponse, ErrorResponse, RunItemInfo, UploadDeleteResponse, UploadResponse } from '../../index.js';

export const TAG_KEYS = ['title', 'artist', 'album', 'comment', 'date', 'genre'];

// Files that only carry a picture cannot become audio, so those targets are
// physically impossible rather than merely unwanted.
const AUDIO_TARGETS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff'];

export const PLATFORM =
  typeof navigator === 'undefined'
    ? 'mac'
    : /Windows/i.test(navigator.userAgent)
      ? 'win'
      : /Mac/i.test(navigator.userAgent)
        ? 'mac'
        : 'linux';

// What the panel sends to the Host: the panel is the sender, so it declares
// the shapes it sends.
export interface ResultPayload {
  file: string;
  size: number;
  kind: MediaKind;
  text?: string;
  copy?: boolean;
  hardware?: boolean;
}
// One queue row, shared by App, FileQueue and QueueGroup. `file` is null on
// rows restored from a saved page state: the browser File is gone, only the
// server-side upload remains.
export interface QueueRow {
  key: string;
  file: File | null;
  url: string;
  thumb: string;
  checked: boolean;
  upload: UploadResponse | null;
  state: string;
  percent: number | null;
  result: ResultPayload | null;
  error: string;
}

export interface ConvertRequest {
  id: string;
  name?: string;
  format?: string;
  quality?: number;
  bitrate?: number;
  fps?: number;
  width?: number;
  mode?: 'extract-audio' | 'extract-video' | 'subtitle' | 'meta';
  stream?: number;
  tags?: Record<string, string>;
  trim?: TrimWindow;
}
export interface CancelRequest {
  id: string;
}
export interface RevealRequest {
  file: string;
}
export interface DecodeRequest {
  text: string;
}

// The decode answer is either plain text or a file the Host wrote; the file
// answer never carries the 'text' kind, so the panel can tell them apart.
export type DecodedText = Extract<DecodeResponse, { text: string }>;
export type DecodedFile = Omit<Extract<DecodeResponse, { file: string }>, 'kind'> & {
  kind: Exclude<MediaKind, 'text'>;
};
export type DecodedPayload = DecodedText | DecodedFile;

export function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

export function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const s = Math.round(seconds);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function formatClock(seconds?: number): string {
  const total = Math.max(0, Math.round((seconds || 0) * 10) / 10);
  const whole = Math.floor(total / 60);
  const rest = Math.round((total - whole * 60) * 10) / 10;
  const restText = (rest < 10 ? '0' : '') + (Number.isInteger(rest) ? String(rest) : rest.toFixed(1));
  return whole + ':' + restText;
}

// "12", "0:12", "0:12.5", "00:00:12" -> seconds; null when empty, NaN when
// unparseable. The Host only ever sees numbers.
export function parseTimecode(text: string): number | null {
  const value = String(text || '').trim();
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return NaN;
    total = total * 60 + Number(part);
  }
  return total;
}

// Long edges for the two pictures the panel makes itself: the detail preview
// and the queue row thumbnail.
export const PREVIEW_MAX = 900;
export const THUMB_MAX = 128;

// The browser has no gif/avif/bmp encoder, so those targets compare as PNG.
export function previewMime(format: string): string {
  return format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
}

// Largest size that fits inside `max` on the long edge, aspect preserved.
export function fitPreview(width: number, height: number, max = PREVIEW_MAX): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(1, width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function previewUrl(file: string): string {
  return '/api/media-convert/preview?file=' + encodeURIComponent(file);
}

export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text.slice(0, 120) || 'HTTP ' + resp.status);
  }
}

// Preview URL for the uploaded original: the browser File is gone after a
// page rebuild, so restored rows stream from the server instead of a blob URL.
export function sourceUrl(id: string): string {
  return '/api/media-convert/source?id=' + encodeURIComponent(id);
}

// States that mean "a job is in flight". A server job in one of these states
// re-attaches the row instead of leaving it as a dead "ready".
const RUNNING_STATES = new Set(['converting', 'cancelling']);

// The server's record of one job (GET /jobs, embedded in /queue): enough to
// build a row's state, result and progress from the server alone.
export interface ServerJob {
  id: string;
  uploadId: string;
  state: string;
  percent: number | null;
  out: string;
  size: number;
  error: string | null;
  kind: MediaKind;
  copy: boolean;
  hardware: boolean;
}

// Files added by path can already be on screen (the Host dedupes by path and
// hands back the existing record). Rows are keyed by upload id, so the panel
// keeps only the ones it does not already hold — otherwise adding the same
// folder twice would show every file twice.
export function withoutKnownUploads<T extends { id: string }>(
  rows: { upload: { id: string } | null }[],
  incoming: T[],
): T[] {
  const known = new Set<string>();
  for (const row of rows) if (row.upload) known.add(row.upload.id);
  return incoming.filter((upload) => !known.has(upload.id));
}

// The state a run item puts on its queue row. The Host owns the batch, so the
// panel derives rows from this instead of from its own in-flight requests; a
// `waiting` item is the batch's queue and shows as an ordinary ready row.
export interface RunItemPatch {
  state: string;
  percent: number | null;
  error: string;
  jobAction: string;
  // undefined keeps the row's current result (a done item without one).
  result?: ResultPayload | null;
}

export function runItemPatch(entry: RunItemInfo): RunItemPatch {
  if (entry.state === 'waiting') {
    return { state: 'ready', percent: null, error: '', jobAction: '', result: null };
  }
  if (entry.state === 'skipped') {
    return { state: 'skipped', percent: null, error: entry.error, jobAction: '', result: null };
  }
  if (entry.state === 'done') {
    return { state: 'done', percent: entry.percent ?? 100, error: '', jobAction: 'batch', result: entry.result };
  }
  if (entry.state === 'error') {
    return { state: 'error', percent: null, error: entry.error, jobAction: '', result: null };
  }
  if (entry.state === 'cancelled') {
    return { state: 'cancelled', percent: null, error: '', jobAction: '', result: null };
  }
  return { state: entry.state, percent: entry.percent, error: '', jobAction: '', result: null };
}

// What a restored row should take from a server job. A running job always
// wins; a finished one only rewrites a row that was itself mid-run when the
// snapshot was taken, so an old result cannot reappear on a reset row.
export interface JobPatch {
  state?: string;
  percent?: number | null;
  result?: ResultPayload | null;
  error?: string;
  jobId?: string;
  attach?: boolean;
}

export function jobPatch(snapshotState: string, job: ServerJob): JobPatch | null {
  if (job.state === 'running' || job.state === 'cancelling') {
    return {
      state: job.state === 'cancelling' ? 'cancelling' : 'converting',
      percent: job.percent,
      error: '',
      jobId: job.id,
      attach: true,
    };
  }
  if (!RUNNING_STATES.has(snapshotState)) return null;
  if (job.state === 'done') {
    return {
      state: 'done',
      percent: 100,
      error: '',
      result: { file: job.out, size: job.size, kind: job.kind, copy: job.copy, hardware: job.hardware },
    };
  }
  if (job.state === 'error') return { state: 'error', percent: null, error: job.error || '' };
  if (job.state === 'cancelled') return { state: 'cancelled', percent: null };
  return null;
}

// Media without a picture still needs a probe; this mirrors the Host's rule so
// the UI can grey out impossible targets before a request is made.
export function unavailableTarget(file: UploadResponse | null, target: string): boolean {
  return Boolean(
    file && file.kind === 'video' && AUDIO_TARGETS.includes(target) && file.streams && !file.streams.audio,
  );
}

// Mirror of the Host's supportsQuality (lib/plan.ts): the quality slider
// shows for exactly these lossy targets, so the two must stay in sync.
export function supportsQuality(kind: string, format: string): boolean {
  return (
    (kind === 'image' && (format === 'jpg' || format === 'webp')) ||
    (kind === 'video' && ['mp4', 'mov', 'mkv', 'flv', 'ts'].includes(format))
  );
}

// Mirror of the Host's supportsBitrate (lib/plan.ts): the bitrate select
// shows for exactly these lossy audio targets, so the two must stay in sync.
export function supportsBitrate(kind: string, format: string): boolean {
  return kind === 'audio' && ['mp3', 'm4a', 'aac', 'opus'].includes(format);
}

// The selectable bitrates (kbps) for the bitrate select; '' means the
// recipe default. Kept here so App and QueueGroup share one list.
export const BITRATE_OPTIONS = [64, 96, 128, 160, 192, 256, 320];

// The testable core of the panel's 移除: ask the Host first, drop the row
// only on success. The removal index is re-read from getRows() AFTER the
// await, so the later of two overlapping clicks finds the row already gone
// and becomes a no-op instead of splicing the neighbour that shifted into a
// captured index. `serverDelete: null` is the local-only path (force/abort).
export interface RowRemoval<Row> {
  rows: Row[];
  removed: Row | null;
  error: string | null;
  skipped: boolean;
}

export async function removeUploadRow<Row extends { key: string; upload: { id: string } | null }>(
  getRows: () => readonly Row[],
  key: string,
  serverDelete: ((id: string) => Promise<UploadDeleteResponse | ErrorResponse>) | null,
): Promise<RowRemoval<Row>> {
  const unchanged = (): RowRemoval<Row> => ({ rows: [...getRows()], removed: null, error: null, skipped: false });
  const target = getRows().find((row) => row.key === key);
  if (!target) return unchanged();
  if (serverDelete) {
    const id = target.upload?.id;
    if (id) {
      let data: UploadDeleteResponse | ErrorResponse;
      try {
        data = await serverDelete(id);
      } catch (err) {
        return { ...unchanged(), error: String((err && (err as Error).message) || err) };
      }
      if (!data.ok) return { ...unchanged(), error: data.error };
      if (data.skipped.includes(id)) return { ...unchanged(), skipped: true };
    }
  }
  const current = getRows().findIndex((row) => row.key === key);
  if (current < 0) return unchanged(); // a racing click (or clearQueue) already took it
  const rows = getRows().slice();
  const [removed] = rows.splice(current, 1);
  return { rows, removed: removed ?? null, error: null, skipped: false };
}

// The trim window described by the two fields; empty fields mean start/end.
export type TrimState =
  | { active: true; start: number; end: number; error: string }
  | { active: false; error: string; start?: number; end?: number };
export interface TrimInput {
  file: UploadResponse | null;
  trimStart: string;
  trimEnd: string;
  t: (key: string) => string;
}

export function trimWindow({ file, trimStart, trimEnd, t }: TrimInput): TrimState {
  if (!file || file.kind === 'image') return { active: false, start: 0, end: 0, error: '' };
  if (!trimStart.trim() && !trimEnd.trim()) return { active: false, start: 0, end: file.duration || 0, error: '' };
  const start = trimStart.trim() ? parseTimecode(trimStart) : 0;
  const end = trimEnd.trim() ? parseTimecode(trimEnd) : file.duration || 0;
  if (start === null || Number.isNaN(start) || end === null || Number.isNaN(end))
    return { active: false, error: t('trim.invalid') };
  if (!(end > start)) return { active: false, error: t('trim.order') };
  if (file.duration > 0 && end > file.duration + 0.05) return { active: false, error: t('trim.over') };
  return { active: true, start, end, error: '' };
}

// --- per-kind batch targets ----------------------------------------------
export const CONVERTIBLE_KINDS = ['video', 'audio', 'image'] as const;
export type ConvertibleKind = (typeof CONVERTIBLE_KINDS)[number];

export function isConvertible(kind: MediaKind): kind is ConvertibleKind {
  return kind === 'video' || kind === 'audio' || kind === 'image';
}

export function defaultTargets(table: Record<string, string[]>): Record<ConvertibleKind, string> {
  return {
    video: (table.video || [])[0] || 'mp4',
    audio: (table.audio || [])[0] || 'mp3',
    image: (table.image || [])[0] || 'png',
  };
}

// Each row now uses its own type's target. A silent video asked for an
// audio-only target is named as a skip instead of letting ffmpeg fail.
export interface BatchRowInput {
  key: string;
  kind: MediaKind;
  streams?: { audio?: boolean } | null;
}
export interface BatchRowTarget {
  key: string;
  target: string;
  error: '' | 'hint.noAudio';
}

export function rowPlan(
  rows: BatchRowInput[],
  targets: Record<ConvertibleKind, string>,
  overrides: Record<string, string> = {},
): BatchRowTarget[] {
  return rows.map((row) => {
    if (!isConvertible(row.kind)) return { key: row.key, target: '', error: '' };
    const target = overrides[row.key] || targets[row.kind];
    const noAudio = row.kind === 'video' && AUDIO_TARGETS.includes(target) && !row.streams?.audio;
    return { key: row.key, target, error: noAudio ? 'hint.noAudio' : '' };
  });
}
