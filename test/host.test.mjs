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
import { apply } from '../index.js';
import { parseDuration } from '../lib/plan.js';

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-out-'));
const routes = new Map();
const webServer = {
  getOrigin: () => 'http://127.0.0.1:65533',
  register: (route) => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  },
};
const cleanups = [];
apply(
  {
    get: (key) => (key === 'webServer' ? webServer : undefined),
    effect: (fn) => cleanups.push(fn()),
  },
  { outputDir: outDir }
);

// Minimal IncomingMessage stand-in: the handlers only use method/url/headers and
// async iteration over the body.
function fakeReq({ method = 'GET', url = '/', body = null, origin = null } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = origin ? { origin } : {};
  return req;
}

async function call(route, options = {}) {
  const handler = routes.get('/api/media-convert/' + route.split('?')[0]);
  assert.ok(handler, `route ${route} registered`);
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(chunk) {
      this.body += chunk || '';
    },
  };
  await handler(fakeReq({ url: '/api/media-convert/' + route, ...options }), res);
  return { status: res.status, data: JSON.parse(res.body) };
}

// Streaming routes need a real writable response.
async function fetchBinary(route) {
  const handler = routes.get('/api/media-convert/' + route.split('?')[0]);
  assert.ok(handler, `route ${route} registered`);
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, done) {
      chunks.push(chunk);
      done();
    },
  });
  res.status = 0;
  res.headers = {};
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers || {};
  };
  const finished = new Promise((resolve) => res.on('finish', resolve));
  await handler(fakeReq({ url: '/api/media-convert/' + route }), res);
  await finished;
  res.body = Buffer.concat(chunks);
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

const status = await call('status');
assert.equal(status.data.ok, true);
assert.deepEqual(status.data.formats.image, ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif']);
if (!status.data.ffmpegPath) {
  console.log('host.test.mjs: skipped (no ffmpeg)');
  process.exit(0);
}
const ffmpeg = status.data.ffmpegPath;

// --- image: upload, convert, preview -------------------------------------
const sample = path.join(outDir, 'sample.png');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', sample]);

const upload = await call('upload?name=' + encodeURIComponent('../evil name.png'), { method: 'POST', body: fs.readFileSync(sample) });
assert.equal(upload.data.ok, true, JSON.stringify(upload.data));
assert.equal(upload.data.kind, 'image');
assert.equal(upload.data.name, 'evil name.png'); // basename wins, no traversal
assert.equal(upload.data.streams.video, true); // ffmpeg calls a still image a video stream

const converted = await call('convert', { method: 'POST', body: JSON.stringify({ id: upload.data.id, format: 'jpg', quality: 60 }) });
assert.equal(converted.data.ok, true, JSON.stringify(converted.data));
const imageJob = await waitJob(converted.data.job);
assert.equal(imageJob.kind, 'image');

const preview = await fetchBinary('preview?file=' + encodeURIComponent(imageJob.out));
assert.equal(preview.status, 200);
assert.equal(preview.headers['content-type'], 'image/jpeg');
assert.ok(preview.body.length > 0);

const previewOutside = await fetchBinary('preview?file=' + encodeURIComponent('/etc/hosts'));
assert.equal(previewOutside.status, 403);

const bad = await call('convert', { method: 'POST', body: JSON.stringify({ id: upload.data.id, format: 'mp4' }) });
assert.equal(bad.data.ok, false); // image sources have no mp4 target

// --- clip: trim, extract audio, extract video ----------------------------
const clip = path.join(outDir, 'clip.mp4');
execFileSync(ffmpeg, [
  '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-t', '2', '-i', 'testsrc=size=64x64:rate=10',
  '-f', 'lavfi', '-t', '2', '-i', 'sine=frequency=440',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip,
]);
const clipUpload = await call('upload?name=clip.mp4', { method: 'POST', body: fs.readFileSync(clip) });
assert.equal(clipUpload.data.kind, 'video');
assert.ok(Math.abs(clipUpload.data.duration - 2) < 0.3, `duration ${clipUpload.data.duration}`);
assert.deepEqual(clipUpload.data.streams, { video: true, audio: true, videoCodec: 'h264', audioCodec: 'aac', subtitles: [] });

const trimmed = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', trim: { start: 0.5, end: 1.5 } }),
});
assert.equal(trimmed.data.ok, true, JSON.stringify(trimmed.data));
assert.deepEqual(trimmed.data.job.trim, { start: 0.5, end: 1.5 });
const trimJob = await waitJob(trimmed.data.job);
const trimmedDuration = parseDuration(spawnSync(ffmpeg, ['-hide_banner', '-i', trimJob.out], { encoding: 'utf8' }).stderr);
assert.ok(Math.abs(trimmedDuration - 1) < 0.25, `trimmed duration ${trimmedDuration}`);

// An inverted window degrades to "no trim" rather than cutting a surprise range.
const inverted = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, format: 'mp4', trim: { start: 1.5, end: 0.5 } }),
});
assert.equal(inverted.data.job.trim, null);

const audioOnly = await call('convert', { method: 'POST', body: JSON.stringify({ id: clipUpload.data.id, mode: 'extract-audio' }) });
assert.equal(audioOnly.data.ok, true, JSON.stringify(audioOnly.data));
const audioJob = await waitJob(audioOnly.data.job);
assert.equal(audioJob.kind, 'audio');
assert.equal(path.extname(audioJob.out), '.m4a');
const audioProbe = spawnSync(ffmpeg, ['-hide_banner', '-i', audioJob.out], { encoding: 'utf8' }).stderr;
assert.match(audioProbe, /Audio: aac/);
assert.doesNotMatch(audioProbe, /Video:/);

const videoOnly = await call('convert', { method: 'POST', body: JSON.stringify({ id: clipUpload.data.id, mode: 'extract-video' }) });
assert.equal(videoOnly.data.ok, true, JSON.stringify(videoOnly.data));
const videoJob = await waitJob(videoOnly.data.job);
assert.equal(videoJob.kind, 'video');
assert.equal(path.extname(videoJob.out), '.mp4');
const videoProbe = spawnSync(ffmpeg, ['-hide_banner', '-i', videoJob.out], { encoding: 'utf8' }).stderr;
assert.match(videoProbe, /Video: h264/);
assert.doesNotMatch(videoProbe, /Audio:/);

// Extracting from a file without the track reports it instead of failing oddly.
const still = await call('convert', { method: 'POST', body: JSON.stringify({ id: upload.data.id, mode: 'extract-video' }) });
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

const decodedText = await call('decode', { method: 'POST', body: JSON.stringify({ text: Buffer.from('你好，世界').toString('base64') }) });
assert.equal(decodedText.data.ok, true);
assert.deepEqual({ kind: decodedText.data.kind, text: decodedText.data.text }, { kind: 'text', text: '你好，世界' });

const badDecode = await call('decode', { method: 'POST', body: JSON.stringify({ text: '%%%' }) });
assert.equal(badDecode.data.ok, false);

// --- subtitle tracks and container metadata -----------------------------
const srtPath = path.join(outDir, 'sub.srt');
fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:01,500\n你好，世界\n\n');
const subbed = path.join(outDir, 'subbed.mkv');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', clip, '-i', srtPath, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'srt', '-metadata:s:s:0', 'language=chi', subbed]);
const subUpload = await call('upload?name=subbed.mkv', { method: 'POST', body: fs.readFileSync(subbed) });
assert.equal(subUpload.data.meta.subtitles.length, 1, JSON.stringify(subUpload.data.meta.subtitles));
assert.equal(subUpload.data.meta.subtitles[0].language, 'chi');
assert.ok(subUpload.data.meta.video.width > 0, 'video width parsed');
assert.match(subUpload.data.meta.format, /matroska/);

const subJob = await call('convert', { method: 'POST', body: JSON.stringify({ id: subUpload.data.id, mode: 'subtitle', stream: 0 }) });
assert.equal(subJob.data.ok, true, JSON.stringify(subJob.data));
const doneSub = await waitJob(subJob.data.job);
assert.ok(doneSub.out.endsWith('.chi.srt'), doneSub.out);
assert.match(fs.readFileSync(doneSub.out, 'utf8'), /你好，世界/);

const metaJob = await call('convert', {
  method: 'POST',
  body: JSON.stringify({ id: clipUpload.data.id, mode: 'meta', tags: { title: '片头测试', artist: '小火山', album: '' } }),
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
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-t', '1', '-i', 'sine=frequency=440', '-c:a', 'aac', audioSrc]);
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
const brokenJob = await call('convert', { method: 'POST', body: JSON.stringify({ id: broken.data.id, format: 'mp4' }) });
let brokenState = brokenJob.data.job;
for (let attempt = 0; attempt < 100 && brokenState.state === 'running'; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  brokenState = (await call('job?id=' + brokenState.id)).data;
}
assert.equal(brokenState.state, 'error');
assert.equal(fs.existsSync(brokenState.out), false, 'failed job leaves no output');
assert.ok(brokenState.error.length > 0);

cleanups.forEach((dispose) => dispose());
fs.rmSync(outDir, { recursive: true, force: true });
console.log('host.test.mjs: ok');
