// Self-check for the pure planner: `node test/plan.test.mjs`.
import assert from 'node:assert/strict';
import {
  FORMATS,
  buildArgs,
  copyArgs,
  defaultFormat,
  hardwareFor,
  extractPlan,
  kindOf,
  metaArgs,
  normalizeStderr,
  normalizeTrim,
  parseDuration,
  parseMeta,
  parseStreams,
  percentOf,
  progressSeconds,
  subtitlePlan,
  supportsQuality,
  trimArgs,
} from '../dist/lib/plan.js';
import { capacityFor, threadsFor } from '../dist/lib/schedule.js';

assert.equal(kindOf('movie.MOV'), 'video');
assert.equal(kindOf('clip.gif'), 'image');
assert.equal(kindOf('song.opus'), 'audio');
assert.equal(kindOf('photo.heic'), 'image');
assert.equal(kindOf('blob', '  Stream #0:0[0x1]: Audio: aac (LC), 44100 Hz'), 'audio');
assert.equal(kindOf('blob', '  Stream #0:0[0x1]: Video: h264 (High)'), 'video');
assert.equal(kindOf('blob'), null);

assert.deepEqual(FORMATS.video, ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'ts', 'ogv', 'gif', 'mp3', 'm4a']);
assert.deepEqual(FORMATS.image, ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif']);
assert.equal(defaultFormat('audio'), 'mp3');
assert.equal(defaultFormat('nope'), 'mp4');

assert.ok(buildArgs('video', 'mp4').includes('libx264'));
assert.ok(buildArgs('video', 'mp3').includes('-vn'));
assert.ok(buildArgs('audio', 'flac').includes('flac'));
assert.ok(buildArgs('image', 'png').includes('-frames:v'));
assert.throws(() => buildArgs('audio', 'mp4'), /不支持的输出格式/);

// Image quality: only the lossy formats take it, and it changes the args.
assert.equal(supportsQuality('image', 'jpg'), true);
assert.equal(supportsQuality('image', 'webp'), true);
assert.equal(supportsQuality('image', 'png'), false);
assert.equal(supportsQuality('video', 'mp4'), false);
assert.deepEqual(buildArgs('image', 'webp', 80), ['-frames:v', '1', '-c:v', 'libwebp', '-quality', '80']);
assert.deepEqual(buildArgs('image', 'jpg', 100), ['-frames:v', '1', '-q:v', '2']);
assert.equal(buildArgs('image', 'jpg', 50).at(-1), '17'); // 31 - 50*0.29 = 16.5 -> 17
assert.equal(buildArgs('image', 'jpg', 10).at(-1), '28');
assert.deepEqual(buildArgs('image', 'jpg', 500), ['-frames:v', '1', '-q:v', '2']); // clamped

assert.equal(parseDuration('  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s'), 62.5);
assert.equal(parseDuration('  Duration: N/A, bitrate: N/A'), 0);

const stderr = [
  '  Duration: 00:00:06.00, start: 0.000000, bitrate: 200 kb/s',
  '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 640x360, 123 kb/s',
  '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 110 kb/s',
].join('\n');
const streams = parseStreams(stderr);
assert.deepEqual(streams, { video: true, audio: true, videoCodec: 'h264', audioCodec: 'aac', subtitles: [] });
assert.deepEqual(parseStreams('Stream #0:0: Video: png, rgb24'), {
  video: true,
  audio: false,
  videoCodec: 'png',
  audioCodec: '',
  subtitles: [],
});

// Windows ffmpeg writes CRLF; the sample is normalised before it is parsed.
const crlf = stderr.replace(/\n/g, '\r\n');
assert.equal(normalizeStderr(crlf), stderr);
assert.equal(parseMeta(normalizeStderr(crlf)).video.pixFmt, 'yuv420p');

assert.deepEqual(extractPlan(streams, 'audio'), {
  ext: 'm4a',
  kind: 'audio',
  args: ['-map', '0:a:0', '-vn', '-c:a', 'copy'],
});
assert.deepEqual(extractPlan(streams, 'video'), {
  ext: 'mp4',
  kind: 'video',
  args: ['-map', '0:v:0', '-an', '-c:v', 'copy'],
});
assert.equal(extractPlan(parseStreams('Stream #0:0: Video: vp9'), 'video').ext, 'webm');
assert.equal(extractPlan(parseStreams('Stream #0:0: Audio: opus'), 'audio').ext, 'ogg');
assert.equal(extractPlan(parseStreams('Stream #0:0: Audio: pcm_s16le'), 'audio').ext, 'wav');
assert.equal(extractPlan(parseStreams('Stream #0:0: Video: mpeg2video'), 'video').ext, 'mp4');
assert.throws(() => extractPlan({ video: true, audio: false }, 'audio'), /没有音轨/);
assert.throws(() => extractPlan({ video: false, audio: true }, 'video'), /没有画面/);

assert.deepEqual(trimArgs(null), []);
assert.deepEqual(trimArgs({ start: 2, end: 5 }), ['-ss', '2.000', '-t', '3.000']);
assert.deepEqual(trimArgs({ start: 0, end: 0.5 }), ['-ss', '0.000', '-t', '0.500']);
assert.deepEqual(trimArgs({ start: 5, end: 5 }), []);

assert.equal(normalizeTrim(null, 10), null);
assert.deepEqual(normalizeTrim({ start: 2, end: 5 }, 10), { start: 2, end: 5 });
assert.deepEqual(normalizeTrim({ start: '2', end: '5' }, 10), { start: 2, end: 5 });
assert.deepEqual(normalizeTrim({ start: 0, end: 0 }, 10), { start: 0, end: 10 }); // empty end = whole file
assert.deepEqual(normalizeTrim({ start: -3, end: 99 }, 10), { start: 0, end: 10 }); // clamped to the file
assert.equal(normalizeTrim({ start: 5, end: 2 }, 10), null); // inverted = no trim
assert.equal(normalizeTrim({ start: 0, end: 0 }, 0), null); // unknown duration, nothing to cut
assert.deepEqual(normalizeTrim({ start: 1, end: 5 }, 0), { start: 1, end: 5 });

// --- container metadata, subtitle tracks, tag rewriting -------------------
const rich = [
  "Input #0, matroska,webm, from '/tmp/x.mkv':",
  '  Metadata:',
  '    ENCODER         : Lavf60.16.100',
  '    title           : 合唱',
  '  Duration: 00:05:11.20, start: 0.000000, bitrate: 320 kb/s',
  '  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 2500 kb/s, 30 fps, 30 tbr, 1k tbn',
  '      Metadata:',
  '        handler_name    : VideoHandler',
  '  Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s (default)',
  '  Stream #0:2(eng): Subtitle: subrip',
  '  Stream #0:3(chi): Subtitle: ass',
  '  Chapter #0:0: start 0.000000, end 60.000000',
  '    Metadata:',
  '      title           : 第一段',
].join('\n');
const parsed = parseMeta(rich);
assert.equal(parsed.format, 'matroska,webm');
assert.equal(parsed.duration, 311.2);
assert.equal(parsed.start, 0);
assert.equal(parsed.bitrate, 320);
assert.equal(parsed.streams.length, 4);
assert.equal(parsed.video.index, 0);
assert.equal(parsed.video.codec, 'h264');
assert.equal(parsed.video.profile, 'High');
assert.equal(parsed.video.width, 1920);
assert.equal(parsed.video.height, 1080);
assert.equal(parsed.video.fps, 30);
assert.equal(parsed.video.bitrate, 2500);
assert.equal(parsed.video.pixFmt, 'yuv420p(progressive)');
assert.deepEqual(parsed.video.tags, { handler_name: 'VideoHandler' });
assert.equal(parsed.video.type, 'video');

assert.equal(parsed.audio.index, 1);
assert.equal(parsed.audio.codec, 'aac');
assert.equal(parsed.audio.profile, 'LC');
assert.equal(parsed.audio.sampleRate, 44100);
assert.equal(parsed.audio.channels, 'stereo');
assert.equal(parsed.audio.sampleFmt, 'fltp');
assert.equal(parsed.audio.bitrate, 128);
assert.deepEqual(parsed.audio.flags, ['default']);

assert.deepEqual(parsed.subtitles, [
  { index: 2, codec: 'subrip', language: 'eng', title: '' },
  { index: 3, codec: 'ass', language: 'chi', title: '' },
]);
assert.deepEqual(parsed.chapters, [{ index: 0, start: 0, end: 60, tags: { title: '第一段' } }]);
assert.deepEqual(parsed.tags, { encoder: 'Lavf60.16.100', title: '合唱' }); // keys normalised to lower case

assert.deepEqual(subtitlePlan(parsed, 1), {
  ext: 'srt',
  kind: 'text',
  args: ['-map', '0:s:1', '-c:s', 'srt'],
  stemSuffix: '.chi',
});
assert.equal(subtitlePlan(parsed, 0).stemSuffix, '.eng');
assert.throws(() => subtitlePlan(parsed, 9), /这条字幕轨不存在/);

assert.deepEqual(metaArgs({ title: '标题', artist: '  ', album: '专辑' }), [
  '-map',
  '0',
  '-c',
  'copy',
  '-metadata',
  'title=标题',
  '-metadata',
  'album=专辑',
]);
assert.deepEqual(metaArgs({}), ['-map', '0', '-c', 'copy']);
assert.deepEqual(metaArgs(null), ['-map', '0', '-c', 'copy']);

assert.equal(progressSeconds('out_time_us=500000'), 0.5);
assert.equal(progressSeconds('out_time_ms=500000'), 0.5);
assert.equal(progressSeconds('progress=end'), null);
assert.equal(percentOf(31, 62), 50);
assert.equal(percentOf(62, 62), 99); // never claim 100 before the process exits
assert.equal(percentOf(1, 0), null);

// Copy only when the codecs fit the target container.
assert.ok(copyArgs('video', 'mp4', { video: { codec: 'h264' }, audio: { codec: 'aac' } }).includes('copy'));
assert.ok(copyArgs('video', 'webm', { video: { codec: 'vp9' }, audio: { codec: 'opus' } }));
assert.equal(copyArgs('video', 'mp4', { video: { codec: 'vp9' }, audio: { codec: 'opus' } }), null);
assert.ok(copyArgs('audio', 'mp3', { video: null, audio: { codec: 'mp3' } }));
assert.equal(copyArgs('audio', 'mp3', { video: null, audio: { codec: 'aac' } }), null);

// VideoToolbox only for the libx264 containers.
assert.ok(hardwareFor('video', 'mp4', 10 * 1024 * 1024, 10).args.includes('h264_videotoolbox'));
assert.deepEqual(hardwareFor('video', 'mp4', 10 * 1024 * 1024, 10).inputArgs, ['-hwaccel', 'videotoolbox']);
assert.equal(hardwareFor('video', 'webm', 10 * 1024 * 1024, 10), null);

// CPU-aware capacity and thread split.
assert.equal(capacityFor(0.9, 10), 1);
assert.equal(capacityFor(0.5, 10), 2);
assert.equal(capacityFor(0.2, 10), 4);
assert.equal(capacityFor(0.9, 2), 1);
assert.equal(threadsFor(1, 1, 10), 0);
assert.ok(threadsFor(2, 0.5, 10) >= 1);

console.log('plan.test.mjs: ok');
