// DSH Host plugin: local media toolkit — convert, trim, extract tracks, and
// move media to/from Base64 through ffmpeg.
//
// The Web page (client.js) never touches the filesystem: it uploads picked
// files to this plugin's same-origin routes, the Host runs one ffmpeg process
// per job, and the page polls the job for progress. Results land in
// ~/Downloads/media-toolbox (config.outputDir overrides it) and are served back
// for preview from that same directory only.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { decodeBase64Payload } from './lib/base64.js';
import {
  FORMATS, buildArgs, extOf, extractPlan, kindByExt, kindOf, metaArgs, mimeOf, normalizeTrim,
  parseDuration, parseMeta, parseStreams, percentOf, progressSeconds, subtitlePlan, trimArgs,
} from './lib/plan.js';

const PREFIX = '/api/media-convert';
const MAX_BASE64_BYTES = 24 * 1024 * 1024;

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
  const root = path.join(os.homedir(), 'Library', 'Python');
  try {
    return fs.readdirSync(root).flatMap((version) => {
      const dir = path.join(root, version, 'lib', 'python', 'site-packages', 'imageio_ffmpeg', 'binaries');
      try {
        return fs.readdirSync(dir).filter((f) => f.startsWith('ffmpeg-')).map((f) => path.join(dir, f));
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function findFfmpeg(configured) {
  const candidates = [
    configured,
    process.env.FFMPEG_PATH,
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'ffmpeg')),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    ...imageioBinaries(),
  ];
  return candidates.find((c) => c && isExecutable(c)) || null;
}

function safeBaseName(raw) {
  const base = path.basename(String(raw || 'input'));
  const stem = base.replace(/\.[^.]*$/, '') || 'output';
  return stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'output';
}

function probe(ffmpeg, file) {
  return new Promise((resolve) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file], { timeout: 20000 }, (_error, _stdout, stderr) => {
      resolve(String(stderr || ''));
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

export function apply(ctx, config) {
  const cfg = config || {};
  const outDir = cfg.outputDir || path.join(os.homedir(), 'Downloads', 'media-toolbox');
  const tmpDir = path.join(os.tmpdir(), 'dsh-media-toolbox');
  const ffmpeg = findFfmpeg(cfg.ffmpegPath);

  const uploads = new Map();
  const jobs = new Map();
  const children = new Set();

  const webServer = ctx.get('webServer');
  if (!webServer) return;
  const noFfmpeg = { ok: false, error: '未找到 ffmpeg：请先安装（brew install ffmpeg），或用 FFMPEG_PATH / 插件配置 ffmpegPath 指定路径' };

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

  const uniqueOutput = (name, extension, suffix = '') => {
    const stem = safeBaseName(name) + suffix;
    const candidate = path.join(outDir, `${stem}.${extension}`);
    return fs.existsSync(candidate) ? path.join(outDir, `${stem}-${Date.now().toString(36)}.${extension}`) : candidate;
  };

  const startJob = (upload, plan, trim, name) => {
    fs.mkdirSync(outDir, { recursive: true });
    const out = uniqueOutput(name || upload.name, plan.ext, plan.stemSuffix || '');
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
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);

    let buffered = '';
    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const seconds = progressSeconds(line);
        if (seconds !== null) job.percent = percentOf(seconds, span);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      tail = (tail + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      job.state = 'error';
      job.error = String((err && err.message) || err);
    });
    child.on('close', (code) => {
      children.delete(child);
      if (job.state !== 'running') return;
      try {
        if (code !== 0) throw new Error(`ffmpeg 退出码 ${code}`);
        job.size = fs.statSync(out).size;
        job.state = 'done';
        job.percent = 100;
      } catch (err) {
        // ffmpeg can create the output before failing; never report that as done.
        fs.rmSync(out, { force: true });
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
  const serveFile = (req, res, file) => {
    let size;
    try {
      size = fs.statSync(file).size;
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
          try {
            const name = path.basename(new URL(req.url, 'http://localhost').searchParams.get('name') || 'input');
            const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const file = path.join(tmpDir, id + path.extname(name).toLowerCase());
            await pipeline(req, fs.createWriteStream(file));
            const stderr = await probe(ffmpeg, file);
            const kind = kindOf(name, stderr);
            if (!kind) {
              fs.rmSync(file, { force: true });
              return json(res, 200, { ok: false, error: '无法识别的媒体文件（支持视频、音频、图片）' });
            }
            const upload = {
              id, name, path: file, kind,
              duration: parseDuration(stderr),
              size: fs.statSync(file).size,
              streams: parseStreams(stderr),
            };
            uploads.set(id, upload);
            json(res, 200, {
              ok: true, id, name, kind: upload.kind, duration: upload.duration,
              size: upload.size, streams: upload.streams, meta: parseMeta(stderr),
            });
          } catch (err) {
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
            const job = startJob(upload, planFor(upload, body), normalizeTrim(body.trim, upload.duration), String(body.name || '').trim());
            json(res, 200, { ok: true, job });
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
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
          const file = new URL(req.url, 'http://localhost').searchParams.get('file');
          if (!insideOutput(file)) return json(res, 403, { ok: false, error: '只能预览输出目录里的文件' });
          serveFile(req, res, file);
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
            if (process.platform !== 'darwin') return json(res, 200, { ok: false, error: '仅在 macOS 上支持' });
            if (!insideOutput(file)) return json(res, 200, { ok: false, error: '只能打开输出目录里的文件' });
            spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
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
          try {
            const body = await readJson(req);
            const upload = uploads.get(body.id);
            if (!upload) return json(res, 200, { ok: false, error: '文件已失效，请重新选择' });
            if (upload.size > MAX_BASE64_BYTES) {
              return json(res, 200, { ok: false, error: `文件 ${(upload.size / 1048576).toFixed(1)} MB 超过 Base64 上限（24 MB）` });
            }
            const mime = mimeOf(upload.name);
            const data = `data:${mime};base64,${fs.readFileSync(upload.path).toString('base64')}`;
            json(res, 200, { ok: true, mime, size: upload.size, data });
          } catch (err) {
            json(res, 200, { ok: false, error: String((err && err.message) || err) });
          }
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
            fs.mkdirSync(outDir, { recursive: true });
            const stamp = Date.now().toString(36);
            const file = path.join(outDir, `decoded-${stamp}.${payload.ext}`);
            fs.writeFileSync(file, payload.bytes);
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
      disposers.forEach((dispose) => dispose());
      for (const child of children) child.kill('SIGTERM');
      for (const upload of uploads.values()) fs.rmSync(upload.path, { force: true });
      uploads.clear();
      jobs.clear();
    };
  });
}
