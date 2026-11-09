// End-to-end self-check for the Host half without the app:
// `node test/host.test.mjs`. Registers the plugin's routes on a stub webServer,
// then drives real upload -> convert / trim / extract / base64 / preview round
// trips through the registered handlers. Skipped when no ffmpeg is installed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { apply, inject, probeFfmpeg, pruneUploads, resolveGroups, runJobAttempts } from '../dist/index.js';
import { formatEncoders, parseDuration } from '../dist/lib/plan.js';

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-out-'));
// Every apply() below captures the ledger path at apply time, so the override
// must exist before the FIRST apply — otherwise the main instance appends
// settled jobs to the real ~/.media-toolbox-history.json. (Caught on a real
// DSH run: the ledger grew thousands of test rows in the user's home.)
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-ledger-'));
const LEDGER_FILE = path.join(ledgerDir, 'ledger.json');
process.env.MEDIA_TOOLBOX_HISTORY = LEDGER_FILE;

// --- fake ffprobe ------------------------------------------------------------
// The dev box ships no ffprobe, so the JSON probing route would only ever run
// on CI. A fake that answers per extension forces every upload below through
// that route. On CI the real ffprobe sitting next to apt's ffmpeg wins the
// candidate order (sibling first), so the same assertions then run against
// real ffprobe output; the log assertion below adapts via fakeProbing.
const fakeProbeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-fake-probe-'));
const fakeProbeLog = path.join(fakeProbeDir, 'calls.log');
const fakeProbeSentinel = path.join(fakeProbeDir, 'broken');
// Shaped like real `ffprobe -show_format -show_streams -show_chapters
// -print_format json` output; parseFfprobeJson's unit tests use the same
// shapes. .mp4 carries the rewritten title so the read-back assertion below
// exercises the format.tags mapping (the write itself is verified against
// real ffmpeg on disk, unaffected by the fake).
const FAKE_PROBE_ANSWERS = {
  '.mp4': {
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        profile: 'High',
        codec_type: 'video',
        width: 320,
        height: 240,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30/1',
        bit_rate: '500000',
        disposition: { default: 1 },
        tags: {},
      },
      {
        index: 1,
        codec_name: 'aac',
        codec_type: 'audio',
        sample_rate: '44100',
        channel_layout: 'stereo',
        sample_fmt: 'fltp',
        bit_rate: '128000',
        disposition: { default: 0 },
        tags: {},
      },
    ],
    chapters: [],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '2.000000',
      start_time: '0.000000',
      bit_rate: '628000',
      tags: { title: '片头测试' },
    },
  },
  '.m4a': {
    streams: [
      {
        index: 0,
        codec_name: 'aac',
        codec_type: 'audio',
        sample_rate: '44100',
        channel_layout: 'mono',
        sample_fmt: 'fltp',
        bit_rate: '81000',
        disposition: { default: 1 },
        tags: {},
      },
      {
        index: 1,
        codec_name: 'mjpeg',
        codec_type: 'video',
        width: 300,
        height: 300,
        pix_fmt: 'yuvj444p',
        disposition: { attached_pic: 1 },
        tags: {},
      },
    ],
    chapters: [],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '1.000000',
      start_time: '0.000000',
      bit_rate: '6575000',
      tags: {},
    },
  },
  '.ac3': {
    streams: [
      {
        index: 0,
        codec_name: 'ac3',
        codec_type: 'audio',
        sample_rate: '48000',
        channel_layout: '5.1(side)',
        sample_fmt: 'fltp',
        bit_rate: '448000',
        disposition: { default: 1 },
        tags: {},
      },
    ],
    chapters: [],
    format: { format_name: 'ac3', duration: '1.020000', start_time: '0.000000', bit_rate: '448000', tags: {} },
  },
  '.mkv': {
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        profile: 'High',
        codec_type: 'video',
        width: 640,
        height: 360,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30/1',
        disposition: { default: 1 },
        tags: {},
      },
      {
        index: 1,
        codec_name: 'aac',
        codec_type: 'audio',
        sample_rate: '44100',
        channel_layout: 'stereo',
        disposition: { default: 0 },
        tags: {},
      },
      {
        index: 2,
        codec_name: 'subrip',
        codec_type: 'subtitle',
        disposition: { default: 0 },
        tags: { language: 'chi', title: '中文字幕' },
      },
    ],
    chapters: [],
    format: {
      format_name: 'matroska,webm',
      duration: '2.000000',
      start_time: '0.000000',
      bit_rate: '700000',
      tags: {},
    },
  },
  '.png': {
    streams: [
      {
        index: 0,
        codec_name: 'png',
        codec_type: 'video',
        width: 64,
        height: 64,
        pix_fmt: 'rgb24',
        disposition: { default: 1 },
        tags: {},
      },
    ],
    chapters: [],
    format: { format_name: 'png_pipe', duration: '0.000000', start_time: '0.000000', tags: {} },
  },
  '.wav': {
    streams: [
      {
        index: 0,
        codec_name: 'pcm_s16le',
        codec_type: 'audio',
        sample_rate: '48000',
        channel_layout: 'stereo',
        sample_fmt: 's16',
        bit_rate: '1536000',
        disposition: { default: 1 },
        tags: {},
      },
    ],
    chapters: [],
    format: { format_name: 'wav', duration: '1.000000', start_time: '0.000000', bit_rate: '1536000', tags: {} },
  },
};
// `*${ext}`: the case word is the full probe target path, not the bare ext.
// Every branch assigns `out`; the log records its byte length so the test can
// tell "the fake answered with metadata" from "the fake fell through to {}" —
// uploads alone cannot, because their assertions were written for the stderr
// route and pass silently when the mapping route is starved.
const fakeProbeCases = Object.entries(FAKE_PROBE_ANSWERS)
  .map(([ext, answer]) => `  *${ext}) out='${JSON.stringify(answer)}' ;;`)
  .join('\n');
fs.writeFileSync(
  path.join(fakeProbeDir, 'ffprobe'),
  `#!/bin/sh
[ -e '${fakeProbeSentinel}' ] && exit 1
for last do :; done
case "$last" in
${fakeProbeCases}
  *) out='{}' ;;
esac
printf '%s %s\\n' "$last" "\${#out}" >> '${fakeProbeLog}'
printf '%s' "$out"
`,
);
fs.chmodSync(path.join(fakeProbeDir, 'ffprobe'), 0o755);
process.env.PATH = fakeProbeDir + path.delimiter + process.env.PATH;
const routes = new Map();
const tools = new Map();
const settingsCalls = [];
const webServer = {
  getOrigin: () => 'http://127.0.0.1:65533',
  register: (route) => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  },
};
// The composition's connection service, reduced to the one call every route
// makes. It keeps the fence's answers: a foreign Origin is 403 before the
// cookie is considered, a caller without the session cookie is 401.
const AUTH_COOKIE = 'authenticated';
const connection = {
  requestRejection: ({ headers }) => {
    if (headers.origin && headers.origin !== 'http://127.0.0.1:65533') return 403;
    return headers.cookie === AUTH_COOKIE ? undefined : 401;
  },
};
// The PTC batch route is driven through fakes: the model stream yields a
// program, and the fake runtime calls the route's own media.convert binding.
// Everything after the binding (plan, job, ffmpeg, response mapping) is real.
let testUploadId = '';
let ptcPrompt = '';
let ptcProgram = '';
let ptcReasoning;
// The real runtime refuses more than maxPendingCalls (128 by default) binding
// calls per evaluation; the fake uses a small cap so the test stays quick.
const PTC_PENDING_LIMIT = 20;
let ptcPeak = 0;
let ptcRuns = 0;
const ptcRuntime = {
  timeout: { defaultMs: 120000, maxMs: 600000 },
  resolve: (request) => request,
  run: async (spec) => {
    ptcProgram = spec.program;
    ptcRuns += 1;
    const convert = spec.bindings[0].functions.convert;
    // Run the program the Host composed, with the runtime's pending-call gate.
    let pending = 0;
    const media = {
      convert: async (args) => {
        pending += 1;
        ptcPeak = Math.max(ptcPeak, pending);
        if (pending > PTC_PENDING_LIMIT) {
          pending -= 1;
          return { id: args && args.id, error: 'pending binding calls exceed configured limits' };
        }
        try {
          return await convert(args);
        } finally {
          pending -= 1;
        }
      },
    };
    const value = await new Function('media', `return (async () => { ${spec.program}\n})();`)(media);
    return { value, logs: [] };
  },
};
const llm = {
  listProviders: () => [{ id: 'test', name: 'Test' }],
  listModels: async () => [{ provider: 'test', id: 'test', name: 'Test Model' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  stream: async function* (options) {
    // A plain string here would produce no completion in the real service.
    assert.ok(Array.isArray(options.messages[0].content), 'messages carry content blocks');
    ptcPrompt = options.messages[0].content[0].text;
    ptcReasoning = options.reasoningEffort;
    // One plan row per file the prompt lists, picking each file's own target so
    // videos, audio and images all get a format the Host accepts.
    const rows = [...ptcPrompt.matchAll(/id=(\S+) name=[^\n]*? kind=(\S+) target=(\S*)/g)].map(
      ([, id, kind, target]) => ({
        id,
        format: target || (kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'jpg'),
        quality: 60,
      }),
    );
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ files: rows }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const agentDefaultModel = { currentSelection: () => ({ provider: 'test', model: 'test' }) };
const sandboxPolicy = { resolve: () => ({ mode: 'read-only', workspaceRoot: outDir }) };
const services = { webServer, connection, ptcRuntime, llm, agentDefaultModel, sandboxPolicy };
const cleanups = [];
apply(
  {
    get: (key) => services[key],
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    settings: {
      configure: (presentation) => {
        settingsCalls.push(['configure', presentation]);
        return () => {};
      },
      update: async (ns, patch) => {
        settingsCalls.push(['update', ns, patch]);
      },
    },
    effect: (fn) => cleanups.push(fn()),
  },
  { outputDir: outDir },
);

// Minimal IncomingMessage stand-in: the handlers only use method/url/headers and
// async iteration over the body.
function fakeReq({ method = 'GET', url = '/', body = null, origin = null, headers = {}, auth = true } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { ...(auth ? { cookie: AUTH_COOKIE } : {}), ...headers, ...(origin ? { origin } : {}) };
  return req;
}

async function call(route, options = {}) {
  const handler = routes.get('/api/media-convert/' + route.split('?')[0]);
  assert.ok(handler, `route ${route} registered`);
  const res = makeRes();
  await handler(fakeReq({ url: '/api/media-convert/' + route, ...options }), res);
  await res.done;
  const body = Buffer.concat(res.chunks).toString('utf8');
  return { status: res.status, data: JSON.parse(body) };
}

// A real writable response: the Base64 route streams its payload out, so the
// handler needs a genuine stream to pipe into.
function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  res.status = 0;
  res.headers = {};
  res.chunks = chunks;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers || {};
  };
  res.done = new Promise((resolve) => res.on('finish', resolve));
  return res;
}

// Streaming routes need a real writable response.
async function fetchBinary(route, options = {}) {
  const handler = routes.get('/api/media-convert/' + route.split('?')[0]);
  assert.ok(handler, `route ${route} registered`);
  const res = makeRes();
  await handler(fakeReq({ url: '/api/media-convert/' + route, ...options }), res);
  await res.done;
  res.body = Buffer.concat(res.chunks);
  return res;
}

async function waitJob(job) {
  let current = job;
  for (let attempt = 0; attempt < 150 && current.state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = (await call('job?id=' + current.id)).data;
  }
  assert.equal(current.state, 'done', current.error);
  assert.ok(fs.existsSync(current.out), 'output written');
  return current;
}

// A batch run settles in the background, so tests poll it like the panel does.
// A cancelled run reports itself cancelled before its ffmpeg processes are
// really gone, so the wait covers the rows too — how long a killed ffmpeg
// takes to disappear is the machine's business, not the test's.
async function waitRun(run) {
  let current = run;
  const busy = (state) => state.items.some((item) => item.state === 'waiting' || item.state === 'converting');
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (current.state !== 'running' && !busy(current)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = (await call('run?id=' + run.id)).data.run;
  }
  assert.notEqual(current.state, 'running', 'the run settled');
  return current;
}

// Without this the plugin can apply before the web server exists, take its
// early return, and register no routes at all.
assert.deepEqual(
  inject,
  ['webServer', 'tools', 'settings', 'connection'],
  'the web server, the tool registry, settings, and the trust fence are declared dependencies',
);
assert.ok(
  settingsCalls.some((call) => call[0] === 'configure' && call[1].auto === true),
  'the instance opts into the generated config form',
);

const status = await call('status');
assert.equal(status.data.ok, true);
assert.equal(status.data.maxUploadMb, 2048, 'the default upload cap is reported');
assert.equal(status.data.composerButton, true, 'the composer button defaults on');
assert.equal(status.data.persistState, false, 'page-state persistence defaults off');
assert.equal(typeof status.data.version, 'string', 'the plugin version is reported');
assert.ok(status.data.version.length > 0, 'a version is present');
assert.deepEqual(status.data.groups, ['convert', 'edit', 'view'], 'the built-in group order is reported');
// The fake ffprobe (or CI's real one) must be detected: the status names the
// structured route, exactly. A detection regression and a hardcoded fallback
// value both fail here.
assert.equal(status.data.probeMode, 'ffprobe', 'the structured probing route is reported');
// The hardware backend the Host probed: a known one or none, and the name the
// panel shows comes with it.
assert.ok(
  status.data.hardware.backend === null ||
    ['videotoolbox', 'nvenc', 'qsv', 'amf'].includes(status.data.hardware.backend),
  'the reported backend is a known one',
);
assert.equal(
  Boolean(status.data.hardware.backendLabel),
  status.data.hardware.backend !== null,
  'the backend label comes with the backend',
);
assert.equal(
  status.data.hardware.h264,
  status.data.hardware.backend !== null,
  'H.264 hardware encoding means a backend was found',
);
if (!status.data.ffmpegPath) {
  // A silent skip is a green run that tested nothing; CI installs ffmpeg, so
  // missing it here is a broken environment, not a reason to pass.
  console.error('host.test.mjs: FAILED — no ffmpeg found (install ffmpeg or set FFMPEG_PATH)');
  process.exit(1);
}
const ffmpeg = status.data.ffmpegPath;
// The fake only wins where no real ffprobe sits next to ffmpeg (this dev
// box); CI's apt install puts one there and the real binary answers instead,
// so the fake-log assertions below are scoped by this flag.
// The fake ffprobe is a POSIX script: on Windows the real ffprobe.exe next
// to ffmpeg answers instead, and the log assertions below do not apply.
const fakeProbing = process.platform !== 'win32' && !fs.existsSync(path.join(path.dirname(ffmpeg), 'ffprobe'));
// The advertised formats must be encodable by this exact ffmpeg: homebrew 9
// drops libtheora and a lying table breaks conversions at runtime.
const encoderText = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout;
for (const [kind, list] of Object.entries(status.data.formats)) {
  for (const format of list) {
    for (const encoder of formatEncoders(kind, format)) {
      assert.ok(encoderText.includes(' ' + encoder + ' '), `${kind}/${format} needs encoder ${encoder}`);
    }
  }
}
// Formats are filtered by this ffmpeg's encoders (homebrew 9 lacks
// libwebp/libaom), so pin the always-built-ins, not the full table.
assert.deepEqual(status.data.formats.image, [
  'png',
  'jpg',
  ...(encoderText.includes('libwebp') ? ['webp'] : []),
  'gif',
  'bmp',
  'tiff',
  ...(encoderText.includes('libaom-av1') ? ['avif'] : []),
]);

// --- image: upload, convert, preview -------------------------------------
const sample = path.join(outDir, 'sample.png');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', sample]);

const upload = await call('upload?name=' + encodeURIComponent('../evil name.png'), {
  method: 'POST',
  body: fs.readFileSync(sample),
});
assert.equal(upload.data.ok, true, JSON.stringify(upload.data));
assert.equal(upload.data.kind, 'image');
assert.equal(upload.data.name, 'evil name.png'); // basename wins, no traversal
assert.equal(upload.data.streams.video, true); // ffmpeg calls a still image a video stream

// Before any job exists the upload has no entry: a page that only picked a
// file must not invent a task.
const noJobs = await call('jobs');
assert.equal(noJobs.data.ok, true);
assert.ok(!noJobs.data.jobs.some((job) => job.uploadId === upload.data.id), 'an unconverted upload has no job');

const converted = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: upload.data.id, format: 'jpg', quality: 60 }),
});
assert.equal(converted.data.ok, true, JSON.stringify(converted.data));
const imageJob = await waitJob(converted.data.job);
assert.equal(imageJob.kind, 'image');

// The queue is what a rebuilt page renders: every live upload plus its newest
// job, so no client-side snapshot is needed.
const queue = await call('queue');
assert.equal(queue.data.ok, true);
const queued = queue.data.items.find((item) => item.upload.id === upload.data.id);
assert.ok(queued, 'the upload is in the queue');
assert.equal(queued.upload.name, 'evil name.png');
assert.equal(queued.job.state, 'done');
assert.equal(queued.job.uploadId, upload.data.id);

// The jobs list is what a rebuilt page reconciles against: it ties the job
// back to the upload it belongs to and carries the finished result.
const finishedJobs = await call('jobs');
assert.equal(finishedJobs.data.ok, true);
const finished = finishedJobs.data.jobs.find((job) => job.id === imageJob.id);
assert.ok(finished, 'the finished job is listed');
assert.equal(finished.uploadId, upload.data.id);
assert.equal(finished.state, 'done');
assert.equal(finished.out, imageJob.out);

const preview = await fetchBinary('preview?file=' + encodeURIComponent(imageJob.out));
assert.equal(preview.status, 200);
assert.equal(preview.headers['content-type'], 'image/jpeg');
assert.ok(preview.body.length > 0);

const previewOutside = await fetchBinary('preview?file=' + encodeURIComponent('/etc/hosts'));
assert.equal(previewOutside.status, 403);

// A '..' segment inside the name used to walk out of the output directory.
const previewEscape = await fetchBinary(
  'preview?file=' + encodeURIComponent(path.join(outDir, '..', '..', 'etc', 'hosts')),
);
assert.equal(previewEscape.status, 403, 'a traversal out of the output directory is refused');

// The uploaded original streams back (with ranges) so a page restored after
// a close can play and trim a row whose browser-side File is gone.
const source = await fetchBinary('source?id=' + upload.data.id);
assert.equal(source.status, 200);
assert.equal(source.headers['content-type'], 'image/png');
assert.ok(source.body.length > 0);
const ranged = await fetchBinary('source?id=' + upload.data.id, { headers: { range: 'bytes=0-9' } });
assert.equal(ranged.status, 206, 'a range request is honoured');
assert.equal(ranged.body.length, 10);
const sourceGone = await fetchBinary('source?id=unope');
assert.equal(sourceGone.status, 404, 'an expired or unknown upload is reported');

// --- adding files by path (no browser upload) -----------------------------
// The Host can read the disk itself: the panel browses a directory and
// registers absolute paths, so a few hundred files never pass through the
// browser. A registered file is the user's own and must never be deleted.
const browseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-browse-'));
fs.mkdirSync(path.join(browseDir, 'nested'));
fs.writeFileSync(path.join(browseDir, '.hidden.png'), fs.readFileSync(sample));
fs.writeFileSync(path.join(browseDir, 'notes.txt'), 'hello');
const browseFile = path.join(browseDir, 'direct.png');
fs.copyFileSync(sample, browseFile);
const nestedFile = path.join(browseDir, 'nested', 'deep.png');
fs.copyFileSync(sample, nestedFile);

const browse = await call('browse?path=' + encodeURIComponent(browseDir));
assert.equal(browse.data.ok, true, JSON.stringify(browse.data));
assert.equal(browse.data.path, browseDir);
const names = browse.data.entries.map((entry) => entry.name);
assert.ok(names.includes('nested'), 'a subdirectory is listed');
assert.ok(names.includes('direct.png'), 'a media file is listed');
assert.ok(!names.includes('notes.txt'), 'a text file is not media');
assert.ok(!names.includes('.hidden.png'), 'dotfiles stay hidden');
assert.equal(browse.data.entries[0].dir, true, 'directories sort first');

const missingDir = await call('browse?path=' + encodeURIComponent(path.join(browseDir, 'nope')));
assert.equal(missingDir.data.ok, false, 'a missing directory is refused');

const registered = await call('register', {
  method: 'POST',
  body: JSON.stringify({
    paths: [browseFile, path.join(browseDir, 'notes.txt'), path.join(browseDir, 'missing.mp4')],
  }),
});
assert.equal(registered.data.ok, true, JSON.stringify(registered.data));
assert.equal(registered.data.uploads.length, 1);
assert.equal(registered.data.uploads[0].name, 'direct.png');
assert.equal(registered.data.uploads[0].kind, 'image');
assert.equal(registered.data.skipped.length, 2, 'non-media and missing paths are reported, not fatal');
const registeredId = registered.data.uploads[0].id;

const registeredSource = await fetchBinary('source?id=' + registeredId);
assert.equal(registeredSource.status, 200, 'a registered file streams from its original path');
assert.ok(registeredSource.body.length > 0);

const folderAdded = await call('register', {
  method: 'POST',
  body: JSON.stringify({ dir: browseDir, recursive: true }),
});
assert.equal(folderAdded.data.ok, true, JSON.stringify(folderAdded.data));
assert.equal(folderAdded.data.uploads.length, 2, 'the folder walk finds both images (deduped)');

// Only the media places a person uses are browsable: home, mounted volumes,
// temp dirs and the output dir. /etc is not one of them.
const outsideBrowse = await call('browse?path=' + encodeURIComponent('/etc'));
assert.equal(outsideBrowse.data.ok, false, 'a directory outside the allowed roots is refused');
const outsideRegister = await call('register', {
  method: 'POST',
  body: JSON.stringify({ paths: ['/etc/hosts'] }),
});
assert.equal(outsideRegister.data.skipped[0].reason, '不在允许的目录');

// The queue cap must cover what a single register adds, or a rebuilt page
// silently drops the rows beyond the newest 200.
const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-bulk-'));
for (let index = 0; index < 205; index += 1) {
  fs.copyFileSync(sample, path.join(bulkDir, 'bulk-' + String(index).padStart(3, '0') + '.png'));
}
const bulk = await call('register', { method: 'POST', body: JSON.stringify({ dir: bulkDir }) });
assert.equal(bulk.data.ok, true, JSON.stringify(bulk.data));
assert.equal(bulk.data.uploads.length, 205);
const bulkQueue = await call('queue');
const queuedIds = new Set(bulkQueue.data.items.map((item) => item.upload.id));
assert.equal(
  bulk.data.uploads.filter((upload) => queuedIds.has(upload.id)).length,
  205,
  'every registered file fits in the rebuilt queue',
);
fs.rmSync(bulkDir, { recursive: true, force: true });

const folderQueue = await call('queue');
assert.ok(
  folderQueue.data.items.some((item) => item.upload.id === registeredId),
  'a registered file appears in the queue',
);

// --- PTC batch: planned by the model, executed by the Host as a run ------
testUploadId = upload.data.id;
const ptcStarted = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: [{ id: upload.data.id, format: 'jpg', quality: 60 }], quality: 60, ptc: true }),
});
assert.equal(ptcStarted.data.ok, true, JSON.stringify(ptcStarted.data));
assert.equal(ptcStarted.data.run.kind, 'ptc');
assert.equal(ptcStarted.data.run.stage, 'planning', 'a PTC run starts in planning');
const ptcDone = await waitRun(ptcStarted.data.run);
assert.equal(ptcDone.state, 'done');
assert.equal(ptcDone.items[0].state, 'done');
assert.equal(ptcDone.items[0].result.kind, 'image');
assert.ok(fs.existsSync(ptcDone.items[0].result.file), 'the planned conversion wrote its output');
assert.ok(ptcDone.modelMs >= 0 && ptcDone.runMs >= 0, 'the run carries both timings');
assert.match(ptcProgram, /media\.convert/, 'the host composes the PTC program from the plan');
assert.match(ptcProgram, new RegExp(upload.data.id), 'the plan carries the selected file');
// The runtime refuses more than maxPendingCalls (128 by default) outstanding
// binding calls; a big plan must not be one Promise.all.
assert.doesNotMatch(ptcProgram, /Promise\.all\(plan\.map/, 'a big plan is not one pending-call wave');
// The wave follows the live CPU capacity (1-4 slots -> 4-16 calls).
const waveMatch = ptcProgram.match(/i \+= (\d+)/);
assert.ok(waveMatch, 'the plan runs in bounded waves');
assert.ok(Number(waveMatch[1]) >= 4 && Number(waveMatch[1]) <= 32, `wave ${waveMatch[1]}`);
assert.match(ptcPrompt, /JSON/);
assert.match(ptcPrompt, /每个文件恰好一条/);
assert.match(ptcPrompt, new RegExp('id=' + upload.data.id));
assert.equal(ptcReasoning, 'low', 'the lowest reasoning effort is requested');

// A skipped row never reaches the model; the plan covers only real work and
// the skipped row keeps its reason after the run.
const skipUpload = await call('upload?name=skip-me.png', { method: 'POST', body: fs.readFileSync(sample) });
const ptcSkipped = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { id: upload.data.id, format: 'jpg' },
      { id: skipUpload.data.id, skip: true, reason: 'hint.noAudio' },
    ],
    ptc: true,
  }),
});
assert.equal(ptcSkipped.data.ok, true, JSON.stringify(ptcSkipped.data));
const ptcSkippedDone = await waitRun(ptcSkipped.data.run);
assert.equal(ptcSkippedDone.items[0].state, 'done');
assert.equal(ptcSkippedDone.items[1].state, 'skipped', 'a skipped row is not planned');
assert.equal(ptcSkippedDone.items[1].error, 'hint.noAudio');

// 41 files exceed one group (40 files), so the Host starts a second sandbox
// evaluation with its own timeout instead of one 10-minute-capped run.
const many = [];
for (let i = 0; i < 41; i += 1) {
  const row = await call('upload?name=many-' + i + '.png', { method: 'POST', body: fs.readFileSync(sample) });
  assert.equal(row.data.ok, true, JSON.stringify(row.data));
  many.push(row.data.id);
}
ptcPeak = 0;
const runsBefore = ptcRuns;
const manyStarted = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: many.map((id) => ({ id, format: 'jpg', quality: 60 })), quality: 60, ptc: true }),
});
assert.equal(manyStarted.data.ok, true, JSON.stringify(manyStarted.data));
const manyDone = await waitRun(manyStarted.data.run);
assert.equal(manyDone.state, 'done');
assert.equal(manyDone.items.filter((item) => item.state === 'done').length, 41);
// The file cap follows the machine, so the group count is derived the same way.
const maxPerGroup = Math.max(4, Math.min(64, os.availableParallelism() * 4));
assert.equal(ptcRuns - runsBefore, Math.ceil(41 / maxPerGroup), `41 files were split by the ${maxPerGroup}-file cap`);
assert.ok(ptcPeak <= 32, `the program kept at most one wave pending (peak ${ptcPeak})`);
assert.ok(
  manyDone.items.every((item) => !item.error),
  'no row was refused for too many pending binding calls',
);

const modelList = await call('models');
assert.equal(modelList.data.ok, true);
assert.equal(modelList.data.default.provider, 'test');
assert.equal(modelList.data.default.model, 'test');
assert.equal(modelList.data.default.name, 'Test Model');
assert.ok(modelList.data.models.some((item) => item.provider === 'test' && item.id === 'test'));

const explicit = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [{ id: testUploadId, format: 'jpg' }],
    model: { provider: 'test', model: 'test' },
    quality: 60,
    ptc: true,
  }),
});
assert.equal(explicit.data.ok, true, JSON.stringify(explicit.data));
await waitRun(explicit.data.run);
assert.equal(ptcReasoning, 'low');

const unregistered = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [{ id: testUploadId, format: 'jpg' }],
    model: { provider: 'test', model: 'nope' },
    ptc: true,
  }),
});
assert.equal(unregistered.data.ok, false);
assert.match(unregistered.data.error, /注册/);

// A program-returned path is never trusted; the Host reports what the binding
// actually wrote.
const realPtcRun = ptcRuntime.run;
ptcRuntime.run = async (spec) => {
  await spec.bindings[0].functions.convert({ id: testUploadId, format: 'png' });
  return { value: [{ id: testUploadId, output: '/etc/passwd' }], logs: [] };
};
const smuggledStarted = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: [{ id: testUploadId, format: 'png' }], ptc: true }),
});
const smuggled = await waitRun(smuggledStarted.data.run);
assert.notEqual(smuggled.items[0].result.file, '/etc/passwd');
assert.ok(fs.existsSync(smuggled.items[0].result.file));
ptcRuntime.run = realPtcRun;

// No runtime means a clear stop, never a silent fallback to fixed rules.
services.ptcRuntime = undefined;
const noPtc = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: [{ id: upload.data.id, format: 'jpg' }], ptc: true }),
});
assert.equal(noPtc.data.ok, false);
assert.match(noPtc.data.error, /PTC/);
services.ptcRuntime = ptcRuntime;

const bad = await call('convert', { method: 'POST', body: JSON.stringify({ id: upload.data.id, format: 'mp4' }) });
assert.equal(bad.data.ok, false); // image sources have no mp4 target

// --- clip: trim, extract audio, extract video ----------------------------
const clip = path.join(outDir, 'clip.mp4');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-t',
  '2',
  '-i',
  'testsrc=size=64x64:rate=10',
  '-f',
  'lavfi',
  '-t',
  '2',
  '-i',
  'sine=frequency=440',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-shortest',
  clip,
]);
const clipUpload = await call('upload?name=clip.mp4', { method: 'POST', body: fs.readFileSync(clip) });
assert.equal(clipUpload.data.kind, 'video');
assert.ok(Math.abs(clipUpload.data.duration - 2) < 0.3, `duration ${clipUpload.data.duration}`);
assert.deepEqual(clipUpload.data.streams, {
  video: true,
  audio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  subtitles: [],
});

const trimmed = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', trim: { start: 0.5, end: 1.5 } }),
});
assert.equal(trimmed.data.ok, true, JSON.stringify(trimmed.data));
assert.deepEqual(trimmed.data.job.trim, { start: 0.5, end: 1.5 });
const trimJob = await waitJob(trimmed.data.job);
const trimmedDuration = parseDuration(
  spawnSync(ffmpeg, ['-hide_banner', '-i', trimJob.out], { encoding: 'utf8' }).stderr,
);
assert.ok(Math.abs(trimmedDuration - 1) < 0.25, `trimmed duration ${trimmedDuration}`);

// An inverted window degrades to "no trim" rather than cutting a surprise range.
const inverted = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', trim: { start: 1.5, end: 0.5 } }),
});
assert.equal(inverted.data.job.trim, null);

// Quality rules on the copy fast path: an explicit quality re-encodes even
// when the container could just copy; the default anchor (90, or anything
// rounding to it) keeps the copy.
const copyDefault = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4' }),
});
assert.equal(copyDefault.data.job.copy, true, 'h264+aac to mp4 copies by default');
const copyQ90 = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', quality: 90 }),
});
assert.equal(copyQ90.data.job.copy, true, 'the default quality anchor keeps the copy');
const copyQ904 = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', quality: 90.4 }),
});
assert.equal(copyQ904.data.job.copy, true, 'a quality that rounds to 90 keeps the copy');
const reencodeQ50 = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', quality: 50 }),
});
assert.equal(reencodeQ50.data.job.copy, false, 'an explicit quality forces the re-encode');
const reencodeJob = await waitJob(reencodeQ50.data.job);
assert.ok(fs.existsSync(reencodeJob.out), 'the re-encoded output lands on disk');

const audioOnly = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, mode: 'extract-audio' }),
});
assert.equal(audioOnly.data.ok, true, JSON.stringify(audioOnly.data));
const audioJob = await waitJob(audioOnly.data.job);
assert.equal(audioJob.kind, 'audio');
assert.equal(path.extname(audioJob.out), '.m4a');
const audioProbe = spawnSync(ffmpeg, ['-hide_banner', '-i', audioJob.out], { encoding: 'utf8' }).stderr;
assert.match(audioProbe, /Audio: aac/);
assert.doesNotMatch(audioProbe, /Video:/);

const videoOnly = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, mode: 'extract-video' }),
});
assert.equal(videoOnly.data.ok, true, JSON.stringify(videoOnly.data));
const videoJob = await waitJob(videoOnly.data.job);
assert.equal(videoJob.kind, 'video');
assert.equal(path.extname(videoJob.out), '.mp4');
const videoProbe = spawnSync(ffmpeg, ['-hide_banner', '-i', videoJob.out], { encoding: 'utf8' }).stderr;
assert.match(videoProbe, /Video: h264/);
assert.doesNotMatch(videoProbe, /Audio:/);

// Extracting from a file without the track reports it instead of failing oddly.
const still = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: upload.data.id, mode: 'extract-video' }),
});
assert.equal(still.data.ok, true); // an image does have a video stream, so this is allowed

// --- base64 both ways ----------------------------------------------------
const encoded = await call('base64', { method: 'POST', body: JSON.stringify({ id: upload.data.id }) });
assert.equal(encoded.data.ok, true, JSON.stringify(encoded.data));
assert.match(encoded.data.data, /^data:image\/png;base64,/);
assert.ok(encoded.data.data.length > fs.statSync(sample).size);

const restored = await call('decode', { method: 'POST', body: JSON.stringify({ text: encoded.data.data }) });
assert.equal(restored.data.ok, true, JSON.stringify(restored.data));
assert.equal(restored.data.kind, 'image');
assert.equal(restored.data.mime, 'image/png');
assert.ok(fs.existsSync(restored.data.file));
assert.ok(fs.readFileSync(restored.data.file).equals(fs.readFileSync(sample)));

const decodedText = await call('decode', {
  method: 'POST',
  body: JSON.stringify({ text: Buffer.from('你好，世界').toString('base64') }),
});
assert.equal(decodedText.data.ok, true);
assert.deepEqual({ kind: decodedText.data.kind, text: decodedText.data.text }, { kind: 'text', text: '你好，世界' });

const badDecode = await call('decode', { method: 'POST', body: JSON.stringify({ text: '%%%' }) });
assert.equal(badDecode.data.ok, false);

// --- subtitle tracks and container metadata -----------------------------
const srtPath = path.join(outDir, 'sub.srt');
fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,500\n你好，世界\n\n');
const subbed = path.join(outDir, 'subbed.mkv');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-i',
  clip,
  '-i',
  srtPath,
  '-map',
  '0',
  '-map',
  '1',
  '-c',
  'copy',
  '-c:s',
  'srt',
  '-metadata:s:s:0',
  'language=chi',
  subbed,
]);
const subUpload = await call('upload?name=subbed.mkv', { method: 'POST', body: fs.readFileSync(subbed) });
assert.equal(subUpload.data.meta.subtitles.length, 1, JSON.stringify(subUpload.data.meta.subtitles));
assert.equal(subUpload.data.meta.subtitles[0].language, 'chi');
assert.ok(subUpload.data.meta.video.width > 0, 'video width parsed');
assert.match(subUpload.data.meta.format, /matroska/);

const subJob = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: subUpload.data.id, mode: 'subtitle', stream: 0 }),
});
assert.equal(subJob.data.ok, true, JSON.stringify(subJob.data));
const doneSub = await waitJob(subJob.data.job);
assert.ok(doneSub.out.endsWith('.chi.srt'), doneSub.out);
assert.match(fs.readFileSync(doneSub.out, 'utf8'), /你好，世界/);

const metaJob = await call('convert', {
  method: 'POST',
  body: JSON.stringify({
    id: clipUpload.data.id,
    mode: 'meta',
    tags: { title: '片头测试', artist: '小火山', album: '' },
  }),
});
assert.equal(metaJob.data.ok, true, JSON.stringify(metaJob.data));
const doneMeta = await waitJob(metaJob.data.job);
const metaProbe = spawnSync(ffmpeg, ['-hide_banner', '-i', doneMeta.out], { encoding: 'utf8' }).stderr;
assert.match(metaProbe, /title\s*:\s*片头测试/);
assert.match(metaProbe, /artist\s*:\s*小火山/);
const rewritten = await call('upload?name=tagged.mp4', { method: 'POST', body: fs.readFileSync(doneMeta.out) });
assert.equal(rewritten.data.meta.tags.title, '片头测试');

// --- probing edge cases (real ffmpeg output) -------------------------------
// A 5.1 layout keeps its channel label instead of shifting the sample format
// into the channels slot.
const surroundSrc = path.join(outDir, 'surround.ac3');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=channel_layout=5.1:sample_rate=48000',
  '-t',
  '1',
  '-c:a',
  'ac3',
  surroundSrc,
]);
const surroundUp = await call('upload?name=surround.ac3', { method: 'POST', body: fs.readFileSync(surroundSrc) });
assert.equal(surroundUp.data.kind, 'audio');
assert.equal(surroundUp.data.meta.audio.channels, '5.1(side)', JSON.stringify(surroundUp.data.meta.audio));

// Cover art of an audio file is artwork, not its picture track.
const coverPng = path.join(outDir, 'cover.png');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=1:size=300x300:rate=1',
  '-frames:v',
  '1',
  coverPng,
]);
const coverM4a = path.join(outDir, 'cover.m4a');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330',
  '-t',
  '1',
  '-i',
  coverPng,
  '-map',
  '0:a',
  '-map',
  '1',
  '-c:a',
  'aac',
  '-c:v',
  'mjpeg',
  '-frames:v',
  '1',
  '-disposition:v:0',
  'attached_pic',
  coverM4a,
]);
const coverUp = await call('upload?name=cover.m4a', { method: 'POST', body: fs.readFileSync(coverM4a) });
assert.equal(coverUp.data.kind, 'audio');
assert.equal(coverUp.data.meta.video, null, 'cover art must not become the picture track');
assert.equal(coverUp.data.meta.audio.codec, 'aac');

// Fake-green guards: the ffprobe route really carried this suite (the log is
// empty when probing silently skipped it), and a broken ffprobe must fall
// back to stderr parsing without the caller noticing. On CI the real ffprobe
// shadows the fake, so the log part is dev-only; the fallback upload still
// asserts correct behaviour either way.
if (fakeProbing) {
  const fakeCalls = fs.readFileSync(fakeProbeLog, 'utf8').trim().split('\n');
  assert.ok(fakeCalls.length > 0, 'uploads were probed through the fake ffprobe');
  // Upload assertions alone cannot prove the mapping route carried them (they
  // pass on the stderr route too, silently); an answer bigger than '{}' does.
  assert.ok(
    fakeCalls.some((line) => Number(line.split(' ').pop()) > 100),
    'the fake ffprobe answered with metadata, not {}',
  );
}
fs.writeFileSync(fakeProbeSentinel, 'x');
const fallbackSrc = path.join(outDir, 'fallback.wav');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=520', '-t', '1', fallbackSrc]);
const fallbackUp = await call('upload?name=fallback.wav', { method: 'POST', body: fs.readFileSync(fallbackSrc) });
assert.equal(fallbackUp.data.kind, 'audio', 'a broken ffprobe falls back to the stderr route');
assert.ok(Math.abs(fallbackUp.data.duration - 1) < 0.3, `fallback duration ${fallbackUp.data.duration}`);
fs.rmSync(fakeProbeSentinel);

// --- every advertised format must actually convert -----------------------
const audioSrc = path.join(outDir, 'tone.m4a');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-t',
  '1',
  '-i',
  'sine=frequency=440',
  '-c:a',
  'aac',
  audioSrc,
]);
const audioUpload = await call('upload?name=tone.m4a', { method: 'POST', body: fs.readFileSync(audioSrc) });
assert.equal(audioUpload.data.kind, 'audio');

for (const [kind, id, formats] of [
  ['video', clipUpload.data.id, status.data.formats.video],
  ['audio', audioUpload.data.id, status.data.formats.audio],
  ['image', upload.data.id, status.data.formats.image],
]) {
  for (const format of formats) {
    const started = await call('convert', { method: 'POST', body: JSON.stringify({ id, format }) });
    assert.equal(started.data.ok, true, `${kind}/${format}: ${JSON.stringify(started.data)}`);
    const done = await waitJob(started.data.job);
    assert.ok(fs.statSync(done.out).size > 0, `${kind}/${format} produced an empty file`);
    assert.equal(path.extname(done.out), '.' + format, `${kind}/${format} extension`);
  }
}

// --- guards --------------------------------------------------------------
const reveal = await call('reveal', { method: 'POST', body: JSON.stringify({ file: '/etc/hosts' }) });
assert.equal(reveal.data.ok, false, 'reveal refuses paths outside the output dir');

const crossOrigin = await call('convert', {
  method: 'POST',
  origin: 'https://evil.example',
  body: JSON.stringify({ id: upload.data.id, format: 'jpg' }),
});
assert.equal(crossOrigin.status, 403);

// A broken input still has a known extension, so the job must fail cleanly and
// leave no truncated output behind.
const broken = await call('upload?name=broken.mp4', { method: 'POST', body: Buffer.from('not a video') });
const brokenJob = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: broken.data.id, format: 'mp4' }),
});
let brokenState = brokenJob.data.job;
for (let attempt = 0; attempt < 100 && brokenState.state === 'running'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  brokenState = (await call('job?id=' + brokenState.id)).data;
}
assert.equal(brokenState.state, 'error');
assert.equal(fs.existsSync(brokenState.out), false, 'failed job leaves no output');
assert.ok(brokenState.error.length > 0);

// --- cancelling a running job ---------------------------------------------
// A slow encode gives the cancel a wide window: VP9 is far slower than the
// x264 the other fixtures use.
const slowClip = path.join(outDir, 'slow.mp4');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-t',
  '8',
  '-i',
  'testsrc=size=640x360:rate=30',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  slowClip,
]);
const slowUpload = await call('upload?name=slow.mp4', { method: 'POST', body: fs.readFileSync(slowClip) });
assert.equal(slowUpload.data.ok, true, JSON.stringify(slowUpload.data));
const slowJob = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: slowUpload.data.id, format: 'webm' }),
});
assert.equal(slowJob.data.ok, true, JSON.stringify(slowJob.data));

const cancelled = await call('cancel', { method: 'POST', body: JSON.stringify({ id: slowJob.data.job.id }) });
assert.equal(cancelled.data.ok, true, JSON.stringify(cancelled.data));
assert.equal(cancelled.data.state, 'cancelling', 'ffmpeg still has to die');

// The job only reports "cancelled" once the process is really gone and the
// half-written output is gone with it.
let cancelState = slowJob.data.job;
for (let attempt = 0; attempt < 100 && ['running', 'cancelling'].includes(cancelState.state); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelState = (await call('job?id=' + cancelState.id)).data;
}
assert.equal(cancelState.state, 'cancelled');
assert.equal(fs.existsSync(cancelState.out), false, 'cancelled job leaves no output');

const unknownCancel = await call('cancel', { method: 'POST', body: JSON.stringify({ id: 'nope' }) });
assert.equal(unknownCancel.data.ok, false, 'cancelling an unknown job reports it');

// --- batch runs belong to the Host ---------------------------------------
// The panel hands over a checked batch and may then be closed, reloaded, or
// rebuilt. The run keeps walking its files and is what the next page restores
// its rows from, so the batch never resets to "waiting" on a page switch.
const runImage = await call('upload?name=run.png', { method: 'POST', body: fs.readFileSync(sample) });
assert.equal(runImage.data.ok, true, JSON.stringify(runImage.data));
const started = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { id: runImage.data.id, format: 'jpg', quality: 55 },
      { id: slowUpload.data.id, skip: true, reason: 'batch.notApplicable' },
    ],
  }),
});
assert.equal(started.data.ok, true, JSON.stringify(started.data));
assert.equal(started.data.run.state, 'running', 'the response does not wait for the batch');
assert.equal(started.data.run.items[0].state, 'waiting');
assert.equal(started.data.run.items[1].state, 'skipped', 'a row the panel cannot convert travels as skipped');
assert.equal(started.data.run.items[1].error, 'batch.notApplicable', 'the skip reason survives a rebuild');

let runState = started.data.run;
for (let attempt = 0; attempt < 150 && runState.state === 'running'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  runState = (await call('run?id=' + started.data.run.id)).data.run;
}
assert.equal(runState.state, 'done');
assert.equal(runState.items[0].state, 'done');
assert.equal(runState.items[0].percent, 100);
assert.ok(fs.existsSync(runState.items[0].result.file), 'the run wrote the output');
assert.equal(runState.items[0].result.kind, 'image');
assert.equal(runState.items[1].state, 'skipped', 'a skipped item is never executed');
assert.equal(runState.items[1].jobId, '', 'a skipped item starts no job');

// A rebuilt page asks without an id and gets the newest run back.
const latestRun = await call('run');
assert.equal(latestRun.data.ok, true);
assert.equal(latestRun.data.run.id, runState.id, 'the newest run is restored without an id');

// Per-row quality travels with the run: a row without its own quality falls
// back to the run default (copy stays), a row with its own re-encodes.
const qualityRun = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { id: clipUpload.data.id, format: 'mp4' },
      { id: clipUpload.data.id, format: 'mp4', quality: 50 },
    ],
    quality: 90,
  }),
});
assert.equal(qualityRun.data.ok, true, JSON.stringify(qualityRun.data));
let qualityState = qualityRun.data.run;
for (let attempt = 0; attempt < 300 && qualityState.state === 'running'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  qualityState = (await call('run?id=' + qualityRun.data.run.id)).data.run;
}
assert.equal(qualityState.state, 'done');
assert.equal(qualityState.items[0].result.copy, true, 'a row on the run default keeps the container copy');
assert.equal(
  qualityState.items[1].result.copy,
  false,
  'a row with its own quality re-encodes under the same run default',
);

// Per-row state still comes from /queue: each run item is an ordinary job.
const runQueue = await call('queue');
const runRow = runQueue.data.items.find((item) => item.upload.id === runImage.data.id);
assert.equal(runRow.job.state, 'done', 'the run item is a normal job in the queue');

// Cancelling a run kills the item in flight and stops the rest.
const slowRun = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: [{ id: slowUpload.data.id, format: 'webm' }] }),
});
assert.equal(slowRun.data.ok, true, JSON.stringify(slowRun.data));
const runCancelled = await call('run/cancel', {
  method: 'POST',
  body: JSON.stringify({ id: slowRun.data.run.id }),
});
assert.equal(runCancelled.data.ok, true, JSON.stringify(runCancelled.data));
assert.equal(runCancelled.data.run.state, 'cancelled');
let cancelledRunState = runCancelled.data.run;
for (let attempt = 0; attempt < 100 && cancelledRunState.items[0].state === 'converting'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelledRunState = (await call('run?id=' + slowRun.data.run.id)).data.run;
}
assert.equal(cancelledRunState.state, 'cancelled');
assert.equal(cancelledRunState.items[0].state, 'cancelled', 'the in-flight item dies with the run');

// The ETA comes from measured throughput: a second batch of the same clip
// estimates differently once the first run has calibrated this machine.
async function ptcEta() {
  const started = await call('run', {
    method: 'POST',
    body: JSON.stringify({ items: [{ id: slowUpload.data.id, format: 'webm' }], ptc: true }),
  });
  const done = await waitRun(started.data.run);
  assert.equal(done.state, 'done', done.error);
  return done.estimatedMs;
}
const firstEta = await ptcEta();
const secondEta = await ptcEta();
assert.ok(firstEta > 0 && secondEta > 0, 'a PTC run reports its estimate');
assert.notEqual(secondEta, firstEta, 'the estimate follows the measured throughput');

// A PTC run is cancelled the same way: its own signal ends the sandbox and the
// ffmpeg job inside it.
const slowPtc = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: [{ id: slowUpload.data.id, format: 'webm' }], ptc: true }),
});
assert.equal(slowPtc.data.ok, true, JSON.stringify(slowPtc.data));
const slowPtcCancel = await call('run/cancel', {
  method: 'POST',
  body: JSON.stringify({ id: slowPtc.data.run.id }),
});
assert.equal(slowPtcCancel.data.ok, true, JSON.stringify(slowPtcCancel.data));
const slowPtcState = await waitRun(slowPtc.data.run);
assert.equal(slowPtcState.state, 'cancelled');
assert.equal(slowPtcState.items[0].state, 'cancelled', 'the PTC sandbox is stopped with the run');

const unknownRun = await call('run?id=nope');
assert.deepEqual(unknownRun.data, { ok: true, run: null }, 'an unknown run is reported as absent');
const unknownRunCancel = await call('run/cancel', { method: 'POST', body: JSON.stringify({ id: 'nope' }) });
assert.equal(unknownRunCancel.data.ok, false, 'cancelling an unknown run reports it');

// --- plain-run lanes: light jobs overlap, software videos stay alone ---------
const slow2 = await call('upload?name=slow2.mp4', { method: 'POST', body: fs.readFileSync(slowClip) });
assert.equal(slow2.data.ok, true, JSON.stringify(slow2.data));
// Sixty seconds of audio keeps one re-encode busy for a second or two — long
// enough for the sampler below to catch lanes overlapping. m4a/aac is built
// into every ffmpeg build, so it is always offered (aom/vorbis were dropped
// from Homebrew ffmpeg 9 and must not be assumed).
const tone60 = path.join(outDir, 'tone60.m4a');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-t',
  '60',
  '-i',
  'sine=frequency=440',
  '-c:a',
  'aac',
  tone60,
]);
const audioIds = [];
for (let i = 0; i < 6; i += 1) {
  const up = await call(`upload?name=tone${i}.m4a`, { method: 'POST', body: fs.readFileSync(tone60) });
  assert.equal(up.data.ok, true, JSON.stringify(up.data));
  audioIds.push(up.data.id);
}

// Poll a live run; resolve with the final frame and the widest state overlap seen.
async function sampleRun(runId) {
  let maxConverting = 0;
  for (;;) {
    const res = await call('run?id=' + runId);
    const run = res.data.run;
    if (!run || run.state !== 'running') return { run, maxConverting };
    const converting = run.items.filter((item) => item.state === 'converting').length;
    if (converting > maxConverting) maxConverting = converting;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The light lane runs audios side by side instead of walking them in order.
const lightRun = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: audioIds.map((id) => ({ id, format: 'm4a' })) }),
});
assert.equal(lightRun.data.ok, true, JSON.stringify(lightRun.data));
const lightSample = await sampleRun(lightRun.data.run.id);
assert.equal(lightSample.run.state, 'done', 'the light-lane run finishes');
assert.ok(lightSample.maxConverting >= 2, `light jobs overlap (max ${lightSample.maxConverting} converting)`);
assert.ok(
  lightSample.run.items.every((item) => item.state === 'done'),
  `light items: ${JSON.stringify(lightSample.run.items.map((item) => [item.id, item.state, item.error]))}`,
);

// Two software video encodes never overlap: each one already saturates the cores.
const twoVideos = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { id: slowUpload.data.id, format: 'webm' },
      { id: slow2.data.id, format: 'webm' },
    ],
  }),
});
assert.equal(twoVideos.data.ok, true, JSON.stringify(twoVideos.data));
const twoVideoSample = await sampleRun(twoVideos.data.run.id);
assert.equal(twoVideoSample.run.state, 'done');
assert.ok(twoVideoSample.maxConverting <= 1, `software videos never overlap (max ${twoVideoSample.maxConverting})`);

// A slow software video does not block the light lane queued behind it.
const mixedRun = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { id: slowUpload.data.id, format: 'webm' },
      { id: audioIds[0], format: 'm4a' },
      { id: audioIds[1], format: 'm4a' },
    ],
  }),
});
assert.equal(mixedRun.data.ok, true, JSON.stringify(mixedRun.data));
let audioFinishedFirst = false;
for (;;) {
  const res = await call('run?id=' + mixedRun.data.run.id);
  const run = res.data.run;
  if (!run || run.state !== 'running') break;
  if (run.items[0].state === 'converting' && (run.items[1].state === 'done' || run.items[2].state === 'done')) {
    audioFinishedFirst = true;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(audioFinishedFirst, 'light items finish while the software video still runs');

// Cancelling a run kills every in-flight job, not just the first converting row.
const cancelMix = await call('run', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { id: slowUpload.data.id, format: 'webm' },
      { id: slow2.data.id, format: 'webm' },
      { id: audioIds[2], format: 'm4a' },
    ],
  }),
});
assert.equal(cancelMix.data.ok, true, JSON.stringify(cancelMix.data));
const cancelMixRes = await call('run/cancel', {
  method: 'POST',
  body: JSON.stringify({ id: cancelMix.data.run.id }),
});
assert.equal(cancelMixRes.data.ok, true, JSON.stringify(cancelMixRes.data));
const cancelMixState = await waitRun(cancelMix.data.run);
assert.equal(cancelMixState.state, 'cancelled');
assert.equal(cancelMixState.items[0].state, 'cancelled', 'the in-flight software video dies with the run');
assert.equal(cancelMixState.items[1].state, 'cancelled', 'the queued software video is never started');
// The audio item is a 1-2s job: a slow CI runner can legitimately finish it
// just before the cancel lands, so 'done' is accepted there and only there.
assert.ok(
  ['done', 'cancelled'].includes(cancelMixState.items[2].state),
  `the audio item ends done or cancelled (${cancelMixState.items[2].state})`,
);
assert.ok(
  cancelMixState.items.every((item) => !item.result || !fs.existsSync(item.result.file)),
  'cancelled jobs leave no output',
);

// Extract-audio is a container rewrite ('-c:a copy' with no copy flag): it must
// ride the light lane in parallel, not queue on the one-at-a-time video lane.
const song = path.join(outDir, 'song.mp4');
execFileSync(ffmpeg, [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=640x360:rate=30',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440',
  '-t',
  '60',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  song,
]);
const songIds = [];
for (let i = 0; i < 8; i += 1) {
  const up = await call(`upload?name=song${i}.mp4`, { method: 'POST', body: fs.readFileSync(song) });
  assert.equal(up.data.ok, true, JSON.stringify(up.data));
  songIds.push(up.data.id);
}
const extractRun = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: songIds.map((id) => ({ id, mode: 'extract-audio' })) }),
});
assert.equal(extractRun.data.ok, true, JSON.stringify(extractRun.data));
const extractSample = await sampleRun(extractRun.data.run.id);
assert.equal(extractSample.run.state, 'done', 'the extract run finishes');
assert.ok(
  extractSample.maxConverting >= 2,
  `extract-audio rewrites overlap on the light lane (max ${extractSample.maxConverting})`,
);
assert.ok(extractSample.run.items.every((item) => item.state === 'done'));
assert.ok(
  extractSample.run.items.every((item) => path.extname(item.result.file) === '.m4a'),
  'extracted audio lands in an audio container',
);

const emptyRun = await call('run', { method: 'POST', body: JSON.stringify({ items: [] }) });
assert.equal(emptyRun.data.ok, false, 'an empty batch is refused');
const staleRunItem = await call('run', {
  method: 'POST',
  body: JSON.stringify({ items: [{ id: 'missing', format: 'jpg' }] }),
});
assert.equal(staleRunItem.data.ok, false, 'a batch naming a stale upload is refused');
const unauthenticatedRun = await call('run', { auth: false });
assert.equal(unauthenticatedRun.status, 401, 'the run routes sit behind the trust fence');

// --- an upload that does not arrive whole ---------------------------------
// A truncated body would only fail later as an "unrecognisable media file",
// so it has to be reported as what it is.
const truncated = await call('upload?name=clip.mp4', {
  method: 'POST',
  body: Buffer.from('partial'),
  headers: { 'content-length': '999999' },
});
assert.equal(truncated.data.ok, false, JSON.stringify(truncated.data));
assert.match(truncated.data.error, /上传不完整/);

// A file ffmpeg cannot read is reported as such, not as a silent failure.
const garbage = await call('upload?name=clip.xyz', { method: 'POST', body: Buffer.from('not a media file') });
assert.equal(garbage.data.ok, false, JSON.stringify(garbage.data));
assert.match(garbage.data.error, /无法识别/);

// --- the agent tool ---------------------------------------------------------
const media = tools.get('media_toolbox');
assert.ok(media, 'the agent tool is registered');
const exec = { signal: new AbortController().signal };

const probed = await media.execute({ path: clip, action: 'probe' }, exec);
assert.equal(probed.kind, 'video');
assert.ok(Math.abs(probed.duration - 2) < 0.3, `probed duration ${probed.duration}`);
assert.equal(probed.meta.streams.length, 2, 'the probe lists both streams');

const convertedByTool = await media.execute({ path: clip, action: 'convert', format: 'mp3' }, exec);
assert.ok(fs.existsSync(convertedByTool.file), 'the tool wrote its output');
assert.equal(path.extname(convertedByTool.file), '.mp3');
assert.ok(convertedByTool.sizeBytes > 0);

const trimmedByTool = await media.execute(
  { path: clip, action: 'convert', format: 'mp4', trim: { start: 0.5, end: 1.5 } },
  exec,
);
const toolTrimDuration = parseDuration(
  spawnSync(ffmpeg, ['-hide_banner', '-i', trimmedByTool.file], { encoding: 'utf8' }).stderr,
);
assert.ok(Math.abs(toolTrimDuration - 1) < 0.25, `trimmed duration ${toolTrimDuration}`);

await assert.rejects(
  () => media.execute({ path: path.join(outDir, 'nope.mp4'), action: 'probe' }, exec),
  /文件不存在/,
  'a missing file is reported, not silently ignored',
);
await assert.rejects(
  () => media.execute({ path: clip, action: 'convert', format: 'exe' }, exec),
  /不支持的输出格式/,
  'an impossible target is refused',
);

// A call that is aborted while it runs stops the ffmpeg and leaves no output.
const aborted = new AbortController();
aborted.abort();
await assert.rejects(() => media.execute({ path: clip, action: 'convert', format: 'mp4' }, { signal: aborted.signal }));

// --- the connection trust fence ---------------------------------------------
// Every route refuses a caller without the browser-session cookie before it
// reads a body or touches the disk.
const unauthenticated = await call('status', { auth: false });
assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated.data));

const unauthenticatedUpload = await call('upload?name=x.mp4', {
  method: 'POST',
  body: Buffer.alloc(8, 1),
  auth: false,
});
assert.equal(unauthenticatedUpload.status, 401, JSON.stringify(unauthenticatedUpload.data));

// A composition that owns no connection service must not serve requests at all:
// the plugin fails closed with 503 instead of accepting an unauthenticated call.
const bareRoutes = new Map();
const bareCleanups = [];
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? {
            getOrigin: () => 'http://127.0.0.1:65533',
            register: (route) => {
              bareRoutes.set(route.path, route.handler);
              return () => bareRoutes.delete(route.path);
            },
          }
        : undefined,
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => bareCleanups.push(fn()),
  },
  { outputDir: outDir },
);
const bareRes = makeRes();
await bareRoutes.get('/api/media-convert/status')(fakeReq({ url: '/api/media-convert/status' }), bareRes);
await bareRes.done;
assert.equal(bareRes.status, 503, Buffer.concat(bareRes.chunks).toString('utf8'));
bareCleanups.forEach((dispose) => dispose());

// A plugin can apply before the composition registers the connection service.
// The route must look it up per request; capturing it at apply time would leave
// every route refusing with 401/503 for the life of the instance.
let lateConnection;
const lateRoutes = new Map();
const lateCleanups = [];
apply(
  {
    get: (key) => {
      if (key === 'webServer') {
        return {
          getOrigin: () => 'http://127.0.0.1:65533',
          register: (route) => {
            lateRoutes.set(route.path, route.handler);
            return () => lateRoutes.delete(route.path);
          },
        };
      }
      return key === 'connection' ? lateConnection : undefined;
    },
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => lateCleanups.push(fn()),
  },
  { outputDir: outDir },
);
lateConnection = connection;
const lateRes = makeRes();
await lateRoutes.get('/api/media-convert/status')(fakeReq({ url: '/api/media-convert/status' }), lateRes);
await lateRes.done;
assert.equal(lateRes.status, 200, Buffer.concat(lateRes.chunks).toString('utf8'));
lateCleanups.forEach((dispose) => dispose());

// --- the upload cap ---------------------------------------------------------
// A body over the cap is refused instead of filling the disk.
const capRoutes = new Map();
const capOut = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-cap-'));
const capCleanups = [];
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? {
            getOrigin: () => 'http://127.0.0.1:65533',
            register: (route) => {
              capRoutes.set(route.path, route.handler);
              return () => capRoutes.delete(route.path);
            },
          }
        : key === 'connection'
          ? connection
          : undefined,
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => capCleanups.push(fn()),
  },
  { outputDir: capOut, maxUploadMb: 0.001 },
);
const capRes = makeRes();
await capRoutes.get('/api/media-convert/upload')(
  fakeReq({ method: 'POST', url: '/api/media-convert/upload?name=big.mp4', body: Buffer.alloc(4096, 7) }),
  capRes,
);
await capRes.done;
const capData = JSON.parse(Buffer.concat(capRes.chunks).toString('utf8'));
assert.equal(capData.ok, false, JSON.stringify(capData));
assert.match(capData.error, /超过上限/);
capCleanups.forEach((dispose) => dispose());
fs.rmSync(capOut, { recursive: true, force: true });

// --- the settings route -----------------------------------------------------
// Saving merges the defined keys into the entry's config through the settings
// service; the loader hot-replaces the plugin with the new values.
const before = settingsCalls.length;
const saved = await call('config', {
  method: 'POST',
  body: JSON.stringify({ outputDir: '~/Movies/converted', maxUploadMb: 100 }),
});
assert.equal(saved.data.ok, true, JSON.stringify(saved.data));
const updateCall = settingsCalls.find((call) => call[0] === 'update');
assert.ok(updateCall, 'the settings service received the update');
assert.equal(updateCall[1], 'media-converter');
assert.deepEqual(updateCall[2], { outputDir: '~/Movies/converted', maxUploadMb: 100 });
assert.ok(settingsCalls.length > before);

const badSave = await call('config', { method: 'POST', body: JSON.stringify({ maxUploadMb: 0 }) });
assert.equal(badSave.data.ok, false, 'an impossible cap is refused');
assert.match(badSave.data.error, /maxUploadMb/);

const emptySave = await call('config', { method: 'POST', body: JSON.stringify({}) });
assert.equal(emptySave.data.ok, false, 'an empty patch is reported');

// The new settings ride the same route; the service records them like any
// other merge.
await call('config', { method: 'POST', body: JSON.stringify({ composerButton: false, groups: 'view,convert' }) });
const uiUpdate = settingsCalls.filter((call) => call[0] === 'update').at(-1);
assert.deepEqual(uiUpdate[2], { composerButton: false, groups: 'view,convert' });

// The page-state toggle saves and applies like the other UI fields.
await call('config', { method: 'POST', body: JSON.stringify({ persistState: true }) });
const persistUpdate = settingsCalls.filter((call) => call[0] === 'update').at(-1);
assert.deepEqual(persistUpdate[2], { persistState: true });
const persisted = await call('status');
assert.equal(persisted.data.persistState, true, 'the toggle applies to the running instance');
const badPersist = await call('config', { method: 'POST', body: JSON.stringify({ persistState: 'yes' }) });
assert.equal(badPersist.data.ok, false, 'a non-boolean toggle is refused');
assert.match(badPersist.data.error, /persistState/);

// The save applies to the running instance: the very next status read serves
// the new values, with no restart and no reload.
const after = await call('status');
assert.equal(after.data.composerButton, false, 'the toggle applies to the running instance');
assert.deepEqual(after.data.groups, ['view', 'convert', 'edit'], 'the group order applies live');

// A later save stacks on the earlier ones instead of restarting from the
// load-time values.
await call('config', { method: 'POST', body: JSON.stringify({ maxUploadMb: 100 }) });
const stacked = await call('status');
assert.equal(stacked.data.maxUploadMb, 100, 'a later save applies too');
assert.equal(stacked.data.composerButton, false, 'an earlier save is not clobbered by the merge');

// --- group order resolution -------------------------------------------------
assert.deepEqual(
  resolveGroups('view,convert'),
  ['view', 'convert', 'edit'],
  'the configured order wins, missing keys follow',
);
assert.deepEqual(
  resolveGroups('bogus,edit,edit'),
  ['edit', 'convert', 'view'],
  'unknown tokens and duplicates are dropped',
);
assert.deepEqual(resolveGroups(''), ['convert', 'edit', 'view'], 'an empty config keeps the built-in order');

// --- runtime-tunable caps (uploadTtlMinutes / queueLimit) -------------------
// The two caps default to 120 minutes / 2000 rows, accept a valid save, and
// reject out-of-range values before they reach the running state. These run
// against the main instance: the section sits after every other test, so the
// config it leaves behind affects nothing below.
const capStatus0 = await call('status');
assert.match(capStatus0.data.instanceId, /^[0-9a-f-]{36}$/, 'status carries an instance id');
assert.equal(capStatus0.data.uploadTtlMinutes, 120, 'default upload TTL is 120 minutes');
assert.equal(capStatus0.data.queueLimit, 2000, 'default queue limit is 2000');
const capSaved = await call('config', {
  method: 'POST',
  body: JSON.stringify({ uploadTtlMinutes: 60, queueLimit: 100 }),
});
assert.equal(capSaved.data.ok, true, JSON.stringify(capSaved.data));
const capStatus1 = await call('status');
assert.equal(capStatus1.data.uploadTtlMinutes, 60, 'a valid save is live at once');
assert.equal(capStatus1.data.queueLimit, 100, 'a valid queue limit save is live at once');
for (const bad of [
  { uploadTtlMinutes: 2, match: /uploadTtlMinutes/ },
  { uploadTtlMinutes: 'abc', match: /uploadTtlMinutes/ },
  { queueLimit: 5, match: /queueLimit/ },
  { queueLimit: 'xyz', match: /queueLimit/ },
]) {
  const refused = await call('config', { method: 'POST', body: JSON.stringify(bad) });
  assert.equal(refused.data.ok, false, JSON.stringify(bad));
  assert.match(refused.data.error, bad.match, `rejects ${JSON.stringify(bad)}`);
}
const capStatus2 = await call('status');
assert.equal(capStatus2.data.uploadTtlMinutes, 60, 'a refused save leaves the live value alone');

// A load-time value below the floor is clamped, not honored: the floor exists
// so a tiny TTL cannot delete sources under running jobs.
const floorRoutes = new Map();
const floorCleanups = [];
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? {
            getOrigin: () => 'http://127.0.0.1:65533',
            register: (route) => {
              floorRoutes.set(route.path, route.handler);
              return () => floorRoutes.delete(route.path);
            },
          }
        : key === 'connection'
          ? connection
          : undefined,
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => floorCleanups.push(fn()),
  },
  { outputDir: outDir, uploadTtlMinutes: 1, queueLimit: 3 },
);
const floorRes = makeRes();
await floorRoutes.get('/api/media-convert/status')(fakeReq({ url: '/api/media-convert/status' }), floorRes);
await floorRes.done;
const floorData = JSON.parse(Buffer.concat(floorRes.chunks).toString('utf8'));
assert.equal(floorData.uploadTtlMinutes, 5, 'load-time TTL below the floor clamps to 5');
assert.equal(floorData.queueLimit, 10, 'load-time queue limit below the floor clamps to 10');
floorCleanups.forEach((dispose) => dispose());

// --- pruneUploads: the TTL sweep, driven directly ---------------------------
// The 10-minute timer only calls this pure function; testing it through the
// timer would need fake timers next to real ffmpeg I/O.
const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-prune-'));
const fakeUpload = (id, at, owned, file) => ({
  id,
  name: id,
  path: file,
  owned,
  kind: 'video',
  duration: 1,
  size: 1,
  streams: [],
  meta: {},
  at,
});
const expiredOwnedFile = path.join(pruneDir, 'expired-owned.mp4');
fs.writeFileSync(expiredOwnedFile, 'x');
const expiredRegisteredFile = path.join(pruneDir, 'expired-registered.mp4');
fs.writeFileSync(expiredRegisteredFile, 'x');
const keptRunningFile = path.join(pruneDir, 'kept-running.mp4');
fs.writeFileSync(keptRunningFile, 'x');
const prunedOwnedFile = path.join(pruneDir, 'pruned-owned.mp4');
fs.writeFileSync(prunedOwnedFile, 'x');
const NOW = Date.now();
const pruneJobs = new Map([
  ['j1', { id: 'j1', uploadId: 'u-running', state: 'running' }],
  ['j2', { id: 'j2', uploadId: 'u-done-job', state: 'done' }],
]);
const pruneUploadsMap = new Map([
  ['u-expired-owned', fakeUpload('u-expired-owned', NOW - 3 * 3600_000, true, expiredOwnedFile)],
  ['u-expired-registered', fakeUpload('u-expired-registered', NOW - 3 * 3600_000, false, expiredRegisteredFile)],
  ['u-running', fakeUpload('u-running', NOW - 3 * 3600_000, true, keptRunningFile)],
  ['u-done-job', fakeUpload('u-done-job', NOW - 3 * 3600_000, true, prunedOwnedFile)],
  ['u-fresh', fakeUpload('u-fresh', NOW - 60_000, true, path.join(pruneDir, 'fresh.mp4'))],
]);
const pruned = pruneUploads(pruneUploadsMap, pruneJobs, 2 * 3600_000, NOW);
assert.deepEqual(
  [...pruned].sort(),
  ['u-done-job', 'u-expired-owned', 'u-expired-registered'],
  'expired uploads prune; a running job and a fresh upload stay',
);
assert.ok(!pruneUploadsMap.has('u-expired-owned') && !pruneUploadsMap.has('u-expired-registered'));
assert.ok(pruneUploadsMap.has('u-running'), 'an expired upload a running job reads survives');
assert.ok(pruneUploadsMap.has('u-fresh'), 'a fresh upload survives');
for (let attempt = 0; attempt < 50 && fs.existsSync(expiredOwnedFile); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(!fs.existsSync(expiredOwnedFile), 'an owned copy is deleted from disk');
assert.ok(fs.existsSync(expiredRegisteredFile), "a file registered by path is the user's own and survives");
assert.ok(fs.existsSync(keptRunningFile), 'the running job keeps its source on disk');
fs.rmSync(pruneDir, { recursive: true, force: true });

// --- upload/delete: 移除/清空 drops the Host record for real ----------------
// Fake-green guards: every case asserts the route answer (removed/skipped)
// AND an independent observable (/queue membership or the exact file on
// disk), so a silently no-op route cannot pass.
const tmpBox = path.join(os.tmpdir(), 'dsh-media-toolbox');
const queueHas = async (id) => {
  const q = await call('queue');
  return q.data.items.some((row) => row.upload.id === id);
};

// An owned browser-upload copy dies with its record.
const ownedUp = await call('upload?name=del-owned.png', { method: 'POST', body: fs.readFileSync(sample) });
assert.equal(ownedUp.data.ok, true, JSON.stringify(ownedUp.data));
const ownedFile = path.join(tmpBox, ownedUp.data.id + '.png');
assert.ok(await queueHas(ownedUp.data.id), 'the owned upload is queued');
assert.ok(fs.existsSync(ownedFile), 'the owned temp copy sits under the id-derived name');
const delOwned = await call('upload/delete', {
  method: 'POST',
  body: JSON.stringify({ ids: [ownedUp.data.id, 'never-heard-of'] }),
});
assert.equal(delOwned.data.ok, true);
assert.equal(delOwned.data.removed, 1, 'one real record removed; an unknown id is not an error');
assert.deepEqual(delOwned.data.skipped, []);
assert.ok(!(await queueHas(ownedUp.data.id)), 'the queue row is gone');
for (let attempt = 0; attempt < 50 && fs.existsSync(ownedFile); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(!fs.existsSync(ownedFile), 'the owned temp copy is deleted from disk');
const delAgain = await call('upload/delete', {
  method: 'POST',
  body: JSON.stringify({ ids: [ownedUp.data.id] }),
});
assert.equal(delAgain.data.removed, 0, 'a second delete is a no-op, not a phantom success');

// A file registered by path loses its record but keeps its bytes.
const registeredFile = path.join(outDir, 'del-registered.png');
fs.copyFileSync(sample, registeredFile);
const regUp = await call('register', { method: 'POST', body: JSON.stringify({ paths: [registeredFile] }) });
assert.equal(regUp.data.ok, true, JSON.stringify(regUp.data));
assert.ok(await queueHas(regUp.data.uploads[0].id), 'the registered file is queued');
const delReg = await call('upload/delete', {
  method: 'POST',
  body: JSON.stringify({ ids: [regUp.data.uploads[0].id] }),
});
assert.equal(delReg.data.removed, 1);
assert.ok(!(await queueHas(regUp.data.uploads[0].id)), 'the registered row is gone');
assert.ok(fs.existsSync(registeredFile), "a registered file is the user's own and stays on disk");
fs.rmSync(registeredFile);

// A row a running job still reads is skipped, never deleted from under ffmpeg.
const guardUp = await call('upload?name=del-guard.mp4', { method: 'POST', body: fs.readFileSync(clip) });
assert.equal(guardUp.data.ok, true, JSON.stringify(guardUp.data));
const guardJob = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: guardUp.data.id, format: 'webm' }),
});
let runningSeen = false;
for (let attempt = 0; attempt < 300; attempt += 1) {
  const j = await call('job?id=' + guardJob.data.job.id);
  if (j.data.state === 'running') {
    runningSeen = true;
    break;
  }
  if (j.data.state === 'done' || j.data.state === 'error') break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(runningSeen, 'the conversion reaches running before we delete under it');
const delRunning = await call('upload/delete', {
  method: 'POST',
  body: JSON.stringify({ ids: [guardUp.data.id] }),
});
assert.deepEqual(delRunning.data.skipped, [guardUp.data.id], 'the running upload is reported, not deleted');
assert.equal(delRunning.data.removed, 0);
assert.ok(await queueHas(guardUp.data.id), 'the running row stays in the queue');
await waitJob(guardJob.data.job);
const delSettled = await call('upload/delete', {
  method: 'POST',
  body: JSON.stringify({ ids: [guardUp.data.id] }),
});
assert.equal(delSettled.data.removed, 1, 'once settled, the same upload deletes');
assert.ok(!(await queueHas(guardUp.data.id)), 'the settled row is gone');

// --- history ledger ----------------------------------------------------------
// The ledger is an append-only JSONL file of settled jobs. The path override
// is global (see the top of the file), so this fresh apply reads the same
// isolated ledger as every other instance above.
const historyFile = LEDGER_FILE;
const histRoutes = new Map();
const histCleanups = [];
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? {
            getOrigin: () => 'http://127.0.0.1:65533',
            register: (route) => {
              histRoutes.set(route.path, route.handler);
              return () => histRoutes.delete(route.path);
            },
          }
        : key === 'connection'
          ? connection
          : undefined,
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => histCleanups.push(fn()),
  },
  { outputDir: outDir },
);
const histCall = async (route, options = {}) => {
  const handler = histRoutes.get('/api/media-convert/' + route.split('?')[0]);
  assert.ok(handler, `route ${route} registered`);
  const res = makeRes();
  await handler(fakeReq({ url: '/api/media-convert/' + route, ...options }), res);
  await res.done;
  return { status: res.status, data: JSON.parse(Buffer.concat(res.chunks).toString('utf8')) };
};

// Seed a ledger: three good lines — one output still on disk, two gone — and
// one torn line, which must be skipped instead of taking the route down.
const keptOutput = path.join(outDir, 'kept.mp4');
fs.writeFileSync(keptOutput, 'x');
fs.writeFileSync(
  historyFile,
  [
    JSON.stringify({ name: 'a.mp4', out: 'kept.mp4', size: 10, state: 'done', error: null, at: 1000 }),
    JSON.stringify({ name: 'gone.mp4', out: 'gone.mp4', size: 20, state: 'done', error: null, at: 2000 }),
    '{"torn":',
    JSON.stringify({ name: 'err.mp4', out: 'err.mp4', size: 0, state: 'error', error: 'boom', at: 3000 }),
  ].join('\n') + '\n',
);
const histPage = await histCall('history');
assert.equal(histPage.data.ok, true);
assert.equal(histPage.data.total, 3, 'the torn line is skipped, not fatal');
assert.deepEqual(
  histPage.data.items.map((item) => item.out),
  ['err.mp4', 'gone.mp4', 'kept.mp4'],
  'the ledger reads newest first',
);
assert.equal(histPage.data.items[0].deleted, true, 'a missing output reports deleted, not an error');
assert.equal(histPage.data.items[0].error, 'boom', 'an error row keeps its message');
assert.equal(histPage.data.items[2].deleted, false, 'an existing output is not deleted');
const histPage2 = await histCall('history?offset=2&limit=1');
assert.equal(histPage2.data.items.length, 1, 'offset and limit page the ledger');
assert.equal(histPage2.data.items[0].out, 'kept.mp4');
assert.equal(histPage2.data.total, 3, 'total is the ledger size, not the page size');
const emptyHistory = await histCall('history?offset=100');
assert.equal(emptyHistory.data.items.length, 0, 'an offset past the end yields an empty page');
assert.equal(emptyHistory.data.total, 3, 'total still reports the ledger size');

// A real conversion appends exactly one done row carrying the output name.
const histUpload = await histCall('upload?name=' + encodeURIComponent('hist ledger.png'), {
  method: 'POST',
  body: fs.readFileSync(sample),
});
assert.equal(histUpload.data.ok, true, JSON.stringify(histUpload.data));
const histConv = await histCall('convert', {
  method: 'POST',
  body: JSON.stringify({ id: histUpload.data.id, format: 'jpg' }),
});
assert.equal(histConv.data.ok, true, JSON.stringify(histConv.data));
{
  let current = histConv.data.job;
  for (let attempt = 0; attempt < 150 && current.state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = (await histCall('job?id=' + current.id)).data;
  }
  assert.equal(current.state, 'done', current.error);
}
// The append is fire-and-forget next to the job settle, so poll briefly.
let ledgerLines = [];
for (let attempt = 0; attempt < 50; attempt += 1) {
  ledgerLines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
  if (ledgerLines.length >= 5) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.equal(ledgerLines.length, 5, 'the conversion appended one row');
const appended = JSON.parse(ledgerLines[4]);
assert.equal(appended.state, 'done');
assert.equal(appended.name, 'hist ledger.png');
assert.ok(appended.out.endsWith('.jpg'), 'the row carries the output file name');
assert.ok(!appended.out.includes('/'), 'the row stores the file NAME, not an absolute path');
assert.ok(appended.size > 0, 'a done row carries the real output size');
assert.equal(typeof appended.at, 'number');

// --- history delete -----------------------------------------------------------
// Record-only delete drops the ledger row and keeps the output file on disk.
const delOnly = await histCall('history/delete', {
  method: 'POST',
  body: JSON.stringify({ items: [{ at: 1000, out: 'kept.mp4' }] }),
});
assert.equal(delOnly.data.ok, true);
assert.equal(delOnly.data.removed, 1);
assert.equal(delOnly.data.filesDeleted, 0);
assert.ok(fs.existsSync(keptOutput), 'record-only delete leaves the output file on disk');
const linesAfterOnly = fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean);
assert.equal(linesAfterOnly.length, 4, 'one ledger row was dropped');

// A batch delete drops several rows in one call.
const delBatch = await histCall('history/delete', {
  method: 'POST',
  body: JSON.stringify({
    items: [
      { at: 2000, out: 'gone.mp4' },
      { at: 3000, out: 'err.mp4' },
    ],
  }),
});
assert.equal(delBatch.data.removed, 2);
const linesAfterBatch = fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean);
assert.equal(linesAfterBatch.length, 2, 'two more rows were dropped');
assert.ok(
  linesAfterBatch.some((l) => l.includes('"torn"')),
  'the torn line rides through the rewrite',
);

// deleteFiles unlinks the matched output file itself.
const lastRow = JSON.parse(linesAfterBatch.find((l) => !l.includes('"torn"')));
const lastRowOut = path.join(outDir, lastRow.out);
assert.ok(fs.existsSync(lastRowOut));
const delFile = await histCall('history/delete', {
  method: 'POST',
  body: JSON.stringify({ items: [{ at: lastRow.at, out: lastRow.out }], deleteFiles: true }),
});
assert.equal(delFile.data.removed, 1);
assert.equal(delFile.data.filesDeleted, 1);
assert.ok(!fs.existsSync(lastRowOut), 'deleteFiles removes the output file from disk');
const textAfterFile = fs.readFileSync(historyFile, 'utf8');
assert.ok(textAfterFile.includes('"torn"'), 'the torn line survives every rewrite');

// A hand-edited row pointing outside the output dir: the record still goes,
// the outside file survives.
const outsideFile = path.join(ledgerDir, 'escape.txt');
fs.writeFileSync(outsideFile, 'x');
const escapeOut = `../${path.basename(ledgerDir)}/escape.txt`;
fs.appendFileSync(
  historyFile,
  JSON.stringify({ name: 'evil.mp4', out: escapeOut, size: 1, state: 'done', error: null, at: 4000 }) + '\n',
);
const delEscape = await histCall('history/delete', {
  method: 'POST',
  body: JSON.stringify({ items: [{ at: 4000, out: escapeOut }], deleteFiles: true }),
});
assert.equal(delEscape.data.ok, true);
assert.equal(delEscape.data.removed, 1);
assert.equal(delEscape.data.filesDeleted, 0, 'a row escaping the output dir never unlinks its file');
assert.ok(fs.existsSync(outsideFile), 'the outside file survives');

// Garbage in, method discipline: empty batch refused, GET answered 405.
const delEmpty = await histCall('history/delete', { method: 'POST', body: JSON.stringify({ items: [] }) });
assert.equal(delEmpty.data.ok, false, 'an empty delete request is refused');
const delWrongMethod = await histCall('history/delete');
assert.equal(delWrongMethod.status, 405, 'the delete route is POST only');

// The ledger is now only the torn line: the page reads empty, not broken.
const histAfterAll = await histCall('history');
assert.equal(histAfterAll.data.ok, true);
assert.equal(histAfterAll.data.total, 0);
assert.equal(histAfterAll.data.items.length, 0);

// --- the hardware backend probe ---------------------------------------------
// The backends are found at runtime: the encoder list, the hardware decoders,
// and a one-frame device check. The runner is injected, so the whole chain
// runs on a machine with no graphics card at all.
const probeCalls = [];
const fakeRunner = (deviceWorks) => (args, timeoutMs) => {
  const joined = args.join(' ');
  probeCalls.push({ joined, timeoutMs });
  if (joined.includes('-encoders')) {
    return Promise.resolve(' V....D h264_nvenc           NVIDIA NVENC H.264 encoder');
  }
  if (joined.includes('-hwaccels')) {
    return Promise.resolve('Hardware acceleration methods:\ncuda\nd3d11va\nqsv');
  }
  // The device check is the last thing the probe runs: a machine whose GPU
  // cannot encode fails here, and then no backend is offered.
  return deviceWorks ? Promise.resolve('') : Promise.reject(new Error('no device'));
};

const windowsProbe = await probeFfmpeg('fake', 'win32', fakeRunner(true));
assert.equal(windowsProbe.info.backend, 'nvenc', 'the NVENC encoder is picked up');
assert.equal(windowsProbe.info.backendLabel, 'NVIDIA NVENC');
assert.equal(windowsProbe.info.h264, true, 'a working backend means H.264 hardware encoding');
assert.ok(windowsProbe.encoders.includes('h264_nvenc'));

// A platform with no hardware backend gets none, whatever the binary claims.
const linuxProbe = await probeFfmpeg('fake', 'linux', fakeRunner(true));
assert.equal(linuxProbe.info.backend, null, 'there is no Linux backend yet');
assert.equal(linuxProbe.info.h264, false, 'no backend means no GPU switch');

// A binary that lists the encoder but cannot run it (no GPU, no driver) must
// not put a switch in front of the user.
const brokenProbe = await probeFfmpeg('fake', 'win32', fakeRunner(false));
assert.equal(brokenProbe.info.backend, null, 'a failing device check means no backend');
assert.equal(brokenProbe.info.h264, false);

// The real binary, probed the way the panel sees it: the encoder list comes
// out of the actual output, and a platform without a backend gets none.
const realProbe = await probeFfmpeg(ffmpeg, 'linux');
assert.ok(realProbe.encoders.includes('libx264'), 'the real encoder list is parsed');
assert.equal(realProbe.info.backend, null, 'a platform without a backend gets none');

// The device check starts a graphics driver, so it waits on its own clock:
// a driver that hangs must not hold the panel hostage.
const listCall = probeCalls.find((call) => call.joined.includes('-encoders'));
const deviceCall = probeCalls.find((call) => call.joined.includes('color='));
assert.ok(listCall && deviceCall, 'the probe asked for the encoder list and ran a device check');
assert.ok(listCall.timeoutMs >= 15000, 'the encoder list may wait for the binary');
assert.ok(
  deviceCall.timeoutMs < listCall.timeoutMs,
  `the device check waits on its own clock (${deviceCall.timeoutMs} < ${listCall.timeoutMs})`,
);

// The verdict lands in a later answer: the device check runs in the
// background, so the panel is never stuck behind a graphics driver.
let settled = (await call('status')).data;
for (let i = 0; i < 40 && settled.hardware.detecting; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  settled = (await call('status')).data;
}
assert.equal(settled.hardware.detecting, false, 'the device check finishes');
assert.equal(
  settled.hardware.h264,
  settled.hardware.backend !== null,
  'H.264 hardware encoding means a backend was found',
);
assert.ok(
  settled.hardware.backend === null || ['videotoolbox', 'nvenc', 'qsv', 'amf'].includes(settled.hardware.backend),
  'the settled backend is a known one',
);

// --- the hardware retry path ------------------------------------------------
// A GPU that cannot decode the file runs the same encoder once more with the
// software decoder. The attempt is injected, so the retry is checked on any
// host, with or without a graphics card.
const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-retry-'));
const retryOut = path.join(retryDir, 'out.mp4');
const hwPlan = {
  ext: 'mp4',
  kind: 'video',
  args: ['-c:v', 'h264_qsv'],
  inputArgs: ['-hwaccel', 'qsv'],
  hardware: true,
};
const swPlan = { ext: 'mp4', kind: 'video', args: ['-c:v', 'libx264'] };

// A software job runs once.
let swCalls = 0;
const swResult = await runJobAttempts(
  swPlan,
  async () => {
    swCalls += 1;
    return { ok: true, size: 10, error: '', ms: 5 };
  },
  retryOut,
  () => false,
);
assert.equal(swCalls, 1, 'a software job runs once');
assert.equal(swResult.ok, true);
assert.equal(swResult.tries, 1);

// A hardware job that fails runs again without the hardware decoder.
const hwCalls = [];
const hwResult = await runJobAttempts(
  hwPlan,
  async (plan) => {
    hwCalls.push(plan);
    return hwCalls.length === 1
      ? { ok: false, size: 0, error: 'no device', ms: 3 }
      : { ok: true, size: 42, error: '', ms: 9 };
  },
  retryOut,
  () => false,
);
assert.equal(hwCalls.length, 2, 'the failed hardware try is followed by a second one');
assert.deepEqual(hwCalls[0].inputArgs, ['-hwaccel', 'qsv'], 'the first try decodes on the GPU');
assert.equal(hwCalls[1].inputArgs, undefined, 'the second try decodes on the CPU');
assert.deepEqual(hwCalls[1].args, hwPlan.args, 'the encoder stays on the GPU');
assert.equal(hwResult.ok, true);
assert.equal(hwResult.size, 42);
assert.equal(hwResult.tries, 2);
assert.equal(hwResult.ms, 9, 'the time of the run that worked is the one that counts');

// Both tries fail: the last error is the one reported.
let failCalls = 0;
const failed = await runJobAttempts(
  hwPlan,
  async () => {
    failCalls += 1;
    return { ok: false, size: 0, error: `boom ${failCalls}`, ms: 1 };
  },
  retryOut,
  () => false,
);
assert.equal(failed.ok, false);
assert.equal(failed.error, 'boom 2', 'the error of the last try is reported');
assert.equal(failed.tries, 2, 'a hardware job tries twice before giving up');

// A cancel between the tries stops the job: no second run.
let cancelCalls = 0;
const cancelledRun = await runJobAttempts(
  hwPlan,
  async () => {
    cancelCalls += 1;
    return { ok: false, size: 0, error: 'cancelled', ms: 1 };
  },
  retryOut,
  () => cancelCalls >= 1,
);
assert.equal(cancelCalls, 1, 'a cancelled job does not start a second try');
assert.equal(cancelledRun.ok, false);

// The half-written output of a failed try is removed before the next one.
fs.writeFileSync(retryOut, 'junk');
await runJobAttempts(
  hwPlan,
  async () => ({ ok: false, size: 0, error: 'x', ms: 1 }),
  retryOut,
  () => false,
);
assert.ok(!fs.existsSync(retryOut), 'the failed output is removed before the next try');
fs.rmSync(retryDir, { recursive: true, force: true });

histCleanups.forEach((dispose) => dispose());

cleanups.forEach((dispose) => dispose());
// The disposer removes the temp copies it owns; a file registered by path is
// the user's own and must survive.
assert.ok(fs.existsSync(browseFile), 'a registered file is never deleted by the plugin');
assert.ok(fs.existsSync(nestedFile), 'a nested registered file is never deleted');
fs.rmSync(browseDir, { recursive: true, force: true });
fs.rmSync(ledgerDir, { recursive: true, force: true });
fs.rmSync(outDir, { recursive: true, force: true });
// --- a broken ffmpeg must not empty the panel --------------------------------
// An ffmpeg that cannot even list its encoders must leave the panel usable:
// the built-in format table is the fallback, and no GPU is offered. This
// instance runs last: the device check writes the instance's own verdict, and
// a stray one would only confuse the instances above.
const brokenRoutes = new Map();
const brokenOut = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-broken-'));
const brokenCleanups = [];
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? {
            getOrigin: () => 'http://127.0.0.1:65533',
            register: (route) => {
              brokenRoutes.set(route.path, route.handler);
              return () => brokenRoutes.delete(route.path);
            },
          }
        : key === 'connection'
          ? connection
          : undefined,
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => brokenCleanups.push(fn()),
  },
  // node itself is a perfectly executable file that answers nothing ffmpeg
  // would understand: the probe fails exactly as it would on a broken binary.
  { outputDir: brokenOut, ffmpegPath: process.execPath },
);
const brokenStatus = async () => {
  const res = makeRes();
  await brokenRoutes.get('/api/media-convert/status')(
    fakeReq({ method: 'GET', url: '/api/media-convert/status' }),
    res,
  );
  await res.done;
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
};
const brokenFirst = await brokenStatus();
assert.equal(brokenFirst.ok, true, JSON.stringify(brokenFirst));
assert.ok(brokenFirst.formats.video.length > 0, 'a broken ffmpeg keeps the built-in format table');
assert.ok(brokenFirst.formats.audio.length > 0, 'the audio formats survive too');
assert.ok(brokenFirst.formats.image.length > 0, 'the image formats survive too');
assert.equal(brokenFirst.hardware.h264, false, 'a broken ffmpeg offers no GPU');
assert.equal(brokenFirst.hardware.detecting, true, 'the device check is still running');

// The verdict lands in a later answer.
const brokenSecond = await brokenStatus();
assert.equal(brokenSecond.hardware.detecting, false, 'the verdict lands in a later answer');
assert.equal(brokenSecond.hardware.backend, null, 'a broken ffmpeg has no backend');
brokenCleanups.forEach((dispose) => dispose());
fs.rmSync(brokenOut, { recursive: true, force: true });

// --- a reloaded plugin must not wait for a probe that already ran ----------
// The device probe is cached per ffmpeg path, but the verdict belongs to the
// instance. A second instance — the plugin was disabled and enabled again —
// must adopt the cached verdict instead of reporting "still detecting"
// forever, which would hide the GPU switch for good.
const reloadRoutes = new Map();
const reloadOut = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-reload-'));
const reloadCleanups = [];
apply(
  {
    get: (key) =>
      key === 'webServer'
        ? {
            getOrigin: () => 'http://127.0.0.1:65533',
            register: (route) => {
              reloadRoutes.set(route.path, route.handler);
              return () => reloadRoutes.delete(route.path);
            },
          }
        : key === 'connection'
          ? connection
          : undefined,
    tools: { register: () => () => {} },
    settings: { configure: () => () => {}, update: async () => {} },
    effect: (fn) => reloadCleanups.push(fn()),
  },
  // The very path the broken instance above already probed: the cache is
  // warm, so this instance only has to adopt the verdict.
  { outputDir: reloadOut, ffmpegPath: process.execPath },
);
const reloadStatus = async () => {
  const res = makeRes();
  await reloadRoutes.get('/api/media-convert/status')(
    fakeReq({ method: 'GET', url: '/api/media-convert/status' }),
    res,
  );
  await res.done;
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
};
const reloadFirst = await reloadStatus();
assert.equal(reloadFirst.ok, true, JSON.stringify(reloadFirst));
assert.equal(reloadFirst.hardware.detecting, true, 'the first answer still reports the check');
const reloadSecond = await reloadStatus();
assert.equal(reloadSecond.hardware.detecting, false, 'a reloaded plugin adopts the cached verdict');
assert.equal(reloadSecond.hardware.backend, null, 'the adopted verdict is the one that was probed');
reloadCleanups.forEach((dispose) => dispose());
fs.rmSync(reloadOut, { recursive: true, force: true });

console.log('host.test.mjs: ok');
