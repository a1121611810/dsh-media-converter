// Pure planning for the media toolkit: media kinds, ffmpeg argument tails,
// stream probing, extraction targets, and the stderr/progress parsing the Host
// needs. No I/O here, so the tests exercise all of it directly.

// The media kinds the toolbox knows. The browser panel imports these types
// (type-only), so the names are part of the plugin's contract.
export type MediaKind = 'video' | 'audio' | 'image' | 'text' | 'file';
// The kinds that have output formats.
export type ConvertKind = 'video' | 'audio' | 'image';
export type FormatTable = Record<ConvertKind, string[]>;
// A trim window in seconds.
export interface TrimWindow {
  start: number;
  end: number;
}

// One stream record of the ffmpeg stderr: the fields every stream carries,
// plus the ones only video or only audio streams carry.
export interface StreamDetail {
  index: number;
  type: string;
  codec: string;
  profile: string;
  tag: string;
  language: string;
  flags: string[];
  tags: Record<string, string>;
  bitrate?: number;
  width?: number;
  height?: number;
  aspect?: string;
  displayAspect?: string;
  fps?: number;
  pixFmt?: string;
  sampleRate?: number;
  channels?: string;
  sampleFmt?: string;
}

// A chapter of the container.
export interface ChapterDetail {
  index: number;
  start: number;
  end: number;
  tags: Record<string, string>;
}

// One subtitle track of the container.
export interface SubtitleDetail {
  index: number;
  codec: string;
  language: string;
  title: string;
}

// The parseMeta() result, written ONCE here (it is a mutable structure, so it
// cannot be inferred): parseMeta fills the fields one by one.
export interface MediaMeta {
  format: string;
  duration: number;
  start: number;
  bitrate: number;
  streams: StreamDetail[];
  chapters: ChapterDetail[];
  tags: Record<string, string>;
  video: StreamDetail | null;
  audio: StreamDetail | null;
  subtitles: SubtitleDetail[];
}
export type StreamMeta = MediaMeta['streams'][number];
export type Chapter = MediaMeta['chapters'][number];
export type SubtitleTrack = MediaMeta['subtitles'][number];
// Derived from the real function, not re-declared:
export type StreamInfo = ReturnType<typeof parseStreams>;

// What one conversion job runs: the output extension, the kind of the result,
// the ffmpeg argument tail, and the optional suffix of the output name.
export interface ConvertPlan {
  ext: string;
  kind: MediaKind;
  args: string[];
  // Input options that must sit before -i (e.g. -hwaccel videotoolbox).
  inputArgs?: string[];
  // True when the job only rewrites the container.
  copy?: boolean;
  // True when the video encoder is Apple VideoToolbox.
  hardware?: boolean;
  // 0 / undefined lets ffmpeg pick its own thread count.
  threads?: number;
  stemSuffix?: string;
}

export const FORMATS: FormatTable = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'ts', 'ogv', 'gif', 'mp3', 'm4a'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff'],
  image: ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif'],
};

export const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  ts: 'video/mp2t',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  ac3: 'audio/ac3',
  eac3: 'audio/eac3',
  mka: 'audio/x-matroska',
  aiff: 'audio/aiff',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  txt: 'text/plain; charset=utf-8',
  srt: 'text/plain; charset=utf-8',
  vtt: 'text/plain; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
};

const KIND_BY_EXT: Record<string, MediaKind> = {
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  avi: 'video',
  flv: 'video',
  wmv: 'video',
  mpg: 'video',
  mpeg: 'video',
  ts: 'video',
  m2ts: 'video',
  '3gp': 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  opus: 'audio',
  aiff: 'audio',
  aif: 'audio',
  wma: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  avif: 'image',
  txt: 'text',
  json: 'text',
  srt: 'text',
  vtt: 'text',
  md: 'text',
};

export function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

export function kindByExt(extension: string): MediaKind {
  return KIND_BY_EXT[String(extension || '').toLowerCase()] || 'file';
}

export function mimeOf(filename: string): string {
  return MIME_BY_EXT[extOf(filename)] || 'application/octet-stream';
}

// Extension first (an image is an image even though ffmpeg calls it a video
// stream); the probe covers extensions we do not know.
export function kindOf(filename: string, stderr = ''): MediaKind | null {
  const known = KIND_BY_EXT[extOf(filename)];
  if (known) return known;
  const streams = parseStreams(stderr);
  if (streams.video) return 'video';
  if (streams.audio) return 'audio';
  return null;
}

// The output formats of a kind; the kinds without formats have none.
export function formatsFor(kind: MediaKind): string[] {
  return kind === 'video' || kind === 'audio' || kind === 'image' ? FORMATS[kind] : [];
}

export function defaultFormat(kind: MediaKind): string {
  return formatsFor(kind)[0] || 'mp4';
}

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];

const VIDEO: Record<string, string[]> = {
  mp4: [...X264, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  mov: [...X264, '-c:a', 'aac', '-b:a', '192k'],
  mkv: [...X264, '-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'],
  avi: ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-b:a', '192k'],
  flv: [...X264, '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'],
  wmv: ['-c:v', 'wmv2', '-q:v', '5', '-c:a', 'wmav2', '-b:a', '128k', '-ar', '44100'],
  ts: [...X264, '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts'],
  ogv: ['-c:v', 'libtheora', '-q:v', '6', '-c:a', 'libvorbis', '-q:a', '4'],
  gif: ['-an', '-vf', "fps=12,scale='min(640,iw)':-2:flags=lanczos", '-loop', '0'],
  mp3: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
};

const AUDIO: Record<string, string[]> = {
  mp3: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  aac: ['-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts'],
  wav: ['-vn', '-c:a', 'pcm_s16le'],
  flac: ['-vn', '-c:a', 'flac'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-vn', '-c:a', 'pcm_s16be'],
};

const IMAGE: Record<string, string[]> = {
  png: ['-frames:v', '1', '-c:v', 'png'],
  jpg: ['-frames:v', '1'],
  webp: ['-frames:v', '1', '-c:v', 'libwebp'],
  gif: ['-frames:v', '1'],
  bmp: ['-frames:v', '1', '-c:v', 'bmp'],
  tiff: ['-frames:v', '1', '-c:v', 'tiff'],
  // libaom defaults to a search-heavy speed; cpu-used 8 keeps a still image
  // under a second instead of tens of seconds.
  avif: ['-frames:v', '1', '-c:v', 'libaom-av1', '-crf', '30', '-cpu-used', '8', '-row-mt', '1', '-still-picture', '1'],
};

// Lossy formats only: the UI shows its quality control for exactly these.
export function supportsQuality(kind: MediaKind, format: string): boolean {
  return kind === 'image' && (format === 'jpg' || format === 'webp');
}

// Split one CPU across concurrent ffmpeg jobs; 0 lets ffmpeg choose.
export function threadArgs(threads?: number): string[] {
  return threads && threads > 1 ? ['-threads', String(threads), '-filter_threads', String(threads)] : [];
}

// Container rewrites that do not re-encode. The video/audio codec matrix is
// deliberately narrow: unknown codecs re-encode instead of risking a broken
// output. A trim window never copies (keyframe seeking would be imprecise).
const COPY_AUDIO: Record<string, string> = {
  mp3: 'mp3',
  m4a: 'aac',
  aac: 'aac',
  flac: 'flac',
  wav: 'pcm_s16le',
  ogg: 'vorbis',
  opus: 'opus',
  aiff: 'pcm_s16be',
};
const COPY_VIDEO: Record<string, { video: string[]; audio: string[]; extra?: string[] }> = {
  mp4: { video: ['h264', 'hevc'], audio: ['aac', 'mp3'], extra: ['-movflags', '+faststart'] },
  mov: { video: ['h264', 'hevc'], audio: ['aac', 'mp3'] },
  mkv: { video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'vorbis', 'mp3', 'flac'] },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
  ts: { video: ['h264', 'hevc'], audio: ['aac', 'mp3'], extra: ['-f', 'mpegts'] },
};

export function copyArgs(kind: MediaKind, format: string, meta: MediaMeta | null | undefined): string[] | null {
  if (!meta) return null;
  const video = String(meta.video?.codec || '').toLowerCase();
  const audio = String(meta.audio?.codec || '').toLowerCase();
  if (kind === 'video' && (format === 'mp3' || format === 'm4a') && audio) {
    if ((format === 'mp3' && audio === 'mp3') || (format === 'm4a' && audio === 'aac')) {
      return ['-vn', '-map', '0:a:0?', '-c:a', 'copy'];
    }
    return null;
  }
  if (kind === 'audio' && COPY_AUDIO[format] && audio === COPY_AUDIO[format]) {
    const args = ['-vn', '-map', '0:a:0?', '-c:a', 'copy'];
    if (format === 'aac') args.push('-f', 'adts');
    return args;
  }
  const rule = COPY_VIDEO[format];
  if (kind !== 'video' || !rule || !video || !rule.video.includes(video)) return null;
  if (audio && !rule.audio.includes(audio)) return null;
  const args = ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
  if (format === 'mp4' && video === 'hevc') args.push('-tag:v', 'hvc1');
  if (rule.extra) args.push(...rule.extra);
  return args;
}

// Apple VideoToolbox H.264. Only the containers that currently use libx264
// are eligible; the quality/bitrate estimate is explained in the UI. Frames
// stay on the GPU end to end: -hwaccel_output_format keeps the decoder's
// videotoolbox_vld frames, which the encoder accepts directly, and no
// -pix_fmt is set on purpose — forcing yuv420p would download every frame
// to the CPU for conversion and defeat the zero-copy path.
const HW_AUDIO: Record<string, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  mov: ['-c:a', 'aac', '-b:a', '192k'],
  mkv: ['-c:a', 'aac', '-b:a', '192k'],
  flv: ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'],
  ts: ['-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts'],
};

export function hardwareFor(
  kind: MediaKind,
  format: string,
  size: number,
  duration: number,
): { args: string[]; inputArgs: string[] } | null {
  const audio = HW_AUDIO[format];
  if (kind !== 'video' || !audio) return null;
  const totalKbps = duration > 0 ? (size * 8) / duration / 1000 : 0;
  const videoKbps = Math.min(12000, Math.max(1500, Math.round(totalKbps - 192)));
  return {
    inputArgs: ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox'],
    args: [
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      videoKbps + 'k',
      '-maxrate',
      Math.round(videoKbps * 1.5) + 'k',
      '-bufsize',
      String(videoKbps * 2) + 'k',
      '-allow_sw',
      '1',
      ...audio,
    ],
  };
}

// 1..100 user quality -> mjpeg qscale (2 best .. 31 worst) or libwebp quality.
function jpegQscale(quality: number): string {
  return String(Math.max(2, Math.round(31 - quality * 0.29)));
}

export function buildArgs(kind: MediaKind, format: string, quality = 90): string[] {
  const table = kind === 'audio' ? AUDIO : kind === 'image' ? IMAGE : VIDEO;
  const base = table[format];
  if (!base) throw new Error(`不支持的输出格式: ${format}`);
  const args = base.slice();
  if (supportsQuality(kind, format)) {
    const q = Math.min(100, Math.max(1, Math.round(Number(quality) || 90)));
    args.push(...(format === 'jpg' ? ['-q:v', jpegQscale(q)] : ['-quality', String(q)]));
  }
  return args;
}

// Trim window in seconds, or null when the request is not a trim. An invalid
// or no-op window degrades to "no trim" instead of cutting a surprise range.
export function normalizeTrim(
  trim: { start?: unknown; end?: unknown } | null | undefined,
  duration: number,
): TrimWindow | null {
  if (!trim) return null;
  let start = Number(trim.start);
  let end = Number(trim.end);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end <= 0) end = Number(duration) || 0;
  if (duration > 0) {
    start = Math.min(start, duration);
    end = Math.min(end, duration);
  }
  if (!(end - start > 0.01)) return null;
  return { start, end };
}

// `-ss`/`-t` before `-i` are input options: ffmpeg seeks first and reads only
// the window, so the cost follows the cut length rather than the file size.
export function trimArgs(trim: TrimWindow | null | undefined): string[] {
  if (!trim) return [];
  const start = Math.max(0, trim.start);
  const length = trim.end - start;
  if (!(length > 0)) return [];
  return ['-ss', start.toFixed(3), '-t', length.toFixed(3)];
}

// ffmpeg writes CRLF line endings on Windows; the parsers below expect plain
// lines, so every stderr sample goes through here first.
export function normalizeStderr(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n');
}

// `ffmpeg -i file` exits non-zero without an output; its stderr is the only
// metadata source, since this plugin ships no ffprobe.
export function parseDuration(stderr: string): number {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// One pass over `ffmpeg -i` stderr — the only metadata source we have (no
// ffprobe ships here). Captures the container line, one record per stream with
// its own tag block, chapters, and the container tags. Everything is
// best-effort; a missing piece stays empty instead of breaking the panel.
const STREAM_FLAGS =
  /\((default|forced|dub|original|comment|attached_pic|hearing_impaired|visual_impaired|clean_effects|timed_thumbnails)\)/g;

function parseStreamLine(index: string, language: string, type: string, descriptor: string): StreamDetail {
  // ffmpeg 7 spells the cover-art flag with a space: "(attached pic)".
  descriptor = descriptor.replace(/attached pic/g, 'attached_pic');
  const chunks = descriptor.split(/,\s*/);
  const first = chunks[0] || '';
  const parens = [...first.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]);
  const stream: StreamDetail = {
    index: Number(index),
    type: String(type).toLowerCase(),
    codec: first.split(' ')[0],
    profile: parens.find((part) => !/\s\/\s*0x/.test(part)) || '',
    tag: (parens.find((part) => /\s\/\s*0x/.test(part)) || '').split(' ')[0],
    language: language || '',
    flags: [...descriptor.matchAll(STREAM_FLAGS)].map((m) => m[1]),
    tags: {},
  };

  const bitrate = /(\d+)\s*kb\/s/.exec(descriptor);
  if (bitrate) stream.bitrate = Number(bitrate[1]);

  if (stream.type === 'video') {
    const size = /(\d{2,5})x(\d{2,5})(?=\s|[,\]])/.exec(descriptor);
    if (size) {
      stream.width = Number(size[1]);
      stream.height = Number(size[2]);
    }
    const sar = /SAR (\d+:\d+)/.exec(descriptor);
    if (sar) stream.aspect = sar[1];
    const dar = /DAR (\d+:\d+)/.exec(descriptor);
    if (dar) stream.displayAspect = dar[1];
    const fps = /([\d.]+)\s*fps\b/.exec(descriptor);
    if (fps) stream.fps = Number(fps[1]);
    const pix = chunks.slice(1).find((chunk) => /^[a-z][a-z0-9]*(\([a-z]+\))?$/.test(chunk));
    if (pix) stream.pixFmt = pix;
  } else if (stream.type === 'audio') {
    const rate = /(\d+)\s*Hz/.exec(descriptor);
    if (rate) stream.sampleRate = Number(rate[1]);
    const words = chunks.slice(1).filter((chunk) => /^[a-z][a-z0-9_.()]*$/i.test(chunk) && !/\d/.test(chunk));
    // The channel layout carries digits (5.1(side)) and never survives the
    // word filter, so match it explicitly before falling back to the words.
    const layout = /(\d\.\d(?:\([^)]*\))?|stereo|mono|quad)/.exec(descriptor);
    if (layout) {
      stream.channels = layout[1];
      stream.sampleFmt = words.find((word) => word !== layout[1]) || undefined;
    } else {
      if (words[0]) stream.channels = words[0];
      if (words[1]) stream.sampleFmt = words[1];
    }
  }
  return stream;
}

export function parseMeta(stderr: string): MediaMeta {
  const text = String(stderr || '');
  const meta: MediaMeta = {
    format: '',
    duration: 0,
    start: 0,
    bitrate: 0,
    streams: [],
    chapters: [],
    tags: {},
    video: null,
    audio: null,
    subtitles: [],
  };

  const input = /^Input #0,\s*(.+?),\s*from\s/m.exec(text);
  if (input) meta.format = input[1].trim();
  // start may be negative (mp3 encoder delay) and bitrate may read N/A
  // (flac/opus); either used to fail the whole line and zero every field.
  const header = /Duration:\s*(\d+):(\d+):([\d.]+),\s*start:\s*(-?[\d.]+),\s*bitrate:\s*(?:(\d+)\s*kb\/s|N\/A)/.exec(
    text,
  );
  if (header) {
    meta.duration = Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]);
    meta.start = Number(header[4]);
    meta.bitrate = Number(header[5] || 0);
  } else {
    meta.duration = parseDuration(text);
  }

  let target = meta.tags;
  let inMetadata = false;
  for (const line of text.split('\n')) {
    if (/^\s*Metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (/^\s*(Input|Output) #\d+/.test(line)) {
      inMetadata = false;
      target = meta.tags;
      continue;
    }
    if (/^\s*Duration:/.test(line)) {
      inMetadata = false;
      continue;
    }
    const chapter = /^\s*Chapter #0:(\d+):\s*start\s*([\d.-]+),\s*end\s*([\d.-]+)/.exec(line);
    if (chapter) {
      inMetadata = false;
      const entry: ChapterDetail = {
        index: Number(chapter[1]),
        start: Number(chapter[2]),
        end: Number(chapter[3]),
        tags: {},
      };
      meta.chapters.push(entry);
      target = entry.tags;
      continue;
    }
    const stream =
      /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([a-z]{3})\))?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*(.+)$/.exec(
        line,
      );
    if (stream) {
      inMetadata = false;
      const entry = parseStreamLine(stream[1], stream[2], stream[3], stream[4]);
      meta.streams.push(entry);
      target = entry.tags;
      continue;
    }
    if (inMetadata) {
      const tag = /^\s+([\w-]+)\s*:\s*(.*)$/.exec(line);
      // Containers disagree on tag case (matroska writes ARTIST, mp4 writes artist).
      if (tag) target[tag[1].toLowerCase()] = tag[2].trim();
    }
  }

  return finishMeta(meta);
}

// The tail every metadata source runs through: pick the picture and audio
// tracks and collect the subtitle tracks. A cover image rides an attached_pic
// video stream; it is artwork, not the picture track, so every "the video of
// this file" lookup skips it.
function finishMeta(meta: MediaMeta): MediaMeta {
  meta.video = meta.streams.find((item) => item.type === 'video' && !item.flags.includes('attached_pic')) || null;
  meta.audio = meta.streams.find((item) => item.type === 'audio') || null;
  meta.subtitles = meta.streams
    .filter((item) => item.type === 'subtitle')
    .map((item) => ({ index: item.index, codec: item.codec, language: item.language, title: item.tags.title || '' }));
  return meta;
}

export function parseStreams(stderr: string) {
  return streamInfoOf(parseMeta(stderr));
}

// The parseStreams() shape built straight from a parsed meta, so the ffprobe
// route can produce the identical structure without re-parsing stderr.
export function streamInfoOf(meta: MediaMeta) {
  return {
    video: Boolean(meta.video),
    audio: Boolean(meta.audio),
    videoCodec: meta.video ? meta.video.codec : '',
    audioCodec: meta.audio ? meta.audio.codec : '',
    subtitles: meta.subtitles,
  };
}

// --- ffprobe JSON ------------------------------------------------------------
// When an ffprobe binary sits next to ffmpeg the host prefers it: its JSON is
// structured instead of banner text, so nothing here can be defeated by a
// format tweak. The result is the SAME MediaMeta the stderr parser produces;
// anything unusable returns null and the caller falls back to stderr.

function numOr(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function lowerTags(tags: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (tags && typeof tags === 'object') {
    for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
      out[key.toLowerCase()] = String(value);
    }
  }
  return out;
}

const DISPOSITION_FLAGS = [
  'default',
  'forced',
  'dub',
  'original',
  'comment',
  'attached_pic',
  'hearing_impaired',
  'visual_impaired',
  'clean_effects',
  'timed_thumbnails',
];

// "30/1" -> 30, "30000/1001" -> 29.97, "0/0" (images) -> 0.
function fpsOf(rate: unknown): number {
  const [num, den] = String(rate || '').split('/');
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return Math.round((n / d) * 1000) / 1000;
}

function ffprobeStream(raw: unknown, position: number): StreamDetail {
  const s = (raw || {}) as Record<string, unknown>;
  const tags = lowerTags(s.tags);
  const disposition = (s.disposition || {}) as Record<string, unknown>;
  const stream: StreamDetail = {
    index: Number.isFinite(Number(s.index)) ? Number(s.index) : position,
    type: String(s.codec_type || '').toLowerCase(),
    codec: String(s.codec_name || ''),
    profile: String(s.profile || ''),
    tag: String(s.codec_tag_string || ''),
    language: tags.language || '',
    flags: DISPOSITION_FLAGS.filter((flag) => Boolean(Number(disposition[flag]))),
    tags,
  };
  if (s.bit_rate !== undefined) {
    const kbps = Math.round(numOr(s.bit_rate) / 1000);
    if (kbps > 0) stream.bitrate = kbps;
  }
  if (stream.type === 'video') {
    if (s.width) stream.width = numOr(s.width);
    if (s.height) stream.height = numOr(s.height);
    if (s.sample_aspect_ratio && !/^(?:0:0|N\/A)$/.test(String(s.sample_aspect_ratio)))
      stream.aspect = String(s.sample_aspect_ratio);
    if (s.display_aspect_ratio && !/^(?:0:0|N\/A)$/.test(String(s.display_aspect_ratio)))
      stream.displayAspect = String(s.display_aspect_ratio);
    const fps = fpsOf(s.avg_frame_rate) || fpsOf(s.r_frame_rate);
    if (fps > 0) stream.fps = fps;
    if (s.pix_fmt) stream.pixFmt = String(s.pix_fmt);
  } else if (stream.type === 'audio') {
    if (s.sample_rate) stream.sampleRate = numOr(s.sample_rate);
    // channel_layout already reads like the stderr labels ("5.1(side)").
    if (s.channel_layout) stream.channels = String(s.channel_layout);
    else if (s.channels) stream.channels = String(s.channels);
    if (s.sample_fmt) stream.sampleFmt = String(s.sample_fmt);
  }
  return stream;
}

export function parseFfprobeJson(text: string): MediaMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;
  const fmt = (doc.format || {}) as Record<string, unknown>;
  const rawStreams = Array.isArray(doc.streams) ? doc.streams : [];
  if (!doc.format && rawStreams.length === 0) return null;

  const meta: MediaMeta = {
    format: String(fmt.format_name || ''),
    duration: numOr(fmt.duration),
    start: numOr(fmt.start_time),
    bitrate: Math.round(numOr(fmt.bit_rate) / 1000),
    streams: rawStreams.map((stream, position) => ffprobeStream(stream, position)),
    chapters: [],
    tags: lowerTags(fmt.tags),
    video: null,
    audio: null,
    subtitles: [],
  };
  if (Array.isArray(doc.chapters)) {
    meta.chapters = doc.chapters.map((rawChapter, position) => {
      const chapter = (rawChapter || {}) as Record<string, unknown>;
      return {
        index: Number.isFinite(Number(chapter.id)) ? Number(chapter.id) : position,
        start: numOr(chapter.start_time),
        end: numOr(chapter.end_time),
        tags: lowerTags(chapter.tags),
      };
    });
  }
  return finishMeta(meta);
}

const AUDIO_CONTAINER: Record<string, string> = {
  aac: 'm4a',
  alac: 'm4a',
  mp3: 'mp3',
  ac3: 'ac3',
  eac3: 'eac3',
  opus: 'ogg',
  vorbis: 'ogg',
  flac: 'flac',
};
const VIDEO_CONTAINER: Record<string, string> = {
  h264: 'mp4',
  hevc: 'mp4',
  av1: 'mp4',
  mpeg4: 'mp4',
  mpeg2video: 'mp4',
  vp8: 'webm',
  vp9: 'webm',
  theora: 'webm',
};

// Stream copy: separating the tracks costs a container rewrite, not an encode.
export function extractPlan(streams: StreamInfo, which: 'audio' | 'video'): ConvertPlan {
  if (which === 'audio') {
    if (!streams || !streams.audio) throw new Error('该文件没有音轨');
    const codec = streams.audioCodec || '';
    const ext = AUDIO_CONTAINER[codec] || (codec.startsWith('pcm_') ? 'wav' : 'm4a');
    return { ext, kind: 'audio', args: ['-map', '0:a:0', '-vn', '-c:a', 'copy'] };
  }
  if (!streams || !streams.video) throw new Error('该文件没有画面');
  const ext = VIDEO_CONTAINER[streams.videoCodec] || 'mkv';
  return { ext, kind: 'video', args: ['-map', '0:v:0', '-an', '-c:v', 'copy'] };
}

// Embedded subtitle track -> plain .srt; the language code keeps multi-track
// exports distinguishable in the output folder.
export function subtitlePlan(streams: StreamInfo, ordinal: number | string | undefined): ConvertPlan {
  const track = streams && streams.subtitles ? streams.subtitles[Number(ordinal)] : null;
  if (!track) throw new Error('这条字幕轨不存在');
  return {
    ext: 'srt',
    kind: 'text',
    args: ['-map', `0:s:${Number(ordinal)}`, '-c:s', 'srt'],
    stemSuffix: track.language ? '.' + track.language : '',
  };
}

const TAG_KEYS = ['title', 'artist', 'album', 'comment', 'date', 'genre'];

// Rewrite container tags without touching the streams. Only keys with content
// are written, so an empty field never clears what the file already had.
export function metaArgs(tags: Record<string, string> | null | undefined): string[] {
  const args = ['-map', '0', '-c', 'copy'];
  for (const key of TAG_KEYS) {
    const value = String((tags && tags[key]) || '').trim();
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  return args;
}

// One `-progress pipe:1` report line (`out_time_us=1234` / `out_time_ms=...`
// is microseconds too on current ffmpeg) as seconds, or null.
export function progressSeconds(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(String(line || '').trim());
  return m ? Number(m[1]) / 1e6 : null;
}

export function percentOf(seconds: number, duration: number): number | null {
  if (!duration) return null;
  return Math.max(0, Math.min(99, Math.round((seconds / duration) * 100)));
}
