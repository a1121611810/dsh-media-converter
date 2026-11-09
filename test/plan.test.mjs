// Self-check for the pure planner: `node test/plan.test.mjs`.
import assert from 'node:assert/strict';
import {
  FORMATS,
  HW_BACKENDS,
  buildArgs,
  copyArgs,
  defaultFormat,
  formatEncoders,
  hardwareFor,
  extractPlan,
  kindOf,
  metaArgs,
  normalizeStderr,
  normalizeTrim,
  parseDuration,
  parseFfprobeJson,
  parseMeta,
  parseStreams,
  percentOf,
  progressSeconds,
  subtitlePlan,
  supportedFormats,
  supportsQuality,
  trimArgs,
} from '../dist/lib/plan.js';
import { blendPtcRate, capacityFor, estimatePtcCost, planPtcGroups, threadsFor } from '../dist/lib/schedule.js';

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
assert.equal(supportsQuality('audio', 'mp3'), false);

// Video quality: the X264 containers take it as CRF (90 keeps the recipe's
// 23); every other video recipe ignores it.
assert.equal(supportsQuality('video', 'mp4'), true);
assert.equal(supportsQuality('video', 'mkv'), true);
assert.equal(supportsQuality('video', 'webm'), false);
assert.equal(supportsQuality('video', 'gif'), false);
const crfAt = (args) => args[args.indexOf('-crf') + 1];
assert.equal(crfAt(buildArgs('video', 'mp4')), '23'); // default unchanged
assert.equal(crfAt(buildArgs('video', 'mp4', 90)), '23');
assert.equal(crfAt(buildArgs('video', 'mp4', 100)), '22');
assert.equal(crfAt(buildArgs('video', 'mp4', 50)), '27');
assert.equal(crfAt(buildArgs('video', 'mp4', 10)), '31');
assert.equal(crfAt(buildArgs('video', 'mp4', 500)), '22'); // clamped
assert.equal(crfAt(buildArgs('video', 'mov', 50)), '27');
assert.equal(crfAt(buildArgs('video', 'webm', 50)), '32'); // vp9 recipe untouched
assert.ok(!buildArgs('video', 'gif', 50).includes('-crf'));
assert.deepEqual(buildArgs('image', 'webp', 80), ['-frames:v', '1', '-c:v', 'libwebp', '-quality', '80']);
assert.deepEqual(buildArgs('image', 'jpg', 100), ['-frames:v', '1', '-q:v', '2']);
assert.equal(buildArgs('image', 'jpg', 50).at(-1), '17'); // 31 - 50*0.29 = 16.5 -> 17
assert.equal(buildArgs('image', 'jpg', 10).at(-1), '28');
assert.deepEqual(buildArgs('image', 'jpg', 500), ['-frames:v', '1', '-q:v', '2']); // clamped

// Format support follows the encoders the recipe needs; homebrew ffmpeg 9
// drops libtheora/libvorbis/libaom/libwebp, so the advertised table must be
// filterable per build. Recipes are the source of truth (formatEncoders
// reads buildArgs), so the two can never drift.
assert.deepEqual(formatEncoders('video', 'ogv'), ['libtheora', 'libvorbis']);
assert.deepEqual(formatEncoders('audio', 'ogg'), ['libvorbis']);
assert.deepEqual(formatEncoders('image', 'avif'), ['libaom-av1']);
assert.deepEqual(formatEncoders('video', 'mp4'), ['libx264', 'aac']);
assert.deepEqual(formatEncoders('video', 'gif'), []); // built-in filters only
const ALL_RECIPE_ENCODERS = [
  'libx264',
  'aac',
  'libmp3lame',
  'libvpx-vp9',
  'libopus',
  'mpeg4',
  'wmv2',
  'wmav2',
  'libtheora',
  'libvorbis',
  'flac',
  'pcm_s16le',
  'pcm_s16be',
  'png',
  'libwebp',
  'bmp',
  'tiff',
  'libaom-av1',
];
assert.deepEqual(supportedFormats(ALL_RECIPE_ENCODERS), FORMATS, 'full encoder set advertises everything');
const brew9 = supportedFormats([
  'libx264',
  'aac',
  'libmp3lame',
  'libopus',
  'libvpx-vp9',
  'wmv2',
  'wmav2',
  'mpeg4',
  'flac',
  'vorbis',
  'opus',
]);
assert.ok(!brew9.video.includes('ogv'), 'ogv needs libtheora');
assert.ok(!brew9.audio.includes('ogg'), 'ogg needs libvorbis');
assert.ok(!brew9.image.includes('webp') && !brew9.image.includes('avif'));
assert.ok(
  brew9.video.includes('webm') &&
    brew9.video.includes('mp4') &&
    brew9.audio.includes('mp3') &&
    brew9.image.includes('jpg'),
);

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

// --- stderr metadata edge cases (verified against real ffmpeg 7.1 output) --
// mp3 encoder delay makes start negative; flac/opus report bitrate N/A.
// Either used to fail the whole Duration line and zero start and bitrate.
const negativeStart = parseMeta('  Duration: 00:00:01.02, start: -0.023220, bitrate: 128 kb/s\n');
assert.equal(negativeStart.duration, 1.02);
assert.equal(negativeStart.start, -0.02322);
assert.equal(negativeStart.bitrate, 128);
const naBitrate = parseMeta('  Duration: 00:00:01.02, start: 0.500000, bitrate: N/A\n');
assert.equal(naBitrate.start, 0.5);
assert.equal(naBitrate.bitrate, 0);

// A channel layout with digits (5.1(side)) never survived the word filter
// and shifted the sample format into the channels slot.
const surround = parseMeta('  Stream #0:0: Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s\n');
assert.equal(surround.audio.channels, '5.1(side)');
assert.equal(surround.audio.sampleFmt, 'fltp');
assert.equal(surround.audio.bitrate, 448);

// Cover art rides a video stream flagged "attached pic" (a space on ffmpeg 7);
// it is artwork, not the picture track.
const coverStderr = [
  '  Duration: 00:00:01.00, start: 0.000000, bitrate: 6575 kb/s',
  '  Stream #0:0: Audio: aac (LC), 44100 Hz, mono, fltp, 81 kb/s (default)',
  '  Stream #0:1: Video: mjpeg (Baseline), yuvj444p(pc), 300x300, 90k tbr (attached pic)',
].join('\n');
const coverOnly = parseMeta(coverStderr);
assert.equal(coverOnly.video, null, 'cover art is not the picture track');
assert.equal(coverOnly.audio.index, 0);
assert.deepEqual(coverOnly.streams[1].flags, ['attached_pic']);
assert.deepEqual(parseStreams(coverStderr), {
  video: false,
  audio: true,
  videoCodec: '',
  audioCodec: 'aac',
  subtitles: [],
});
assert.equal(
  kindOf(
    'blob',
    '  Stream #0:0: Video: mjpeg (Baseline), 300x300 (attached pic)\n  Stream #0:1: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp',
  ),
  'audio',
);
// A real video next to cover art still wins.
const withVideo = parseMeta(
  '  Stream #0:0: Video: mjpeg (Baseline), 300x300 (attached pic)\n  Stream #0:1: Video: h264 (High), yuv420p, 1920x1080\n',
);
assert.equal(withVideo.video.codec, 'h264');

// --- ffprobe JSON: the same MediaMeta from the structured route ------------
const fromJson = parseFfprobeJson(
  JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        profile: 'High',
        codec_type: 'video',
        codec_tag_string: 'avc1',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p',
        sample_aspect_ratio: '1:1',
        display_aspect_ratio: '16:9',
        avg_frame_rate: '30000/1001',
        bit_rate: '2500000',
        disposition: { default: 1, attached_pic: 0 },
        tags: { language: 'eng' },
      },
      {
        index: 1,
        codec_name: 'ac3',
        codec_type: 'audio',
        sample_rate: '48000',
        channel_layout: '5.1(side)',
        sample_fmt: 'fltp',
        bit_rate: '448000',
        disposition: { default: 0 },
        tags: { language: 'chi' },
      },
    ],
    chapters: [{ id: 0, start_time: '0.000000', end_time: '60.000000', tags: { title: '第一段' } }],
    format: {
      format_name: 'matroska,webm',
      duration: '311.200000',
      start_time: '-0.023220',
      bit_rate: '320000',
      tags: { TITLE: '合唱', ENCODER: 'Lavf60.16.100' },
    },
  }),
);
assert.equal(fromJson.format, 'matroska,webm');
assert.equal(fromJson.duration, 311.2);
assert.equal(fromJson.start, -0.02322);
assert.equal(fromJson.bitrate, 320);
assert.deepEqual(fromJson.tags, { title: '合唱', encoder: 'Lavf60.16.100' });
assert.equal(fromJson.video.codec, 'h264');
assert.equal(fromJson.video.bitrate, 2500, 'stream bit_rate is bps, MediaMeta is kb/s');
assert.equal(fromJson.video.fps, 29.97);
assert.equal(fromJson.video.aspect, '1:1');
assert.equal(fromJson.video.displayAspect, '16:9');
assert.equal(fromJson.video.language, 'eng');
assert.deepEqual(fromJson.video.flags, ['default']);
assert.equal(fromJson.audio.channels, '5.1(side)');
assert.equal(fromJson.audio.bitrate, 448);
assert.equal(fromJson.audio.sampleRate, 48000);
assert.deepEqual(fromJson.chapters, [{ index: 0, start: 0, end: 60, tags: { title: '第一段' } }]);

// The cover-art stream keeps its flag and stays out of the video slot.
const coverJson = parseFfprobeJson(
  JSON.stringify({
    streams: [
      { index: 0, codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', disposition: { default: 1 } },
      { index: 1, codec_name: 'mjpeg', codec_type: 'video', width: 300, disposition: { attached_pic: 1 } },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '60.000000' },
  }),
);
assert.equal(coverJson.video, null);
assert.equal(coverJson.audio.codec, 'aac');
assert.deepEqual(coverJson.streams[1].flags, ['attached_pic']);

// Nothing usable -> null, so the host falls back to the stderr parser.
assert.equal(parseFfprobeJson(''), null);
assert.equal(parseFfprobeJson('not json'), null);
assert.equal(parseFfprobeJson('{}'), null);
assert.equal(parseFfprobeJson('{"streams":[]}'), null);

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

// Hardware H.264: one row per vendor, and only the libx264 containers.
const hwSize = 10 * 1024 * 1024;
const hwDuration = 10;
const vtPlan = hardwareFor(HW_BACKENDS.videotoolbox, 'video', 'mp4', hwSize, hwDuration);
assert.ok(vtPlan.args.includes('h264_videotoolbox'));
assert.ok(vtPlan.args.includes('-allow_sw'));
assert.deepEqual(vtPlan.inputArgs, ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox']);

const nvencPlan = hardwareFor(HW_BACKENDS.nvenc, 'video', 'mp4', hwSize, hwDuration);
assert.ok(nvencPlan.args.includes('h264_nvenc'));
assert.ok(nvencPlan.args.includes('-rc'));
assert.ok(nvencPlan.args.includes('vbr'));
assert.deepEqual(nvencPlan.inputArgs, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);

const qsvPlan = hardwareFor(HW_BACKENDS.qsv, 'video', 'mp4', hwSize, hwDuration);
assert.ok(qsvPlan.args.includes('h264_qsv'));
assert.deepEqual(qsvPlan.inputArgs, ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv']);
// QSV reads -b:v plus -maxrate as VBR; without -maxrate it falls back to
// constant QP and the bitrate runs away.
assert.ok(qsvPlan.args.includes('-maxrate'));

const amfPlan = hardwareFor(HW_BACKENDS.amf, 'video', 'mp4', hwSize, hwDuration);
assert.ok(amfPlan.args.includes('h264_amf'));
assert.ok(amfPlan.args.includes('vbr_peak'));
assert.deepEqual(amfPlan.inputArgs, ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11']);

// No -pix_fmt on purpose: forcing a conversion would download the GPU frames
// and break the zero-copy path.
assert.ok(!nvencPlan.args.includes('-pix_fmt'));
// The bitrate comes from the source, the same estimate for every backend.
assert.ok(nvencPlan.args.includes('8197k'));
// Quality scales the derived bitrate on the hardware path (90 = unchanged).
const hwKbps = (quality) => {
  const plan = hardwareFor(HW_BACKENDS.videotoolbox, 'video', 'mp4', hwSize, hwDuration, quality);
  return plan.args[plan.args.indexOf('-b:v') + 1];
};
assert.equal(hwKbps(90), '8197k');
assert.equal(hwKbps(100), '9016k');
assert.equal(hwKbps(10), '3279k');
for (const backend of Object.values(HW_BACKENDS)) {
  assert.equal(hardwareFor(backend, 'video', 'webm', hwSize, hwDuration), null);
  assert.equal(hardwareFor(backend, 'audio', 'mp3', hwSize, hwDuration), null);
  for (const format of ['mp4', 'mov', 'mkv', 'flv', 'ts']) {
    const plan = hardwareFor(backend, 'video', format, hwSize, hwDuration);
    assert.ok(plan, backend.id + ' supports ' + format);
    assert.ok(plan.args.includes('-b:v'));
  }
}

// CPU-aware capacity and thread split.
assert.equal(capacityFor(0.9, 10), 1);
assert.equal(capacityFor(0.5, 10), 2);
assert.equal(capacityFor(0.2, 10), 4);
assert.equal(capacityFor(0.9, 2), 1);
assert.equal(threadsFor(1, 1, 10), 0);
assert.ok(threadsFor(2, 0.5, 10) >= 1);

// --- PTC cost model & evaluation groups ------------------------------------
// Seeds are media-seconds per wall-second: a copy is nearly free, a video
// re-encode is the slow case, and an image is a fixed cost.
assert.ok(estimatePtcCost({ duration: 10, kind: 'video', copy: true }) < 1000);
assert.ok(estimatePtcCost({ duration: 60, kind: 'video' }) > estimatePtcCost({ duration: 60, kind: 'audio' }));
assert.equal(estimatePtcCost({ duration: 0, kind: 'image' }), 400);
// A measured fast run lifts the seeded rate and shrinks the next estimate.
const faster = blendPtcRate(6, 60, 3000); // 20x realtime observed
assert.ok(faster > 6 && faster < 20);
assert.equal(blendPtcRate(6, 60, 200), 6, 'a job too short to measure says nothing');

const ptcLimits = { defaultMs: 120_000, maxMs: 600_000 };
const videoCost = (duration) => estimatePtcCost({ duration, kind: 'video' });
// Ten short clips fit one evaluation; the timeout never drops below defaultMs.
const shortClips = Array.from({ length: 10 }, (_, index) => ({ id: 'c' + index, costMs: videoCost(10) }));
const oneGroup = planPtcGroups(shortClips, ptcLimits);
assert.equal(oneGroup.length, 1);
assert.equal(oneGroup[0].items.length, 10);
assert.ok(oneGroup[0].timeoutMs >= 120_000);
// The file cap splits a batch even when the time estimate would fit.
const manyClips = Array.from({ length: 41 }, (_, index) => ({ id: 'm' + index, costMs: 400 }));
assert.deepEqual(
  planPtcGroups(manyClips, ptcLimits).map((group) => group.items.length),
  [40, 1],
);
// Long clips fill a group until the time budget is used, then start another.
const longClips = Array.from({ length: 12 }, (_, index) => ({ id: 'l' + index, costMs: videoCost(300) }));
const longGroups = planPtcGroups(longClips, ptcLimits);
assert.deepEqual(
  longGroups.map((group) => group.items.length),
  [11, 1],
);
assert.equal(longGroups[0].timeoutMs, 600_000, 'a full group is clamped to the runtime cap');
// A single file that cannot fit one evaluation still gets its own group.
const huge = [{ id: 'huge', costMs: videoCost(7200) }];
const hugeGroup = planPtcGroups(huge, ptcLimits);
assert.equal(hugeGroup.length, 1);
assert.equal(hugeGroup[0].timeoutMs, 600_000);
assert.deepEqual(planPtcGroups([], ptcLimits), []);

console.log('plan.test.mjs: ok');
