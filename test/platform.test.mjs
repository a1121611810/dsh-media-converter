// The platform rules the Windows support rests on. Everything here is pure,
// so the Windows branches are checked from any host.
import assert from 'node:assert/strict';
import {
  renderNameTemplate,
  binaryNames,
  expandDirs,
  ffmpegCandidates,
  hardwareBackendsFor,
  imageioPatterns,
  isInsideDir,
  pickBackend,
  probeCandidates,
  revealCommand,
  safeBaseName,
} from '../dist/lib/platform.js';
import { probeFfmpegDevice } from '../dist/index.js';

// --- ffmpeg discovery ------------------------------------------------------
assert.deepEqual(binaryNames('win32'), ['ffmpeg.exe']);
assert.deepEqual(binaryNames('darwin'), ['ffmpeg']);

const win = ffmpegCandidates({
  platform: 'win32',
  configured: 'C:\\tools\\ffmpeg',
  env: { PATH: 'C:\\ffmpeg\\bin;C:\\Windows', FFMPEG_PATH: 'D:\\media\\ffmpeg.exe' },
  home: 'C:\\Users\\me',
});
assert.equal(win[0], 'C:\\tools\\ffmpeg', 'the configured path comes first');
assert.ok(win.includes('C:\\tools\\ffmpeg.exe'), 'a Windows path without a suffix still names the binary');
assert.ok(win.includes('D:\\media\\ffmpeg.exe'), 'FFMPEG_PATH is used');
assert.ok(win.includes('C:\\ffmpeg\\bin\\ffmpeg.exe'), 'PATH lookup uses the exe name');
assert.ok(!win.includes('C:\\ffmpeg\\bin\\ffmpeg'), 'PATH is split on the Windows separator');

const mac = ffmpegCandidates({ platform: 'darwin', configured: '', env: { PATH: '/usr/bin:/bin' }, home: '/Users/me' });
assert.ok(mac.includes('/usr/bin/ffmpeg'));
assert.ok(mac.includes('/opt/homebrew/bin/ffmpeg'));
assert.ok(mac.includes('/usr/local/bin/ffmpeg'));
assert.ok(!mac.some((candidate) => candidate.endsWith('.exe')), 'no exe suffix off Windows');

// --- ffprobe discovery -----------------------------------------------------
// Full installs ship ffprobe next to ffmpeg, so that sibling wins and then
// the same scan ffmpeg gets; FFMPEG_PATH names ffmpeg and is not consulted.
assert.deepEqual(binaryNames('win32', 'ffprobe'), ['ffprobe.exe']);
assert.deepEqual(binaryNames('darwin', 'ffprobe'), ['ffprobe']);

const macProbe = probeCandidates('/opt/homebrew/bin/ffmpeg', {
  platform: 'darwin',
  configured: null,
  env: { PATH: '/usr/bin', FFMPEG_PATH: '/weird/ffmpeg' },
  home: '/Users/me',
});
assert.equal(macProbe[0], '/opt/homebrew/bin/ffprobe', 'the sibling of the resolved ffmpeg wins');
assert.ok(macProbe.includes('/usr/bin/ffprobe'), 'PATH is scanned');
assert.ok(macProbe.includes('/usr/local/bin/ffprobe'), 'the usual install dirs are scanned');
assert.ok(!macProbe.some((candidate) => candidate.includes('weird')), 'FFMPEG_PATH is ffmpeg-only');

const winProbe = probeCandidates('C:\\tools\\ffmpeg.exe', {
  platform: 'win32',
  configured: null,
  env: { PATH: 'C:\\Windows' },
  home: 'C:\\Users\\me',
});
assert.equal(winProbe[0], 'C:\\tools\\ffprobe.exe', 'Windows siblings keep the exe name');

// --- imageio-ffmpeg layouts ------------------------------------------------
assert.deepEqual(imageioPatterns('darwin', {}, '/Users/me')[0], [
  '/Users/me/Library/Python',
  '*',
  'lib',
  'python',
  'site-packages',
  'imageio_ffmpeg',
  'binaries',
]);
assert.deepEqual(imageioPatterns('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')[0], [
  'C:\\Users\\me\\AppData\\Local\\imageio_ffmpeg\\binaries',
]);
assert.deepEqual(imageioPatterns('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me')[1], [
  'C:\\Users\\me\\AppData\\Roaming\\Python',
  'Python*',
  'site-packages',
  'imageio_ffmpeg',
  'binaries',
]);

const expanded = expandDirs(
  '/root',
  ['*', 'site-packages'],
  (dir) => (dir === '/root' ? ['py3', 'other'] : []),
  'darwin',
);
assert.deepEqual(expanded, ['/root/py3/site-packages', '/root/other/site-packages']);
assert.deepEqual(
  expandDirs('/root', ['a', 'b'], () => [], 'darwin'),
  ['/root/a/b'],
);

// --- opening the file manager ---------------------------------------------
assert.deepEqual(revealCommand('/tmp/a.mp4', 'darwin'), { command: 'open', args: ['-R', '/tmp/a.mp4'] });
assert.deepEqual(revealCommand('C:\\out\\a.mp4', 'win32'), { command: 'explorer', args: ['/select,C:\\out\\a.mp4'] });
assert.deepEqual(revealCommand('/tmp/out/a.mp4', 'linux'), { command: 'xdg-open', args: ['/tmp/out'] });

// --- staying inside a directory --------------------------------------------
// A prefix check alone is defeated by a '..' segment.
assert.equal(isInsideDir('/out/box', '/out/box/a.mp4'), true);
assert.equal(isInsideDir('/out/box', '/out/box/sub/a.mp4'), true);
assert.equal(isInsideDir('/out/box', '/out/box/../secret.txt'), false);
assert.equal(isInsideDir('/out/box', '/out/box/../../etc/hosts'), false);
assert.equal(isInsideDir('/out/box', '/etc/hosts'), false);
assert.equal(isInsideDir('/out/box', '/out/box-2/a.mp4'), false, 'a sibling with the same prefix is outside');
assert.equal(isInsideDir('/out/box', '/out/box'), false, 'the directory itself is not a file in it');
assert.equal(isInsideDir('C:\\out', 'C:\\out\\a.mp4', 'win32'), true);
assert.equal(isInsideDir('C:\\out', 'C:\\out\\..\\secret.txt', 'win32'), false);

// --- output names ----------------------------------------------------------
assert.equal(safeBaseName('evil name.png', 'darwin'), 'evil name');
assert.equal(safeBaseName('C:\\dir\\clip.mp4', 'win32'), 'clip');
assert.equal(safeBaseName('a/b:c?.png', 'win32'), 'b_c_');
assert.equal(safeBaseName('CON.mp4', 'win32'), '_CON', 'Windows reserves CON');
assert.equal(safeBaseName('nul.mp4', 'win32'), '_nul');
assert.equal(safeBaseName('con.mp4', 'darwin'), 'con', 'the reservation is a Windows rule');
assert.equal(safeBaseName('', 'darwin'), 'input');
assert.equal(safeBaseName('.png', 'darwin'), 'output', 'a name that is only an extension');

// --- the hardware transcode path ------------------------------------------------
// The platform only says which backends may be tried; the probe then checks
// whether this machine can really run one of them.
assert.deepEqual(hardwareBackendsFor('darwin'), ['videotoolbox']);
assert.deepEqual(hardwareBackendsFor('win32'), ['nvenc', 'amf', 'qsv']);
assert.deepEqual(hardwareBackendsFor('linux'), ['vaapi']);

// --- picking the backend this machine can really run -------------------------
// The device check is injected, so the decision is checked on any host.
const ALL_ENCODERS = ['h264_nvenc', 'h264_amf', 'h264_qsv'];
const ALL_ACCELS = ['cuda', 'd3d11va', 'qsv'];
const ready = (id) => async (backend) => backend.id === id;

assert.equal(
  (await pickBackend('win32', ALL_ENCODERS, ALL_ACCELS, ready('nvenc')))?.id,
  'nvenc',
  'the discrete GPU wins',
);
assert.equal(
  (await pickBackend('win32', ALL_ENCODERS, ALL_ACCELS, ready('amf')))?.id,
  'amf',
  'AMD is tried before Intel',
);
assert.equal(
  (await pickBackend('win32', ALL_ENCODERS, ALL_ACCELS, ready('qsv')))?.id,
  'qsv',
  'Intel is the last resort',
);

// A GPU that cannot encode is not offered, whatever the binary carries.
assert.equal(
  await pickBackend('win32', ALL_ENCODERS, ALL_ACCELS, async () => false),
  null,
  'a failing device check means no backend',
);

// An encoder the binary does not carry is not considered.
assert.equal(
  (await pickBackend('win32', ['h264_qsv'], ['qsv'], async () => true))?.id,
  'qsv',
  'only the encoders the binary carries count',
);
assert.equal(
  await pickBackend('win32', ['libx264'], ['cuda'], async () => true),
  null,
  'a binary without a hardware encoder gets none',
);

// Every candidate that passes the cheap checks is checked, and the priority
// still decides: a driver that hangs costs one wait, not one per candidate.
const checked = [];
await pickBackend('win32', ALL_ENCODERS, ALL_ACCELS, async (backend) => {
  checked.push(backend.id);
  return backend.id === 'qsv';
});
assert.deepEqual(checked.sort(), ['amf', 'nvenc', 'qsv'], 'every candidate is checked');
assert.equal(
  (
    await pickBackend(
      'win32',
      ALL_ENCODERS,
      ALL_ACCELS,
      async (backend) => backend.id === 'nvenc' || backend.id === 'amf',
    )
  )?.id,
  'nvenc',
  'the first candidate in order still wins',
);

// A candidate whose check throws must not sink the probe.
const throwing = await pickBackend('win32', ALL_ENCODERS, ALL_ACCELS, async (backend) => {
  if (backend.id === 'nvenc') throw new Error('driver hung');
  return backend.id === 'qsv';
});
assert.equal(throwing?.id, 'qsv', 'a throwing device check does not sink the probe');

// macOS keeps its own backend, Linux has none yet.
assert.equal(
  (await pickBackend('darwin', ['h264_videotoolbox'], ['videotoolbox'], async () => true))?.id,
  'videotoolbox',
);
assert.equal(await pickBackend('linux', ALL_ENCODERS, ALL_ACCELS, async () => true), null, 'no Linux backend yet');

// renderNameTemplate: placeholders expand; anything that is not a bare file
// name is refused — the rendered string joins the output dir directly.
const tplNow = new Date(2026, 10, 9, 8, 7, 6);
assert.equal(renderNameTemplate('{name}-{date}-{time}.{ext}', 'clip', 'mp4', tplNow), 'clip-20261109-080706.mp4');
assert.equal(renderNameTemplate('{name}', 'plain', 'jpg', tplNow), 'plain');
for (const bad of ['../{name}', 'a/{name}', '{name}/..', '/{name}', '']) {
  assert.throws(() => renderNameTemplate(bad, 'x', 'mp4', tplNow), /命名模板非法/, `template refused: ${bad}`);
}
assert.throws(
  () => renderNameTemplate('{name}', 'a/b', 'mp4', tplNow),
  /命名模板非法/,
  'unsanitized {name} is refused too',
);

// VAAPI probes walk the render-node list: one encode per candidate until one
// answers, and a plain attempt last. No list at all = a single plain attempt.
const vaapiBuild = { encoders: ['h264_vaapi', 'hevc_vaapi'], hwaccels: ['vaapi'], filters: [] };
const vaapiAttempts = [];
const vaapiChosen = await probeFfmpegDevice(
  'linux',
  vaapiBuild,
  async (args) => {
    vaapiAttempts.push(args);
  },
  ['/dev/dri/renderD128', '/dev/dri/renderD129'],
);
assert.equal(vaapiChosen.backend.id, 'vaapi');
assert.ok(vaapiChosen.hevc, 'the hevc sibling passes its own device encode');
assert.deepEqual(
  vaapiAttempts[0].slice(vaapiAttempts[0].indexOf('-vaapi_device'), vaapiAttempts[0].indexOf('-vaapi_device') + 2),
  ['-vaapi_device', '/dev/dri/renderD128'],
  'the first candidate render node is tried with -vaapi_device',
);
const plainAttempts = [];
await probeFfmpegDevice('linux', vaapiBuild, async (args) => {
  plainAttempts.push(args);
});
const plainH264 = plainAttempts.filter((a) => a.includes('h264_vaapi'));
assert.equal(plainH264.length, 1, 'no device list = one plain attempt per encoder');
assert.ok(!plainH264[0].includes('-vaapi_device'), 'the plain attempt carries no device flag');

console.log('platform.test.mjs: ok');
