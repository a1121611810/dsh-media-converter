// Pure planning for the media toolkit: media kinds, ffmpeg argument tails,
// stream probing, extraction targets, and the stderr/progress parsing the Host
// needs. No I/O here, so the tests exercise all of it directly.

export const FORMATS = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'ts', 'ogv', 'gif', 'mp3', 'm4a'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff'],
  image: ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif'],
};

export const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', gif: 'image/gif',
  flv: 'video/x-flv', wmv: 'video/x-ms-wmv', ts: 'video/mp2t', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', ac3: 'audio/ac3',
  eac3: 'audio/eac3', mka: 'audio/x-matroska', aiff: 'audio/aiff',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff', avif: 'image/avif',
  txt: 'text/plain; charset=utf-8', srt: 'text/plain; charset=utf-8',
  vtt: 'text/plain; charset=utf-8', ass: 'text/plain; charset=utf-8',
};

const KIND_BY_EXT = {
  mp4: 'video', m4v: 'video', mov: 'video', mkv: 'video', webm: 'video',
  avi: 'video', flv: 'video', wmv: 'video', mpg: 'video', mpeg: 'video',
  ts: 'video', m2ts: 'video', '3gp': 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio',
  ogg: 'audio', opus: 'audio', aiff: 'audio', aif: 'audio', wma: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', heic: 'image', avif: 'image',
  txt: 'text', json: 'text', srt: 'text', vtt: 'text', md: 'text',
};

export function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

export function kindByExt(extension) {
  return KIND_BY_EXT[String(extension || '').toLowerCase()] || 'file';
}

export function mimeOf(filename) {
  return MIME_BY_EXT[extOf(filename)] || 'application/octet-stream';
}

// Extension first (an image is an image even though ffmpeg calls it a video
// stream); the probe covers extensions we do not know.
export function kindOf(filename, stderr = '') {
  const known = KIND_BY_EXT[extOf(filename)];
  if (known) return known;
  const streams = parseStreams(stderr);
  if (streams.video) return 'video';
  if (streams.audio) return 'audio';
  return null;
}

export function defaultFormat(kind) {
  return (FORMATS[kind] || [])[0] || 'mp4';
}

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];

const VIDEO = {
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

const AUDIO = {
  mp3: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  aac: ['-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts'],
  wav: ['-vn', '-c:a', 'pcm_s16le'],
  flac: ['-vn', '-c:a', 'flac'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-vn', '-c:a', 'pcm_s16be'],
};

const IMAGE = {
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
export function supportsQuality(kind, format) {
  return kind === 'image' && (format === 'jpg' || format === 'webp');
}

// 1..100 user quality -> mjpeg qscale (2 best .. 31 worst) or libwebp quality.
function jpegQscale(quality) {
  return String(Math.max(2, Math.round(31 - quality * 0.29)));
}

export function buildArgs(kind, format, quality = 90) {
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
export function normalizeTrim(trim, duration) {
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
export function trimArgs(trim) {
  if (!trim) return [];
  const start = Math.max(0, trim.start);
  const length = trim.end - start;
  if (!(length > 0)) return [];
  return ['-ss', start.toFixed(3), '-t', length.toFixed(3)];
}

// ffmpeg writes CRLF line endings on Windows; the parsers below expect plain
// lines, so every stderr sample goes through here first.
export function normalizeStderr(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

// `ffmpeg -i file` exits non-zero without an output; its stderr is the only
// metadata source, since this plugin ships no ffprobe.
export function parseDuration(stderr) {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// One pass over `ffmpeg -i` stderr — the only metadata source we have (no
// ffprobe ships here). Captures the container line, one record per stream with
// its own tag block, chapters, and the container tags. Everything is
// best-effort; a missing piece stays empty instead of breaking the panel.
const STREAM_FLAGS = /\((default|forced|dub|original|comment|attached_pic|hearing_impaired|visual_impaired|clean_effects|timed_thumbnails)\)/g;

function parseStreamLine(index, language, type, descriptor) {
  const chunks = descriptor.split(/,\s*/);
  const first = chunks[0] || '';
  const parens = [...first.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]);
  const stream = {
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
    // "stereo", then "fltp"; a layout with digits (5.1(side)) is skipped.
    const words = chunks.slice(1).filter((chunk) => /^[a-z][a-z0-9_.()]*$/i.test(chunk) && !/\d/.test(chunk));
    if (words[0]) stream.channels = words[0];
    if (words[1]) stream.sampleFmt = words[1];
  }
  return stream;
}

export function parseMeta(stderr) {
  const text = String(stderr || '');
  const meta = { format: '', duration: 0, start: 0, bitrate: 0, streams: [], chapters: [], tags: {}, video: null, audio: null, subtitles: [] };

  const input = /^Input #0,\s*(.+?),\s*from\s/m.exec(text);
  if (input) meta.format = input[1].trim();
  const header = /Duration:\s*(\d+):(\d+):([\d.]+),\s*start:\s*([\d.]+),\s*bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (header) {
    meta.duration = Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]);
    meta.start = Number(header[4]);
    meta.bitrate = Number(header[5]);
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
      const entry = { index: Number(chapter[1]), start: Number(chapter[2]), end: Number(chapter[3]), tags: {} };
      meta.chapters.push(entry);
      target = entry.tags;
      continue;
    }
    const stream = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([a-z]{3})\))?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*(.+)$/.exec(line);
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

  meta.video = meta.streams.find((item) => item.type === 'video') || null;
  meta.audio = meta.streams.find((item) => item.type === 'audio') || null;
  meta.subtitles = meta.streams
    .filter((item) => item.type === 'subtitle')
    .map((item) => ({ index: item.index, codec: item.codec, language: item.language, title: item.tags.title || '' }));
  return meta;
}

export function parseStreams(stderr) {
  const meta = parseMeta(stderr);
  return {
    video: Boolean(meta.video),
    audio: Boolean(meta.audio),
    videoCodec: meta.video ? meta.video.codec : '',
    audioCodec: meta.audio ? meta.audio.codec : '',
    subtitles: meta.subtitles,
  };
}

const AUDIO_CONTAINER = {
  aac: 'm4a', alac: 'm4a', mp3: 'mp3', ac3: 'ac3', eac3: 'eac3',
  opus: 'ogg', vorbis: 'ogg', flac: 'flac',
};
const VIDEO_CONTAINER = { h264: 'mp4', hevc: 'mp4', av1: 'mp4', mpeg4: 'mp4', mpeg2video: 'mp4', vp8: 'webm', vp9: 'webm', theora: 'webm' };

// Stream copy: separating the tracks costs a container rewrite, not an encode.
export function extractPlan(streams, which) {
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
export function subtitlePlan(streams, ordinal) {
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
export function metaArgs(tags) {
  const args = ['-map', '0', '-c', 'copy'];
  for (const key of TAG_KEYS) {
    const value = String((tags && tags[key]) || '').trim();
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  return args;
}

// One `-progress pipe:1` report line (`out_time_us=1234` / `out_time_ms=...`
// is microseconds too on current ffmpeg) as seconds, or null.
export function progressSeconds(line) {
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(String(line || '').trim());
  return m ? Number(m[1]) / 1e6 : null;
}

export function percentOf(seconds, duration) {
  if (!duration) return null;
  return Math.max(0, Math.min(99, Math.round((seconds / duration) * 100)));
}
