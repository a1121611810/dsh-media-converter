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
  runSummary,
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
  upsertPresetPack,
  allowedBridgeCall,
  bridgeReplyOf,
  isBridgeMessage,
  isExpectedSource,
  makeNonce,
  preambleOf,
  presetExtrasUnsupported,
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

// A finished batch's summary line counts terminal item states only; the
// rebuilt panel shows it inside a freshness window keyed off the server stamp.
assert.deepEqual(
  runSummary([
    { state: 'done' },
    { state: 'done' },
    { state: 'error' },
    { state: 'skipped' },
    { state: 'cancelled' },
    { state: 'waiting' },
  ]),
  { done: 2, failed: 1, skipped: 1, cancelled: 1 },
  'waiting items are not terminal and must not count',
);
assert.deepEqual(runSummary([]), { done: 0, failed: 0, skipped: 0, cancelled: 0 }, 'an empty batch sums to zero');

console.log('client-lib.test.mjs: ok');

// --- save-as-preset: reserved per-kind manifest merge (R2) -------------------
const savedFirst = upsertPresetPack([], 'video', 'web-compress', { format: 'webp', quality: 60, width: 1080 });
assert.equal(savedFirst.ok, true);
if (savedFirst.ok) {
  assert.equal(savedFirst.ref, 'x:user-presets-video/web-compress');
  assert.equal(savedFirst.packs.length, 1);
  const manifest = savedFirst.packs[0];
  assert.equal(manifest.version, 1);
  assert.equal(manifest.id, 'user-presets-video');
  assert.equal(manifest.actions.length, 1);
  assert.deepEqual(manifest.actions[0].params, { format: 'webp', quality: 60, width: 1080 });
}
// CJK 名生成稳定 id（p+base36），ref 形态不变。
const savedCjk = upsertPresetPack([], 'video', '网页压缩', { format: 'mp4' });
assert.equal(savedCjk.ok, true);
if (savedCjk.ok) {
  assert.match(savedCjk.ref, /^x:user-presets-video\/p[0-9a-z]+$/);
  assert.equal(savedCjk.packs[0].actions[0].label.zh, '网页压缩');
}
// 同名再存 = 覆盖而不是追加；异名追加到同一 manifest。
const rawOf = (result) => (result.ok ? result.packs.map((pack) => JSON.stringify(pack)) : []);
const overwrite = upsertPresetPack(rawOf(savedFirst), 'video', 'web-compress', { format: 'jpg', quality: 70 });
assert.equal(overwrite.ok, true);
if (overwrite.ok) {
  const manifest = overwrite.packs.find((pack) => pack.id === 'user-presets-video');
  assert.equal(manifest.actions.length, 1, '同名覆盖不追加');
  assert.equal(manifest.actions[0].params.format, 'jpg');
}
const appendMore = upsertPresetPack(rawOf(overwrite), 'video', 'archive', { format: 'mkv', codec: 'hevc' });
assert.equal(appendMore.ok, true);
if (appendMore.ok) {
  const manifest = appendMore.packs.find((pack) => pack.id === 'user-presets-video');
  assert.equal(manifest.actions.length, 2);
  assert.equal(manifest.actions[1].params.codec, 'hevc', '宏携带软件编码选择');
}
// 类型分库：音频预设进自己的 manifest。
const audioSaved = upsertPresetPack(rawOf(appendMore), 'audio', 'voice-mono', {
  format: 'mp3',
  channels: 1,
  sampleRate: 22050,
});
assert.equal(audioSaved.ok, true);
if (audioSaved.ok) {
  assert.equal(audioSaved.packs.length, 2, '音频预设另起 manifest');
  assert.ok(audioSaved.packs.some((pack) => pack.id === 'user-presets-audio'));
}
// 负形态：坏 JSON、空名、非法类型、满员。
const broken = upsertPresetPack(['{"version":1'], 'video', 'x', { format: 'mp4' });
assert.equal(broken.ok, false);
assert.match(broken.error, /扩展开源数据损坏/);
assert.equal(upsertPresetPack([], 'video', '   ', { format: 'mp4' }).ok, false, '空名拒绝');
assert.equal(upsertPresetPack([], 'text', 'x', { format: 'mp4' }).ok, false, '非媒体类型拒绝');
const full = Array.from({ length: 16 }, (_, i) => ({
  id: `p${i}`,
  type: 'macro',
  kind: 'image',
  label: { zh: `p${i}`, en: `p${i}` },
  params: { format: 'jpg' },
}));
const fullRaw = [JSON.stringify({ version: 1, id: 'user-presets-image', name: { zh: 'x', en: 'x' }, actions: full })];
const tooMany = upsertPresetPack(fullRaw, 'image', 'one-more', { format: 'jpg' });
assert.equal(tooMany.ok, false, '满 16 拒绝追加');
assert.match(tooMany.error, /已满/);
console.log('client-lib: 存预设用例 ok');

// --- extension page bridge（R6，第 3 期）-------------------------------------
// 桥是纯函数的信任链：形状/令牌/路径/体积累积逐一断言，突变注入时
// 必须在这里转红（mutation-check G 家族的防线就在这些断言上）。
const ok = (actual, expected, what) => assert.deepEqual(actual, expected, what);
const TOKEN = 'nonce123';
const bridgeMsg = (patch) => ({
  __mc: 1,
  token: TOKEN,
  id: 1,
  method: 'GET',
  path: '/api/media-convert/status',
  ...patch,
});
ok(isBridgeMessage(bridgeMsg(), TOKEN), true, '桥消息合法');
ok(isBridgeMessage(bridgeMsg({ token: 'forged-nonce' }), TOKEN), false, 'token 错配拒');
ok(isBridgeMessage(bridgeMsg({ token: 123 }), TOKEN), false, 'token 非字符串拒');
ok(isBridgeMessage(bridgeMsg({ id: 0 }), TOKEN), false, 'id 0 拒');
ok(isBridgeMessage(bridgeMsg({ id: -3 }), TOKEN), false, 'id 负拒');
ok(isBridgeMessage(bridgeMsg({ id: 1.5 }), TOKEN), false, 'id 非整数拒');
ok(isBridgeMessage(bridgeMsg({ method: 'PUT' }), TOKEN), false, 'method 拒');
ok(isBridgeMessage(bridgeMsg({ method: 'get' }), TOKEN), false, 'method 大小写拒');
ok(isBridgeMessage(bridgeMsg({ path: '/api/other/x' }), TOKEN), false, '外部路径拒');
ok(isBridgeMessage(bridgeMsg({ path: '/api/media-convert-evil/x' }), TOKEN), false, '前缀仿冒路径拒');
ok(isBridgeMessage(bridgeMsg({ path: '/api/media-convert' }), TOKEN), false, '无尾斜杠拒');
ok(isBridgeMessage(bridgeMsg({ path: '../api/media-convert/status' }), TOKEN), false, '相对路径拒');
ok(isBridgeMessage(bridgeMsg({ path: 42 }), TOKEN), false, 'path 非字符串拒');
ok(isBridgeMessage(bridgeMsg({ __mc: 2 }), TOKEN), false, '__mc 拒');
ok(isBridgeMessage(null, TOKEN), false, 'null 拒');
ok(isBridgeMessage('msg', TOKEN), false, '字符串拒');
ok(isBridgeMessage([bridgeMsg()], TOKEN), false, '数组拒');
{
  const get = allowedBridgeCall(bridgeMsg());
  ok(get.ok, true, 'GET 放行');
  ok(get.method, 'GET', 'GET method');
  ok(get.body, undefined, 'GET 无 body');
  const post = allowedBridgeCall(
    bridgeMsg({ id: 2, method: 'POST', path: '/api/media-convert/config', body: { a: 1 } }),
  );
  ok(post.ok, true, 'POST 放行');
  ok(post.body, '{"a":1}', 'POST body 序列化');
  const noBody = allowedBridgeCall(bridgeMsg({ method: 'POST', body: undefined }));
  ok(noBody.ok, true, 'POST 无 body 放行');
  ok(noBody.body, 'null', 'POST 无 body 序列化为 null');
  // 边界用绝对字面量而不是 BRIDGE_MAX_BODY 推导：测试的期望必须与常数
  // 无关，突变把上限改大时这些用例才会真的转红（mutation-check G6 的防线）。
  const big = allowedBridgeCall(bridgeMsg({ method: 'POST', body: { x: 'y'.repeat(1048576) } }));
  ok(big.ok, false, 'body 超限拒');
  const at = allowedBridgeCall(bridgeMsg({ method: 'POST', body: { x: 'y'.repeat(1048566) } }));
  ok(at.ok, true, 'body 边界内放行');
}
{
  const win = { name: 'iframe' };
  ok(isExpectedSource(win, win), true, '同源对象放行');
  ok(isExpectedSource({}, win), false, '不同对象拒');
  ok(isExpectedSource(null, null), false, 'null===null 也拒');
  ok(isExpectedSource('mc-forged-source', win), false, '伪造源字面量拒');
}
ok(
  bridgeReplyOf(7, { ok: true, status: 200, json: { a: 1 } }),
  { __mc: 1, id: 7, ok: true, status: 200, json: { a: 1 } },
  '成功封套',
);
ok(bridgeReplyOf(7, { ok: false, error: 'nope' }), { __mc: 1, id: 7, ok: false, error: 'nope' }, '失败封套');
{
  const n1 = makeNonce();
  const n2 = makeNonce();
  assert.notEqual(n1, n2, 'nonce 唯一');
  assert.ok(n1.length >= 8, 'nonce 长度');
  ok(preambleOf(TOKEN).includes(JSON.stringify(TOKEN)), true, '前导脚本含 nonce');
  ok(preambleOf(TOKEN).includes('mcBridge'), true, '前导脚本含桥');
  ok(preambleOf(TOKEN).includes('</script>'), true, '前导脚本自闭合');
  assert.notEqual(preambleOf(n1), preambleOf(n2), '不同 nonce 不同前导');
}
console.log('client-lib: 扩展页桥用例 ok');

// --- preset save guard（评审修复）--------------------------------------------
// 判别力：真值八条逐一带 + 假值四条（rotate:0 / speed:1 / 空串 / 全 undefined）——
// 缺了假值组，「恒 true」的坏实现照样绿（mutation-check G10 就是打这个）。
ok(presetExtrasUnsupported({}), false, '全缺省不拦截');
ok(presetExtrasUnsupported({ crop: '640:360' }), true, 'crop 拦截');
ok(presetExtrasUnsupported({ rotate: 90 }), true, 'rotate 拦截');
ok(presetExtrasUnsupported({ flip: 'h' }), true, 'flip 拦截');
ok(presetExtrasUnsupported({ remux: true }), true, 'remux 拦截');
ok(presetExtrasUnsupported({ speed: 2 }), true, 'speed 拦截');
ok(presetExtrasUnsupported({ loudnorm: true }), true, 'loudnorm 拦截');
ok(presetExtrasUnsupported({ watermarkText: 'x' }), true, '水印拦截');
ok(presetExtrasUnsupported({ burn: true }), true, '烧录拦截');
ok(presetExtrasUnsupported({ rotate: 0 }), false, 'rotate 0 不拦截');
// 契约边界：helper 只判「存在性」，各旋钮的中性值由调用方归一成 undefined
//（App.vue 已把 speed!==1 才传入）；所以 speed:1 在 helper 层面算「有值」。
ok(presetExtrasUnsupported({ speed: 1 }), true, 'speed 1 由调用方归一化，helper 只看存在性');
ok(presetExtrasUnsupported({ speed: undefined, loudnorm: undefined }), false, 'undefined 不拦截');
ok(presetExtrasUnsupported({ watermarkText: '' }), false, '空串不拦截');
console.log('client-lib: 预设拦截用例 ok');
