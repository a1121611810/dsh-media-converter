// The platform rules the Windows support rests on. Everything here is pure,
// so the Windows branches are checked from any host.
import assert from 'node:assert/strict';
import {
  binaryNames,
  expandDirs,
  ffmpegCandidates,
  imageioPatterns,
  isInsideDir,
  revealCommand,
  safeBaseName,
} from '../dist/lib/platform.js';

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

console.log('platform.test.mjs: ok');
