// The panel's pure helpers: formatting, timecodes, and the trim window.
// Kept DOM-free so they can be checked without a browser.
import assert from 'node:assert/strict';
import {
  CONVERTIBLE_KINDS,
  defaultTargets,
  formatClock,
  formatDuration,
  formatSize,
  isConvertible,
  parseTimecode,
  rowPlan,
  trimWindow,
  unavailableTarget,
} from '../dist/src/client/lib.js';

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

console.log('client-lib.test.mjs: ok');
