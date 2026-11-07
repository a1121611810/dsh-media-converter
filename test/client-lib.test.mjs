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
} from '../dist/src/client/lib.js';

assert.deepEqual(fitPreview(4000, 3000), { width: 900, height: 675 });
assert.deepEqual(fitPreview(300, 200), { width: 300, height: 200 });
assert.deepEqual(fitPreview(6000, 9000, 128), { width: 85, height: 128 });
assert.equal(previewMime('jpg'), 'image/jpeg');
assert.equal(previewMime('webp'), 'image/webp');
assert.equal(previewMime('gif'), 'image/png');

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
