// DSH Host plugin: local media toolkit — convert, trim, extract tracks, and
// move media to/from Base64 through ffmpeg.
//
// The Web page (client.js) never touches the filesystem: it uploads picked
// files to this plugin's same-origin routes, the Host runs one ffmpeg process
// per job, and the page polls the job for progress. Results land in
// ~/Downloads/media-toolbox (config.outputDir overrides it) and are served back
// for preview from that same directory only.
//
// Node does the heavy lifting without ever holding a whole file in memory: the
// upload streams to disk, the Base64 answer streams back out, the file system
// calls are asynchronous so a multi-gigabyte job never blocks the Host, and
// every job carries an AbortSignal so the page can cancel it.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeBase64Payload } from './lib/base64.js';
import {
  FORMATS, buildArgs, extOf, extractPlan, kindByExt, kindOf, metaArgs, mimeOf, normalizeStderr,
  normalizeTrim, parseDuration, parseMeta, parseStreams, percentOf, progressSeconds, subtitlePlan, trimArgs,
} from './lib/plan.js';
import { expandDirs, ffmpegCandidates, imageioPatterns, revealCommand, safeBaseName } from './lib/platform.js';

const PREFIX = '/api/media-convert';
const MAX_BASE64_BYTES = 24 * 1024 * 1024;
// Uploaded copies live in a temp directory. Big videos are big, so anything
// older than this is dropped instead of filling the disk over a long session.
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

function isExecutable(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Machines without `ffmpeg` on PATH often still carry imageio-ffmpeg's static
// build; check there before telling the user to install anything.
function imageioBinaries() {
  const out = [];
  const listDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  for (const pattern of imageioPatterns(process.platform, process.env, os.homedir())) {
    for (const dir of expandDirs(pattern[0], pattern.slice(1), listDirs, process.platform)) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (/^ffmpeg/i.test(file)) out.push(path.join(dir, file));
        }
      } catch {
        // not the static-build layout
      }
    }
  }
  return out;
}

function findFfmpeg(configured) {
  const candidates = [
    ...ffmpegCandidates({ platform: process.platform, configured, env: process.env, home: os.homedir() }),
    ...imageioBinaries(),
  ];
  return candidates.find((c) => c && isExecutable(c)) || null;
}

function probe(ffmpeg, file) {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { timeout: 20000 }, (_error, _stdout, stderr) => {
      // ffmpeg writes CRLF on Windows; the parser expects plain lines.
      resolve(normalizeStderr(stderr));
    });
  });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64e6) throw new Error('请求体过大');
  }
  return body ? JSON.parse(body) : {};
}

// Base64 encoder that works on the file in chunks: the native Buffer encoder
// is twice as fast as the string decoder, and the file never becomes one
// string in memory. Chunks are trimmed to a multiple of three so the Base64
// stays aligned.
function base64Encoder() {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, done) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const usable = pending.length - (pending.length % 3);
      if (usable) this.push(pending.subarray(0, usable).toString('base64'));
      pending = pending.subarray(usable);
      done();
    },
    flush(done) {
      if (pending.length) this.push(pending.toString('base64'));
      done();
    },
  });
}

// The web server is the whole point of this plugin, so declare it as a hard
// dependency: Cordis then runs apply only once the service is ready. Reading it
// once with ctx.get let apply run before the server existed, take the early
// return below, and silently register no routes at all.
export const inject = ['webServer'];

export function apply(ctx, config) {
  const cfg = config || {};
  const outDir = cfg.outputDir || path.join(os.homedir(), 'Downloads', 'media-toolbox');
  const tmpDir = path.join(os.tmpdir(), 'dsh-media-toolbox');
  const ffmpeg = findFfmpeg(cfg.ffmpegPath);

  const uploads = new Map();
  const jobs = new Map();
  const controllers = new Map();
  const children = new Set();

  const webServer = ctx.get('webServer');
  if (!webServer) {
    // inject should make this impossible; say so loudly if it ever happens.
    console.error('[dsh-media-converter] webServer service missing: no routes registered');
    return;
  }
  const noFfmpeg = {
    ok: false,
    error: '未找到 ffmpeg：请先安装（brew install ffmpeg / winget install ffmpeg），或用 FFMPEG_PATH / 插件配置 ffmpegPath 指定路径',
  };

  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };

  // Mutating routes are same-origin only: a plain cross-origin POST is a
  // "simple request" the browser sends without preflight.
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === new URL(webServer.getOrigin()).host;
    } catch {
      return false;
    }
  };

  const insideOutput = (file) => typeof file === 'string' && file.startsWith(outDir + path.sep);

  const uniqueOutput = async (name, extension, suffix = '') => {
    const stem = safeBaseName(name) + suffix;
    const candidate = path.join(outDir, `${stem}.${extension}`);
    const taken = await fsp.stat(candidate).then(() => true, () => false);
    return taken ? path.join(outDir, `${stem}-${Date.now().toString(36)}.${extension}`) : candidate;
  };

  const startJob = async (upload, plan, trim, name) => {
    await fsp.mkdir(outDir, { recursive: true });
    const out = await uniqueOutput(name || upload.name, plan.ext, plan.stemSuffix || '');
    const job = {
      id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      state: 'running', percent: null, out, size: 0, error: null, kind: plan.kind, trim,
    };
    jobs.set(job.id, job);
    const span = trim ? trim.end - trim.start : upload.duration;

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...trimArgs(trim),
      '-i', upload.path,
      ...plan.args,
      '-progress', 'pipe:1', '-nostats', out,
    ];
    // The AbortSignal is the whole cancel mechanism: aborting kills the ffmpeg
    // process, and the close handler below cleans up what it left behind.
    const controller = new AbortController();
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal });
    controllers.set(job.id, { controller, child, killTimer: null });
    children.add(child);

    let buffered = '';
    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        if (job.state !== 'running') return;
        const seconds = progressSeconds(line);
        if (seconds !== null) job.percent = percentOf(seconds, span);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      tail = normalizeStderr(tail + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      // An aborted job already carries its own state.
      if (job.state !== 'running') return;
      job.state = 'error';
      job.error = String((err && err.message) || err);
    });
    child.on('close', async (code) => {
      children.delete(child);
      const entry = controllers.get(job.id);
      if (entry && entry.killTimer) clearTimeout(entry.killTimer);
      controllers.delete(job.id);
      if (job.state === 'cancelling') {
        // ffmpeg can have written half an output before the kill landed.
        await fsp.rm(out, { force: true }).catch(() => {});
        job.state = 'cancelled';
        return;
      }
      if (job.state !== 'running') return;
      try {
        if (code !== 0) throw new Error(`ffmpeg 退出码 ${code}`);
        job.size = (await fsp.stat(out)).size;
        job.state = 'done';
        job.percent = 100;
      } catch (err) {
        // ffmpeg can create the output before failing; never report that as done.
        await fsp.rm(out, { force: true }).catch(() => {});
        job.state = 'error';
        job.error = tail.trim().split('\n').slice(-3).join(' ') || String((err && err.message) || err);
      }
    });
    return job;
  };

  const planFor = (upload, body) => {
    const mode = String(body.mode || 'convert');
    if (mode === 'extract-audio') return extractPlan(upload.streams, 'audio');
    if (mode === 'extract-video') return extractPlan(upload.streams, 'video');
    if (mode === 'subtitle') return subtitlePlan(upload.streams, body.stream);
    if (mode === 'meta') return { ext: extOf(upload.name), kind: upload.kind, args: metaArgs(body.tags) };
    const format = String(body.format || '');
    if (!FORMATS[upload.kind] || !FORMATS[upload.kind].includes(format)) {
      throw new Error(`不支持的输出格式: ${format}`);
    }
    return { ext: format, kind: kindByExt(format), args: buildArgs(upload.kind, format, body.quality) };
  };

  // Byte range support keeps the preview player's scrub bar working.
  const serveFile = async (req, res, file) => {
    let size;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    const mime = mimeOf(file);
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!(start <= end && start < size)) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': mime,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': mime, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  };

  ctx.effect(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Drop stale uploads so a session with many big files does not fill the
    // temp directory. unref() keeps the timer from holding the process open.
    const pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, upload] of uploads) {
        if (now - upload.at > UPLOAD_TTL_MS) {
          uploads.delete(id);
          fs.rm(upload.path, { force: true }, () => {});
        }
      }
    }, 10 * 60 * 1000);
    pruneTimer.unref();

    const disposers = [
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/status`,
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
          json(res, 200, { ok: true, ffmpegPath: ffmpeg, outputDir: outDir, formats: FORMATS });
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/upload`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
          if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' });
          if (!ffmpeg) return json(res, 200, noFfmpeg);
          let file = '';
          try {
            const name = path.basename(new URL(req.url, 'http://localhost').searchParams.get('name') || 'input');
            const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            file = path.join(tmpDir, id + path.extname(name).toLowerCase());
            await pipeline(req, fs.createWriteStream(file));
            // A body that stops early would only fail later as an
            // "unrecognisable media file", so compare it with what was promised.
            const written = (await fsp.stat(file)).size;
            const expected = Number(req.headers['content-length'] || 0);
            if (expected && written !== expected) {
              await fsp.rm(file, { force: true }).catch(() => {});
              console.error(`[dsh-media-converter] upload truncated: ${name} got ${written} of ${expected} bytes`);
              return json(res, 200, { ok: false, error: `上传不完整：收到 ${written} 字节，应为 ${expected} 字节` });
            }
            const stderr = await probe(ffmpeg, file);
            const kind = kindOf(name, stderr);
            if (!kind) {
              await fsp.rm(file, { force: true }).catch(() => {});
              console.error(`[dsh-media-converter] unrecognised media: ${name} (${written} bytes)`);
              return json(res, 200, { ok: false, error: '无法识别的媒体文件（支持视频、音频、图片）——文件可能已损坏或格式不支持' });
            }
            const upload = {
              id, name, path: file, kind,
              duration: parseDuration(stderr),
              size: written,
              streams: parseStreams(stderr),
              at: Date.now(),
            };
            uploads.set(id, upload);
            json(res, 200, {
              ok: true, id, name, kind: upload.kind, duration: upload.duration,
              size: upload.size, streams: upload.streams, meta: parseMeta(stderr),
            });
          } catch (err) {
            // A cancelled or broken upload must not leave its copy behind.
            if (file) await fsp.rm(file, { force: true }).catch(() => {});
            console.error('[dsh-media-converter] upload failed:', (err && err.message) || err);
            json(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/convert`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
          if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' });
          if (!ffmpeg) return json(res, 200, noFfmpeg);
          try {
            const body = await readJson(req);
            const upload = uploads.get(body.id);
            if (!upload) return json(res, 200, { ok: false, error: '文件已失效，请重新选择' });
            const job = await startJob(upload, planFor(upload, body), normalizeTrim(body.trim, upload.duration), String(body.name || '').trim());
            json(res, 200, { ok: true, job });
          } catch (err) {
            json(res, 200, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/cancel`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
          if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' });
          try {
            const body = await readJson(req);
            const job = jobs.get(String(body.id || ''));
            if (!job) return json(res, 200, { ok: false, error: '任务不存在' });
            if (job.state !== 'running') return json(res, 200, { ok: true, state: job.state });
            // ffmpeg needs a moment to die, so the job is "cancelling" until the
            // process is really gone.
            job.state = 'cancelling';
            job.error = null;
            const entry = controllers.get(job.id);
            if (entry) {
              entry.controller.abort();
              // ffmpeg leaves on SIGTERM at the next frame; if it is stuck in a
              // decoder, make sure it really stops burning the CPU.
              entry.killTimer = setTimeout(() => {
                if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
              }, 3000);
              entry.killTimer.unref();
            }
            json(res, 200, { ok: true, state: job.state });
          } catch (err) {
            json(res, 200, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/job`,
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
          const id = new URL(req.url, 'http://localhost').searchParams.get('id');
          const job = jobs.get(id);
          if (!job) return json(res, 404, { ok: false, error: '任务不存在' });
          json(res, 200, { ok: true, ...job });
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/preview`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
          const file = new URL(req.url, 'http://localhost').searchParams.get('file');
          if (!insideOutput(file)) return json(res, 403, { ok: false, error: '只能预览输出目录里的文件' });
          await serveFile(req, res, file);
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/reveal`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
          if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' });
          try {
            const { file } = await readJson(req);
            if (!insideOutput(file)) return json(res, 200, { ok: false, error: '只能打开输出目录里的文件' });
            const { command, args } = revealCommand(file, process.platform);
            spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
            json(res, 200, { ok: true });
          } catch (err) {
            json(res, 200, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/base64`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
          if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' });
          let upload;
          let mime;
          try {
            const body = await readJson(req);
            upload = uploads.get(body.id);
            if (!upload) return json(res, 200, { ok: false, error: '文件已失效，请重新选择' });
            if (upload.size > MAX_BASE64_BYTES) {
              return json(res, 200, { ok: false, error: `文件 ${(upload.size / 1048576).toFixed(1)} MB 超过 Base64 上限（24 MB）` });
            }
            mime = mimeOf(upload.name);
          } catch (err) {
            return json(res, 200, { ok: false, error: String((err && err.message) || err) });
          }
          // The payload is streamed out: a 24 MB file must not become one
          // 32 MB string inside the Host, and the encoder keeps the event loop
          // free while it works.
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.write(`{"ok":true,"mime":${JSON.stringify(mime)},"size":${upload.size},"data":"data:${mime};base64,`);
          try {
            await pipeline(fs.createReadStream(upload.path, { highWaterMark: 3 * 65536 }), base64Encoder(), res, { end: false });
          } catch {
            res.destroy();
            return;
          }
          res.end('"}');
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}/decode`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
          if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden origin' });
          try {
            const body = await readJson(req);
            const payload = decodeBase64Payload(body.text);
            if (payload.kind === 'text') return json(res, 200, { ok: true, kind: 'text', text: payload.text });
            await fsp.mkdir(outDir, { recursive: true });
            const stamp = Date.now().toString(36);
            const file = path.join(outDir, `decoded-${stamp}.${payload.ext}`);
            await fsp.writeFile(file, payload.bytes);
            json(res, 200, {
              ok: true, kind: kindByExt(payload.ext), file, mime: payload.mime, size: payload.bytes.length,
            });
          } catch (err) {
            json(res, 200, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }),
    ];
    return () => {
      clearInterval(pruneTimer);
      disposers.forEach((dispose) => dispose());
      for (const child of children) child.kill('SIGTERM');
      for (const upload of uploads.values()) fs.rm(upload.path, { force: true }, () => {});
      uploads.clear();
      jobs.clear();
      controllers.clear();
    };
  });
}
