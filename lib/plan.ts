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
  // Input options that must sit before -i (e.g. -hwaccel cuda or the concat
  // demuxer's -f concat -safe 0).
  inputArgs?: string[];
  // Overrides the input path (the concat list file); duration and progress
  // still come from the upload view the caller hands to startJob.
  input?: string;
  // True when the job only rewrites the container.
  copy?: boolean;
  // True when the video encoder runs on the graphics card.
  hardware?: boolean;
  // Appended on the software-decode retry (see HwBackend.retryArgs).
  retryArgs?: string[];
  // 0 / undefined lets ffmpeg pick its own thread count.
  threads?: number;
  stemSuffix?: string;
  // Scratch files (watermark text) the caller removes when the job settles.
  scratch?: string[];
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

// Software codec variants for containers that can hold more than one
// mainstream encoder. The built-in recipe stays libx264; an explicit pick
// swaps the encoder and its quality curve. Like the hardware path, a pick
// the container cannot honor (e.g. hevc-in-webm) quietly falls back to the
// default recipe instead of a doomed ffmpeg command.
const SW_CODECS: Record<string, Record<string, string[]>> = {
  mp4: {
    hevc: [
      '-c:v',
      'libx265',
      '-crf',
      '28',
      '-preset',
      'medium',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-tag:v',
      'hvc1',
      '-movflags',
      '+faststart',
    ],
    av1: ['-c:v', 'libsvtav1', '-crf', '32', '-preset', '6', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  },
  mov: {
    hevc: ['-c:v', 'libx265', '-crf', '28', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-tag:v', 'hvc1'],
    av1: ['-c:v', 'libsvtav1', '-crf', '32', '-preset', '6', '-c:a', 'aac', '-b:a', '192k'],
  },
  mkv: {
    hevc: ['-c:v', 'libx265', '-crf', '28', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k'],
    av1: ['-c:v', 'libsvtav1', '-crf', '32', '-preset', '6', '-c:a', 'aac', '-b:a', '192k'],
  },
};

// 1..100 user quality -> x265 CRF: 90 (the default) keeps the recipe's 28.
// shortcut: 常用文献值，未经 VMAF 实测；上线后补实测再校准。
function x265CrfOf(quality: number): number {
  return Math.min(34, Math.max(22, Math.round(28 + (90 - quality) * 0.12)));
}

// 1..100 user quality -> SVT-AV1 CRF: 90 keeps the recipe's 32. AV1 tolerates
// much higher CRFs than x264 before falling apart, hence the wider clamp.
// shortcut: 常用文献值，未经 VMAF 实测；上线后补实测再校准。
function svtCrfOf(quality: number): number {
  return Math.min(45, Math.max(20, Math.round(32 + (90 - quality) * 0.3)));
}

// --- R5: speed / loudnorm / watermark / burn / snapshot ---------------------
// Speed factor -> the two filter segments. atempo only covers [0.5, 2] per
// segment, so extreme factors chain several; setpts rides the video chain
// FIRST (timing before geometry).
export function speedSegments(factor: number): { vf: string; af: string } | null {
  const speed = Number(factor);
  if (!(speed > 0) || speed === 1) return null;
  if (speed < 0.25 || speed > 4) throw new Error('speed 必须在 0.25–4 之间');
  const parts: string[] = [];
  let rest = speed;
  while (rest < 0.5 - 1e-9) {
    parts.push('atempo=0.5');
    rest /= 0.5;
  }
  while (rest > 2 + 1e-9) {
    parts.push('atempo=2');
    rest /= 2;
  }
  parts.push(`atempo=${String(Math.round(rest * 1000) / 1000)}`);
  return { vf: `setpts=PTS/${String(speed)}`, af: parts.join(',') };
}

// Single-pass loudnorm. shortcut: 单遍精度弱于双遍分析，等真实需求再补。
export function loudnormSegment(): string {
  return 'loudnorm=I=-16:TP=-1.5:LRA=11';
}

const WM_POS: Record<string, { x: string; y: string }> = {
  tl: { x: '24', y: '24' },
  tr: { x: 'w-tw-24', y: '24' },
  bl: { x: '24', y: 'h-th-24' },
  br: { x: 'w-tw-24', y: 'h-th-24' },
};
export const WM_POS_KEYS = Object.keys(WM_POS);

// drawtext rides the TAIL of the video chain (after scale/burn). textfile
// (not text=) sidesteps every escaping nightmare; paths are quoted, and
// backslashes become slashes for the filter parser.
export function watermarkSegment(opts: { fontFile: string; textFile: string; size: number; pos: string }): string {
  const pos = WM_POS[opts.pos] || WM_POS.br;
  const font = opts.fontFile.replace(/\\/g, '/');
  const text = opts.textFile.replace(/\\/g, '/');
  return (
    `drawtext=fontfile='${font}':textfile='${text}':fontsize=${Math.round(opts.size)}` +
    `:fontcolor=white:box=1:boxcolor=black@0.4:boxborderw=8:x=${pos.x}:y=${pos.y}`
  );
}

// subtitles=filename= is the explicit-option form every current ffmpeg
// accepts (the bare positional form was retired). Colons are escaped for
// Windows drive letters; backslashes become slashes.
export function burnSegment(srtFile: string, fontsDir: string): string {
  const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return `subtitles=filename=${esc(srtFile)}:fontsdir=${esc(fontsDir)}`;
}

// One frame at `at` seconds via input options (a trim would fight -frames:v).
export function snapshotPlan(at: number, format: string): ConvertPlan {
  const when = Math.max(0, Number(at) || 0);
  const ext = format === 'jpg' ? 'jpg' : 'png';
  return {
    ext,
    kind: 'image',
    inputArgs: ['-ss', when.toFixed(3)],
    args: ['-frames:v', '1', ...(ext === 'jpg' ? ['-q:v', '2'] : [])],
  };
}

// Lossy formats only: the UI shows its quality control for exactly these.
// Video: the X264 containers take quality as CRF; webm as VP9 CRF; avi/wmv/ogv
// as codec qscale. Images: jpg/webp take their own scale, avif as AV1 CRF.
// The client mirrors this (lib.ts); the two must stay in sync.
export function supportsQuality(kind: MediaKind, format: string): boolean {
  return (
    (kind === 'image' && ['jpg', 'webp', 'avif'].includes(format)) ||
    (kind === 'video' && ['mp4', 'mov', 'mkv', 'flv', 'ts', 'webm', 'avi', 'wmv', 'ogv'].includes(format))
  );
}

// Lossy audio formats only: the bitrate control shows for exactly these,
// including a video file turned into mp3/m4a (an audio-encode target). The
// client mirrors this (lib.ts); the two must stay in sync.
export function supportsBitrate(kind: MediaKind, format: string): boolean {
  return (
    ['mp3', 'm4a', 'aac', 'opus'].includes(format) &&
    (kind === 'audio' || (kind === 'video' && (format === 'mp3' || format === 'm4a')))
  );
}

// Audio-encode targets: an audio file of any format, or a video file turned
// into mp3/m4a. The channel/sample-rate controls show for exactly these; a
// silent-picture format never is one. The client mirrors this (lib.ts).
export function supportsAudioTune(kind: MediaKind, format: string): boolean {
  return kind === 'audio' || (kind === 'video' && (format === 'mp3' || format === 'm4a'));
}

// Video-encode targets: every video conversion except the audio-only ones
// (mp3/m4a carry no picture). The fps/width controls show for exactly these.
// The client mirrors this (lib.ts).
export function supportsVideoTune(kind: MediaKind, format: string): boolean {
  return kind === 'video' && format !== 'mp3' && format !== 'm4a';
}

// The recipe's own -b:a value, the anchor for "explicitly asked for the
// default" (keeps the copy fast path) vs "a real re-encode request".
export function defaultBitrate(format: string): number {
  return format === 'opus' ? 128 : 192;
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
  mp4: {
    video: ['h264', 'hevc', 'vp9', 'av1'],
    audio: ['aac', 'mp3', 'flac', 'alac', 'opus'],
    extra: ['-movflags', '+faststart'],
  },
  mov: { video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'alac'] },
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

// The hardware encoders the toolkit can drive, one row per vendor. The
// probe picks the first row this machine can really run; the row itself says
// which encoder to call, how to keep the frames on the GPU, and the few rate
// control options the encoder needs before -b:v means anything.
export type HwBackendId = 'videotoolbox' | 'nvenc' | 'qsv' | 'amf' | 'vaapi';

export interface HwBackend {
  id: HwBackendId;
  // Shown in the panel; a vendor name needs no translation.
  label: string;
  encoder: string;
  // The H.265 sibling of `encoder`, device-verified separately: a GPU old
  // enough to lack HEVC encoding keeps working, just without the codec choice.
  hevcEncoder: string;
  // The name -hwaccels reports for this vendor's hardware decoder.
  hwaccel: string;
  // Input options, before -i: hardware decode that feeds the encoder directly.
  decodeArgs: string[];
  // Encoder options that make -b:v/-maxrate mean what they say.
  rateArgs: string[];
  // Args the software-decode retry adds: VAAPI-family encoders only eat
  // device-memory frames, so the retry (which drops -hwaccel) must upload them.
  retryArgs?: string[];
}

export const HW_BACKENDS: Record<HwBackendId, HwBackend> = {
  videotoolbox: {
    id: 'videotoolbox',
    label: 'Apple VideoToolbox',
    encoder: 'h264_videotoolbox',
    hevcEncoder: 'hevc_videotoolbox',
    hwaccel: 'videotoolbox',
    decodeArgs: ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox'],
    // VideoToolbox's own fallback switch: software encode if the GPU says no.
    rateArgs: ['-allow_sw', '1'],
  },
  nvenc: {
    id: 'nvenc',
    label: 'NVIDIA NVENC',
    encoder: 'h264_nvenc',
    hevcEncoder: 'hevc_nvenc',
    hwaccel: 'cuda',
    decodeArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    // Without an explicit rate control mode NVENC decides on its own what
    // -b:v means.
    rateArgs: ['-rc', 'vbr'],
  },
  qsv: {
    id: 'qsv',
    label: 'Intel Quick Sync',
    encoder: 'h264_qsv',
    hevcEncoder: 'hevc_qsv',
    hwaccel: 'qsv',
    decodeArgs: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
    // No rate option needed: QSV reads -b:v plus -maxrate as VBR on its own.
    rateArgs: [],
  },
  amf: {
    id: 'amf',
    label: 'AMD AMF',
    encoder: 'h264_amf',
    hevcEncoder: 'hevc_amf',
    hwaccel: 'd3d11va',
    // d3d11 (not d3d11va) is what the AMF encoder takes without a copy.
    decodeArgs: ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'],
    // AMF would otherwise run constant QP and ignore -b:v entirely.
    rateArgs: ['-rc', 'vbr_peak'],
  },
  vaapi: {
    id: 'vaapi',
    label: 'VAAPI',
    encoder: 'h264_vaapi',
    hevcEncoder: 'hevc_vaapi',
    hwaccel: 'vaapi',
    decodeArgs: ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi'],
    // Without an explicit mode VAAPI runs constant QP and ignores -b:v.
    rateArgs: ['-rc_mode', 'VBR'],
    retryArgs: ['-vf', 'format=nv12|vaapi,hwupload'],


  },
};

// Hardware H.264. Only the containers that currently use libx264 are
// eligible; the quality/bitrate estimate is explained in the UI. Frames stay
// on the GPU end to end: -hwaccel_output_format keeps the decoder's hardware
// frames, which the encoder accepts directly, and no -pix_fmt is set on
// purpose — forcing yuv420p would download every frame to the CPU for
// conversion and defeat the zero-copy path.
const HW_AUDIO: Record<string, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
  mov: ['-c:a', 'aac', '-b:a', '192k'],
  mkv: ['-c:a', 'aac', '-b:a', '192k'],
  flv: ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'],
  ts: ['-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts'],
};

// The containers the hardware plan re-encodes an audio track for; planFor's
// copy gate uses this so an explicit audio ask reaches the hardware branch
// instead of coming back as a copied stream.
export function supportsHardwareAudio(format: string): boolean {
  return Boolean(HW_AUDIO[format]);
}

// HEVC-in-FLV is non-standard, so the codec choice stops at the containers
// where HEVC belongs; mp4/mov additionally need the hvc1 tag Apple players
// require (the same tag copyArgs already writes for stream copies).
const HEVC_FORMATS = new Set(['mp4', 'mov', 'mkv', 'ts']);

export function hardwareFor(
  backend: HwBackend,
  kind: MediaKind,
  format: string,
  size: number,
  duration: number,
  quality?: number,
  codec?: string,
  bitrate?: number,
  channels?: number,
  sampleRate?: number,
): { args: string[]; inputArgs: string[]; retryArgs?: string[] } | null {
  const audio = HW_AUDIO[format];
  if (kind !== 'video' || !audio) return null;
  const wantHevc = codec === 'hevc' && HEVC_FORMATS.has(format);
  const encoder = wantHevc ? backend.hevcEncoder : backend.encoder;
  const totalKbps = duration > 0 ? (size * 8) / duration / 1000 : 0;
  const q = Math.min(100, Math.max(1, Math.round(Number(quality) || 90)));
  const videoKbps = Math.min(12000, Math.max(1500, Math.round((totalKbps - 192) * hwFactorOf(q))));
  return {
    inputArgs: [...backend.decodeArgs],
    ...(backend.retryArgs ? { retryArgs: backend.retryArgs } : {}),
    args: [
      '-c:v',
      encoder,
      '-b:v',
      videoKbps + 'k',
      // -maxrate stays: QSV reads -b:v plus -maxrate as VBR and falls back to
      // constant QP (an uncontrolled bitrate) when it is missing.
      '-maxrate',
      Math.round(videoKbps * 1.5) + 'k',
      '-bufsize',
      String(videoKbps * 2) + 'k',
      // Apple players refuse HEVC in mp4/mov without the hvc1 tag.
      ...(wantHevc && (format === 'mp4' || format === 'mov') ? ['-tag:v', 'hvc1'] : []),
      ...backend.rateArgs,
      // The audio track is software-encoded on the GPU path too, so the same
      // three knobs apply; absent values leave the recipe untouched.
      ...applyAudioTune(audio.slice(), bitrate, channels, sampleRate),
    ],
  };
}

// 1..100 user quality -> mjpeg qscale (2 best .. 31 worst) or libwebp quality.
function jpegQscale(quality: number): string {
  return String(Math.max(2, Math.round(31 - quality * 0.29)));
}

// 1..100 user quality -> x264 CRF: 90 (the default) keeps the recipe's 23,
// higher is better; clamped to the range that still makes visual sense.
function crfOf(quality: number): number {
  return Math.min(32, Math.max(18, Math.round(23 + (90 - quality) * 0.1)));
}

// 1..100 user quality -> VP9 CRF: 90 keeps the recipe's 32. VP9 tolerates much
// higher CRFs than x264 before falling apart, hence the wider clamp.
function vp9CrfOf(quality: number): number {
  return Math.min(45, Math.max(15, Math.round(32 + (90 - quality) * 0.3)));
}

// 1..100 user quality -> Theora -q:v (0 best .. 10 worst): 90 keeps 6.
function theoraQscale(quality: number): number {
  return Math.min(10, Math.max(0, Math.round(6 + (90 - quality) * 0.06)));
}

// 1..100 user quality -> libaom AV1 CRF: 90 keeps the recipe's 30. AV1
// tolerates much higher CRFs than x264 before falling apart, hence the wider
// clamp. libaom has no -quality option, so this rides -crf like the videos.
function avifCrfOf(quality: number): number {
  return Math.min(45, Math.max(20, Math.round(30 + (90 - quality) * 0.3)));
}

// Hardware encoders have no CRF (a probe of h264_videotoolbox shows no
// quality option at all), so quality scales the bitrate the plan derives
// from the source file: 90 (the default) leaves it unchanged.
function hwFactorOf(quality: number): number {
  return Math.min(1.6, Math.max(0.4, 1 + (quality - 90) * 0.01));
}

// The three audio-track knobs in one home so the clamps live once: an
// explicit bitrate rewrites the recipe's -b:a, channels/sample-rate write
// -ac/-ar (rewriting a recipe value when it already carries one). Zero,
// absent or garbage anywhere means "keep the recipe/source" — a no-op.
export function applyAudioTune(args: string[], bitrate?: number, channels?: number, sampleRate?: number): string[] {
  if (Number.isFinite(Number(bitrate)) && Number(bitrate) > 0) {
    const at = args.indexOf('-b:a');
    if (at >= 0) args[at + 1] = String(Math.min(320, Math.max(32, Math.round(Number(bitrate))))) + 'k';
  }
  if (Number(channels) > 0) args.push('-ac', String(Math.min(2, Math.max(1, Math.round(Number(channels))))));
  if (Number(sampleRate) > 0) {
    const value = String(Math.min(96000, Math.max(8000, Math.round(Number(sampleRate)))));
    const at = args.indexOf('-ar');
    if (at >= 0) args[at + 1] = value;
    else args.push('-ar', value);
  }
  return args;
}

// The picture knobs a conversion can carry: a crop window, a rotation and a
// flip. Canonical -vf order (crop -> transpose -> flip -> fps -> scale) is
// built in buildArgs; this only validates.
export interface VideoGeometry {
  // 'w:h[:x[:y]]'
  crop?: string;
  // 90 / 180 / 270
  rotate?: number;
  // 'h' | 'v'
  flip?: string;
}

// Truthy-but-malformed geometry is an error, not a silent drop: a wrong crop
// string would otherwise "succeed" as a no-op and the user never knows.
export function normalizeGeometry(raw: {
  crop?: unknown;
  rotate?: unknown;
  flip?: unknown;
}): VideoGeometry | undefined {
  const out: VideoGeometry = {};
  const crop = String(raw.crop || '').trim();
  if (crop) {
    if (!/^\d{1,5}:\d{1,5}(?::\d{1,5})?(?::\d{1,5})?$/.test(crop)) {
      throw new Error(`crop 格式必须是 宽:高[:x[:y]]: ${crop}`);
    }
    const [w, h] = crop.split(':').map(Number);
    if (w % 2 || h % 2) throw new Error(`crop 宽高必须是偶数（yuv420p 要求）: ${crop}`);
    out.crop = crop;
  }
  const rotate = Number(raw.rotate);
  if (rotate) {
    if (rotate !== 90 && rotate !== 180 && rotate !== 270) throw new Error('rotate 只支持 90/180/270');
    out.rotate = rotate;
  }
  const flip = String(raw.flip || '').trim();
  if (flip) {
    if (flip !== 'h' && flip !== 'v') throw new Error("flip 只支持 'h'（水平）/ 'v'（垂直）");
    out.flip = flip;
  }
  return out.crop || out.rotate || out.flip ? out : undefined;
}

// The explicit remux escape hatch: copy whatever fits the target container
// and let ffmpeg itself be the validator — an impossible combination is an
// error row, never a silent re-encode.
export function forceRemuxArgs(format: string): string[] {
  const args = ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
  if (format === 'mp4') args.push('-movflags', '+faststart');
  return args;
}

export function buildArgs(
  kind: MediaKind,
  format: string,
  quality = 90,
  bitrate?: number,
  fps?: number,
  width?: number,
  channels?: number,
  sampleRate?: number,
  codec?: unknown,
  geometry?: VideoGeometry,
  filters?: { speed?: number; loudnorm?: boolean; extraVf?: string[]; extraAf?: string[] },
): string[] {
  const table = kind === 'audio' ? AUDIO : kind === 'image' ? IMAGE : VIDEO;
  // An explicit software pick swaps the recipe; an unsupported combination
  // (hevc-in-webm) falls back to the default, mirroring the hardware path.
  const pick = kind === 'video' ? String(codec || '') : '';
  const variant = pick && pick !== 'h264' ? SW_CODECS[format]?.[pick] : undefined;
  const base = variant ?? table[format];
  if (!base) throw new Error(`不支持的输出格式: ${format}`);
  const args = base.slice();
  if (supportsQuality(kind, format)) {
    const q = Math.min(100, Math.max(1, Math.round(Number(quality) || 90)));
    if (kind === 'video') {
      // The CRF recipes (x264 containers, webm, software variants) rewrite
      // -crf; the qscale recipes (avi/wmv mpeg4-family, ogv theora) rewrite
      // -q:v instead.
      const at = args.indexOf('-crf');
      if (at >= 0) {
        const value =
          pick === 'hevc' ? x265CrfOf(q) : pick === 'av1' ? svtCrfOf(q) : format === 'webm' ? vp9CrfOf(q) : crfOf(q);
        args[at + 1] = String(value);
      } else {
        const atq = args.indexOf('-q:v');
        if (atq >= 0) args[atq + 1] = String(format === 'ogv' ? theoraQscale(q) : jpegQscale(q));
      }
    } else if (format === 'avif') {
      // libaom has no -quality option: quality rides the recipe's -crf.
      const at = args.indexOf('-crf');
      if (at >= 0) args[at + 1] = String(avifCrfOf(q));
    } else {
      args.push(...(format === 'jpg' ? ['-q:v', jpegQscale(q)] : ['-quality', String(q)]));
    }
  }
  // Audio-encode targets take the three audio knobs; the gate is
  // supportsAudioTune alone because every supportsBitrate format is also an
  // audio-encode target (recipes without -b:a are untouched by the override).
  if (supportsAudioTune(kind, format)) applyAudioTune(args, bitrate, channels, sampleRate);
  // Video targets take an optional fps/width; absent/zero/garbage leaves the
  // recipe untouched. GIF rebuilds its whole filter chain, so a missing value
  // falls back to the recipe's own 12fps/640px; the other recipes carry no -vf
  // and get one pushed with only what was asked.
  const geo = kind === 'video' ? geometry : undefined;
  // Speed and loudnorm never touch images; on audio files only the -af chain
  // applies (atempo/loudnorm are pure audio filters).
  const speed = kind !== 'image' ? speedSegments(filters?.speed ?? 1) : null;
  const loud = kind !== 'image' && filters?.loudnorm === true ? loudnormSegment() : '';
  const afParts: string[] = [];
  if (speed) afParts.push(speed.af);
  if (loud) afParts.push(loud);
  if (filters?.extraAf?.length) afParts.push(...filters.extraAf);
  // Recipes that drop audio (-an, e.g. gif/png single-frame) would leave the
  // -af chain applying to nothing; ffmpeg rejects that, so skip it.
  if (afParts.length && !args.includes('-an')) args.push('-af', afParts.join(','));
  const geoParts: string[] = speed ? [speed.vf] : [];
  if (geo) {
    if (geo.crop) geoParts.push(`crop=${geo.crop}`);
    if (geo.rotate === 90) geoParts.push('transpose=1');
    else if (geo.rotate === 270) geoParts.push('transpose=2');
    else if (geo.rotate === 180) geoParts.push('transpose=1,transpose=1');
    if (geo.flip === 'h') geoParts.push('hflip');
    else if (geo.flip === 'v') geoParts.push('vflip');
  }
  const tailParts = filters?.extraVf ?? [];
  if (
    supportsVideoTune(kind, format) &&
    (geoParts.length > 0 || tailParts.length > 0 || Number(fps) > 0 || Number(width) > 0)
  ) {
    if (format === 'gif') {
      const f = Number(fps) > 0 ? Math.min(30, Math.max(1, Math.round(Number(fps)))) : 12;
      const w = Number(width) > 0 ? Math.min(7680, Math.max(16, Math.round(Number(width)))) : 640;
      const at = args.indexOf('-vf');
      if (at >= 0)
        args[at + 1] = [...geoParts, `fps=${f},scale='min(${w},iw)':-2:flags=lanczos`, ...tailParts].join(',');
    } else {
      const parts: string[] = [...geoParts];
      if (Number(fps) > 0) parts.push(`fps=${Math.min(30, Math.max(1, Math.round(Number(fps))))}`);
      // trunc() keeps the capped width even: x264/vp9/wmv2 all force yuv420p
      // and reject an odd width, whether it comes from the source or the cap.
      if (Number(width) > 0)
        parts.push(
          `scale='trunc(min(${Math.min(7680, Math.max(16, Math.round(Number(width))))},iw)/2)*2':-2:flags=lanczos`,
        );
      parts.push(...tailParts);
      args.push('-vf', parts.join(','));
    }
  }
  return args;
}

// Which software encoders beyond the h264 default this ffmpeg build can run
// for a format, e.g. ['hevc', 'av1'] for mp4. Mirrors supportedFormats' role
// for the codec dimension: the panel hides picks the machine cannot honor.
export function softwareCodecsFor(kind: ConvertKind, format: string, encoders: Iterable<string>): string[] {
  if (kind !== 'video' || !SW_CODECS[format]) return [];
  const have = new Set(encoders);
  const out: string[] = [];
  if (have.has('libx265')) out.push('hevc');
  if (have.has('libsvtav1')) out.push('av1');
  return out;
}

// /status ships this: format -> available software codecs, only for formats
// that actually have variants. An empty object means "probed nothing extra".
export function softwareCodecTable(encoders: Iterable<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const format of FORMATS.video) {
    const codecs = softwareCodecsFor('video', format, encoders);
    if (codecs.length) out[format] = codecs;
  }
  return out;
}

// The encoders one output format's recipe needs, read from the recipe itself
// (buildArgs is the source of truth). Built-in codec names (aac, flac, pcm_*,
// png...) appear in every ffmpeg build, so filtering by them is a no-op.
export function formatEncoders(kind: ConvertKind, format: string): string[] {
  const args = buildArgs(kind, format);
  const wanted: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-c:v' || args[i] === '-c:a') wanted.push(args[i + 1]);
  }
  return wanted;
}

// The output formats this ffmpeg build can actually encode: a format is
// offered only when every encoder its recipe needs is present. Homebrew's
// ffmpeg 9 drops libtheora/libvorbis/libaom/libwebp, so a static table lies.
export function supportedFormats(encoders: Iterable<string>): FormatTable {
  const have = new Set(encoders);
  const pick = (kind: ConvertKind): string[] =>
    FORMATS[kind].filter((format) => formatEncoders(kind, format).every((name) => have.has(name)));
  return { video: pick('video'), audio: pick('audio'), image: pick('image') };
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
// The per-type counts drive track selection (convert) and the PTC prompt:
// an ordinal ask is validated against them before it reaches an ffmpeg arg.
export function streamInfoOf(meta: MediaMeta) {
  return {
    video: Boolean(meta.video),
    audio: Boolean(meta.audio),
    videoCount: meta.streams.filter((item) => item.type === 'video').length,
    audioCount: meta.streams.filter((item) => item.type === 'audio').length,
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
// `ordinal` picks within the type (0 = first = historical default), so a
// second audio track can be lifted without re-encoding.
export function extractPlan(streams: StreamInfo, which: 'audio' | 'video', ordinal = 0): ConvertPlan {
  const at = Math.max(0, Math.round(Number(ordinal) || 0));
  if (which === 'audio') {
    if (!streams || !streams.audio) throw new Error('该文件没有音轨');
    if ((streams.audioCount || 0) > 0 && at >= (streams.audioCount || 0)) {
      throw new Error(`音轨序号 ${at} 不存在（共 ${streams.audioCount} 条）`);
    }
    const codec = streams.audioCodec || '';
    const ext = AUDIO_CONTAINER[codec] || (codec.startsWith('pcm_') ? 'wav' : 'm4a');
    return { ext, kind: 'audio', args: ['-map', `0:a:${at}`, '-vn', '-c:a', 'copy'] };
  }
  if (!streams || !streams.video) throw new Error('该文件没有画面');
  if ((streams.videoCount || 0) > 0 && at >= (streams.videoCount || 0)) {
    throw new Error(`画面轨序号 ${at} 不存在（共 ${streams.videoCount} 条）`);
  }
  const ext = VIDEO_CONTAINER[streams.videoCodec] || 'mkv';
  return { ext, kind: 'video', args: ['-map', `0:v:${at}`, '-an', '-c:v', 'copy'] };
}

// Embedded subtitle track -> plain text; the language code keeps multi-track
// exports distinguishable in the output folder. srt/ass/vtt are compiled into
// every ffmpeg build, so no encoder probing applies here.
const SUBTITLE_FORMATS = ['srt', 'ass', 'vtt'];
export function subtitlePlan(streams: StreamInfo, ordinal: number | string | undefined, format = 'srt'): ConvertPlan {
  const track = streams && streams.subtitles ? streams.subtitles[Number(ordinal)] : null;
  if (!track) throw new Error('这条字幕轨不存在');
  if (!SUBTITLE_FORMATS.includes(format)) throw new Error(`不支持的字幕格式: ${format}`);
  return {
    ext: format,
    kind: 'text',
    args: ['-map', `0:s:${Number(ordinal)}`, '-c:s', format === 'vtt' ? 'webvtt' : format],
    stemSuffix: track.language ? '.' + track.language : '',
  };
}

// --- concat & chapter split (R3) --------------------------------------------
// The concat demuxer reads a list file; paths with single quotes are escaped
// the way the demuxer documents (`'` -> `'\''`).
export function concatListText(paths: string[]): string {
  return paths.map((item) => `file '${item.replace(/'/g, `'\\''`)}'`).join('\n') + '\n';
}

// What the copy level needs every file to agree on; a null answer means the
// files can be concatenated without re-encoding. The probed metas carry the
// facts — never probe again here.
export function concatCompatible(metas: MediaMeta[]): string | null {
  const first = metas[0];
  const videoCodec = first.video ? first.video.codec : '';
  const audioCodec = first.audio ? first.audio.codec : '';
  const width = first.video ? first.video.width || 0 : 0;
  const height = first.video ? first.video.height || 0 : 0;
  for (const meta of metas.slice(1)) {
    if ((meta.video ? meta.video.codec : '') !== videoCodec) return '画面编码不一致';
    if ((meta.audio ? meta.audio.codec : '') !== audioCodec) return '音轨编码不一致';
    if (width && (meta.video ? meta.video.width || 0 : 0) !== width) return '分辨率不一致';
    if (height && (meta.video ? meta.video.height || 0 : 0) !== height) return '分辨率不一致';
  }
  return null;
}

export function concatCopyArgs(format: string): string[] {
  const args = ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
  if (format === 'mp4') args.push('-movflags', '+faststart');
  return args;
}

// Chapters worth their own file: positive length, start clamped at zero and
// end clamped at the duration. Zero-length chapters are skipped, not errors.
export interface ChapterWindow {
  index: number;
  start: number;
  end: number;
  title: string;
}
export function chapterWindows(meta: MediaMeta): ChapterWindow[] {
  const out: ChapterWindow[] = [];
  for (const [index, chapter] of meta.chapters.entries()) {
    const start = Math.max(0, chapter.start);
    let end = chapter.end;
    if (meta.duration > 0) end = Math.min(end, meta.duration);
    if (!(end - start > 0.01)) continue;
    out.push({ index, start, end, title: chapter.tags.title || '' });
  }
  return out;
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
