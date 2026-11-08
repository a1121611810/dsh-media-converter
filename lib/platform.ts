// Platform-specific bits of the media toolbox: where ffmpeg lives, how the
// file manager is opened, and which output names a file system accepts.
//
// Everything here is pure — the caller does the file system access — so the
// Windows behaviour can be tested from any host (test/platform.test.mjs).

import path from 'node:path';

// Windows refuses these names even with an extension (CON.txt is still CON).
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Where ffmpeg may sit: explicit config, environment, PATH, then the usual
// install locations.
export interface FfmpegOptions {
  platform: string;
  configured?: string | null;
  env?: Record<string, string | undefined>;
  home?: string;
}

export function pathFor(platform: string): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Windows resolves a binary only as `<name>.exe`, so a PATH scan must look
// for the suffix; an explicitly configured path may name the binary itself.
export function binaryNames(platform: string, binary = 'ffmpeg'): string[] {
  return platform === 'win32' ? [binary + '.exe'] : [binary];
}

// Every place ffmpeg (or ffprobe, asked for by `binary`) may sit, best
// first: explicit config, environment, PATH, then the usual install locations.
// FFMPEG_PATH names ffmpeg only, so it is skipped for other binaries.
export function ffmpegCandidates(
  { platform, configured, env = {}, home: _home = '' }: FfmpegOptions,
  binary = 'ffmpeg',
): string[] {
  const p = pathFor(platform);
  const names = binaryNames(platform, binary);
  const out: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    out.push(value);
    // A Windows path without a suffix still names the binary.
    if (platform === 'win32' && !path.win32.extname(value)) out.push(value + '.exe');
  };
  push(configured ?? undefined);
  if (binary === 'ffmpeg') push(env.FFMPEG_PATH);
  for (const dir of String(env.PATH || '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) out.push(p.join(dir, name));
  }
  if (platform === 'win32') out.push(`C:\\ffmpeg\\bin\\${binary}.exe`);
  else out.push(`/opt/homebrew/bin/${binary}`, `/usr/local/bin/${binary}`);
  return out;
}

// Where ffprobe may sit: full installs ship the two as a pair, so the
// directory that yielded ffmpeg comes first; then the same scan ffmpeg gets.
export function probeCandidates(ffmpegPath: string, opts: FfmpegOptions): string[] {
  const p = pathFor(opts.platform);
  const out: string[] = [];
  if (ffmpegPath) {
    for (const name of binaryNames(opts.platform, 'ffprobe')) out.push(p.join(p.dirname(ffmpegPath), name));
  }
  out.push(...ffmpegCandidates(opts, 'ffprobe'));
  return out;
}

// imageio-ffmpeg ships a static build next to the Python packages. The layout
// differs per platform, so each entry is a path pattern where `*` stands for
// exactly one directory level.
export function imageioPatterns(platform: string, env: Record<string, string | undefined> = {}, home = ''): string[][] {
  const p = pathFor(platform);
  if (platform === 'win32') {
    return [
      [p.join(env.LOCALAPPDATA || home, 'imageio_ffmpeg', 'binaries')],
      [p.join(env.APPDATA || home, 'Python'), 'Python*', 'site-packages', 'imageio_ffmpeg', 'binaries'],
    ];
  }
  return [
    [p.join(home, 'Library', 'Python'), '*', 'lib', 'python', 'site-packages', 'imageio_ffmpeg', 'binaries'],
    [p.join(home, '.local', 'lib'), 'python*', 'site-packages', 'imageio_ffmpeg', 'binaries'],
  ];
}

// Expand a pattern into the directories it names. `listDir` returns the names
// of the directories inside a directory, so this function touches no files.
export function expandDirs(
  root: string,
  segments: string[],
  listDir: (dir: string) => string[],
  platform = process.platform,
): string[] {
  const p = pathFor(platform);
  let current = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of current) {
      if (!segment.includes('*')) {
        next.push(p.join(dir, segment));
        continue;
      }
      for (const name of listDir(dir)) next.push(p.join(dir, name));
    }
    current = next;
  }
  return current;
}

// Open the system file manager with the file selected.
export function revealCommand(file: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    // explorer takes "/select,<path>" as one single argument.
    return { command: 'explorer', args: ['/select,' + file] };
  }
  if (platform === 'darwin') return { command: 'open', args: ['-R', file] };
  return { command: 'xdg-open', args: [pathFor(platform).dirname(file)] };
}

// Whether a file really sits inside a directory. A plain string-prefix check
// is defeated by a '..' segment, so both sides are resolved first.
export function isInsideDir(dir: string, file: string, platform = process.platform): boolean {
  const p = pathFor(platform);
  const rel = p.relative(p.resolve(dir), p.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
}

// A file name every file system accepts: no separators, no control characters,
// and none of the names Windows reserves for devices.
export function safeBaseName(raw: string, platform = process.platform): string {
  const p = pathFor(platform);
  const base = p.basename(String(raw || 'input'));
  let stem = base.replace(/\.[^.]*$/, '') || 'output';
  // The control characters are what we strip.
  // oxlint-disable-next-line no-control-regex
  stem = stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'output';
  if (platform === 'win32' && WIN_RESERVED.test(stem)) stem = '_' + stem;
  return stem;
}

// The hardware transcode path speaks videotoolbox, which only exists on
// Apple platforms; everywhere else the caller gets the software plan.
export function hardwarePathAllowed(platform: string): boolean {
  return platform === 'darwin';
}
