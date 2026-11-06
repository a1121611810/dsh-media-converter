// Framework-free helpers shared by the panel (App.vue) and its tests.
// Nothing here touches the DOM except downloadText/previewUrl consumers.
import type { MediaKind, TrimWindow } from '../../lib/plan.js';
import type { DecodeResponse, UploadResponse } from '../../index.js';

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
// One queue row, shared by App, FileQueue and QueueGroup.
export interface QueueRow {
  key: string;
  file: File;
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

// Media without a picture still needs a probe; this mirrors the Host's rule so
// the UI can grey out impossible targets before a request is made.
export function unavailableTarget(file: UploadResponse | null, target: string): boolean {
  return Boolean(
    file && file.kind === 'video' && AUDIO_TARGETS.includes(target) && file.streams && !file.streams.audio,
  );
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
