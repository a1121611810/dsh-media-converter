// User extensions, v1: data only. A manifest declares either macros (fixed
// parameter combinations over the built-in convert action) or recipes
// (whitelisted ffmpeg argument lists that override a built-in format's
// recipe). Everything here is pure validation and derivation — no I/O, no
// code execution: a manifest can never register a route or run JavaScript.
// The Config field stores the raw JSON text; parseExtensions rejects the
// whole batch on any error so a bad import never leaves half an extension.
import { FORMATS, formatsFor } from './plan.js';
import type { ConvertKind } from './plan.js';

export interface LocalizedText {
  zh: string;
  en: string;
}

// Only the knobs the convert path already validates may appear in a macro;
// the plan builder re-runs every clamp, so these bounds are advisory here
// and authoritative there.
export interface MacroParams {
  format: string;
  quality?: number;
  bitrate?: number;
  channels?: number;
  sampleRate?: number;
  fps?: number;
  width?: number;
}

interface ActionBase {
  id: string;
  kind: ConvertKind;
  label: LocalizedText;
}

export interface MacroAction extends ActionBase {
  type: 'macro';
  params: MacroParams;
}

export interface RecipeQuality {
  // The flag the 1-100 quality slider drives; the anchor keeps the recipe's
  // own value at the 90 default and slides linearly towards min (best) and
  // max (worst) on either side.
  flag: string;
  at90: number;
  min: number;
  max: number;
}

export interface RecipeAction extends ActionBase {
  type: 'recipe';
  format: string;
  override: true;
  args: string[];
  quality?: RecipeQuality;
}

export type ExtensionAction = MacroAction | RecipeAction;

export interface ExtensionManifest {
  version: 1;
  id: string;
  name: LocalizedText;
  description?: LocalizedText;
  actions: ExtensionAction[];
}

// The runtime descriptor planFor resolves presets against; deliberately not
// an ActionEntry (no closures) so it stays plain data end to end.
export interface ExtensionEntry {
  ref: string;
  extId: string;
  actionId: string;
  type: 'macro' | 'recipe';
  kind: ConvertKind;
  label: LocalizedText;
  format: string;
  params?: MacroParams;
  args?: string[];
  quality?: RecipeQuality;
}

export const LIMITS = {
  MAX_MANIFESTS: 16,
  MAX_ACTIONS_PER_MANIFEST: 16,
  MAX_ACTIONS_TOTAL: 32,
} as const;

const ID_RE = /^[a-z0-9-]{1,32}$/;
// Preset references travel in the `format`/`preset` fields the same way
// formats do: `x:<manifest>/<action>`.
export const REF_RE = /^x:([a-z0-9-]{1,32})\/([a-z0-9-]{1,32})$/;

export const refOf = (extId: string, actionId: string): string => `x:${extId}/${actionId}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : null;

function checkLocalized(v: unknown, what: string, required: boolean, max = 64): string | null {
  if (v === undefined && !required) return null;
  if (!isObject(v)) return `${what} 必须是对象`;
  const zh = text(v.zh, max);
  if (required && zh === null) return `${what}.zh 必须是 1-${max} 字的非空字符串`;
  const en = text(v.en, max);
  if (required && en === null) return `${what}.en 必须是 1-${max} 字的非空字符串`;
  return null;
}

const int = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function checkMacroParams(raw: unknown, kind: ConvertKind, what: string): MacroParams | string {
  if (!isObject(raw)) return `${what}.params 必须是对象`;
  const format = typeof raw.format === 'string' ? raw.format : '';
  if (!formatsFor(kind).includes(format)) {
    return `${what}：format "${format}" 不属于 ${kind} 的可用格式`;
  }
  const params: MacroParams = { format };
  if (raw.quality !== undefined && !int(raw.quality, 1, 100)) return `${what}：quality 必须是 1-100 的整数`;
  if (raw.quality !== undefined) params.quality = raw.quality as number;
  if (raw.bitrate !== undefined && !int(raw.bitrate, 32, 320)) return `${what}：bitrate 必须是 32-320 的整数`;
  if (raw.bitrate !== undefined) params.bitrate = raw.bitrate as number;
  if (raw.channels !== undefined && !int(raw.channels, 1, 2)) return `${what}：channels 必须是 1 或 2`;
  if (raw.channels !== undefined) params.channels = raw.channels as number;
  if (raw.sampleRate !== undefined && !int(raw.sampleRate, 8000, 96000)) {
    return `${what}：sampleRate 必须是 8000-96000 的整数`;
  }
  if (raw.sampleRate !== undefined) params.sampleRate = raw.sampleRate as number;
  if (raw.fps !== undefined && !int(raw.fps, 1, 30)) return `${what}：fps 必须是 1-30 的整数`;
  if (raw.fps !== undefined) params.fps = raw.fps as number;
  if (raw.width !== undefined && !int(raw.width, 16, 7680)) return `${what}：width 必须是 16-7680 的整数`;
  if (raw.width !== undefined) params.width = raw.width as number;
  const extra = Object.keys(raw).filter(
    (k) => !['format', 'quality', 'bitrate', 'channels', 'sampleRate', 'fps', 'width'].includes(k),
  );
  if (extra.length) return `${what}：params 有未知字段 ${extra.join(', ')}`;
  return params;
}

// --- ffmpeg argument whitelist ---------------------------------------------
// Recipes may only carry output-side flags the plan builder would emit
// itself. Values are matched against per-flag patterns so a recipe can never
// name an input file (`-i`), run a filter graph (`-filter_complex`), or read
// anything through a filter source (`movie=`/lavfi).

const VF_FILTERS = /^(scale|crop|rotate|transpose|fps|setsar|format|pad|eq|hue)\b/;
// Colons and equals signs belong to filter syntax; slashes and quotes never
// do, and either would be an attempt to smuggle a path or a second filter.
const VF_VALUE = /^[a-z0-9_=:().,+\-*\s]+$/i;

function vfValue(value: string): boolean {
  if (!VF_VALUE.test(value) || /[/'"\\]/.test(value)) return false;
  if (/movie|lavfi|amovie|filter/i.test(value)) return false;
  return value.split(',').every((f) => VF_FILTERS.test(f.trim()));
}

// null = flag takes no value; RegExp = the one following token must match.
const ALLOWED_FLAGS: Record<string, RegExp | null> = {
  '-c:v': /^(libx264|libx265|libsvtav1|libvpx-vp9|libvpx|mpeg4|wmv2|libtheora|h264|hevc|vp9|av1|copy)$/,
  '-c:a': /^(aac|libmp3lame|libopus|libvorbis|flac|pcm_s16le|pcm_s16be|wmav2|copy)$/,
  '-c:s': /^(srt|ass|vtt|mov_text|copy)$/,
  '-b:v': /^\d{1,6}[kKmM]?$/,
  '-b:a': /^\d{1,4}[kKmM]?$/,
  '-crf': /^\d{1,3}$/,
  '-q:v': /^\d{1,2}$/,
  '-q:a': /^\d{1,2}$/,
  '-preset': /^(ultrafast|superfast|veryfast|faster|fast|medium|slow|slower|veryslow)$/,
  '-tune': /^[a-z]{1,16}$/,
  '-profile:v': /^[a-z0-9]{1,16}$/,
  '-pix_fmt': /^[a-z0-9_]{1,16}$/,
  '-movflags': /^[+a-z_]{1,64}$/,
  '-tag:v': /^[a-z0-9]{3,4}$/,
  '-maxrate': /^\d{1,6}[kKmM]?$/,
  '-bufsize': /^\d{1,6}[kKmM]?$/,
  '-rc': /^[a-z_]{1,16}$/,
  '-g': /^\d{1,4}$/,
  '-ac': /^[12]$/,
  '-ar': /^\d{3,6}$/,
  '-map': /^(0:v:0|0:a:0|0)$/,
  '-vn': null,
  '-an': null,
  '-sn': null,
  '-threads': /^\d{1,2}$/,
  '-f': /^(mpegts|adts)$/,
  '-vf': null, // handled specially below
};

export function validateArgs(args: unknown, what: string): string | null {
  if (!Array.isArray(args) || args.length < 2 || args.length > 64 || args.some((a) => typeof a !== 'string')) {
    return `${what}：args 必须是 2-64 个字符串的数组`;
  }
  for (let i = 0; i < args.length;) {
    const token = args[i] as string;
    if (!token.startsWith('-')) return `${what}：位置参数 "${token}" 不允许，只能是 -标志 值 对`;
    if (token === '-i' || token === '-filter_complex') return `${what}：参数 ${token} 永远不允许`;
    if (!(token in ALLOWED_FLAGS)) return `${what}：参数 ${token} 不在白名单里`;
    const rule = ALLOWED_FLAGS[token];
    if (token === '-vf') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.startsWith('-')) return `${what}：-vf 缺少值`;
      if (!vfValue(value)) return `${what}：-vf 值 "${value}" 不允许`;
      i += 2;
      continue;
    }
    if (rule === null) {
      i += 1;
      continue;
    }
    const value = args[i + 1];
    if (typeof value !== 'string' || value.startsWith('-')) return `${what}：${token} 缺少值`;
    if (/[\\/]/.test(value)) return `${what}：${token} 的值不允许包含路径分隔符`;
    if (!rule.test(value)) return `${what}：${token} 的值 "${value}" 不允许`;
    i += 2;
  }
  return null;
}

function checkQualityMap(raw: unknown, args: string[], what: string): RecipeQuality | string {
  if (!isObject(raw)) return `${what}：quality 必须是对象`;
  const flag = typeof raw.flag === 'string' ? raw.flag : '';
  if (!flag.startsWith('-') || !(flag in ALLOWED_FLAGS)) return `${what}：quality.flag "${flag}" 不在白名单里`;
  if (!args.includes(flag)) return `${what}：quality.flag ${flag} 必须出现在 args 里`;
  const { at90, min, max } = raw as Record<string, unknown>;
  if (!int(at90, 0, 100000) || !int(min, 0, 100000) || !int(max, 0, 100000)) {
    return `${what}：quality.at90/min/max 必须是整数`;
  }
  const anchor = at90 as number;
  const best = min as number;
  const worst = max as number;
  if (!(best <= anchor && anchor <= worst)) {
    return `${what}：quality 需要 min ≤ at90 ≤ max（quality 越大值越小=质量越好）`;
  }
  return { flag, at90: anchor, min: best, max: worst };
}

function checkAction(raw: unknown, kind: ConvertKind | null, what: string): ExtensionAction | string {
  if (!isObject(raw)) return `${what} 必须是对象`;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) return `${what}.id 必须匹配 [a-z0-9-]{1,32}`;
  const labelError = checkLocalized(raw.label, `${what}.label`, true);
  if (labelError) return labelError;
  const actionKind = raw.kind;
  if (actionKind !== 'video' && actionKind !== 'audio' && actionKind !== 'image') {
    return `${what}.kind 必须是 video/audio/image`;
  }
  if (kind !== null && actionKind !== kind) {
    return `${what}.kind 与该扩展已声明的 kind 不一致`;
  }
  if (raw.type === 'macro') {
    const params = checkMacroParams(raw.params, actionKind, what);
    if (typeof params === 'string') return params;
    const action: MacroAction = { id, type: 'macro', kind: actionKind, label: raw.label as LocalizedText, params };
    return action;
  }
  if (raw.type === 'recipe') {
    if (raw.override !== true) return `${what}：recipe 只支持 override: true（v1 不新增格式名）`;
    const format = typeof raw.format === 'string' ? raw.format : '';
    if (!formatsFor(actionKind).includes(format)) {
      return `${what}：format "${format}" 不属于 ${actionKind} 的可用格式`;
    }
    const argsError = validateArgs(raw.args, what);
    if (argsError) return argsError;
    const args = raw.args as string[];
    const action: RecipeAction = {
      id,
      type: 'recipe',
      kind: actionKind,
      label: raw.label as LocalizedText,
      format,
      override: true,
      args,
    };
    if (raw.quality !== undefined) {
      const map = checkQualityMap(raw.quality, args, what);
      if (typeof map === 'string') return map;
      action.quality = map;
    }
    return action;
  }
  return `${what}.type 必须是 macro 或 recipe`;
}

function checkManifest(raw: unknown): ExtensionManifest | string {
  if (!isObject(raw)) return '扩展必须是对象';
  if (raw.version !== 1) return 'version 必须是 1';
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) return `id "${id}" 必须匹配 [a-z0-9-]{1,32}`;
  const nameError = checkLocalized(raw.name, 'name', true);
  if (nameError) return nameError;
  const descError = checkLocalized(raw.description, 'description', false, 200);
  if (descError) return descError;
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) return 'actions 必须是非空数组';
  if (raw.actions.length > LIMITS.MAX_ACTIONS_PER_MANIFEST) {
    return `actions 超过每包上限 ${LIMITS.MAX_ACTIONS_PER_MANIFEST}`;
  }
  const actions: ExtensionAction[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.actions.entries()) {
    // A manifest's actions share one media kind: presets group by kind in the
    // panel, and a mixed-kind pack would make the grouping arbitrary.
    const action = checkAction(item, actions.length ? actions[0].kind : null, `actions[${index}]`);
    if (typeof action === 'string') return action;
    if (seen.has(action.id)) return `actions[${index}]：动作 id "${action.id}" 重复`;
    seen.add(action.id);
    actions.push(action);
  }
  const manifest: ExtensionManifest = { version: 1, id, name: raw.name as LocalizedText, actions };
  if (raw.description !== undefined) manifest.description = raw.description as LocalizedText;
  return manifest;
}

export type ParseResult = { ok: true; manifests: ExtensionManifest[] } | { ok: false; error: string };

// The Config field holds a JSON array of manifests (empty string = none).
// Any error rejects the whole batch: a half-installed extension pack is
// worse than a refused one.
export function parseExtensions(raw: unknown): ParseResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, manifests: [] };
  if (typeof raw !== 'string') return { ok: false, error: 'extensions 必须是字符串' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'extensions 不是合法 JSON' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, error: 'extensions 必须是非空数组' };
  if (parsed.length > LIMITS.MAX_MANIFESTS) {
    return { ok: false, error: `extensions 超过包数量上限 ${LIMITS.MAX_MANIFESTS}` };
  }
  const manifests: ExtensionManifest[] = [];
  const ids = new Set<string>();
  const refs = new Set<string>();
  const overrides = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    const manifest = checkManifest(item);
    if (typeof manifest === 'string') return { ok: false, error: `manifests[${index}]：${manifest}` };
    if (ids.has(manifest.id)) return { ok: false, error: `manifest id "${manifest.id}" 重复` };
    ids.add(manifest.id);
    for (const action of manifest.actions) {
      const ref = refOf(manifest.id, action.id);
      if (refs.has(ref)) return { ok: false, error: `动作引用 "${ref}" 重复` };
      refs.add(ref);
      if (action.type === 'recipe') {
        const key = `${action.kind}:${action.format}`;
        if (overrides.has(key)) {
          return { ok: false, error: `${key} 的覆盖配方重复（每个 kind+format 只允许一个）` };
        }
        overrides.add(key);
      }
    }
    manifests.push(manifest);
  }
  if (refs.size > LIMITS.MAX_ACTIONS_TOTAL) {
    return { ok: false, error: `动作总数超过上限 ${LIMITS.MAX_ACTIONS_TOTAL}` };
  }
  return { ok: true, manifests };
}

export function entriesOf(manifests: ExtensionManifest[]): ExtensionEntry[] {
  const entries: ExtensionEntry[] = [];
  for (const manifest of manifests) {
    for (const action of manifest.actions) {
      entries.push({
        ref: refOf(manifest.id, action.id),
        extId: manifest.id,
        actionId: action.id,
        type: action.type,
        kind: action.kind,
        label: action.label,
        format: action.type === 'macro' ? action.params.format : action.format,
        ...(action.type === 'macro' ? { params: action.params } : { args: action.args, quality: action.quality }),
      });
    }
  }
  return entries;
}

// quality 1-100 → the recipe's flag value: 90 anchors at at90, 100 lands on
// min (best), 1 saturates at max (worst); the two halves scale independently.
export function applyQualityMap(args: string[], map: RecipeQuality, quality: number): string[] {
  const q = Math.min(100, Math.max(1, Math.round(Number(quality) || 90)));
  const value =
    q >= 90 ? map.at90 - ((q - 90) / 10) * (map.at90 - map.min) : map.at90 + ((90 - q) / 89) * (map.max - map.at90);
  const at = args.indexOf(map.flag);
  const text = String(Math.round(Math.min(map.max, Math.max(map.min, value))));
  if (at < 0) return args;
  const next = args.slice();
  next[at + 1] = text;
  return next;
}

// What /status ships: everything the panel needs to render extension actions
// without importing any of this module's logic.
export function statusOf(manifests: ExtensionManifest[]): {
  id: string;
  name: LocalizedText;
  description?: LocalizedText;
  actions: { ref: string; type: 'macro' | 'recipe'; kind: ConvertKind; label: LocalizedText; format: string }[];
}[] {
  return manifests.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    actions: manifest.actions.map((action) => ({
      ref: refOf(manifest.id, action.id),
      type: action.type,
      kind: action.kind,
      label: action.label,
      format: action.type === 'macro' ? action.params.format : action.format,
    })),
  }));
}

// The built-in format table, re-exported for the panel-facing type surface.
export const EXTENSION_FORMATS = FORMATS;
