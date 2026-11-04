// Framework-free helpers shared by the panel (App.vue) and its tests.
// Nothing here touches the DOM except downloadText/previewUrl consumers.

export const TAG_KEYS = ['title', 'artist', 'album', 'comment', 'date', 'genre'];

// Files that only carry a picture cannot become audio, so those targets are
// physically impossible rather than merely unwanted.
const AUDIO_TARGETS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff'];

export const PLATFORM = typeof navigator === 'undefined'
  ? 'mac'
  : /Windows/i.test(navigator.userAgent)
    ? 'win'
    : /Mac/i.test(navigator.userAgent)
      ? 'mac'
      : 'linux';

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

export function formatDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.round((seconds || 0) * 10) / 10);
  const whole = Math.floor(total / 60);
  const rest = Math.round((total - whole * 60) * 10) / 10;
  const restText = (rest < 10 ? '0' : '') + (Number.isInteger(rest) ? String(rest) : rest.toFixed(1));
  return whole + ':' + restText;
}

// "12", "0:12", "0:12.5", "00:00:12" -> seconds; null when empty, NaN when
// unparseable. The Host only ever sees numbers.
export function parseTimecode(text) {
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

export function previewUrl(file) {
  return '/api/media-convert/preview?file=' + encodeURIComponent(file);
}

export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 120) || 'HTTP ' + resp.status);
  }
}

// Media without a picture still needs a probe; this mirrors the Host's rule so
// the UI can grey out impossible targets before a request is made.
export function unavailableTarget(file, target) {
  return Boolean(file && file.kind === 'video' && AUDIO_TARGETS.includes(target) && file.streams && !file.streams.audio);
}

// The trim window described by the two fields; empty fields mean start/end.
export function trimWindow({ file, trimStart, trimEnd, t }) {
  if (!file || file.kind === 'image') return { active: false, start: 0, end: 0, error: '' };
  if (!trimStart.trim() && !trimEnd.trim()) return { active: false, start: 0, end: file.duration || 0, error: '' };
  const start = trimStart.trim() ? parseTimecode(trimStart) : 0;
  const end = trimEnd.trim() ? parseTimecode(trimEnd) : (file.duration || 0);
  if (start === null || Number.isNaN(start) || end === null || Number.isNaN(end)) return { active: false, error: t('trim.invalid') };
  if (!(end > start)) return { active: false, error: t('trim.order') };
  if (file.duration > 0 && end > file.duration + 0.05) return { active: false, error: t('trim.over') };
  return { active: true, start, end, error: '' };
}
