// The action registry: one declaration per toolbox action. planFor, the PTC
// prompt and the agent tool's action enum derive from this table instead of
// repeating the action list; user extensions (a later phase) deserialize into
// the same entry type. The heavy plan helpers stay in lib/plan.ts — entries
// here are thin shells around them.
import type { JsonBody, Upload } from '../index.js';
import {
  buildArgs,
  copyArgs,
  defaultBitrate,
  extOf,
  extractPlan,
  formatsFor,
  hardwareFor,
  kindByExt,
  metaArgs,
  normalizeTrim,
  subtitlePlan,
  supportsAudioTune,
  supportsBitrate,
  supportsHardwareAudio,
  supportsVideoTune,
} from './plan.js';
import type { ConvertPlan, HwBackend, MediaKind } from './plan.js';

export interface ActionEntry {
  id: string;
  // The name in the agent tool's action enum; absent = not agent-facing.
  // 'rewrite-tags' is the tool's name for the 'meta' plan mode.
  tool?: string;
  // Takes part in PTC batch planning (convert only).
  ptc?: boolean;
  plan?: (upload: Upload, body: JsonBody, threads: number, hwBackend: HwBackend | null | undefined) => ConvertPlan;
}

// The convert action's whole plan, moved verbatim out of planFor: the tuned
// gates first (an explicit ask always means re-encode), then the container
// copy fast path, then the hardware path, then the software recipe.
function convertPlan(
  upload: Upload,
  body: JsonBody,
  threads: number,
  hwBackend: HwBackend | null | undefined,
): ConvertPlan {
  const format = String(body.format || '');
  const formats = formatsFor(upload.kind);
  if (!formats.includes(format)) {
    throw new Error(`不支持的输出格式: ${format}`);
  }
  const trim = normalizeTrim(body.trim, upload.duration);
  // Track selection rides the same idiom as fps/width: 0/absent keeps the
  // source default, a positive ordinal picks within the type. The ordinals
  // are validated against the probed stream list before they can reach an
  // ffmpeg arg, and misdirected asks fail instead of being silently dropped.
  const vtrack = Math.max(0, Math.round(Number(body.videoTrack) || 0));
  const atrack = Math.max(0, Math.round(Number(body.audioTrack) || 0));
  if (vtrack > 0) {
    if (upload.kind !== 'video' || kindByExt(format) !== 'video') {
      throw new Error('videoTrack 仅对视频转视频目标有效');
    }
    const count = upload.meta.streams.filter((item) => item.type === 'video').length;
    if (vtrack >= count) throw new Error(`画面轨序号 ${vtrack} 不存在（共 ${count} 条）`);
  }
  if (atrack > 0) {
    if (kindByExt(format) === 'image') throw new Error('audioTrack 不适用于图片输出');
    const count = upload.meta.streams.filter((item) => item.type === 'audio').length;
    if (count === 0) throw new Error('该文件没有音轨');
    if (atrack >= count) throw new Error(`音轨序号 ${atrack} 不存在（共 ${count} 条）`);
  }
  // An explicit quality choice means "re-encode to this quality": a container
  // copy would silently drop it. Rounded, so 89.6/90.4 (which buildArgs rounds
  // to the 90 default) do not force a pointless re-encode.
  const qualityTuned = upload.kind === 'video' && Number(body.quality) > 0 && Math.round(Number(body.quality)) !== 90;
  // The same rule for an explicit audio bitrate: asking for 128k when the
  // source could just be copied is a real re-encode request. Compared against
  // the recipe's own default, so asking for 192 keeps the copy fast path.
  const bitrateTuned =
    supportsBitrate(upload.kind, format) &&
    Number(body.bitrate) > 0 &&
    Math.round(Number(body.bitrate)) !== defaultBitrate(format);
  // The same rule for an explicit software codec: asking for HEVC/AV1 when
  // the source could just be copied is a real re-encode request.
  const codecTuned =
    upload.kind === 'video' && (String(body.codec || '') === 'hevc' || String(body.codec || '') === 'av1');
  // Downsampling channels or rate is a real re-encode request too: a mono
  // ask must never come back as a copied stereo stream.
  const audioTuned =
    supportsAudioTune(upload.kind, format) && (Number(body.channels) > 0 || Number(body.sampleRate) > 0);
  // An explicit output size or frame rate is a real re-encode request: a
  // copied stream would silently keep the source's.
  const videoTuneTuned = supportsVideoTune(upload.kind, format) && (Number(body.fps) > 0 || Number(body.width) > 0);
  // An explicit track pick is a real re-encode request as well: the copy
  // path only ever carries the default streams, so a picked track would be
  // silently dropped.
  const trackTuned = vtrack > 0 || atrack > 0;
  // The same rule on the GPU path: an explicit audio ask (bitrate,
  // channels, rate) for a container the hardware plan re-encodes audio for
  // must reach the hardware branch, not come back as a copied stream. The
  // condition mirrors the branch below: without a hardware ask or a probed
  // backend the ask is a documented software-path no-op and the copy stays.
  const hwAudioTuned =
    Boolean(body.hardware) &&
    Boolean(hwBackend) &&
    upload.kind === 'video' &&
    supportsHardwareAudio(format) &&
    (Number(body.bitrate) > 0 || Number(body.channels) > 0 || Number(body.sampleRate) > 0);
  if (
    !trim &&
    !qualityTuned &&
    !bitrateTuned &&
    !codecTuned &&
    !audioTuned &&
    !videoTuneTuned &&
    !trackTuned &&
    !hwAudioTuned
  ) {
    const copy = copyArgs(upload.kind, format, upload.meta);
    if (copy) return { ext: format, kind: kindByExt(format), args: copy, copy: true };
  }
  // The picked tracks become explicit maps on every re-encoding path (the
  // copy path is unreachable: an explicit pick disabled it above). Only the
  // picked side is mapped; the other side keeps ffmpeg's default selection.
  const trackMaps: string[] = [];
  if (vtrack > 0) trackMaps.push('-map', `0:v:${vtrack}`);
  if (atrack > 0) trackMaps.push('-map', `0:a:${atrack}`);
  // The hardware path is vendor specific and only exists where the probe
  // found a backend this machine can really run; elsewhere the hardware ask
  // silently gets the software plan instead of a doomed ffmpeg command. A
  // size/frame-rate ask never takes it: -vf would break the zero-copy path,
  // and the bitrate estimate assumes the source resolution.
  if (body.hardware && hwBackend && !videoTuneTuned) {
    // hardwareFor whitelists the codec: 'hevc' outside mp4/mov/mkv/ts (or
    // any unknown value) quietly becomes H.264 instead of a failed encode.
    const hw = hardwareFor(
      hwBackend,
      upload.kind,
      format,
      upload.size,
      upload.duration,
      Number(body.quality),
      String(body.codec || ''),
      Number(body.bitrate),
      Number(body.channels),
      Number(body.sampleRate),
    );
    if (hw) {
      return {
        ext: format,
        kind: kindByExt(format),
        args: [...trackMaps, ...hw.args],
        inputArgs: hw.inputArgs,
        hardware: true,
      };
    }
  }
  return {
    ext: format,
    kind: kindByExt(format),
    args: [
      ...trackMaps,
      ...buildArgs(
        upload.kind,
        format,
        body.quality,
        body.bitrate,
        body.fps,
        body.width,
        body.channels,
        body.sampleRate,
        body.codec,
      ),
    ],
    threads,
  };
}

export const ACTIONS: ActionEntry[] = [
  // No plan: the probe answers from the file's own metadata, never a job.
  { id: 'probe', tool: 'probe' },
  { id: 'convert', tool: 'convert', ptc: true, plan: convertPlan },
  {
    id: 'extract-audio',
    tool: 'extract-audio',
    plan: (upload, body) => extractPlan(upload.streams, 'audio', Number(body.stream) || 0),
  },
  {
    id: 'extract-video',
    tool: 'extract-video',
    plan: (upload, body) => extractPlan(upload.streams, 'video', Number(body.stream) || 0),
  },
  {
    id: 'subtitle',
    tool: 'subtitle',
    plan: (upload, body) => subtitlePlan(upload.streams, body.stream, body.format ? String(body.format) : undefined),
  },
  {
    id: 'meta',
    tool: 'rewrite-tags',
    plan: (upload, body) => ({ ext: extOf(upload.name), kind: upload.kind, args: metaArgs(body.tags) }),
  },
  // No plan: Base64 lives on its own routes and never builds an ffmpeg job.
  { id: 'base64' },
  // No plan: concat is a run-level job over many uploads (see /run), and a
  // chapter split starts one job per chapter (see /convert). Both stay in
  // the registry so the features whitelist and the tool enum govern them.
  { id: 'concat', tool: 'concat' },
  { id: 'split-chapters', tool: 'split-chapters' },
];

export function actionFor(mode: string): ActionEntry | undefined {
  return ACTIONS.find((entry) => entry.id === mode);
}

// A configured `features` string is a whitelist of enabled action ids: empty
// enables everything, unknown tokens are dropped (same mental model as
// resolveGroups for the panel's action groups).
export function resolveFeatures(raw: unknown): string[] {
  const tokens = String(raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => ACTIONS.some((entry) => entry.id === token));
  const known = [...new Set(tokens)];
  return known.length ? known : ACTIONS.map((entry) => entry.id);
}

export function toolActions(enabled: string[] = ACTIONS.map((entry) => entry.id)): string[] {
  return ACTIONS.flatMap((entry) => (entry.tool && enabled.includes(entry.id) ? [entry.tool] : []));
}

// The PTC prompt's format lists follow the convert entry: when convert is
// removed from the table (or disabled), PTC has nothing to plan.
export function ptcFormats(kind: MediaKind, enabled: string[] = ACTIONS.map((entry) => entry.id)): string[] {
  return actionFor('convert')?.ptc && enabled.includes('convert') ? formatsFor(kind) : [];
}
