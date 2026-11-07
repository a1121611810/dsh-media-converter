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
import { apply, inject, resolveGroups } from '../dist/index.js';
import { parseDuration } from '../dist/lib/plan.js';

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-out-'));
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
async function waitRun(run) {
  let current = run;
  for (let attempt = 0; attempt < 400 && current.state === 'running'; attempt += 1) {
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
assert.deepEqual(status.data.formats.image, ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif']);
if (!status.data.ffmpegPath) {
  // A silent skip is a green run that tested nothing; CI installs ffmpeg, so
  // missing it here is a broken environment, not a reason to pass.
  console.error('host.test.mjs: FAILED — no ffmpeg found (install ffmpeg or set FFMPEG_PATH)');
  process.exit(1);
}
const ffmpeg = status.data.ffmpegPath;

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

cleanups.forEach((dispose) => dispose());
fs.rmSync(outDir, { recursive: true, force: true });
console.log('host.test.mjs: ok');
