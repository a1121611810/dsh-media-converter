// The panel's pure helpers: formatting, timecodes, and the trim window.
// Kept DOM-free so they can be checked without a browser.
import assert from 'node:assert/strict';
import {
  CONVERTIBLE_KINDS,
  defaultTargets,
  fitPreview,
  formatClock,
  formatDuration,
  formatSize,
  isConvertible,
  parseTimecode,
  jobPatch,
  previewMime,
  rowPlan,
  runItemPatch,
  trimWindow,
  withoutKnownUploads,
  unavailableTarget,
  sourceUrl,
  supportsAudioTune,
  supportsBitrate,
  supportsQuality,
  removeUploadRow,
  extensionActionItems,
  presetTargetsFor,
} from '../dist/src/client/lib.js';

// --- extension packs: pure projections of the /status payload -----------------
const packs = [
  {
    id: 'wechat-image',
    name: { zh: '微信图', en: 'WeChat image' },
    raw: '{"version":1}',
    actions: [
      {
        ref: 'x:wechat-image/wx-webp',
        type: 'macro',
        kind: 'image',
        label: { zh: '微信压缩图', en: 'WeChat compress' },
        format: 'webp',
      },
    ],
  },
  {
    id: 'slow-mp4',
    name: { zh: '慢速 MP4', en: 'Slow MP4' },
    raw: '{"version":1}',
    actions: [
      {
        ref: 'x:slow-mp4/x265',
        type: 'recipe',
        kind: 'video',
        label: { zh: 'x265 慢速', en: 'x265 slow' },
        format: 'mp4',
      },
      {
        ref: 'x:slow-mp4/wx-audio',
        type: 'macro',
        kind: 'audio',
        label: { zh: '语音', en: 'Voice' },
        format: 'mp3',
      },
    ],
  },
];
const zh = (l) => l.zh;
assert.deepEqual(extensionActionItems(packs, 'image', zh), [
  { id: 'x:wechat-image/wx-webp', label: '微信压缩图', hint: '微信图', format: 'webp' },
]);
// Recipes add no tile; other kinds stay out.
assert.deepEqual(extensionActionItems(packs, 'video', zh), []);
assert.deepEqual(extensionActionItems(undefined, 'image', zh), []);
assert.equal(extensionActionItems(packs, 'audio', (l) => l.en)[0].label, 'Voice');
assert.deepEqual(presetTargetsFor(packs, 'image'), ['x:wechat-image/wx-webp']);
assert.deepEqual(presetTargetsFor(packs, 'video'), []);
assert.deepEqual(presetTargetsFor(undefined, 'audio'), []);

assert.deepEqual(fitPreview(4000, 3000), { width: 900, height: 675 });
assert.deepEqual(fitPreview(300, 200), { width: 300, height: 200 });
assert.deepEqual(fitPreview(6000, 9000, 128), { width: 85, height: 128 });
assert.equal(previewMime('jpg'), 'image/jpeg');
assert.equal(previewMime('webp'), 'image/webp');
assert.equal(previewMime('gif'), 'image/png');

// Mirror of the Host's supportsQuality: the quality slider shows for exactly
// these lossy targets.
assert.equal(supportsQuality('image', 'jpg'), true);
assert.equal(supportsQuality('image', 'webp'), true);
assert.equal(supportsQuality('image', 'avif'), true);
assert.equal(supportsQuality('image', 'png'), false);
assert.equal(supportsQuality('video', 'mp4'), true);
assert.equal(supportsQuality('video', 'mkv'), true);
assert.equal(supportsQuality('video', 'webm'), true);
assert.equal(supportsQuality('video', 'avi'), true);
assert.equal(supportsQuality('video', 'wmv'), true);
assert.equal(supportsQuality('video', 'ogv'), true);
assert.equal(supportsQuality('video', 'gif'), false);
assert.equal(supportsQuality('audio', 'mp3'), false);

// Mirror of the Host's supportsBitrate: the bitrate select shows for exactly
// these lossy audio targets, a video file's mp3/m4a target included.
assert.equal(supportsBitrate('audio', 'mp3'), true);
assert.equal(supportsBitrate('audio', 'm4a'), true);
assert.equal(supportsBitrate('audio', 'opus'), true);
assert.equal(supportsBitrate('audio', 'ogg'), false);
assert.equal(supportsBitrate('audio', 'flac'), false);
assert.equal(supportsBitrate('video', 'mp3'), true);
assert.equal(supportsBitrate('video', 'm4a'), true);
assert.equal(supportsBitrate('video', 'aac'), false);
assert.equal(supportsBitrate('video', 'mp4'), false);
assert.equal(supportsBitrate('image', 'jpg'), false);

// Mirror of the Host's supportsAudioTune: the channel/rate selects show for
// exactly these audio-encode targets.
assert.equal(supportsAudioTune('audio', 'mp3'), true);
assert.equal(supportsAudioTune('audio', 'wav'), true);
assert.equal(supportsAudioTune('video', 'mp3'), true);
assert.equal(supportsAudioTune('video', 'm4a'), true);
assert.equal(supportsAudioTune('video', 'mp4'), false);
assert.equal(supportsAudioTune('video', 'aac'), false);
assert.equal(supportsAudioTune('image', 'jpg'), false);

// removeUploadRow: the async core of 移除. The race case is the point — two
// overlapping clicks, the later one resolving after the first was applied,
// must drop nothing.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const rowA = { key: 'a', upload: { id: 'ua' } };
const rowB = { key: 'b', upload: { id: 'ub' } };
const okAnswer = { ok: true, removed: 1, skipped: [] };

// The double click, deterministically: second click lands before the first
// request resolves; the first result is applied; the late second resolution
// must find the row already gone. A captured-index implementation would drop
// the neighbour here and fail the last two asserts.
{
  let live = [rowA, rowB];
  const first = deferred();
  const second = deferred();
  const calls = [];
  const del = (d) => (id) => {
    calls.push(id);
    return d.promise;
  };
  const p1 = removeUploadRow(() => live, 'a', del(first));
  const p2 = removeUploadRow(() => live, 'a', del(second));
  first.resolve(okAnswer);
  const r1 = await p1;
  live = r1.rows; // the panel applies the first result
  assert.equal(r1.removed, rowA);
  assert.deepEqual(
    live.map((r) => r.key),
    ['b'],
  );
  second.resolve({ ok: true, removed: 0, skipped: [] }); // the Host treats the second delete as a no-op
  const r2 = await p2;
  live = r2.rows;
  assert.equal(r2.removed, null, 'the late second click drops nothing');
  assert.deepEqual(
    live.map((r) => r.key),
    ['b'],
    'the neighbour survives the double click',
  );
  assert.deepEqual(calls, ['ua', 'ua']);
}

// A running job keeps the row, flagged as skipped.
{
  let live = [rowA, rowB];
  const r = await removeUploadRow(
    () => live,
    'a',
    async () => ({ ok: true, removed: 0, skipped: ['ua'] }),
  );
  assert.equal(r.removed, null);
  assert.equal(r.skipped, true);
  assert.equal(r.error, null);
  assert.deepEqual(
    r.rows.map((row) => row.key),
    ['a', 'b'],
  );
}

// A rejected request keeps the row and reports why.
{
  let live = [rowA, rowB];
  const r = await removeUploadRow(
    () => live,
    'a',
    async () => {
      throw new Error('网络错误');
    },
  );
  assert.equal(r.removed, null);
  assert.match(r.error, /网络错误/);
  assert.deepEqual(
    r.rows.map((row) => row.key),
    ['a', 'b'],
  );
}

// An explicit !ok answer surfaces its message.
{
  let live = [rowA, rowB];
  const r = await removeUploadRow(
    () => live,
    'a',
    async () => ({ ok: false, error: 'unauthorized' }),
  );
  assert.equal(r.error, 'unauthorized');
  assert.deepEqual(
    r.rows.map((row) => row.key),
    ['a', 'b'],
  );
}

// Unknown key: no-op, no error, and the injected delete is never consulted.
{
  let live = [rowA, rowB];
  const r = await removeUploadRow(
    () => live,
    'zzz',
    async () => {
      throw new Error('must not be called');
    },
  );
  assert.equal(r.removed, null);
  assert.equal(r.error, null);
  assert.equal(r.skipped, false);
  assert.deepEqual(
    r.rows.map((row) => row.key),
    ['a', 'b'],
  );
}

// serverDelete null (force/abort path): local-only, no request.
{
  let live = [rowA, rowB];
  const r = await removeUploadRow(() => live, 'a', null);
  assert.equal(r.removed, rowA);
  assert.deepEqual(
    r.rows.map((row) => row.key),
    ['b'],
  );
}

assert.equal(formatSize(0), '');
assert.equal(formatSize(512), '512 B');
assert.equal(formatSize(2048), '2 KB');
assert.equal(formatSize(5 * 1048576), '5.0 MB');
assert.equal(formatSize(3 * 1073741824), '3.00 GB');

assert.equal(formatDuration(0), '');
assert.equal(formatDuration(65), '1:05');
assert.equal(formatClock(0), '0:00');
assert.equal(formatClock(9.5), '0:09.5');
assert.equal(formatClock(61), '1:01');
assert.equal(formatClock(-3), '0:00');

assert.equal(parseTimecode(''), null);
assert.equal(parseTimecode('12'), 12);
assert.equal(parseTimecode('1:05'), 65);
assert.equal(parseTimecode('0:01.5'), 1.5);
assert.equal(parseTimecode('00:00:12'), 12);
assert.ok(Number.isNaN(parseTimecode('abc')));
assert.ok(Number.isNaN(parseTimecode('1:2:3:4')));

const t = (key) => key;
const video = { kind: 'video', duration: 10, streams: { video: true, audio: false } };

// An empty pair means the whole clip, not an error.
assert.deepEqual(trimWindow({ file: video, trimStart: '', trimEnd: '', t }), {
  active: false,
  start: 0,
  end: 10,
  error: '',
});
assert.deepEqual(trimWindow({ file: video, trimStart: '2', trimEnd: '5', t }), {
  active: true,
  start: 2,
  end: 5,
  error: '',
});
// An inverted or over-long window is refused instead of cutting a surprise range.
assert.equal(trimWindow({ file: video, trimStart: '5', trimEnd: '2', t }).error, 'trim.order');
assert.equal(trimWindow({ file: video, trimStart: '0', trimEnd: '99', t }).error, 'trim.over');
assert.equal(trimWindow({ file: { kind: 'image' }, trimStart: '', trimEnd: '', t }).active, false);

// A silent video cannot produce an audio-only file.
assert.equal(unavailableTarget(video, 'mp3'), true);
assert.equal(unavailableTarget({ ...video, streams: { video: true, audio: true } }, 'mp3'), false);
assert.equal(unavailableTarget(video, 'mp4'), false);

// --- per-kind batch targets ----------------------------------------------
const table = {
  video: ['mp4', 'mp3', 'm4a'],
  audio: ['mp3', 'm4a'],
  image: ['png', 'jpg'],
};
assert.deepEqual([...CONVERTIBLE_KINDS], ['video', 'audio', 'image']);
assert.equal(isConvertible('video'), true);
assert.equal(isConvertible('text'), false);
assert.deepEqual(defaultTargets(table), { video: 'mp4', audio: 'mp3', image: 'png' });

const rows = [
  { key: 'a', kind: 'video', streams: { video: true, audio: true } },
  { key: 'b', kind: 'image', streams: { video: true, audio: false } },
  { key: 'c', kind: 'video', streams: { video: true, audio: false } },
];
assert.deepEqual(rowPlan(rows, { video: 'mp3', audio: 'mp3', image: 'png' }), [
  { key: 'a', target: 'mp3', error: '' },
  { key: 'b', target: 'png', error: '' },
  { key: 'c', target: 'mp3', error: 'hint.noAudio' },
]);
// A silent video converting to a video format is fine.
assert.deepEqual(rowPlan([rows[2]], { video: 'mp4', audio: 'mp3', image: 'png' }), [
  { key: 'c', target: 'mp4', error: '' },
]);
// A per-row target overrides the group default; other rows keep it.
assert.deepEqual(rowPlan(rows, { video: 'mp4', audio: 'mp3', image: 'png' }, { b: 'jpg', c: 'mp4' }), [
  { key: 'a', target: 'mp4', error: '' },
  { key: 'b', target: 'jpg', error: '' },
  { key: 'c', target: 'mp4', error: '' },
]);

// --- server queue -----------------------------------------------------------
// Rows are rebuilt from the server, so the only client-side helper left is the
// upload preview URL.
assert.equal(sourceUrl('u abc'), '/api/media-convert/source?id=u%20abc');
// The restored row's preview URL points at the server copy of the upload.
assert.equal(sourceUrl('u abc'), '/api/media-convert/source?id=u%20abc');

// --- server job reconciliation ----------------------------------------------
// A rebuilt page trusts the server's job record over its own snapshot.
const serverJob = (patch) => ({
  id: 'j1',
  uploadId: 'uabc',
  state: 'running',
  percent: null,
  out: '/out/x.mp4',
  size: 10,
  error: null,
  kind: 'video',
  copy: false,
  hardware: false,
  ...patch,
});

// A running job always re-attaches, whatever the snapshot said.
assert.deepEqual(jobPatch('ready', serverJob({ percent: 42 })), {
  state: 'converting',
  percent: 42,
  error: '',
  jobId: 'j1',
  attach: true,
});
assert.equal(jobPatch('converting', serverJob({ state: 'cancelling' })).state, 'cancelling');

// A finished job updates a row that was itself mid-run when the snapshot was
// taken (the page went away before it saw the result).
assert.deepEqual(jobPatch('converting', serverJob({ state: 'done', size: 33 })), {
  state: 'done',
  percent: 100,
  error: '',
  result: { file: '/out/x.mp4', size: 33, kind: 'video', copy: false, hardware: false },
});
assert.deepEqual(jobPatch('cancelling', serverJob({ state: 'error', error: 'boom' })), {
  state: 'error',
  percent: null,
  error: 'boom',
});
assert.deepEqual(jobPatch('converting', serverJob({ state: 'cancelled' })), {
  state: 'cancelled',
  percent: null,
});

// A row the user reset stays reset: an old result must not reappear.
assert.equal(jobPatch('ready', serverJob({ state: 'done' })), null);
assert.equal(jobPatch('done', serverJob({ state: 'done' })), null);

// --- uploaded rows already on screen ----------------------------------------
// Adding the same folder twice must not duplicate rows: the Host returns the
// same upload ids, and the panel keeps one row per id.
const onScreen = [{ upload: { id: 'a' } }, { upload: null }];
assert.deepEqual(
  withoutKnownUploads(onScreen, [{ id: 'a' }, { id: 'b' }]).map((upload) => upload.id),
  ['b'],
);
assert.deepEqual(
  withoutKnownUploads([], [{ id: 'a' }]).map((upload) => upload.id),
  ['a'],
);
assert.deepEqual(withoutKnownUploads(onScreen, []), []);

// --- run items (the Host-owned batch) ---------------------------------------
// One batch item as GET /run returns it.
const runItem = (patch) => ({
  id: 'uabc',
  mode: '',
  format: 'jpg',
  state: 'waiting',
  percent: null,
  jobId: '',
  error: '',
  result: null,
  ...patch,
});

// The batch's queue is an ordinary ready row, and an earlier result or error
// is dropped: this row is about to be converted again.
assert.deepEqual(runItemPatch(runItem({})), {
  state: 'ready',
  percent: null,
  error: '',
  jobAction: '',
  result: null,
});
// A skipped row keeps the panel's own locale key, so the reason survives a
// rebuilt page and reads in the user's language.
assert.deepEqual(runItemPatch(runItem({ state: 'skipped', error: 'hint.noAudio' })), {
  state: 'skipped',
  percent: null,
  error: 'hint.noAudio',
  jobAction: '',
  result: null,
});
assert.deepEqual(runItemPatch(runItem({ state: 'converting', percent: 42 })), {
  state: 'converting',
  percent: 42,
  error: '',
  jobAction: '',
  result: null,
});
const runDone = { file: '/out/x.jpg', size: 9, kind: 'image', copy: false, hardware: false };
assert.deepEqual(runItemPatch(runItem({ state: 'done', percent: 100, jobId: 'j2', result: runDone })), {
  state: 'done',
  percent: 100,
  error: '',
  jobAction: 'batch',
  result: runDone,
});
assert.deepEqual(runItemPatch(runItem({ state: 'error', error: 'boom' })), {
  state: 'error',
  percent: null,
  error: 'boom',
  jobAction: '',
  result: null,
});
assert.deepEqual(runItemPatch(runItem({ state: 'cancelled' })), {
  state: 'cancelled',
  percent: null,
  error: '',
  jobAction: '',
  result: null,
});

console.log('client-lib.test.mjs: ok');
