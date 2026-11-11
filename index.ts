// DSH Host plugin: local media toolkit — convert, trim, extract tracks, and
// move media to/from Base64 through ffmpeg.
//
// Security has one home: every route asks the composition's `connection`
// service for a rejection first (the Host/Origin fence plus browser
// authentication, the same guard the `/api` bridge applies). No connection
// service means no trusted caller, so requests are refused rather than served.
//
// The Web page (client.js) never touches the filesystem: it uploads picked
// files to this plugin's routes, the Host runs one ffmpeg process
// per job, and the page polls the job for progress. Results land in
// ~/Downloads/media-toolbox (config.outputDir overrides it) and are served back
// for preview from that same directory only.
//
// Node does the heavy lifting without ever holding a whole file in memory: the
// upload streams to disk, the Base64 answer streams back out, the file system
// calls are asynchronous so a multi-gigabyte job never blocks the Host, and
// every job carries an AbortSignal so the page can cancel it.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Schema from '@deepseek-ai/schemastery';
import { decodeBase64Payload } from './lib/base64.js';
import { actionFor, ptcFormats, resolveFeatures, toolActions } from './lib/actions.js';
import { applyQualityMap, entriesOf, parseExtensions, statusOf } from './lib/extensions.js';
import type { ExtensionEntry, ExtensionManifest } from './lib/extensions.js';
import {
  FORMATS,
  defaultFormat,
  extOf,
  formatsFor,
  kindByExt,
  kindOf,
  mimeOf,
  normalizeStderr,
  normalizeTrim,
  parseDuration,
  parseFfprobeJson,
  parseMeta,
  parseStreams,
  percentOf,
  progressSeconds,
  streamInfoOf,
  supportedFormats,
  threadArgs,
  trimArgs,
} from './lib/plan.js';
import type {
  ConvertPlan,
  FormatTable,
  HwBackend,
  HwBackendId,
  MediaKind,
  MediaMeta,
  StreamInfo,
  TrimWindow,
} from './lib/plan.js';
import {
  PTC_DEFAULT_RATES,
  WEIGHTS,
  blendPtcRate,
  capacityFor,
  estimatePtcCost,
  planPtcGroups,
  threadsFor,
} from './lib/schedule.js';
import type { PtcRates } from './lib/schedule.js';
import {
  expandDirs,
  ffmpegCandidates,
  imageioPatterns,
  isInsideDir,
  pickBackend,
  probeCandidates,
  revealCommand,
  safeBaseName,
} from './lib/platform.js';

// The Cordis context of this plugin: only the webServer service and the tool
// registry are used. The plugin ships no Cordis type package, so the part of
// the surface the code touches is declared here.
interface WebServerRoute {
  kind: 'exact';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
interface WebServer {
  getOrigin(): string;
  register(route: WebServerRoute): () => void;
}
// Trust surface consumed from the composition's connection service; the
// browser-side connection package owns the full type.
interface Connection {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined;
}
// The PTC seam this plugin hosts itself: the model writes a program and the
// runtime executes it against one binding namespace. Only the parts used here
// are declared (the plugin ships no DSH type package).
interface PtcRuntime {
  timeout?: { defaultMs: number; maxMs: number };
  resolve(request: unknown): unknown;
  run(spec: unknown): Promise<{
    value?: unknown;
    logs?: string[];
    error?: { kind: string; message: string };
  }>;
}
interface LlmChunk {
  type: string;
  text?: string;
  reason?: { kind: string; failure?: { code?: string; message?: string } };
}
interface LlmModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
}
interface Llm {
  listProviders?(): { id: string; name: string }[];
  listModels?(provider: string): Promise<LlmModelInfo[]>;
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts?: { id: string }[] } }>;
  stream(options: {
    provider: string;
    model: string;
    messages: unknown[];
    maxTokens: number;
    reasoningEffort?: string;
    signal: AbortSignal;
  }): AsyncIterable<LlmChunk>;
}
interface AgentDefaultModel {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
}
interface SandboxPolicy {
  resolve(request?: { mode?: string }): { mode: string; workspaceRoot: string };
}
interface HostContext {
  get(key: 'webServer'): WebServer | undefined;
  get(key: 'connection'): Connection | undefined;
  get(key: 'ptcRuntime'): PtcRuntime | undefined;
  get(key: 'llm'): Llm | undefined;
  get(key: 'agentDefaultModel'): AgentDefaultModel | undefined;
  get(key: 'sandboxPolicy'): SandboxPolicy | undefined;
  tools: Tools;
  settings: SettingsForms;
  effect(fn: () => void | (() => void)): void;
}

// The settings service the host projects from the exported Config schema:
// configure() opts this instance into the generated form, update() persists
// a merge into the profile document and hot-replaces this plugin.
interface SettingsForms {
  configure(presentation: { auto?: boolean }): () => void;
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>;
}

// The plugin's tunables. volatile() marks a field runtime-editable: the
// settings service projects only volatile fields into forms, and update()
// refuses anything else. Empty strings mean "the built-in default" (see
// apply's resolution); `groups` is a comma-separated order of the panel's
// action groups — a string, not an array, because update() merge semantics
// for arrays are undocumented.
export interface Config {
  outputDir: string;
  ffmpegPath: string;
  maxUploadMb: number;
  composerButton: boolean;
  groups: string;
  features: string;
  persistState: boolean;
  uploadTtlMinutes: number;
  queueLimit: number;
  extensions: string;
}

export const Config = Schema.object({
  outputDir: Schema.string().default('').volatile(),
  ffmpegPath: Schema.string().default('').volatile(),
  maxUploadMb: Schema.number().default(2048).volatile(),
  composerButton: Schema.boolean().default(true).volatile(),
  groups: Schema.string().default('convert,edit,view').volatile(),
  features: Schema.string().default('').volatile(),
  persistState: Schema.boolean().default(false).volatile(),
  uploadTtlMinutes: Schema.number().default(120).volatile(),
  queueLimit: Schema.number().default(2000).volatile(),
  extensions: Schema.string().default('').volatile(),
});

// The action panel's module keys, in their built-in order. A configured
// `groups` string reorders them and omits hidden ones; unknown tokens and
// duplicates are dropped, missing keys keep their built-in place at the end.
const GROUP_KEYS = ['convert', 'edit', 'view'];
export function resolveGroups(raw: unknown): string[] {
  const tokens = String(raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => GROUP_KEYS.includes(token));
  const ordered = [...new Set(tokens)];
  return [...ordered, ...GROUP_KEYS.filter((key) => !ordered.includes(key))];
}

// The tool registry the agent calls into. Only the parts this plugin uses
// are declared: a definition, its schema, and the text it renders.
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): { type: string; text: string }[];
  };
  timeoutMs?: number;
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>;
}
interface Tools {
  register(definition: ToolDefinition): () => void;
}

// The job as the page sees it while it polls for progress.
export type JobState = 'running' | 'cancelling' | 'cancelled' | 'done' | 'error';
export interface Job {
  id: string;
  // The upload this job belongs to, so a page that was torn down can find
  // its still-running jobs again by file rather than by job id.
  uploadId: string;
  state: JobState;
  percent: number | null;
  out: string;
  size: number;
  error: string | null;
  kind: MediaKind;
  trim: TrimWindow | null;
  copy: boolean;
  hardware: boolean;
  // When the job started, so finished ones can be dropped from the map.
  at: number;
}
export interface ErrorResponse {
  ok: false;
  error: string;
}

// The jobs the page may still care about, keyed by the upload they belong to.
// The server is the authority on "is something still running": a page that was
// torn down and rebuilt asks here instead of trusting its own snapshot.
// One queue row as the page rebuilds it: the upload plus its latest job. The
// server is the source of truth, so a rebuilt page shows the same files and
// the same running jobs as any other window.
export interface QueueItem {
  upload: {
    ok: true;
    id: string;
    name: string;
    kind: MediaKind;
    duration: number;
    size: number;
    streams: StreamInfo;
    meta: MediaMeta;
  };
  job: JobInfo | null;
}

// One row of the server-side directory browser the panel uses to add files by
// path instead of sending them through the browser.
export interface BrowseEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  kind: MediaKind;
}

export interface JobInfo {
  id: string;
  uploadId: string;
  state: JobState;
  percent: number | null;
  out: string;
  size: number;
  error: string | null;
  kind: MediaKind;
  copy: boolean;
  hardware: boolean;
}

// One settled conversion, appended to a JSONL ledger on disk so it survives a
// DSH restart. `out` is the output file name only; the panel greys a row whose
// file no longer exists. `state` is the final job state — done, error, or
// cancelled all land here.
export interface HistoryEntry {
  name: string;
  out: string;
  size: number;
  state: JobState;
  error: string | null;
  at: number;
}
export interface HistoryItem extends HistoryEntry {
  deleted: boolean;
}
export interface HistoryResponse {
  ok: true;
  items: HistoryItem[];
  total: number;
}
// What the panel sends to drop ledger rows: the row key is at + out, the same
// composite the list view keys by. deleteFiles additionally unlinks the output
// file of every matched row.
export interface HistoryDeleteRequest {
  items: Array<{ at: number; out: string }>;
  deleteFiles?: boolean;
}
export interface HistoryDeleteResponse {
  ok: true;
  removed: number;
  filesDeleted: number;
}

// The queue-removal answer: per-id so one running job cannot block the rest.
// `skipped` names uploads a running job still reads (they are never deleted
// from under ffmpeg) and ids the Host never heard of is not an error.
export interface UploadDeleteResponse {
  ok: true;
  removed: number;
  skipped: string[];
}

// One checked batch is a server-side "run": the Host walks its items in order,
// starting one normal Job per file. The run is what a page restores from when
// it is closed, reloaded, or switched away mid-batch — the browser is not the
// thing that keeps the batch alive.
export type RunState = 'running' | 'done' | 'cancelled' | 'error';
export type RunItemState = 'waiting' | 'converting' | 'skipped' | 'cancelled' | 'done' | 'error';
export interface RunItemInfo {
  id: string;
  // 'extract-audio' / 'extract-video' for an audio/video batch, '' for convert.
  mode: string;
  format: string;
  // An extension preset reference ('x:<manifest>/<action>'); '' = plain convert.
  preset?: string;
  // The panel's per-row quality choice; the run's top-level quality is the
  // fallback for rows without one.
  quality?: number;
  // The panel's per-row audio bitrate (kbps); lossy audio formats only.
  bitrate?: number;
  // The panel's per-row video knobs; video targets only (gif and regular
  // containers), 0/absent = recipe default (gif) or source (others).
  fps?: number;
  width?: number;
  // The panel's per-row GPU codec choice ('h264' | 'hevc'); hardware only.
  codec?: string;
  // The panel's per-row audio downmix (mono/stereo) and sample rate; audio
  // encode targets only, 0/absent = keep the source.
  channels?: number;
  sampleRate?: number;
  state: RunItemState;
  percent: number | null;
  jobId: string;
  // A skipped row carries the panel's own locale key (e.g. 'hint.noAudio'),
  // so the restored row explains itself in the user's language.
  error: string;
  result: { file: string; size: number; kind: MediaKind; copy: boolean; hardware: boolean } | null;
}
export interface RunInfo {
  id: string;
  state: RunState;
  // 'ptc' runs are planned by the model and executed in bounded evaluation
  // waves; `stage` tells a rebuilt page whether the model is still deciding.
  kind: 'plain' | 'ptc';
  stage?: 'planning' | 'converting';
  at: number;
  modelMs?: number;
  runMs?: number;
  // Estimated wall time for the whole batch, from the measured throughput.
  estimatedMs?: number;
  error?: string;
  items: RunItemInfo[];
}

// An uploaded file the Host keeps on disk until the job is done.
export interface Upload {
  id: string;
  name: string;
  path: string;
  // True only for a copy in the temp dir: a file registered by path is the
  // user's own and must never be deleted by the TTL sweep or on unload.
  owned: boolean;
  kind: MediaKind;
  duration: number;
  size: number;
  streams: StreamInfo;
  meta: MediaMeta;
  at: number;
}

// The JSON bodies the routes accept.
export interface JsonBody {
  id?: string;
  mode?: string;
  format?: string;
  quality?: number;
  bitrate?: number;
  fps?: number;
  width?: number;
  // Audio downmix (mono/stereo) and sample rate; audio encode targets only,
  // 0/absent = keep the source.
  channels?: number;
  sampleRate?: number;
  codec?: unknown;
  hardware?: unknown;
  // An extension preset reference ('x:<manifest>/<action>'); when set, the
  // plan comes from the extension table instead of the built-in recipe.
  preset?: unknown;
  name?: string;
  stream?: number | string;
  trim?: { start?: unknown; end?: unknown };
  tags?: Record<string, string>;
  text?: string;
  file?: string;
  outputDir?: unknown;
  ffmpegPath?: unknown;
  maxUploadMb?: unknown;
  composerButton?: unknown;
  groups?: unknown;
  features?: unknown;
  persistState?: unknown;
  uploadTtlMinutes?: unknown;
  queueLimit?: unknown;
  extensions?: unknown;
  ids?: unknown;
  items?: unknown;
  model?: unknown;
  runId?: unknown;
  ptc?: unknown;
  paths?: unknown;
  dir?: unknown;
  recursive?: unknown;
}

// The answers of the routes, each built by a small function so the exported
// type is derived from what is actually sent.
export interface HardwareInfo {
  h264: boolean;
  hevc: boolean;
  hwaccel: boolean;
  // The backend the probe settled on, and the name the panel shows.
  backend: HwBackendId | null;
  backendLabel: string | null;
  // True while the device check is still running: the panel must not offer a
  // backend the Host has not verified yet.
  detecting: boolean;
}
const noHardware: HardwareInfo = {
  h264: false,
  hevc: false,
  hwaccel: false,
  backend: null,
  backendLabel: null,
  detecting: false,
};
export interface FfmpegProbe {
  info: HardwareInfo;
  // Encoder names from `-encoders`, e.g. "libtheora"; drives supportedFormats.
  encoders: string[];
  // The backend this machine can really run, if any.
  backend: HwBackend | null;
}
// The cheap half of the probe, per ffmpeg path.
const buildCache = new Map<string, Promise<FfmpegBuild>>();
// The device half, per ffmpeg path: one driver check per binary.
const deviceCache = new Map<string, Promise<{ backend: HwBackend; hevc: boolean } | null>>();

// Running ffmpeg: resolves with its output, rejects when the command fails.
// The runner is injected so the whole probe can be walked on a machine that
// has no graphics card at all.
export type FfmpegRunner = (args: string[], timeoutMs?: number) => Promise<string>;

// Listing the encoders and the hardware decoders: two local calls, no
// graphics driver involved.
const FFMPEG_TIMEOUT_MS = 15_000;
// One real frame through the encoder starts a graphics driver. A driver that
// hangs must not hold the panel hostage, so this call waits on its own.
// shortcut: 8 seconds; no real machine needed more than one, but the first
// oneVPL init can take a few. Raise it if a real machine needs more.
const DEVICE_TIMEOUT_MS = 8_000;

function execRunner(ffmpeg: string): FfmpegRunner {
  return (args, timeoutMs = FFMPEG_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      execFile(ffmpeg, args, { timeout: timeoutMs }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout || '')),
      );
    });
}

// One frame through the given encoder of a backend. A vendor encoder can be
// compiled into the binary and still have no device to talk to (no matching
// GPU, no driver), so only a real encode proves the machine can use it. The
// rate options ride along: an option name this ffmpeg does not know fails the
// check here instead of in the middle of a user's batch.
function deviceArgs(backend: HwBackend, encoder: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=64x64:r=1:d=0.1',
    '-frames:v',
    '1',
    ...backend.rateArgs,
    '-c:v',
    encoder,
    '-b:v',
    '200k',
    '-f',
    'null',
    '-',
  ];
}

// What this ffmpeg binary can do: the encoder names and the hardware
// decoders it carries. Both come from cheap local calls.
export interface FfmpegBuild {
  encoders: string[];
  hwaccels: Set<string>;
}

export async function probeFfmpegBuild(ffmpeg: string, run: FfmpegRunner = execRunner(ffmpeg)): Promise<FfmpegBuild> {
  const [encText, accelText] = await Promise.all([
    run(['-hide_banner', '-encoders'], FFMPEG_TIMEOUT_MS).catch(() => ''),
    run(['-hide_banner', '-hwaccels'], FFMPEG_TIMEOUT_MS).catch(() => ''),
  ]);
  // Some lines carry a leading space in the flags column (" VF...D").
  const encoders = [...encText.matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)].map((match) => match[1]);
  const hwaccels = new Set(accelText.split(/\s+/).filter((name) => /^[a-z][a-z0-9_]*$/.test(name)));
  return { encoders, hwaccels };
}

// Which backend this machine can really run, and whether its HEVC sibling
// encodes too. This starts a graphics driver, so it can take seconds; the
// caller usually runs it in the background. A backend whose H.264 works but
// whose HEVC does not (an older GPU) stays offered — just without the codec
// choice.
export async function probeFfmpegDevice(
  platform: string,
  build: FfmpegBuild,
  run: FfmpegRunner,
): Promise<{ backend: HwBackend; hevc: boolean } | null> {
  // The first backend this machine can really run wins: a laptop with an
  // Intel GPU and an NVIDIA card uses the NVIDIA encoder. Only a real encode
  // counts — an encoder the binary carries but the GPU cannot run must not
  // put a GPU switch in front of the user.
  const backend = await pickBackend(platform, build.encoders, build.hwaccels, async (candidate) => {
    try {
      await run(deviceArgs(candidate, candidate.encoder), DEVICE_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  });
  if (!backend) return null;
  // The HEVC check is gated on the encoder list: a binary that does not even
  // carry hevc_nvenc cannot gain the codec by passing a device check.
  let hevc = false;
  if (build.encoders.includes(backend.hevcEncoder)) {
    try {
      await run(deviceArgs(backend, backend.hevcEncoder), DEVICE_TIMEOUT_MS);
      hevc = true;
    } catch {
      hevc = false;
    }
  }
  return { backend, hevc };
}

// Both halves, for a caller that can wait.
export async function probeFfmpeg(
  ffmpeg: string,
  platform = process.platform,
  run: FfmpegRunner = execRunner(ffmpeg),
): Promise<FfmpegProbe> {
  const build = await probeFfmpegBuild(ffmpeg, run);
  const chosen = await probeFfmpegDevice(platform, build, run);
  return {
    info: {
      h264: chosen !== null,
      hevc: chosen ? chosen.hevc : false,
      hwaccel: chosen !== null,
      backend: chosen ? chosen.backend.id : null,
      backendLabel: chosen ? chosen.backend.label : null,
      detecting: false,
    },
    encoders: build.encoders,
    backend: chosen ? chosen.backend : null,
  };
}

let modelCatalog: { at: number; models: PtcModelOption[]; unavailable: string[] } | null = null;
async function loadModelCatalog(llm: Llm): Promise<{ models: PtcModelOption[]; unavailable: string[] }> {
  if (modelCatalog && Date.now() - modelCatalog.at < 60_000) return modelCatalog;
  const models: PtcModelOption[] = [];
  const unavailable: string[] = [];
  const providers = llm.listProviders?.() ?? [];
  await Promise.all(
    providers.map(async (provider) => {
      try {
        const list = (await llm.listModels?.(provider.id)) ?? [];
        for (const model of list) {
          models.push({
            provider: provider.id,
            providerName: provider.name,
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
          });
        }
      } catch {
        unavailable.push(provider.id);
      }
    }),
  );
  modelCatalog = { at: Date.now(), models, unavailable };
  return modelCatalog;
}

const statusPayload = (
  ffmpegPath: string | null,
  outputDir: string,
  maxUploadMb: number,
  version: string,
  composerButton: boolean,
  groups: string[],
  persistState: boolean,
  uploadTtlMinutes: number,
  queueLimit: number,
  instanceId: string,
  hardware: HardwareInfo,
  probeMode: 'ffprobe' | 'ffmpeg',
  formats: FormatTable,
  extensions: ReturnType<typeof statusOf>,
) => ({
  ok: true as const,
  ffmpegPath,
  outputDir,
  maxUploadMb,
  version,
  composerButton,
  groups,
  persistState,
  uploadTtlMinutes,
  queueLimit,
  instanceId,
  hardware,
  probeMode,
  formats,
  extensions,
});
export type StatusResponse = ReturnType<typeof statusPayload>;

const uploadPayload = (
  id: string,
  name: string,
  kind: MediaKind,
  duration: number,
  size: number,
  streams: StreamInfo,
  meta: MediaMeta,
) => ({ ok: true as const, id, name, kind, duration, size, streams, meta });
export type UploadResponse = ReturnType<typeof uploadPayload>;

const base64Payload = (mime: string, size: number) => ({ ok: true as const, mime, size });
// The encoded string is streamed behind the payload, so the answer carries it
// even though the builder does not hold it.
export type Base64Response = ReturnType<typeof base64Payload> & { data: string };

// The decode route answers with one of two shapes: plain text, or a file it
// wrote into the output directory.
const decodeTextPayload = (text: string) => ({ ok: true as const, kind: 'text' as const, text });
const decodeFilePayload = (kind: MediaKind, file: string, mime: string, size: number) => ({
  ok: true as const,
  kind,
  file,
  mime,
  size,
});
export type DecodeResponse = ReturnType<typeof decodeTextPayload> | ReturnType<typeof decodeFilePayload>;

const errorPayload = (error: string): ErrorResponse => ({ ok: false, error });

export interface PtcModelOption {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  description?: string;
}
export interface ModelsResponse {
  ok: true;
  default: { provider: string; model: string; name: string } | null;
  models: PtcModelOption[];
  unavailableProviders?: string[];
}

const PREFIX = '/api/media-convert';
const MAX_BASE64_BYTES = 24 * 1024 * 1024;
// Uploaded copies live in a temp directory. Big videos are big, so anything
// older than this is dropped instead of filling the disk over a long session.
// The built-in defaults for the two runtime-tunable caps below; both are
// user-configurable (Config.uploadTtlMinutes / Config.queueLimit).
const DEFAULT_UPLOAD_TTL_MINUTES = 120;
// A rebuilt page rebuilds its whole queue from /queue, so the cap has to cover
// what /register allows to be added at once; a smaller cap silently drops rows.
const DEFAULT_QUEUE_LIMIT = 2000;
// A finished job only has to outlive the poll that reads it.
const JOB_TTL_MS = 30 * 60 * 1000;

// Drop uploads whose TTL has passed, except any a running job still reads
// (deleting the source under ffmpeg breaks the job and the queue row).
// Pure over the maps so the host tests can drive it without the 10-minute
// timer. Returns the pruned ids.
export const pruneUploads = (
  uploads: Map<string, Upload>,
  jobs: Map<string, Job>,
  ttlMs: number,
  now: number,
): string[] => {
  const pruned: string[] = [];
  for (const [id, upload] of uploads) {
    if (now - upload.at <= ttlMs) continue;
    if ([...jobs.values()].some((job) => job.uploadId === id && job.state === 'running')) continue;
    uploads.delete(id);
    if (upload.owned) fs.rm(upload.path, { force: true }, () => {});
    pruned.push(id);
  }
  return pruned;
};
// An upload bigger than this is refused instead of filling the disk.
const MAX_UPLOAD_MB = 2048;

function isExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The version the host serves to the settings page, read from the shipped
// package.json next to dist/.
function pluginVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

// Machines without `ffmpeg` on PATH often still carry imageio-ffmpeg's static
// build; check there before telling the user to install anything.
function imageioBinaries(): string[] {
  const out: string[] = [];
  const listDirs = (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  for (const pattern of imageioPatterns(process.platform, process.env, os.homedir())) {
    for (const dir of expandDirs(pattern[0], pattern.slice(1), listDirs, process.platform)) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (/^ffmpeg/i.test(file)) out.push(path.join(dir, file));
        }
      } catch {
        // not the static-build layout
      }
    }
  }
  return out;
}

function findFfmpeg(configured?: string): string | null {
  const candidates = [
    ...ffmpegCandidates({ platform: process.platform, configured, env: process.env, home: os.homedir() }),
    ...imageioBinaries(),
  ];
  return candidates.find((c) => c && isExecutable(c)) || null;
}

function probe(ffmpeg: string, file: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { timeout: 20000 }, (_error, _stdout, stderr) => {
      // ffmpeg writes CRLF on Windows; the parser expects plain lines.
      resolve(normalizeStderr(stderr));
    });
  });
}

function findFfprobe(ffmpegPath: string): string | null {
  const candidates = probeCandidates(ffmpegPath, {
    platform: process.platform,
    configured: null,
    env: process.env,
    home: os.homedir(),
  });
  return candidates.find((c) => c && isExecutable(c)) || null;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

interface ProbedFile {
  kind: MediaKind;
  duration: number;
  streams: StreamInfo;
  meta: MediaMeta;
}

// What one file is, plus everything the panel shows about it. Prefers
// ffprobe's JSON when the binary exists; otherwise parses `ffmpeg -i`
// stderr. Returns null when neither route recognises the file as media.
async function probeFile(file: string, ffmpeg: string, ffprobe: string | null): Promise<ProbedFile | null> {
  const name = path.basename(file);
  if (ffprobe) {
    try {
      const stdout = await execFileText(ffprobe, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        file,
      ]);
      const meta = parseFfprobeJson(stdout);
      if (meta) {
        // Same precedence as kindOf(): the extension wins, then the streams.
        const byExt = kindByExt(extOf(name));
        const kind: MediaKind | null = byExt !== 'file' ? byExt : meta.video ? 'video' : meta.audio ? 'audio' : null;
        if (kind) return { kind, duration: meta.duration, streams: streamInfoOf(meta), meta };
      }
    } catch {
      // ffprobe hiccuped (non-zero exit, timeout): the stderr route decides.
    }
  }
  const stderr = await probe(ffmpeg, file);
  const kind = kindOf(name, stderr);
  if (!kind) return null;
  return { kind, duration: parseDuration(stderr), streams: parseStreams(stderr), meta: parseMeta(stderr) };
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64e6) throw new Error('请求体过大');
  }
  return body ? (JSON.parse(body) as JsonBody) : {};
}

// The URL of the request, whatever the route was called with.
const requestUrl = (req: IncomingMessage): URL => new URL(req.url as string, 'http://localhost');

// The message of a thrown value, however it was thrown.
const errorText = (err: unknown): string => String((err instanceof Error ? err.message : err) || err);

// Base64 encoder that works on the file in chunks: the native Buffer encoder
// is twice as fast as the string decoder, and the file never becomes one
// string in memory. Chunks are trimmed to a multiple of three so the Base64
// stays aligned.
function base64Encoder(): Transform {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, done) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const usable = pending.length - (pending.length % 3);
      if (usable) this.push(pending.subarray(0, usable).toString('base64'));
      pending = pending.subarray(usable);
      done();
    },
    flush(done) {
      if (pending.length) this.push(pending.toString('base64'));
      done();
    },
  });
}

// The web server is the panel's home, the tool registry serves the agent, and
// settings makes the exported Config schema editable in the UI. The connection
// service is the trust fence every route crosses. All four are hard
// dependencies: Cordis runs apply only once every service is ready, so the
// fence cannot be missed because the plugin started a moment too early.
export const inject = ['webServer', 'tools', 'settings', 'connection'];

// One ffmpeg run's outcome. ms is how long the run took: the throughput
// estimate needs the time of the run that actually produced the file.
export interface AttemptOutcome {
  ok: boolean;
  size: number;
  error: string;
  ms: number;
}

// The plans one job tries, in order: the hardware plan first, then the same
// plan without the hardware decoder (the encoder stays on the GPU). A
// software job has one try. A failed run can leave half an output file
// behind, so it is removed before the next try.
export async function runJobAttempts(
  plan: ConvertPlan,
  attempt: (plan: ConvertPlan) => Promise<AttemptOutcome>,
  out: string,
  shouldStop: () => boolean,
): Promise<{ ok: boolean; size: number; error: string; ms: number; tries: number }> {
  const plans = plan.hardware ? [plan, { ...plan, inputArgs: undefined }] : [plan];
  let lastError = '';
  let tries = 0;
  for (const next of plans) {
    if (shouldStop()) break;
    tries += 1;
    const result = await attempt(next);
    if (result.ok) return { ok: true, size: result.size, error: '', ms: result.ms, tries };
    lastError = result.error;
    if (shouldStop()) break;
    // The next attempt starts from a clean slate.
    await fsp.rm(out, { force: true }).catch(() => {});
  }
  return { ok: false, size: 0, error: lastError, ms: 0, tries };
}

export function apply(ctx: HostContext, config?: Partial<Config>): void {
  // The loaded config, updated by the config route after each save so the
  // live merge accumulates across saves instead of restarting from the
  // load-time values.
  let cfg: Partial<Config> = config || {};
  // Volatile fields arrive wrapped (cosmokit Volatile, read via .get()); the
  // host test feeds plain values, so unwrap by shape rather than type.
  const unwrap = (value: unknown): unknown =>
    value && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get: () => unknown }).get()
      : value;
  // The desktop loader does not re-apply a plugin when its config changes
  // (verified live: the document updates, the running instance keeps the
  // values it loaded with). These bindings are therefore `let`, and the
  // config route re-resolves them after a save, so a change takes effect
  // without a restart. The saved document stays the source of truth across
  // restarts. Every consumer reads the bindings at request time, so nothing
  // captures a stale copy.
  let outDir = '';
  let ffmpeg: string | null = null;
  // The structured prober, when a full install ships it next to ffmpeg;
  // imageio-ffmpeg's single static binary does not, and that is fine.
  let ffprobe: string | null = null;
  let maxUploadBytes = MAX_UPLOAD_MB * 1048576;
  let uploadLimit = `${MAX_UPLOAD_MB} MB`;
  let composerButton = true;
  let groups: string[] = [...GROUP_KEYS];
  let features: string[] = resolveFeatures('');
  let persistState = false;
  let uploadTtlMs = DEFAULT_UPLOAD_TTL_MINUTES * 60 * 1000;
  let queueLimitN = DEFAULT_QUEUE_LIMIT;
  // User extensions (data-only manifests): parsed tolerantly at load — a bad
  // saved value must not take the whole plugin down — and strictly at save.
  let extensionManifests: ExtensionManifest[] = [];
  let extensionEntries: ExtensionEntry[] = [];
  const resolveConfig = (raw: Partial<Config>) => {
    // A configured '~/Movies/x' means the home directory, not a folder literally
    // named '~' under the working directory.
    const cfgOutputDir = unwrap(raw.outputDir);
    const configured = cfgOutputDir ? String(cfgOutputDir).replace(/^~(?=$|[/\\])/, os.homedir()) : '';
    outDir = path.resolve(configured || path.join(os.homedir(), 'Downloads', 'media-toolbox'));
    const cfgFfmpeg = unwrap(raw.ffmpegPath);
    ffmpeg = findFfmpeg(cfgFfmpeg ? String(cfgFfmpeg) : undefined);
    // A full install ships ffprobe next to ffmpeg; imageio's single static
    // binary does not, and the stderr parser below carries that case.
    ffprobe = ffmpeg ? findFfprobe(ffmpeg) : null;
    if (ffprobe) console.log(`[dsh-media-converter] ffprobe found: ${ffprobe} (structured metadata probing)`);
    // An upload bigger than this is refused instead of filling the disk.
    const cfgMaxMb = unwrap(raw.maxUploadMb);
    maxUploadBytes = Math.max(1, Math.round((cfgMaxMb === undefined ? MAX_UPLOAD_MB : Number(cfgMaxMb)) * 1048576));
    uploadLimit = maxUploadBytes >= 1048576 ? `${Math.round(maxUploadBytes / 1048576)} MB` : `${maxUploadBytes} B`;
    composerButton = unwrap(raw.composerButton) !== false;
    groups = resolveGroups(unwrap(raw.groups));
    features = resolveFeatures(unwrap(raw.features));
    persistState = unwrap(raw.persistState) === true;
    const cfgTtl = unwrap(raw.uploadTtlMinutes);
    // Floor of 5 minutes: a smaller TTL deletes sources under running jobs.
    uploadTtlMs =
      Math.max(5, Math.round(cfgTtl === undefined ? DEFAULT_UPLOAD_TTL_MINUTES : Number(cfgTtl))) * 60 * 1000;
    const cfgQueueLimit = unwrap(raw.queueLimit);
    // Floor of 10: a /queue cap near zero would restore an empty page.
    queueLimitN = Math.max(10, Math.round(cfgQueueLimit === undefined ? DEFAULT_QUEUE_LIMIT : Number(cfgQueueLimit)));
    const parsedExtensions = parseExtensions(unwrap(raw.extensions));
    if (!parsedExtensions.ok) {
      console.error(`[dsh-media-converter] extensions 配置无效，已忽略：${parsedExtensions.error}`);
    }
    extensionManifests = parsedExtensions.ok ? parsedExtensions.manifests : [];
    extensionEntries = entriesOf(extensionManifests);
  };
  resolveConfig(cfg);
  // The backend this machine can really run. planFor() is synchronous, so the
  // probe publishes its verdict here. undefined = the device check is still
  // running, null = no backend works, otherwise the backend itself.
  let hwBackend: HwBackend | null | undefined = undefined;
  // Whether the chosen backend's HEVC sibling passed its own device check.
  let hwHevc = false;
  // Whether the device check has produced its verdict.
  let deviceSettled = false;
  // The cheap half of the probe: the encoder list and the hardware decoders.
  const detectBuild = (bin: string): Promise<FfmpegBuild> => {
    let pending = buildCache.get(bin);
    if (!pending) {
      pending = probeFfmpegBuild(bin);
      buildCache.set(bin, pending);
    }
    return pending;
  };
  // The slow half: it starts the graphics driver, so it runs in the
  // background. The verdict lands in hwBackend when it is ready.
  const startDeviceProbe = (bin: string, build: FfmpegBuild): Promise<HwBackend | null> => {
    let pending = deviceCache.get(bin);
    if (!pending) {
      pending = probeFfmpegDevice(process.platform, build, execRunner(bin)).catch(() => null);
      deviceCache.set(bin, pending);
    }
    // The cache outlives the instance: whoever asks adopts the verdict, so a
    // reloaded plugin does not wait for a probe that already ran.
    return pending.then((verdict) => {
      hwBackend = verdict ? verdict.backend : null;
      hwHevc = verdict ? verdict.hevc : false;
      deviceSettled = true;
      return hwBackend;
    });
  };
  // Wait for the verdict (the device check times out on its own). For a
  // request that asks for hardware encoding while the verdict is still
  // unknown: better to wait than to quietly fall back to the CPU.
  const deviceVerdict = async (bin: string): Promise<HwBackend | null> => {
    if (deviceSettled) return hwBackend ?? null;
    return startDeviceProbe(bin, await detectBuild(bin));
  };
  const tmpDir = path.join(os.tmpdir(), 'dsh-media-toolbox');
  const version = pluginVersion();

  const uploads = new Map<string, Upload>();
  const jobs = new Map<string, Job>();
  // Survives no restart: the client remembers the last one and compares on
  // every status fetch, so a fresh id is how it learns DSH was restarted.
  const instanceId = randomUUID();
  // The append-only ledger of settled jobs. Env override exists for tests and
  // for hosts that keep dotfiles elsewhere; the default sits next to the other
  // media-toolbox state in the home directory. Every write (append or the
  // filtered rewrite behind /history/delete) funnels through one promise
  // chain, so the two can never interleave and a rewrite can never swallow an
  // in-flight append. A lost history row never blocks or fails a conversion.
  const historyFile = process.env.MEDIA_TOOLBOX_HISTORY || path.join(os.homedir(), '.media-toolbox-history.json');
  let historyWrite: Promise<unknown> = Promise.resolve();
  const withLedgerLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = historyWrite.then(fn, fn);
    historyWrite = run.catch(() => {});
    return run;
  };
  const appendHistory = (entry: HistoryEntry) => {
    void withLedgerLock(() => fsp.appendFile(historyFile, `${JSON.stringify(entry)}\n`, 'utf8')).catch(() => {});
  };
  const runs = new Map<string, RunInfo>();
  const runControllers = new Map<string, AbortController>();
  // Measured encode throughput (media seconds per wall second) per path. The
  // seeds are conservative; every finished job blends its real speed in, so
  // PTC estimates follow this machine instead of a fixed guess.
  const ptcRates: PtcRates = { ...PTC_DEFAULT_RATES };
  let latestRun = '';
  const controllers = new Map<
    string,
    { controller: AbortController; child: ReturnType<typeof spawn>; killTimer: NodeJS.Timeout | null }
  >();
  const children = new Set<ReturnType<typeof spawn>>();

  const webServer = ctx.get('webServer');
  if (!webServer) {
    // inject should make this impossible; say so loudly if it ever happens.
    console.error('[dsh-media-converter] webServer service missing: no routes registered');
    return;
  }
  const noFfmpeg: ErrorResponse = {
    ok: false,
    error:
      '未找到 ffmpeg：请先安装（brew install ffmpeg / winget install ffmpeg），或用 FFMPEG_PATH / 插件配置 ffmpegPath 指定路径',
  };

  const json = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };

  // Every route crosses the connection trust fence before it touches the body
  // or the disk: 403 answers a foreign Host/Origin, 401 a caller without the
  // browser-session cookie. 503 when the composition owns no connection
  // service — fail closed, never serve an unauthenticated request.
  //
  // The service is looked up per request, not captured at apply time: a plugin
  // can apply before the composition registers its connection service, and a
  // captured undefined would refuse every route for the life of the instance
  // (the panel then shows "unauthorized" on every upload).
  const rejectUnauthenticated = (req: IncomingMessage, res: ServerResponse): boolean => {
    const connection = ctx.get('connection');
    if (!connection) {
      console.error('[dsh-media-converter] connection service missing: refusing request');
      json(res, 503, errorPayload('连接信任服务不可用：插件拿不到 connection 服务，请重启 DSH 后再试'));
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    // The next line is the quickest way to tell a missing service apart from a
    // real auth failure: host/origin/cookie presence are enough to diagnose.
    console.error(
      `[dsh-media-converter] request rejected (${rejection}): host=${req.headers.host || ''} origin=${req.headers.origin || ''} cookie=${req.headers.cookie ? 'yes' : 'no'}`,
    );
    json(res, rejection, errorPayload('unauthorized'));
    return true;
  };

  // The preview and the reveal may only reach into the output directory. The
  // check resolves both sides first: a plain prefix check is defeated by a
  // '..' segment inside the file name.
  const insideOutput = (file: unknown): file is string => typeof file === 'string' && isInsideDir(outDir, file);

  // The panel may look at the places a person keeps media — home, mounted
  // volumes, the temp dirs and the output dir — and nowhere else. This is the
  // one-line fence between "the user's files" and "whatever the process reads".
  const browseAllowed = (target: string): boolean => {
    const resolved = path.resolve(target);
    return [os.homedir(), '/Volumes', '/tmp', os.tmpdir(), outDir]
      .map((root) => path.resolve(root))
      .some((root) => resolved === root || isInsideDir(root, resolved));
  };

  const uniqueOutput = async (name: string, extension: string, suffix = ''): Promise<string> => {
    const stem = safeBaseName(name) + suffix;
    const candidate = path.join(outDir, `${stem}.${extension}`);
    const taken = await fsp.stat(candidate).then(
      () => true,
      () => false,
    );
    return taken
      ? path.join(outDir, `${stem}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${extension}`)
      : candidate;
  };

  // One finished job tells the estimator how fast this machine really is. Short
  // or failed jobs say nothing; blendPtcRate ignores those.
  const recordPtcRate = (job: Job, mediaSeconds: number, wallMs: number): void => {
    // Images are a fixed per-file cost, so they calibrate that constant
    // directly instead of a media rate.
    if (job.kind === 'image') {
      if (wallMs >= 50 && wallMs < 60_000) {
        ptcRates.imageMs = Math.max(50, ptcRates.imageMs * 0.6 + wallMs * 0.4);
      }
      return;
    }
    const key = job.copy
      ? 'copy'
      : job.hardware
        ? 'hardware'
        : job.kind === 'video'
          ? 'video'
          : job.kind === 'audio'
            ? 'audio'
            : '';
    if (!key) return;
    ptcRates[key] = blendPtcRate(ptcRates[key], mediaSeconds, wallMs);
  };

  const startJob = async (
    upload: Upload,
    plan: ConvertPlan,
    trim: TrimWindow | null,
    name: string,
  ): Promise<{ job: Job; done: Promise<void> }> => {
    await fsp.mkdir(outDir, { recursive: true });
    const out = await uniqueOutput(name || upload.name, plan.ext, plan.stemSuffix || '');
    const job: Job = {
      id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      uploadId: upload.id,
      state: 'running',
      percent: null,
      out,
      size: 0,
      error: null,
      kind: plan.kind,
      trim,
      copy: Boolean(plan.copy),
      hardware: Boolean(plan.hardware),
      at: Date.now(),
    };
    jobs.set(job.id, job);
    const span = trim ? trim.end - trim.start : upload.duration;
    // The ledger row every final state writes. The name is captured now: the
    // upload map entry may be swept before the job settles.
    const record = (state: JobState, size: number, error: string | null) =>
      appendHistory({ name: upload.name, out: path.basename(out), size, state, error, at: Date.now() });
    // Resolves when the job reaches its final state, so a caller that has to
    // wait (the agent tool) does not have to poll.
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    // One ffmpeg run with the given plan. The caller decides how many
    // plans to try.
    const attemptOnce = (attempt: ConvertPlan): Promise<AttemptOutcome> =>
      new Promise((resolve) => {
        const started = Date.now();
        const args = [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          ...(attempt.inputArgs || []),
          ...trimArgs(trim),
          '-i',
          upload.path,
          ...attempt.args,
          ...threadArgs(attempt.threads),
          '-progress',
          'pipe:1',
          '-nostats',
          out,
        ];
        // The AbortSignal is the whole cancel mechanism: aborting kills the
        // ffmpeg process, and the close handler below cleans up what it left.
        const controller = new AbortController();
        // The routes answer with "no ffmpeg" before they ever start a job.
        const child = spawn(ffmpeg!, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal });
        controllers.set(job.id, { controller, child, killTimer: null });
        children.add(child);

        let buffered = '';
        let tail = '';
        let spawnError = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines) {
            if (job.state !== 'running') return;
            const seconds = progressSeconds(line);
            if (seconds !== null) job.percent = percentOf(seconds, span);
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          tail = normalizeStderr(tail + chunk).slice(-2000);
        });
        child.on('error', (err) => {
          // 'close' follows a spawn failure, so the verdict is made there.
          spawnError = String((err && err.message) || err);
        });
        child.on('close', async (code) => {
          children.delete(child);
          const entry = controllers.get(job.id);
          if (entry && entry.killTimer) clearTimeout(entry.killTimer);
          controllers.delete(job.id);
          if (job.state === 'cancelling') {
            // ffmpeg can have written half an output before the kill landed.
            await fsp.rm(out, { force: true }).catch(() => {});
            job.state = 'cancelled';
            record('cancelled', 0, null);
            resolve({ ok: false, size: 0, error: 'cancelled', ms: Date.now() - started });
            return;
          }
          if (code === 0 && !spawnError) {
            try {
              const size = (await fsp.stat(out)).size;
              resolve({ ok: true, size, error: '', ms: Date.now() - started });
            } catch (err) {
              resolve({ ok: false, size: 0, error: errorText(err), ms: Date.now() - started });
            }
            return;
          }
          // ffmpeg can create the output before failing; never report that as done.
          await fsp.rm(out, { force: true }).catch(() => {});
          resolve({
            ok: false,
            size: 0,
            error: tail.trim().split('\n').slice(-3).join(' ') || spawnError || `ffmpeg 退出码 ${code}`,
            ms: Date.now() - started,
          });
        });
      });

    // The job runs in the background: the caller gets the job record now and
    // waits on `done` when it needs the result.
    const run = async (): Promise<void> => {
      try {
        // A GPU that cannot decode this file (VP9 on an older Intel chip,
        // ProRes, anything the driver does not list) must not sink the job:
        // the same encoder runs once more with the software decoder. The
        // encoder stays on the GPU, so the result is still a hardware encode.
        const result = await runJobAttempts(plan, attemptOnce, out, () => job.state !== 'running');
        if (result.ok) {
          job.size = result.size;
          job.state = 'done';
          job.percent = 100;
          recordPtcRate(job, span, result.ms);
          record('done', job.size, null);
          return;
        }
        if (job.state === 'running') {
          job.state = 'error';
          job.error = result.error;
          record('error', 0, job.error);
        } else if (job.state === 'cancelling') {
          // The cancel landed between two attempts: no process was left to kill.
          await fsp.rm(out, { force: true }).catch(() => {});
          job.state = 'cancelled';
          record('cancelled', 0, null);
        }
      } finally {
        // The job has its final state now: whoever waits for it can go on.
        settle();
      }
    };
    void run();
    return { job, done };
  };

  // Wait for a started job to settle, killing ffmpeg if the caller aborts.
  // Shared by the agent tool and the PTC media.convert binding.
  const awaitJob = async (job: Job, done: Promise<void>, signal: AbortSignal): Promise<Job> => {
    const abort = () => {
      if (job.state !== 'running') return;
      // The state is marked first: the job can sit between two attempts, with
      // no process left to kill.
      job.state = 'cancelling';
      controllers.get(job.id)?.controller.abort();
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    try {
      await done;
    } finally {
      signal.removeEventListener('abort', abort);
    }
    if (job.state === 'error') throw new Error(job.error || '处理失败');
    if (job.state !== 'done') throw new Error(`任务没有完成（${job.state}）`);
    return job;
  };

  // The run drives its items in three lanes: a software video encode saturates
  // every core (see capacityFor), so only one runs at a time; hardware encodes
  // ride the graphics card's media engine, cap 3 — parallel 1080p sessions
  // barely slow each other, 4K does; everything else (copy/image/audio) is
  // cheap and light.
  // A lane's workers walk their own queue, so a slow software video never
  // blocks the other lanes behind it.
  const executeRun = async (run: RunInfo, quality: number, hardware: boolean): Promise<void> => {
    // The backend must be settled before the plans are built, or a batch
    // that asked for hardware encoding would quietly fall back to the CPU.
    if (hardware) await deviceVerdict(ffmpeg!);
    const controller = new AbortController();
    runControllers.set(run.id, controller);
    const { signal } = controller;
    try {
      interface RunEntry {
        item: RunInfo['items'][number];
        upload: Upload;
        plan: ConvertPlan;
      }
      const softwareVideos: RunEntry[] = [];
      const hardwareJobs: RunEntry[] = [];
      const lightJobs: RunEntry[] = [];
      for (const item of run.items) {
        if (item.state !== 'waiting') continue;
        const upload = uploads.get(item.id);
        if (!upload) {
          item.state = 'error';
          item.error = '文件已失效，请重新选择';
          continue;
        }
        try {
          const plan = planFor(
            upload,
            {
              mode: item.mode,
              format: item.format,
              quality: item.quality ?? quality,
              bitrate: item.bitrate,
              fps: item.fps,
              width: item.width,
              channels: item.channels,
              sampleRate: item.sampleRate,
              codec: item.codec,
              preset: item.preset || '',
              hardware,
            },
            0,
          );
          // Container rewrites (copy, extract-audio, metadata) carry 'copy' in
          // their encoder args but not the copy flag; only a real re-encode
          // belongs on the one-at-a-time software video lane.
          const isRewrite = plan.copy || plan.args.includes('copy');
          if (!isRewrite && !plan.hardware && upload.kind === 'video') {
            softwareVideos.push({ item, upload, plan });
          } else if (plan.hardware) {
            hardwareJobs.push({ item, upload, plan });
          } else {
            lightJobs.push({ item, upload, plan });
          }
        } catch (err) {
          item.state = 'error';
          item.percent = null;
          item.error = errorText(err);
        }
      }
      const processItem = async ({ item, upload, plan }: RunEntry): Promise<void> => {
        // An item can wait in a lane while the batch is cancelled: never start it.
        if (run.state !== 'running' || signal.aborted) {
          if (item.state === 'waiting') item.state = 'cancelled';
          return;
        }
        item.state = 'converting';
        item.percent = null;
        try {
          const { job, done } = await startJob(upload, plan, null, '');
          item.jobId = job.id;
          // A cancel can land between "this item started" and the process
          // existing; the run is already cancelled then, so stop it right away.
          if (run.state !== 'running' && job.state === 'running') {
            job.state = 'cancelling';
            controllers.get(job.id)?.controller.abort();
          }
          const tick = setInterval(() => {
            item.percent = job.percent;
          }, 250);
          tick.unref();
          try {
            await awaitJob(job, done, signal);
          } finally {
            clearInterval(tick);
          }
          if (job.state === 'done') {
            item.state = 'done';
            item.percent = 100;
            item.result = { file: job.out, size: job.size, kind: job.kind, copy: job.copy, hardware: job.hardware };
          } else if (job.state === 'cancelled') {
            item.state = 'cancelled';
            item.percent = null;
          } else {
            item.state = 'error';
            item.percent = null;
            item.error = job.error || '处理失败';
          }
        } catch (err) {
          item.state = run.state === 'running' && !signal.aborted ? 'error' : 'cancelled';
          item.percent = null;
          if (item.state === 'error') item.error = errorText(err);
        }
      };
      const runLane = async (entries: RunEntry[], width: number): Promise<void> => {
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < entries.length) {
            const entry = entries[cursor];
            cursor += 1;
            await processItem(entry);
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(width, Math.max(1, entries.length))) }, worker));
      };
      const lightCap = Math.max(1, Math.min(4, cpus));
      await Promise.all([runLane(softwareVideos, 1), runLane(hardwareJobs, 3), runLane(lightJobs, lightCap)]);
      if (run.state === 'running') run.state = 'done';
    } finally {
      runControllers.delete(run.id);
    }
  };

  // PTC batch: the model decides per-file formats once, then the Host runs the
  // plan in cost-sized evaluation groups. The limits follow the machine: each
  // file's cost comes from measured throughput, a group is as large as the
  // runtime's time cap allows, and the binding wave follows the live CPU
  // capacity instead of a fixed constant.
  const executePtcRun = async (
    run: RunInfo,
    requested: { provider: string; model: string } | null,
    quality: number,
    hardware: boolean,
  ): Promise<void> => {
    // The backend must be settled before the plans are built, or a batch
    // that asked for hardware encoding would quietly fall back to the CPU.
    if (hardware) await deviceVerdict(ffmpeg!);
    const controller = new AbortController();
    runControllers.set(run.id, controller);
    const { signal } = controller;
    const runtime = ctx.get('ptcRuntime');
    const policies = ctx.get('sandboxPolicy');
    try {
      // A cancel can land between the POST answer and this line; the run is
      // already cancelled then, and the rows already say so.
      if (run.state !== 'running') return;
      if (!runtime || !policies) {
        throw new Error('PTC 调度不可用：当前环境缺少 PTC 运行时（不会回退到固定规则）');
      }
      // A skipped row (a silent video asked for an audio-only target) never
      // reaches the model: its format is empty, and the plan is validated
      // against exactly the files that will be converted.
      const planned = run.items.filter((item) => item.state !== 'skipped');
      const files: Upload[] = [];
      for (const item of planned) {
        const upload = uploads.get(item.id);
        if (upload) files.push(upload);
      }
      if (files.length !== planned.length) throw new Error('文件已失效，请重新选择');
      // Preset rows carry the reference as their target: the model echoes it
      // back as the row's format, and parsePtcPlan validates it against the
      // extension table.
      const targets = new Map(planned.map((item) => [item.id, item.preset || item.format]));
      const bitrates = new Map(planned.map((item) => [item.id, item.bitrate]));
      const channelMap = new Map(planned.map((item) => [item.id, item.channels]));
      const rateMap = new Map(planned.map((item) => [item.id, item.sampleRate]));
      const model = await resolvePtcModel(requested);
      run.stage = 'planning';
      const modelStart = Date.now();
      const plan = await collectPtcPlan(files, targets, bitrates, channelMap, rateMap, quality, model, controller);
      run.modelMs = Date.now() - modelStart;
      for (const row of plan) {
        const item = run.items.find((candidate) => candidate.id === row.id);
        if (item) {
          item.format = row.format;
          // The model may omit bitrate/codec: the panel's choice stays the fallback.
          if (row.bitrate !== undefined) item.bitrate = row.bitrate;
          if (row.codec !== undefined) item.codec = row.codec;
          if (row.channels !== undefined) item.channels = row.channels;
          if (row.sampleRate !== undefined) item.sampleRate = row.sampleRate;
        }
      }
      run.stage = 'converting';
      await fsp.mkdir(outDir, { recursive: true });
      const policy = policies.resolve({ mode: 'read-only' });
      const limits = runtime.timeout || { defaultMs: 120_000, maxMs: 600_000 };
      const allowed = new Set(files.map((file) => file.id));
      const runStart = Date.now();
      // Cost every planned file once: a copy or hardware path skips the
      // encoder, and the measured rates track this machine's real speed.
      const costs = new Map<string, number>();
      let totalCost = 0;
      for (const row of plan) {
        const upload = uploads.get(row.id);
        if (!upload) continue;
        // codec rides along: like quality it can flip the copy gate (a hevc
        // ask is a re-encode), and a misread plan would cost the row as a
        // free copy while the binding runs a hardware encode.
        const rowPreset = row.format.startsWith('x:') ? row.format : '';
        const preview = planFor(upload, {
          format: rowPreset ? '' : row.format,
          preset: rowPreset,
          quality: row.quality ?? quality,
          bitrate: row.bitrate ?? bitrates.get(row.id),
          // channels/sampleRate ride along for the copy gate too: a mono ask
          // is a re-encode, costed as a copy it would dodge nothing but lie.
          channels: row.channels ?? channelMap.get(row.id),
          sampleRate: row.sampleRate ?? rateMap.get(row.id),
          codec: row.codec,
          hardware,
        });
        const cost = estimatePtcCost(
          {
            duration: upload.duration,
            kind: upload.kind,
            copy: Boolean(preview.copy),
            hardware: Boolean(preview.hardware),
          },
          ptcRates,
        );
        costs.set(row.id, cost);
        totalCost += cost;
      }
      // The ETA the panel shows is the same cost, but wall time with the
      // scheduler's idle concurrency (groups stay sized on the serial cost so a
      // slow machine can never overrun one evaluation).
      const parallel = Math.max(1, capacityFor(0, cpus));
      run.estimatedMs = Math.round((totalCost + plan.length * 1500) / parallel + 5000);
      // A group larger than the CPU can chew on only piles up pending binding
      // calls, so the file cap follows the machine too.
      const groups = planPtcGroups(
        plan.map((row) => ({ id: row.id, costMs: costs.get(row.id) ?? 0 })),
        {
          defaultMs: limits.defaultMs,
          maxMs: limits.maxMs,
          maxFiles: Math.max(4, Math.min(64, cpus * 4)),
        },
      );
      const convert = async (args: unknown): Promise<unknown> => {
        const a = (args || {}) as Record<string, unknown>;
        const upload = uploads.get(String(a.id || ''));
        if (!upload || !allowed.has(upload.id)) throw new Error('文件不在这一批里');
        const target = String(a.format || '');
        const presetRef = target.startsWith('x:') ? target : '';
        if (!presetRef && !formatsFor(upload.kind).includes(target)) {
          throw new Error(`不支持的输出格式: ${target}`);
        }
        const entry = run.items.find((item) => item.id === upload.id);
        if (entry) {
          entry.state = 'converting';
          entry.percent = null;
          entry.error = '';
        }
        // The estimate only picks a scheduling weight: fps/width change the
        // output size, not the lane, so they stay out of the estimate call.
        // codec stays in for the same reason quality does: it can flip the
        // copy gate, and a copy-classified hevc job would dodge the GPU cap.
        const estimate = planFor(upload, {
          format: target,
          quality: Number(a.quality ?? quality),
          bitrate: Number(a.bitrate ?? entry?.bitrate),
          channels: Number(a.channels ?? entry?.channels),
          sampleRate: Number(a.sampleRate ?? entry?.sampleRate),
          codec: a.codec !== undefined ? String(a.codec) : entry?.codec,
          preset: presetRef,
          hardware,
        });
        const weight = estimate.copy
          ? WEIGHTS.copy
          : estimate.hardware
            ? WEIGHTS.hardware
            : upload.kind === 'video'
              ? WEIGHTS.video
              : upload.kind === 'audio'
                ? WEIGHTS.audio
                : WEIGHTS.image;
        try {
          const finished = await schedule(
            weight,
            async (threads) => {
              const plan = planFor(
                upload,
                {
                  format: target,
                  quality: Number(a.quality ?? quality),
                  bitrate: Number(a.bitrate ?? entry?.bitrate),
                  fps: Number(a.fps ?? entry?.fps),
                  width: Number(a.width ?? entry?.width),
                  channels: Number(a.channels ?? entry?.channels),
                  sampleRate: Number(a.sampleRate ?? entry?.sampleRate),
                  codec: a.codec !== undefined ? String(a.codec) : entry?.codec,
                  preset: presetRef,
                  hardware,
                },
                threads,
              );
              const { job, done } = await startJob(upload, plan, null, '');
              if (entry) entry.jobId = job.id;
              const tick = entry
                ? setInterval(() => {
                    entry.percent = job.percent;
                  }, 300)
                : 0;
              try {
                return await awaitJob(job, done, signal);
              } finally {
                if (tick) clearInterval(tick);
              }
            },
            estimate.hardware,
          );
          if (entry) {
            entry.state = 'done';
            entry.percent = 100;
            entry.result = {
              file: finished.out,
              size: finished.size,
              kind: finished.kind,
              copy: finished.copy,
              hardware: finished.hardware,
            };
          }
          return {
            id: upload.id,
            output: finished.out,
            kind: finished.kind,
            sizeBytes: finished.size,
            copy: finished.copy,
            hardware: finished.hardware,
          };
        } catch (err) {
          if (entry) {
            entry.state = signal.aborted ? 'cancelled' : 'error';
            entry.percent = null;
            if (entry.state === 'error') entry.error = errorText(err);
          }
          throw err;
        }
      };
      for (const group of groups) {
        if (run.state !== 'running' || signal.aborted) break;
        const groupIds = new Set(group.items.map((row) => row.id));
        const rows = plan.filter((row) => groupIds.has(row.id));
        if (!rows.length) continue;
        // Concurrency the CPU can actually use right now; 1-4 slots become a
        // 4-16 call wave, well under the runtime's pending-call default.
        const wave = Math.max(4, Math.min(32, capacityFor(cpuUsage, cpus) * 4));
        const spec = runtime.resolve({
          program: ptcProgramFor(rows, wave),
          bindings: [{ global: 'media', functions: { convert } }],
          cwd: policy.workspaceRoot,
          sandboxPolicy: policy,
          timeoutMs: group.timeoutMs,
          signal,
        });
        const watchdog = setTimeout(() => controller.abort(), group.timeoutMs + 5_000);
        let result: { value?: unknown; logs?: string[]; error?: { kind: string; message: string } };
        try {
          result = await runtime.run(spec);
        } finally {
          clearTimeout(watchdog);
        }
        if (result.error) {
          const message = `PTC 运行失败（${result.error.kind}）：${result.error.message}`;
          for (const item of run.items) {
            if (groupIds.has(item.id) && (item.state === 'waiting' || item.state === 'converting')) {
              item.state = 'error';
              item.percent = null;
              item.error = message;
            }
          }
          throw new Error(message);
        }
      }
      run.runMs = Date.now() - runStart;
      run.stage = undefined;
      if (run.state === 'running') run.state = 'done';
    } catch (err) {
      run.stage = undefined;
      if (run.state === 'running') {
        run.state = signal.aborted ? 'cancelled' : 'error';
        run.error = signal.aborted ? '' : errorText(err);
      }
      for (const item of run.items) {
        if (item.state === 'waiting' || item.state === 'converting') {
          const cancelled = signal.aborted || run.state === 'cancelled';
          item.state = cancelled ? 'cancelled' : 'error';
          item.percent = null;
          if (!cancelled && !item.error) item.error = run.error || '处理失败';
        }
      }
    } finally {
      runControllers.delete(run.id);
    }
  };
  // A preset reference ('x:<manifest>/<action>') resolves before the built-in
  // modes: macros are fixed convert params (the convert entry re-runs every
  // tuned gate), recipes carry their own whitelisted args and always
  // re-encode, with quality sliding the mapped flag.
  const planForPreset = (upload: Upload, body: JsonBody, ref: string, threads: number): ConvertPlan => {
    const entry = extensionEntries.find((e) => e.ref === ref);
    if (!entry) throw new Error(`扩展预设不存在：${ref}`);
    if (!features.includes('convert')) throw new Error('该功能已停用');
    if (entry.type === 'macro') {
      const convert = actionFor('convert');
      if (!convert?.plan) throw new Error('该功能已停用');
      return convert.plan(upload, { ...entry.params, trim: body.trim, name: body.name }, threads, hwBackend);
    }
    const base = entry.args ?? [];
    const args = entry.quality ? applyQualityMap(base, entry.quality, Number(body.quality) || 90) : base;
    return { ext: entry.format, kind: kindByExt(entry.format), args: args.slice(), threads };
  };

  const planFor = (upload: Upload, body: JsonBody, threads = 0): ConvertPlan => {
    const preset = String(body.preset || '');
    if (preset) return planForPreset(upload, body, preset, threads);
    const mode = String(body.mode || 'convert');
    // Unrecognised modes keep the historical behaviour: they plan a convert.
    const entry = actionFor(mode) ?? actionFor('convert');
    if (!entry?.plan) throw new Error(`不支持的输出格式: ${String(body.format || '')}`);
    if (!features.includes(entry.id)) throw new Error('该功能已停用');
    return entry.plan(upload, body, threads, hwBackend);
  };

  // --- PTC batch scheduling ------------------------------------------------
  // The panel hands a checked batch to the user's main model, which writes a
  // small program over this one binding. Conversions still go through the
  // same planFor/startJob path, so PTC changes scheduling, not the ffmpeg core.
  const ptcPlanPrompt = (
    files: Upload[],
    targets: Map<string, string>,
    bitrates: Map<string, number | undefined>,
    channelMap: Map<string, number | undefined>,
    rateMap: Map<string, number | undefined>,
    quality: number,
  ): string => {
    const macroRefs = features.includes('convert')
      ? extensionEntries.filter((e) => e.type === 'macro').map((e) => `${e.ref}（${e.kind}）`)
      : [];
    const lines = files.map(
      (f) =>
        `- id=${f.id} name=${f.name} kind=${f.kind} target=${targets.get(f.id) || ''} ` +
        `bitrate=${bitrates.get(f.id) || ''} channels=${channelMap.get(f.id) || ''} ` +
        `rate=${rateMap.get(f.id) || ''} ` +
        `duration=${f.duration.toFixed(2)}s video=${f.streams.video ? 'yes' : 'no'} ` +
        `audio=${f.streams.audio ? 'yes' : 'no'} size=${(f.size / 1048576).toFixed(2)}MB`,
    );
    return [
      '你在为本地媒体工具箱调度一批转换任务。',
      `文件（共 ${files.length} 个，每行已有该文件的 target）：`,
      ...lines,
      '',
      `质量默认：${quality}（1-100，90=默认）。对软件编码的视频映射为该编码的质量参数（x264/vp9 为 CRF，avi/wmv/ogv 为 qscale），对 GPU 硬编视频映射为目标码率倍率，对 jpg/webp/avif 图片生效；quality 不是 90 时已强制重编码（不会走拷贝）。`,
      `各类型的可用输出格式：video=${ptcFormats('video', features).join(', ')}；audio=${ptcFormats('audio', features).join(', ')}；image=${ptcFormats('image', features).join(', ')}。`,
      ...(macroRefs.length
        ? [`可用预设（宏，固定参数，format 直接填引用）：${macroRefs.join(' ')}。预设忽略 quality/bitrate 等旋钮。`]
        : []),
      '',
      '只返回一个 JSON 对象。不要代码、不要解释、不要 Markdown 代码块：',
      '{"files":[{"id":"文件id","format":"输出格式","quality":90,"bitrate":128,"channels":1,"rate":22050,"fps":12,"width":640,"codec":"h264"}]}',
      '',
      '规则：',
      '1. 每个文件恰好一条，id 必须与上面完全一致；不能多、不能少、不能重复。',
      '2. format 必须属于该文件 kind 的可用格式；优先用该行的 target。',
      '3. quality 1–100，仅对视频与 jpg/webp/avif 图片有意义，其它类型请省略。',
      '4. bitrate 仅对 mp3/m4a/aac/opus 有效（kbps，32-320）；该行 bitrate 非空时优先用它，为空则省略。',
      '5. fps（1–30）与 width（≥16 像素）对视频目标有效（gif 及普通视频容器；mp3/m4a 无画面不要带）：gif 省略用内置默认 12fps/640px，其它容器省略则保持源分辨率/帧率。',
      '6. codec 仅对 GPU 硬编视频有效（h264/hevc），省略默认 h264；hevc 仅 mp4/mov/mkv/ts 可选。',
      '7. channels（1=单声道，2=立体声）与 rate（采样率 Hz，8000–96000，如 22050）仅对音频编码目标有效（音频文件，或视频转 mp3/m4a），省略则保留源；该行 channels/rate 非空时优先用它们。',
      '8. 没有音轨的文件不要选纯音频格式。',
      '9. 批次走 GPU 硬编时，bitrate/channels/rate 对 mp4/mov/mkv/flv/ts 的输出音轨同样生效（不限于音频编码目标）。',
    ].join('\n');
  };

  const parsePtcPlan = (
    text: string,
    files: Upload[],
  ): {
    id: string;
    format: string;
    quality?: number;
    bitrate?: number;
    channels?: number;
    sampleRate?: number;
    fps?: number;
    width?: number;
    codec?: string;
  }[] => {
    const clean = text
      .trim()
      .replace(/^```[a-zA-Z]*\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new Error('模型没有返回合法的 JSON 计划');
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)
        ? (parsed as { files: unknown[] }).files
        : null;
    if (!rows) throw new Error('模型没有返回合法的计划文件列表');
    if (rows.length !== files.length) throw new Error('模型计划没有覆盖全部文件');
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error('模型计划里有无效条目');
      const id = String((row as Record<string, unknown>).id || '');
      if (!id || byId.has(id)) throw new Error('模型计划的 id 缺失或重复');
      byId.set(id, row as Record<string, unknown>);
    }
    return files.map((file) => {
      const row = byId.get(file.id);
      if (!row) throw new Error(`模型计划缺少文件 ${file.id}`);
      const format = String(row.format || '');
      if (format.startsWith('x:')) {
        const preset = extensionEntries.find((entry) => entry.ref === format);
        if (!preset || preset.type !== 'macro' || preset.kind !== file.kind) {
          throw new Error(`模型给 ${file.id} 选了不支持的预设 ${format}`);
        }
      } else if (!formatsFor(file.kind).includes(format)) {
        throw new Error(`模型给 ${file.id} 选了不支持的格式 ${format}`);
      }
      const out: {
        id: string;
        format: string;
        quality?: number;
        bitrate?: number;
        channels?: number;
        sampleRate?: number;
        fps?: number;
        width?: number;
        codec?: string;
      } = {
        id: file.id,
        format,
      };
      const rawQuality = row.quality;
      if (rawQuality !== undefined && rawQuality !== null) {
        const value = Number(rawQuality);
        if (!Number.isFinite(value) || value < 1 || value > 100) {
          throw new Error(`模型给 ${file.id} 的质量不合法`);
        }
        out.quality = Math.round(value);
      }
      const rawBitrate = row.bitrate;
      if (rawBitrate !== undefined && rawBitrate !== null) {
        const value = Number(rawBitrate);
        if (!Number.isFinite(value) || value < 32 || value > 320) {
          throw new Error(`模型给 ${file.id} 的码率不合法`);
        }
        out.bitrate = Math.round(value);
      }
      // The audio knobs ride the plan row into the convert binding; all optional.
      const rawChannels = row.channels;
      if (rawChannels !== undefined && rawChannels !== null) {
        const value = Number(rawChannels);
        if (!Number.isFinite(value) || value < 1 || value > 2) {
          throw new Error(`模型给 ${file.id} 的 channels 不合法`);
        }
        out.channels = Math.round(value);
      }
      const rawRate = row.rate ?? row.sampleRate;
      if (rawRate !== undefined && rawRate !== null) {
        const value = Number(rawRate);
        if (!Number.isFinite(value) || value < 8000 || value > 96000) {
          throw new Error(`模型给 ${file.id} 的采样率不合法`);
        }
        out.sampleRate = Math.round(value);
      }
      // GIF knobs ride the plan row into the convert binding; both are optional.
      for (const key of ['fps', 'width'] as const) {
        const raw = row[key];
        if (raw === undefined || raw === null) continue;
        const value = Number(raw);
        const lo = key === 'fps' ? 1 : 16;
        const hi = key === 'fps' ? 30 : 7680;
        if (!Number.isFinite(value) || value < lo || value > hi) {
          throw new Error(`模型给 ${file.id} 的 ${key} 不合法`);
        }
        out[key] = Math.round(value);
      }
      const rawCodec = row.codec;
      if (rawCodec !== undefined && rawCodec !== null) {
        const value = String(rawCodec);
        if (value !== 'h264' && value !== 'hevc') {
          throw new Error(`模型给 ${file.id} 的 codec 不合法`);
        }
        out.codec = value;
      }
      return out;
    });
  };

  // Which registered model plans this batch. An explicit choice must exist in
  // the catalog; otherwise the current main model is used — no silent fallback.
  const resolvePtcModel = async (
    requested: { provider: string; model: string } | null,
  ): Promise<{ provider: string; modelId: string; modelName: string }> => {
    const llm = ctx.get('llm');
    const main = ctx.get('agentDefaultModel');
    if (!llm) throw new Error('模型服务不可用');
    let provider = '';
    let modelId = '';
    if (requested) {
      provider = requested.provider;
      modelId = requested.model;
      if (!provider || !modelId) throw new Error('模型选择不完整');
      const catalog = await loadModelCatalog(llm);
      if (!catalog.models.some((item) => item.provider === provider && item.id === modelId)) {
        throw new Error('这个模型没有在 DSH 注册');
      }
    } else {
      const selection = main?.currentSelection();
      if (!selection?.provider || !selection.model) throw new Error('没有可用的主模型');
      provider = selection.provider;
      modelId = selection.model;
    }
    const catalog = await loadModelCatalog(llm);
    const modelName = catalog.models.find((item) => item.provider === provider && item.id === modelId)?.name || modelId;
    return { provider, modelId, modelName };
  };

  // The model only decides formats; the Host validates the JSON and builds the
  // program itself. A stalled stream is cut after three minutes.
  const collectPtcPlan = async (
    files: Upload[],
    targets: Map<string, string>,
    bitrates: Map<string, number | undefined>,
    channelMap: Map<string, number | undefined>,
    rateMap: Map<string, number | undefined>,
    quality: number,
    model: { provider: string; modelId: string },
    controller: AbortController,
  ): Promise<
    {
      id: string;
      format: string;
      quality?: number;
      bitrate?: number;
      channels?: number;
      sampleRate?: number;
      fps?: number;
      width?: number;
      codec?: string;
    }[]
  > => {
    const llm = ctx.get('llm');
    if (!llm) throw new Error('模型服务不可用');
    const { signal } = controller;
    let reasoningEffort: string | undefined;
    try {
      const info = await llm.resolveModelInfo?.(model.provider, model.modelId, signal);
      reasoningEffort = info?.reasoning?.efforts?.[0]?.id;
    } catch {
      // The reasoning hint is optional; the model still runs with its default.
    }
    let text = '';
    let failure = '';
    const modelTimer = setTimeout(() => controller.abort(), 180_000);
    try {
      for await (const chunk of llm.stream({
        provider: model.provider,
        model: model.modelId,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: ptcPlanPrompt(files, targets, bitrates, channelMap, rateMap, quality) }],
          },
        ],
        maxTokens: 6000,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        signal,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind !== 'stop') {
          failure = chunk.reason.failure?.message || chunk.reason.kind;
        }
      }
    } catch (err) {
      if (signal.aborted) throw new Error('模型调用超时或被取消');
      throw new Error('模型调用失败：' + errorText(err));
    } finally {
      clearTimeout(modelTimer);
    }
    if (failure) throw new Error('模型调用失败：' + failure);
    if (!text.trim()) throw new Error('模型没有返回计划');
    return parsePtcPlan(text, files);
  };

  // One evaluation per group. The runtime refuses more than maxPendingCalls
  // (128 by default) outstanding binding calls, so the plan runs in waves.
  const ptcProgramFor = (rows: { id: string; format: string; quality?: number }[], wave: number): string => {
    return (
      'const plan = ' +
      JSON.stringify(rows) +
      ';\n' +
      'const out = [];\n' +
      `for (let i = 0; i < plan.length; i += ${wave}) {\n` +
      `  const batch = plan.slice(i, i + ${wave});\n` +
      '  out.push(...await Promise.all(batch.map(async (p) => { try { return await media.convert(p); } catch (e) { return { id: p.id, error: String((e && e.message) || e) }; } })));\n' +
      '}\n' +
      'return out;'
    );
  };

  // Cooperative CPU-aware queue. ffmpeg processes are CPU-heavy, so the
  // capacity follows the machine's one-second CPU average: one job while busy,
  // a few small jobs while idle. It never preempts a running job. Hardware
  // (VideoToolbox, NVENC, Quick Sync, AMF) jobs use the media engine and get
  // their own two-session cap.
  let cpuUsage = 0.9;
  let cpuTimer: ReturnType<typeof setInterval> | null = null;
  let lastCpu = os.cpus();
  const cpus = Math.max(1, os.availableParallelism());
  const sampleCpu = (): void => {
    const now = os.cpus();
    let idle = 0;
    let total = 0;
    for (let i = 0; i < now.length; i += 1) {
      const before = lastCpu[i];
      const after = now[i];
      if (!before || !after) continue;
      const a = before.times;
      const b = after.times;
      const beforeTotal = a.user + a.nice + a.sys + a.idle + a.irq;
      const afterTotal = b.user + b.nice + b.sys + b.idle + b.irq;
      idle += b.idle - a.idle;
      total += afterTotal - beforeTotal;
    }
    lastCpu = now;
    if (total > 0) {
      const instant = Math.max(0, Math.min(1, 1 - idle / total));
      cpuUsage = cpuUsage * 0.6 + instant * 0.4;
    }
  };
  const ensureCpuTimer = (): void => {
    if (cpuTimer) return;
    lastCpu = os.cpus();
    cpuTimer = setInterval(sampleCpu, 1000);
    cpuTimer.unref();
  };
  interface PendingJob {
    weight: number;
    gpu: boolean;
    run: (threads: number) => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
  }
  const pending: PendingJob[] = [];
  let activeWeight = 0;
  let gpuActive = 0;
  const pump = (): void => {
    const capacity = capacityFor(cpuUsage, cpus);
    for (let i = 0; i < pending.length;) {
      const item = pending[i];
      if (item.gpu && gpuActive >= 2) {
        i += 1;
        continue;
      }
      if (activeWeight + item.weight > capacity + 0.0001) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      activeWeight += item.weight;
      if (item.gpu) gpuActive += 1;
      const threads = threadsFor(capacity, item.weight, cpus);
      Promise.resolve()
        .then(() => item.run(threads))
        .then(item.resolve, item.reject)
        .finally(() => {
          activeWeight -= item.weight;
          if (item.gpu) gpuActive -= 1;
          pump();
        });
    }
  };
  const schedule = <T>(weight: number, run: (threads: number) => Promise<T>, gpu = false): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push({ weight, gpu, run, resolve: (value) => resolve(value as T), reject });
      ensureCpuTimer();
      pump();
    });

  // Opt this instance into the generated config form (its bundle row in the
  // Plugins settings section gains a configure page driven by the Config
  // schema above); edits persist through the profile document and
  // hot-replace this plugin, so they take effect without a restart.
  ctx.effect(() => ctx.settings.configure({ auto: true }));

  // The agent half: the same engine, reachable from a conversation. The tool
  // works on a local path, so it never copies the file into the temp folder.
  const runMediaTool = async (args: unknown, exec: { signal: AbortSignal }): Promise<unknown> => {
    if (!ffmpeg) throw new Error(noFfmpeg.error);
    const a = (args || {}) as Record<string, unknown>;
    const file = String(a.path || '');
    if (!file) throw new Error('缺少 path：需要本机文件的绝对路径');
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${file}`);
    const probed = await probeFile(file, ffmpeg, ffprobe);
    const name = path.basename(file);
    if (!probed) throw new Error(`无法识别的媒体文件：${file}`);
    // The tool's own view of the file. It is deliberately not put in `uploads`:
    // that map is wiped on unload, and this path is the user's own file.
    const upload: Upload = {
      id: 'tool',
      name,
      path: file,
      owned: false,
      kind: probed.kind,
      duration: probed.duration,
      size: stat.size,
      streams: probed.streams,
      meta: probed.meta,
      at: Date.now(),
    };
    const action = String(a.action || 'convert');
    const actionId = action === 'rewrite-tags' ? 'meta' : action;
    if (!features.includes(actionId)) throw new Error('该功能已停用');
    if (action === 'probe') {
      return { file, kind: probed.kind, duration: probed.duration, sizeBytes: stat.size, meta: probed.meta };
    }
    const body: JsonBody = {
      mode: action === 'rewrite-tags' ? 'meta' : action,
      // A subtitle extraction without an explicit format defaults to srt, not
      // to the kind's default container (mp4 would fail the format whitelist).
      format: action === 'subtitle' ? String(a.format || 'srt') : String(a.format || defaultFormat(probed.kind)),
      quality: Number(a.quality || 90),
      bitrate: Number(a.bitrate || 0),
      fps: Number(a.fps || 0),
      width: Number(a.width || 0),
      channels: Number(a.channels || 0),
      sampleRate: Number(a.sampleRate || 0),
      codec: a.codec !== undefined ? String(a.codec) : undefined,
      // A codec choice only means something on the GPU: asking for one opts
      // into hardware encoding (which still falls back to software where no
      // backend was probed).
      hardware: a.codec !== undefined ? true : undefined,
      // An extension preset reference ('x:<manifest>/<action>'): when set it
      // supersedes format/quality, like the panel's preset tiles.
      preset: a.preset !== undefined ? String(a.preset) : undefined,
      stream: Number(a.stream || 0),
      tags: (a.tags || {}) as Record<string, string>,
      trim: a.trim as { start?: unknown; end?: unknown } | undefined,
    };
    // The tool opts into the GPU exactly like a batch does, so it waits for
    // the device verdict too: asking while the check is still running must
    // not quietly fall back to the CPU.
    if (body.hardware) await deviceVerdict(ffmpeg!);
    const { job, done } = await startJob(
      upload,
      planFor(upload, body, 0),
      normalizeTrim(body.trim, upload.duration),
      '',
    );
    // The agent can walk away or the call can time out: either way the ffmpeg
    // process dies and the half-written output is removed.
    const finished = await awaitJob(job, done, exec.signal);
    return { file: finished.out, kind: finished.kind, duration: upload.duration, sizeBytes: finished.size };
  };

  // Byte range support keeps the preview player's scrub bar working.
  const serveFile = async (req: IncomingMessage, res: ServerResponse, file: string): Promise<void> => {
    let size: number;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    const mime = mimeOf(file);
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!(start <= end && start < size)) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': mime,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': mime,
      'content-length': size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  };

  // The tool the agent calls. One tool with an action, not one tool per
  // action: the engine behind it is the same plan the panel builds.
  // Re-registered on every config save so a changed `features` whitelist
  // reaches the advertised action enum without a restart.
  let toolDisposer: (() => void) | null = null;
  const registerMediaTool = (): void => {
    toolDisposer?.();
    toolDisposer = ctx.tools.register({
      name: 'media_toolbox',
      description:
        '本机媒体处理（ffmpeg，文件不出本机）。支持：①probe 查看时长/分辨率/编码/音轨/字幕轨/标签；②convert 转格式（视频 mp4/mov/mkv/webm/avi/flv/wmv/ts/ogv/gif，音频 mp3/m4a/aac/wav/flac/ogg/opus/aiff，图片 png/jpg/webp/gif/bmp/tiff/avif）；' +
        '③extract-audio 抽音轨、④extract-video 抽画面（不重编码）；⑤subtitle 导出内嵌字幕（srt/ass/vtt，默认 srt）；⑥rewrite-tags 改写标题/作者/专辑/备注/日期/流派（另存新文件）。' +
        'convert 可带 trim（秒，{start,end}）裁剪；软件编码的视频（mp4/mov/mkv/flv/ts 映射 x264 CRF，webm 映射 vp9 CRF，avi/wmv/ogv 映射 qscale）与图片 jpg/webp 可带 quality（1-100，90=默认），GPU 硬编时映射为目标码率倍率；指定 codec（h264/hevc）即视同请求 GPU 硬编（无显卡时自动回退软件编码；hevc 仅 mp4/mov/mkv/ts 有效，体积更小）；转 mp3/m4a/aac/opus 可带 bitrate（kbps，32-320；音频文件与视频转音频均有效；GPU 硬编的视频转视频 mp4/mov/mkv/flv/ts 控制输出音轨，软件编码的视频转视频仍保留源音轨）；音频编码目标（音频文件转 mp3/m4a/aac/opus/wav/flac/ogg/aiff，或视频转 mp3/m4a）可带 channels（1=单声道，2=立体声）与 sampleRate（采样率 Hz，8000-96000，如 22050；0 或不填保留源）；视频转 gif 可带 fps（1-30）与 width（≥16 像素，0 或不填用默认 12fps/640px）。产物写在输出目录，返回新文件路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机文件的绝对路径。' },
          action: {
            type: 'string',
            enum: toolActions(features),
            description: '要做的动作，默认 convert。',
          },
          format: {
            type: 'string',
            description: 'convert 的目标格式；不填则用该类型的默认格式（视频 mp4、音频 mp3、图片 png）。',
          },
          preset: {
            type: 'string',
            description:
              "扩展预设引用（'x:<包id>/<动作id>'）：设置后覆盖 format/quality，走该预设的固定参数或覆盖配方；预设不存在会报错。",
          },
          trim: {
            type: 'object',
            properties: { start: { type: 'number' }, end: { type: 'number' } },
            description: '裁剪区间（秒）。',
          },
          quality: {
            type: 'number',
            description:
              '质量 1-100（90=默认）：软件编码视频映射该编码的质量参数（mp4/mov/mkv/flv/ts 为 CRF，webm 为 vp9 CRF，avi/wmv/ogv 为 qscale），GPU 硬编映射码率倍率，jpg/webp/avif 图片有效。',
          },
          codec: {
            type: 'string',
            enum: ['h264', 'hevc'],
            description:
              'GPU 编码器（h264/hevc）；指定即视同请求 GPU 硬编（无显卡时自动回退软件编码）。hevc 体积更小，仅 mp4/mov/mkv/ts 有效，预览播放取决于系统解码。',
          },
          bitrate: {
            type: 'number',
            description:
              '音频码率 kbps（32-320，仅音频编码目标 mp3/m4a/aac/opus：音频文件直转，或视频转 mp3/m4a；0 或不填用配方默认 192/128）。',
          },
          fps: {
            type: 'number',
            description: '输出帧率 1-30（仅视频目标：gif 与普通视频容器；0 或不填时 gif 用默认 12、其它保持源帧率）。',
          },
          width: {
            type: 'number',
            description: '输出宽度上限（像素，≥16，等比缩放不放大；0 或不填时 gif 用默认 640、其它保持源分辨率）。',
          },
          channels: {
            type: 'number',
            description: '声道数（1=单声道，2=立体声；仅音频编码目标有效，0 或不填保留源）。',
          },
          sampleRate: {
            type: 'number',
            description: '采样率 Hz（8000-96000，如 22050；仅音频编码目标有效，0 或不填保留源）。',
          },
          tags: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              artist: { type: 'string' },
              album: { type: 'string' },
              comment: { type: 'string' },
              date: { type: 'string' },
              genre: { type: 'string' },
            },
            description: 'rewrite-tags 要写入的标签，空值不会清空原标签。',
          },
          stream: { type: 'number', description: 'subtitle 的字幕轨序号，默认 0。' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            kind: { type: 'string' },
            duration: { type: 'number' },
            sizeBytes: { type: 'number' },
            meta: { type: 'object' },
          },
          required: ['file'],
        },
        render(_args, value) {
          const v = (value || {}) as Record<string, unknown>;
          const lines = [`文件: ${String(v.file || '')}`];
          const bytes = Number(v.sizeBytes) || 0;
          if (bytes) {
            // A 26 KB file is "0.0 MB"; below a megabyte the KB figure is the honest one.
            lines.push(
              `大小: ${bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB'}`,
            );
          }
          if (v.kind) lines.push(`类型: ${String(v.kind)}`);
          if (v.duration) lines.push(`时长: ${Math.round(Number(v.duration))} 秒`);
          // probe 的价值就在这些事实里：不画出来模型等于白探。
          const meta = v.meta as
            | {
                video?: { codec?: string; width?: number; height?: number } | null;
                audio?: { codec?: string } | null;
                subtitles?: unknown[];
                tags?: Record<string, string>;
              }
            | undefined;
          if (meta) {
            if (meta.video) {
              lines.push(
                `视频: ${meta.video.codec || '?'}${meta.video.width ? ` ${meta.video.width}x${meta.video.height}` : ''}`,
              );
            }
            if (meta.audio) lines.push(`音频: ${meta.audio.codec || '?'}`);
            if (meta.subtitles && meta.subtitles.length) lines.push(`字幕轨: ${meta.subtitles.length} 条`);
            const tags = Object.entries(meta.tags || {}).filter(([, value]) => value);
            if (tags.length) lines.push(`标签: ${tags.map(([key, value]) => `${key}=${value}`).join(' ')}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      // A long clip can take a while; the abort kills ffmpeg and cleans up.
      timeoutMs: 1800000,
      execute: (args, exec) => runMediaTool(args, exec),
    });
  };
  ctx.effect(() => {
    registerMediaTool();
    return () => toolDisposer?.();
  });

  ctx.effect(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Drop stale uploads so a session with many big files does not fill the
    // temp directory. unref() keeps the timer from holding the process open.
    const pruneTimer = setInterval(
      () => {
        const now = Date.now();
        pruneUploads(uploads, jobs, uploadTtlMs, now);
        // Finished jobs are only kept so the poll that reads them still works.
        for (const [id, job] of jobs) {
          if (job.state !== 'running' && now - job.at > JOB_TTL_MS) jobs.delete(id);
        }
        // A finished run is kept for the same reason: a page that comes back
        // still restores the batch it started.
        for (const [id, run] of runs) {
          if (run.state !== 'running' && now - run.at > 30 * 60 * 1000) runs.delete(id);
        }
      },
      10 * 60 * 1000,
    );
    pruneTimer.unref();

    const disposers = [
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/status`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          // The cheap half answers right away; the device check keeps
          // running in the background and its verdict lands in a later answer.
          const build = ffmpeg ? await detectBuild(ffmpeg) : null;
          if (build) startDeviceProbe(ffmpeg!, build);
          const info: HardwareInfo = build
            ? {
                h264: hwBackend != null,
                hevc: hwBackend != null && hwHevc,
                hwaccel: hwBackend != null,
                backend: hwBackend?.id ?? null,
                backendLabel: hwBackend?.label ?? null,
                // The device check is still running: the panel must not offer
                // a backend the Host has not verified yet.
                detecting: !deviceSettled,
              }
            : noHardware;
          json(
            res,
            200,
            statusPayload(
              ffmpeg,
              outDir,
              Math.round(maxUploadBytes / 1048576),
              version,
              composerButton,
              groups,
              persistState,
              Math.round(uploadTtlMs / 60000),
              queueLimitN,
              instanceId,
              info,
              ffprobe ? 'ffprobe' : 'ffmpeg',
              // An ffmpeg that cannot even list its encoders must not empty
              // the panel's format table: the built-in one is the fallback.
              build?.encoders.length ? supportedFormats(build.encoders) : FORMATS,
              statusOf(extensionManifests),
            ),
          );
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/config`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const body = await readJson(req);
            // Only defined keys are merged; an empty string resets that key to
            // the built-in default on the next load.
            const patch: Record<string, unknown> = {};
            if (body.outputDir !== undefined) {
              if (typeof body.outputDir !== 'string') throw new Error('outputDir 必须是字符串');
              patch.outputDir = body.outputDir;
            }
            if (body.ffmpegPath !== undefined) {
              if (typeof body.ffmpegPath !== 'string') throw new Error('ffmpegPath 必须是字符串');
              patch.ffmpegPath = body.ffmpegPath;
            }
            if (body.maxUploadMb !== undefined) {
              const mb = Number(body.maxUploadMb);
              if (!Number.isFinite(mb) || mb < 1) throw new Error('maxUploadMb 必须是 ≥ 1 的数字');
              patch.maxUploadMb = mb;
            }
            if (body.composerButton !== undefined) {
              if (typeof body.composerButton !== 'boolean') throw new Error('composerButton 必须是布尔值');
              patch.composerButton = body.composerButton;
            }
            if (body.groups !== undefined) {
              if (typeof body.groups !== 'string') throw new Error('groups 必须是字符串');
              patch.groups = body.groups;
            }
            if (body.features !== undefined) {
              if (typeof body.features !== 'string') throw new Error('features 必须是字符串');
              patch.features = body.features;
            }
            if (body.persistState !== undefined) {
              if (typeof body.persistState !== 'boolean') throw new Error('persistState 必须是布尔值');
              patch.persistState = body.persistState;
            }
            if (body.uploadTtlMinutes !== undefined) {
              const minutes = Number(body.uploadTtlMinutes);
              if (!Number.isFinite(minutes) || minutes < 5) throw new Error('uploadTtlMinutes 必须是 ≥ 5 的数字');
              patch.uploadTtlMinutes = minutes;
            }
            if (body.queueLimit !== undefined) {
              const limit = Number(body.queueLimit);
              if (!Number.isFinite(limit) || limit < 10) throw new Error('queueLimit 必须是 ≥ 10 的数字');
              patch.queueLimit = limit;
            }
            if (body.extensions !== undefined) {
              if (typeof body.extensions !== 'string') throw new Error('extensions 必须是字符串');
              const parsed = parseExtensions(body.extensions);
              // Reject the whole batch: a half-installed pack is worse than a refused one.
              if (!parsed.ok) throw new Error(parsed.error);
              patch.extensions = body.extensions;
            }
            if (Object.keys(patch).length === 0) return json(res, 200, errorPayload('没有要保存的字段'));
            // No expectedRevision: last write wins; the service validates the
            // whole Config schema before persisting. The loader does not
            // actually re-apply on this desktop build, so the running
            // instance applies the merge itself; cfg accumulates the patch so
            // consecutive saves stack correctly.
            await ctx.settings.update('media-converter', patch);
            cfg = { ...cfg, ...patch };
            resolveConfig(cfg);
            registerMediaTool();
            json(res, 200, { ok: true as const });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/upload`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          if (!ffmpeg) return json(res, 200, noFfmpeg);
          let file = '';
          try {
            const name = path.basename(requestUrl(req).searchParams.get('name') || 'input');
            const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            file = path.join(tmpDir, id + path.extname(name).toLowerCase());
            // A body that announces more than the cap is refused before a byte
            // is written; the counter below catches the ones that do not.
            const announced = Number(req.headers['content-length'] || 0);
            if (announced > maxUploadBytes) {
              return json(res, 200, errorPayload(`文件超过上限（${uploadLimit}）`));
            }
            let received = 0;
            const counter = new Transform({
              transform(chunk, _encoding, done) {
                received += chunk.length;
                if (received > maxUploadBytes) done(new Error(`文件超过上限（${uploadLimit}）`));
                else done(null, chunk);
              },
            });
            await pipeline(req, counter, fs.createWriteStream(file));
            // A body that stops early would only fail later as an
            // "unrecognisable media file", so compare it with what was promised.
            const written = (await fsp.stat(file)).size;
            const expected = announced;
            if (expected && written !== expected) {
              await fsp.rm(file, { force: true }).catch(() => {});
              console.error(`[dsh-media-converter] upload truncated: ${name} got ${written} of ${expected} bytes`);
              return json(res, 200, errorPayload(`上传不完整：收到 ${written} 字节，应为 ${expected} 字节`));
            }
            const probed = await probeFile(file, ffmpeg, ffprobe);
            if (!probed) {
              await fsp.rm(file, { force: true }).catch(() => {});
              console.error(`[dsh-media-converter] unrecognised media: ${name} (${written} bytes)`);
              return json(
                res,
                200,
                errorPayload('无法识别的媒体文件（支持视频、音频、图片）——文件可能已损坏或格式不支持'),
              );
            }
            const upload: Upload = {
              id,
              name,
              path: file,
              owned: true,
              kind: probed.kind,
              duration: probed.duration,
              size: written,
              streams: probed.streams,
              meta: probed.meta,
              at: Date.now(),
            };
            uploads.set(id, upload);
            json(
              res,
              200,
              uploadPayload(id, name, upload.kind, upload.duration, upload.size, upload.streams, upload.meta),
            );
          } catch (err) {
            // A cancelled or broken upload must not leave its copy behind.
            if (file) await fsp.rm(file, { force: true }).catch(() => {});
            console.error('[dsh-media-converter] upload failed:', err instanceof Error ? err.message : err);
            json(res, 500, errorPayload(errorText(err)));
          }
        },
      }),
      // Queue removal is per-id: the panel's 移除/清空 deletes the Host record
      // for real, so a rebuilt page does not resurrect the row. A row whose
      // job is still running is skipped, never deleted from under ffmpeg; an
      // owned browser-upload copy goes with its record, a registered path is
      // the user's own file and stays on disk.
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/upload/delete`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const body = await readJson(req);
            const raw = Array.isArray(body.ids) ? body.ids : [];
            const ids = [...new Set(raw.map(String).filter(Boolean))].slice(0, 2000);
            let removed = 0;
            const skipped: string[] = [];
            for (const id of ids) {
              const upload = uploads.get(id);
              if (!upload) continue; // TTL may have swept it first; stay idempotent.
              if (
                [...jobs.values()].some(
                  (job) => job.uploadId === id && (job.state === 'running' || job.state === 'cancelling'),
                )
              ) {
                skipped.push(id);
                continue;
              }
              uploads.delete(id);
              if (upload.owned) fs.rm(upload.path, { force: true }, () => {});
              removed += 1;
            }
            json(res, 200, { ok: true, removed, skipped } satisfies UploadDeleteResponse);
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      // The Host can read the disk itself, so a few hundred files never pass
      // through the browser: the panel browses directories and registers
      // absolute paths. Registered files are the user's own and are never
      // deleted (see Upload.owned).
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/browse`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const raw = requestUrl(req).searchParams.get('path') || '~';
            const dir = path.resolve(raw.replace(/^~(?=$|[/\\])/, os.homedir()));
            if (!browseAllowed(dir)) return json(res, 200, errorPayload('只能浏览家目录、/Volumes 或临时目录'));
            const stat = await fsp.stat(dir).catch(() => null);
            if (!stat || !stat.isDirectory()) return json(res, 200, errorPayload('目录不存在或不可读'));
            const listing = await fsp.readdir(dir, { withFileTypes: true });
            const dirs: BrowseEntry[] = [];
            const files: BrowseEntry[] = [];
            for (const entry of listing) {
              // Dotfiles stay hidden: a media browser has no business listing
              // caches and credentials, and the native picker hides them too.
              if (entry.name.startsWith('.')) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                dirs.push({ name: entry.name, path: full, dir: true, size: 0, kind: 'file' });
              } else if (entry.isFile()) {
                const kind = kindByExt(extOf(entry.name));
                // Only convertible media: text/unknown files have no place in a
                // batch queue and would only add noise to a folder listing.
                if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
                const size = await fsp.stat(full).then(
                  (value) => value.size,
                  () => 0,
                );
                files.push({ name: entry.name, path: full, dir: false, size, kind });
              }
            }
            const byName = (a: BrowseEntry, b: BrowseEntry) => a.name.localeCompare(b.name);
            dirs.sort(byName);
            files.sort(byName);
            json(res, 200, { ok: true, path: dir, parent: path.dirname(dir), entries: [...dirs, ...files] });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/register`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          if (!ffmpeg) return json(res, 200, noFfmpeg);
          // The workers below are closures; a const is what carries the
          // narrowing of `ffmpeg` into them.
          const bin = ffmpeg;
          try {
            const body = await readJson(req);
            const requested = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
            const dir = String(body.dir || '');
            if (dir) {
              const root = path.resolve(dir.replace(/^~(?=$|[/\\])/, os.homedir()));
              if (!browseAllowed(root))
                return json(res, 200, errorPayload('只能添加家目录、/Volumes 或临时目录里的文件'));
              const depthLimit = body.recursive === true ? 4 : 0;
              const walk = async (current: string, depth: number): Promise<string[]> => {
                if (depth > depthLimit) return [];
                const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
                const out: string[] = [];
                for (const entry of entries) {
                  if (entry.name.startsWith('.')) continue;
                  const full = path.join(current, entry.name);
                  if (entry.isDirectory()) out.push(...(await walk(full, depth + 1)));
                  else if (entry.isFile()) {
                    const kind = kindByExt(extOf(entry.name));
                    if (kind === 'video' || kind === 'audio' || kind === 'image') out.push(full);
                  }
                  if (out.length >= 2000) return out.slice(0, 2000);
                }
                return out;
              };
              requested.push(...(await walk(root, 0)));
            }
            const files = [...new Set(requested)].slice(0, 2000);
            if (!files.length) return json(res, 200, errorPayload('没有可添加的媒体文件'));
            const uploadsOut: { path: string; payload: UploadResponse }[] = [];
            const skipped: { path: string; reason: string }[] = [];
            // The probe is the only slow part; four at a time turns a folder of
            // a few hundred files into a few seconds without flooding ffmpeg.
            let cursor = 0;
            const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
              for (;;) {
                const index = cursor;
                cursor += 1;
                if (index >= files.length) return;
                const file = path.resolve(files[index]);
                if (!browseAllowed(file)) {
                  skipped.push({ path: file, reason: '不在允许的目录' });
                  continue;
                }
                const name = path.basename(file);
                const kind = kindByExt(extOf(name));
                if (kind !== 'video' && kind !== 'audio' && kind !== 'image') {
                  skipped.push({ path: file, reason: '不是媒体文件' });
                  continue;
                }
                const stat = await fsp.stat(file).catch(() => null);
                if (!stat || !stat.isFile()) {
                  skipped.push({ path: file, reason: '文件不存在' });
                  continue;
                }
                const existing = [...uploads.values()].find((item) => item.path === file);
                if (existing) {
                  uploadsOut.push({
                    path: file,
                    payload: uploadPayload(
                      existing.id,
                      existing.name,
                      existing.kind,
                      existing.duration,
                      existing.size,
                      existing.streams,
                      existing.meta,
                    ),
                  });
                  continue;
                }
                const result = await probeFile(file, bin, ffprobe);
                if (!result) {
                  skipped.push({ path: file, reason: '无法识别的媒体文件' });
                  continue;
                }
                const upload: Upload = {
                  id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                  name,
                  path: file,
                  owned: false,
                  kind: result.kind,
                  duration: result.duration,
                  size: stat.size,
                  streams: result.streams,
                  meta: result.meta,
                  at: Date.now(),
                };
                uploads.set(upload.id, upload);
                uploadsOut.push({
                  path: file,
                  payload: uploadPayload(
                    upload.id,
                    upload.name,
                    upload.kind,
                    upload.duration,
                    upload.size,
                    upload.streams,
                    upload.meta,
                  ),
                });
              }
            });
            await Promise.all(workers);
            // Four workers finish in any order; the panel shows the rows in
            // the order it receives them, so answer in path order.
            uploadsOut.sort((a, b) => a.path.localeCompare(b.path));
            json(res, 200, { ok: true, uploads: uploadsOut.map((entry) => entry.payload), skipped });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/convert`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          if (!ffmpeg) return json(res, 200, noFfmpeg);
          try {
            const body = await readJson(req);
            const upload = body.id ? uploads.get(body.id) : undefined;
            if (!upload) return json(res, 200, errorPayload('文件已失效，请重新选择'));
            // A request that asks for hardware encoding waits for the verdict
            // instead of quietly converting on the CPU.
            if (body.hardware) await deviceVerdict(ffmpeg!);
            const { job } = await startJob(
              upload,
              planFor(upload, body, 0),
              normalizeTrim(body.trim, upload.duration),
              String(body.name || '').trim(),
            );
            json(res, 200, { ok: true, job });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: PREFIX + '/models',
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          const llm = ctx.get('llm');
          if (!llm) return json(res, 200, errorPayload('模型服务不可用'));
          try {
            const catalog = await loadModelCatalog(llm);
            const selection = ctx.get('agentDefaultModel')?.currentSelection();
            const fallback =
              selection && selection.provider && selection.model
                ? {
                    provider: selection.provider,
                    model: selection.model,
                    name:
                      catalog.models.find((item) => item.provider === selection.provider && item.id === selection.model)
                        ?.name || selection.model,
                  }
                : null;
            json(res, 200, {
              ok: true,
              default: fallback,
              models: catalog.models,
              ...(catalog.unavailable.length ? { unavailableProviders: catalog.unavailable } : {}),
            });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/cancel`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const body = await readJson(req);
            const job = jobs.get(String(body.id || ''));
            if (!job) return json(res, 200, errorPayload('任务不存在'));
            if (job.state !== 'running') return json(res, 200, { ok: true, state: job.state });
            // ffmpeg needs a moment to die, so the job is "cancelling" until the
            // process is really gone.
            job.state = 'cancelling';
            job.error = null;
            const entry = controllers.get(job.id);
            if (entry) {
              entry.controller.abort();
              // ffmpeg leaves on SIGTERM at the next frame; if it is stuck in a
              // decoder, make sure it really stops burning the CPU.
              entry.killTimer = setTimeout(() => {
                if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
              }, 3000);
              entry.killTimer.unref();
            }
            json(res, 200, { ok: true, state: job.state });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/job`,
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          const id = requestUrl(req).searchParams.get('id');
          const job = id ? jobs.get(id) : undefined;
          if (!job) return json(res, 404, errorPayload('任务不存在'));
          json(res, 200, { ok: true, ...job });
        },
      }),
      // The batch itself, owned by the Host. POST answers immediately and the
      // run keeps walking its items; GET (no id = the newest run) is what a
      // rebuilt page restores the batch and its per-file states from.
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/run`,
        handler: async (req, res) => {
          if (rejectUnauthenticated(req, res)) return;
          if (req.method === 'GET') {
            const id = requestUrl(req).searchParams.get('id');
            const run = id ? runs.get(id) : runs.get(latestRun);
            return json(res, 200, { ok: true, run: run || null });
          }
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (!ffmpeg) return json(res, 200, noFfmpeg);
          try {
            const body = await readJson(req);
            const raw = Array.isArray(body.items) ? body.items : [];
            const items: RunItemInfo[] = [];
            for (const entry of raw) {
              const row = (entry || {}) as Record<string, unknown>;
              const id = String(row.id || '');
              if (!uploads.has(id)) return json(res, 200, errorPayload('文件已失效，请重新选择'));
              if (!features.includes(String(row.mode || 'convert'))) {
                return json(res, 200, errorPayload('该功能已停用'));
              }
              // A row the panel already knows it cannot convert (a silent video
              // asked for an audio-only target) travels with the run so it is
              // still explained after a page rebuild.
              const skipped = row.skip === true;
              const q = Number(row.quality);
              const br = Number(row.bitrate);
              const gf = Number(row.fps);
              const gw = Number(row.width);
              const ch = Number(row.channels);
              const sr = Number(row.sampleRate);
              const codecRaw = String(row.codec || '');
              items.push({
                id,
                mode: String(row.mode || ''),
                format: String(row.format || ''),
                ...(row.preset !== undefined ? { preset: String(row.preset || '') } : {}),
                quality: Number.isFinite(q) && q >= 1 && q <= 100 ? Math.round(q) : undefined,
                bitrate: Number.isFinite(br) && br >= 32 && br <= 320 ? Math.round(br) : undefined,
                fps: Number.isFinite(gf) && gf >= 1 && gf <= 30 ? Math.round(gf) : undefined,
                width: Number.isFinite(gw) && gw >= 16 && gw <= 7680 ? Math.round(gw) : undefined,
                channels: Number.isFinite(ch) && ch >= 1 && ch <= 2 ? Math.round(ch) : undefined,
                sampleRate: Number.isFinite(sr) && sr >= 8000 && sr <= 96000 ? Math.round(sr) : undefined,
                codec: codecRaw === 'hevc' || codecRaw === 'h264' ? codecRaw : undefined,
                state: skipped ? 'skipped' : 'waiting',
                percent: null,
                jobId: '',
                error: skipped ? String(row.reason || '') : '',
                result: null,
              });
            }
            if (!items.length) return json(res, 200, errorPayload('没有要处理的文件'));
            const ptc = body.ptc === true;
            let requested: { provider: string; model: string } | null = null;
            if (ptc) {
              // Fail before answering when the runtime or model is missing: the
              // panel then shows the same immediate error a single job would.
              if (!ctx.get('ptcRuntime') || !ctx.get('sandboxPolicy')) {
                return json(
                  res,
                  200,
                  errorPayload('PTC 调度不可用：当前环境缺少 PTC 运行时或模型服务（不会回退到固定规则）'),
                );
              }
              const rawModel =
                body.model && typeof body.model === 'object' ? (body.model as Record<string, unknown>) : null;
              requested = rawModel
                ? { provider: String(rawModel.provider || ''), model: String(rawModel.model || '') }
                : null;
              await resolvePtcModel(requested);
            }
            const run: RunInfo = {
              id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              state: 'running',
              kind: ptc ? 'ptc' : 'plain',
              ...(ptc ? { stage: 'planning' as const } : {}),
              at: Date.now(),
              items,
            };
            runs.set(run.id, run);
            latestRun = run.id;
            json(res, 200, { ok: true, run });
            if (ptc) void executePtcRun(run, requested, Number(body.quality ?? 90), Boolean(body.hardware));
            else void executeRun(run, Number(body.quality ?? 90), Boolean(body.hardware));
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/run/cancel`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const body = await readJson(req);
            const run = runs.get(String(body.id || ''));
            if (!run) return json(res, 200, errorPayload('任务不存在'));
            if (run.state === 'running') {
              run.state = 'cancelled';
              for (const item of run.items) if (item.state === 'waiting') item.state = 'cancelled';
              // Both run kinds stop through their own signal: the PTC sandbox
              // ends, and the plain-run lanes kill the ffmpeg jobs they already
              // started via awaitJob. The sweep below covers the window where a
              // job started but its lane has not observed the signal yet.
              runControllers.get(run.id)?.abort();
              for (const item of run.items) {
                if (item.state !== 'converting' || !item.jobId) continue;
                const job = jobs.get(item.jobId);
                if (job && job.state === 'running') {
                  // The same door as a single cancel: ffmpeg gets SIGTERM first.
                  job.state = 'cancelling';
                  job.error = null;
                  const entry = controllers.get(job.id);
                  if (entry) {
                    entry.controller.abort();
                    entry.killTimer = setTimeout(() => {
                      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
                    }, 3000);
                    entry.killTimer.unref();
                  }
                }
              }
            }
            json(res, 200, { ok: true, run });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      // Every job the server still remembers, so a rebuilt page can re-attach
      // a row to a running job (or pick up a result it finished while away).
      // Everything the panel needs to rebuild its queue: the uploads still on
      // disk, each with its newest job. Newest uploads first.
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/queue`,
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          const newest = new Map<string, Job>();
          for (const job of jobs.values()) newest.set(job.uploadId, job);
          const items: QueueItem[] = [];
          // Oldest first while walking; the newest rows are what the panel
          // shows, so the cap trims from the front below.
          for (const upload of uploads.values()) {
            const job = newest.get(upload.id);
            items.push({
              upload: {
                ok: true,
                id: upload.id,
                name: upload.name,
                kind: upload.kind,
                duration: upload.duration,
                size: upload.size,
                streams: upload.streams,
                meta: upload.meta,
              },
              job: job
                ? {
                    id: job.id,
                    uploadId: job.uploadId,
                    state: job.state,
                    percent: job.percent,
                    out: job.out,
                    size: job.size,
                    error: job.error,
                    kind: job.kind,
                    copy: job.copy,
                    hardware: job.hardware,
                  }
                : null,
            });
          }
          // shortcut: only the newest rows come back after a page rebuild;
          // the working set is small, and uploads expire after the TTL anyway.
          json(res, 200, { ok: true, items: items.slice(-queueLimitN) });
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/jobs`,
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          const list: JobInfo[] = [];
          for (const job of jobs.values()) {
            list.push({
              id: job.id,
              uploadId: job.uploadId,
              state: job.state,
              percent: job.percent,
              out: job.out,
              size: job.size,
              error: job.error,
              kind: job.kind,
              copy: job.copy,
              hardware: job.hardware,
            });
            if (list.length >= 50) break;
          }
          json(res, 200, { ok: true, jobs: list });
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/preview`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          const file = requestUrl(req).searchParams.get('file');
          if (!insideOutput(file)) return json(res, 403, errorPayload('只能预览输出目录里的文件'));
          await serveFile(req, res, file);
        },
      }),
      // The settled-jobs ledger: newest first, paged. Existence of each
      // returned file is checked here and only here, so a page of 50 costs at
      // most 50 stats no matter how long the ledger grows. A missing file is
      // data (the row greys out), not an error.
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/history`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const params = requestUrl(req).searchParams;
            const offset = Math.max(0, Number(params.get('offset')) || 0);
            const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
            let text = '';
            try {
              text = await fsp.readFile(historyFile, 'utf8');
            } catch {
              // No ledger yet: an empty first page, not an error.
            }
            const entries: HistoryEntry[] = [];
            for (const line of text.split('\n')) {
              if (!line.trim()) continue;
              try {
                entries.push(JSON.parse(line) as HistoryEntry);
              } catch {
                // A torn or hand-edited line never takes the whole ledger down.
              }
            }
            entries.reverse(); // the file is append-only oldest-first
            const items: HistoryItem[] = await Promise.all(
              entries.slice(offset, offset + limit).map(async (entry) => {
                let deleted = false;
                try {
                  await fsp.stat(path.join(outDir, entry.out));
                } catch {
                  deleted = true;
                }
                return { ...entry, deleted };
              }),
            );
            json(res, 200, { ok: true, items, total: entries.length } satisfies HistoryResponse);
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      // Dropping ledger rows, with an optional per-row unlink of the output
      // file. The ledger is append-only, so a delete is a filtered rewrite
      // under the ledger lock; torn lines ride through untouched. File
      // deletion refuses anything outside the output directory — a hand-edited
      // ledger line must not turn this route into an arbitrary unlink. Files
      // go first so a failed ledger write can be retried instead of leaving
      // orphan outputs no record points at.
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/history/delete`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const body = (await readJson(req)) as HistoryDeleteRequest;
            const targets = (Array.isArray(body.items) ? body.items : []).filter(
              (it): it is { at: number; out: string } =>
                typeof it?.at === 'number' &&
                Number.isFinite(it.at) &&
                typeof it?.out === 'string' &&
                it.out.length > 0 &&
                it.out.length <= 255,
            );
            if (!targets.length || targets.length > 500) {
              return json(res, 200, errorPayload('无效的删除请求'));
            }
            const deleteFiles = Boolean(body.deleteFiles);
            const result = await withLedgerLock(async () => {
              let lines: string[] = [];
              try {
                lines = (await fsp.readFile(historyFile, 'utf8')).split('\n').filter((line) => line.trim());
              } catch {
                return { removed: 0, filesDeleted: 0 };
              }
              const wanted = new Set(targets.map((t) => `${t.at}:${t.out}`));
              const kept: string[] = [];
              const removed: HistoryEntry[] = [];
              for (const line of lines) {
                let entry: HistoryEntry | null = null;
                try {
                  entry = JSON.parse(line) as HistoryEntry;
                } catch {
                  // A torn line is carried through the rewrite untouched.
                }
                if (entry && wanted.has(`${entry.at}:${entry.out}`)) removed.push(entry);
                else kept.push(line);
              }
              let filesDeleted = 0;
              if (deleteFiles) {
                for (const entry of removed) {
                  const target = path.resolve(outDir, entry.out);
                  if (!insideOutput(target)) continue;
                  await fsp.rm(target, { force: true });
                  filesDeleted += 1;
                }
              }
              await fsp.writeFile(historyFile, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
              return { removed: removed.length, filesDeleted };
            });
            json(res, 200, { ok: true, ...result } satisfies HistoryDeleteResponse);
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      // The uploaded original, so a page restored after close can play and trim
      // a queue row whose browser-side File is gone. Same trust fence and Range
      // support as the output preview.
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/source`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, errorPayload('GET only'));
          if (rejectUnauthenticated(req, res)) return;
          const id = requestUrl(req).searchParams.get('id');
          const upload = id ? uploads.get(id) : undefined;
          if (!upload) return json(res, 404, errorPayload('文件已失效，请重新选择'));
          await serveFile(req, res, upload.path);
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/reveal`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          try {
            const { file } = await readJson(req);
            if (!insideOutput(file)) return json(res, 200, errorPayload('只能打开输出目录里的文件'));
            const { command, args } = revealCommand(file, process.platform);
            spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
            json(res, 200, { ok: true });
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/base64`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          if (!features.includes('base64')) return json(res, 200, errorPayload('该功能已停用'));
          let upload: Upload | undefined;
          let mime: string | undefined;
          try {
            const body = await readJson(req);
            upload = body.id ? uploads.get(body.id) : undefined;
            if (!upload) return json(res, 200, errorPayload('文件已失效，请重新选择'));
            if (upload.size > MAX_BASE64_BYTES) {
              return json(
                res,
                200,
                errorPayload(`文件 ${(upload.size / 1048576).toFixed(1)} MB 超过 Base64 上限（24 MB）`),
              );
            }
            mime = mimeOf(upload.name);
          } catch (err) {
            return json(res, 200, errorPayload(errorText(err)));
          }
          // The payload is streamed out: a 24 MB file must not become one
          // 32 MB string inside the Host, and the encoder keeps the event loop
          // free while it works.
          const payload = base64Payload(mime, upload.size);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.write(
            `{"ok":true,"mime":${JSON.stringify(payload.mime)},"size":${payload.size},"data":"data:${mime};base64,`,
          );
          try {
            await pipeline(fs.createReadStream(upload.path, { highWaterMark: 3 * 65536 }), base64Encoder(), res, {
              end: false,
            });
          } catch {
            res.destroy();
            return;
          }
          res.end('"}');
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/decode`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, errorPayload('POST only'));
          if (rejectUnauthenticated(req, res)) return;
          if (!features.includes('base64')) return json(res, 200, errorPayload('该功能已停用'));
          try {
            const body = await readJson(req);
            const payload = decodeBase64Payload(body.text);
            if (payload.kind === 'text') return json(res, 200, decodeTextPayload(payload.text));
            await fsp.mkdir(outDir, { recursive: true });
            const stamp = Date.now().toString(36);
            const file = path.join(outDir, `decoded-${stamp}.${payload.ext}`);
            await fsp.writeFile(file, payload.bytes);
            json(res, 200, decodeFilePayload(kindByExt(payload.ext), file, payload.mime, payload.bytes.length));
          } catch (err) {
            json(res, 200, errorPayload(errorText(err)));
          }
        },
      }),
    ];
    return () => {
      clearInterval(pruneTimer);
      disposers.forEach((dispose) => dispose());
      for (const child of children) child.kill('SIGTERM');
      if (cpuTimer) clearInterval(cpuTimer);
      for (const upload of uploads.values()) {
        if (upload.owned) fs.rm(upload.path, { force: true }, () => {});
      }
      uploads.clear();
      jobs.clear();
      controllers.clear();
    };
  });
}
