#!/usr/bin/env node
// 假绿防线：对源码逐一注入已知的「回归性突变」，断言对应测试一定转红。
// 任一突变后测试仍绿 = 测试是摆设（false green），本脚本以非零退出。
//
// 纪律（来自 gotchas/attack-script-hardcoded-path-false-green 的本仓适配）：
// - 单 ROOT 派生全部路径，不用 heredoc 拼绝对路径；
// - 每个突变先断言源码锚点（apply 内 assert），构建后再断言 dist 产物
//   （host 测试读的是 ../dist/index.js —— 只改源码不重建等于没突变）；
// - 每轮之间恢复源码并跑基线，结束时恢复 + 复绿，仓库必须留在可用状态；
// - 删除型突变先审基线 dist 里锚点确实存在，防止「锚点本就不在产物里」假通过。
//
// 两个本仓踩过的坑，别再犯：
// - 不要在 bash -c 字符串里做 && 相关的源码手术（转义地狱），全在 Node 内替换；
// - 任何让参数 / import「只声明不使用」的突变（删返回体字段、删某参数的唯一
//   使用行）都会触发 TS6133 构建失败，测试根本没跑——那不是红。要换成
//   保活读取的等价语义突变：字段用 `queueLimit && 0`（A2），删除型整行改用
//   反转条件（A3 的 `===` → `!==`），调用点静态化时连 import 一起处理（A7）。
//
// 第三个坑（本次新增）：硬件编码的新逻辑一半在 lib/ 里，lib 的测试是纯函数
// 测试，不需要 ffmpeg。所以每个突变可以点名自己的源文件、测试和产物文件，
// 默认仍是 index.ts + host.test.mjs + dist/index.js。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A mutant may point at another source file, another test and another built
// file. The defaults keep the original behaviour.
const DEFAULTS = { source: 'index.ts', test: 'test/host.test.mjs', dist: 'dist/index.js' };

/** @param {object} mutant @param {'source'|'test'|'dist'} key */
const pathOf = (mutant, key) => path.join(ROOT, mutant[key] || DEFAULTS[key]);

// The pristine text of every file a mutant touches, so each round starts from
// the same tree and the repository is left as it was found.
const originals = new Map();
function originalOf(file) {
  if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
  return originals.get(file);
}

/** @param {string} s @param {string} oldText @param {string} newText */
function replaceOnce(s, oldText, newText) {
  if (!s.includes(oldText)) throw new Error(`源码锚点缺失：${oldText.slice(0, 60)}…`);
  if (s.indexOf(oldText) !== s.lastIndexOf(oldText)) throw new Error(`源码锚点不唯一：${oldText.slice(0, 60)}…`);
  return s.replace(oldText, newText);
}

// Windows scanners can hold a source file open for a moment, and a
// transient lock must not abort the gate or leave the tree mutated. Retrying
// the write is enough; the tree is only rewritten with the same bytes.
function writeFileRobust(file, text) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(file, text);
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      // 100ms, 200ms, 400ms, 800ms
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * 2 ** attempt);
    }
  }
}

/** @param {string} s @param {string} line 整行去掉（行首空白任意） */
function deleteLine(s, line) {
  const lines = s.split('\n');
  const hits = lines.filter((l) => l.trim() === line);
  if (hits.length !== 1) throw new Error(`行锚点命中 ${hits.length} 次：${line}`);
  return lines.filter((l) => l.trim() !== line).join('\n');
}

const MUTANTS = [
  {
    id: 'A1',
    name: 'uploadTtlMinutes 下限失效（5 → 500）',
    apply: (s) => replaceOnce(s, 'minutes < 5', 'minutes < 500'),
    distAnchor: '< 500',
    expect: '保存 uploadTtlMinutes: 5 必须被钳到 5，突变后钳到 500',
  },
  {
    id: 'A2',
    name: '/status 不回传真实 queueLimit（恒 0）',
    apply: (s) => replaceOnce(s, '  queueLimit,\n  instanceId,', '  queueLimit: queueLimit && 0,\n  instanceId,'),
    distAnchor: 'queueLimit && 0',
    expect: '/status 的 queueLimit 必须是 2000，突变后为 0',
  },
  {
    id: 'A3',
    name: 'sweep 不再跳过 running 任务的源文件',
    // 不能整行删：jobs 参数只有这一处使用，删掉会 TS6133 构建失败（假红）。
    // 反转条件等价于永不跳过，且仍读取 jobs。
    apply: (s) => replaceOnce(s, 'job.uploadId === id && job.state ===', 'job.uploadId !== id && job.state ==='),
    // upload/delete 路由也有一处 `job.uploadId === id && (job.state ===`，锚点
    // 必须带 `job.state ===` 后缀区分开，否则突变后产物「仍含锚点」误报。
    distAnchor: 'job.uploadId === id && job.state ===',
    expect: 'pruneUploads 必须保下 running 任务的上传，突变后永不跳过 → 测试红',
    delete: true,
  },
  {
    id: 'A4',
    name: 'done 落点不再写历史账本',
    apply: (s) => deleteLine(s, "record('done', job.size, null);"),
    distAnchor: "record('done', job.size, null)",
    expect: '真实转换后 JSONL 必须多一行 done，突变后行数不变 → 测试红',
    delete: true,
  },
  {
    id: 'A5',
    name: '历史行 deleted 恒 false',
    apply: (s) => deleteLine(s, 'deleted = true;'),
    distAnchor: 'deleted = true;',
    expect: '输出文件已删除的历史行必须 deleted=true，突变后恒 false → 测试红',
    delete: true,
  },
  {
    id: 'A6',
    name: '账本坏行容错被移除（遇坏行整体报错）',
    apply: (s) =>
      replaceOnce(
        s,
        `              } catch {
                // A torn or hand-edited line never takes the whole ledger down.
              }`,
        `              } catch {
                throw new Error('A6');
              }`,
      ),
    distAnchor: 'A6',
    expect: '账本里一行坏数据必须被跳过，突变后整页报错 → 测试红',
  },
  {
    id: 'A7',
    name: 'instanceId 恒定（重启检测失效）',
    // 调用点与 import 必须一起换：只静态化调用会留下未用的 randomUUID
    // import 触发 TS6133，测试根本没跑（假红）。
    apply: (s) =>
      replaceOnce(
        replaceOnce(s, "import { randomUUID } from 'node:crypto';", '// mutant removed the randomUUID import'),
        'const instanceId = randomUUID();',
        "const instanceId = 'deadbeef';",
      ),
    distAnchor: 'deadbeef',
    expect: '/status 必须携带 UUID 形态的 instanceId，突变后为 deadbeef → 测试红',
  },
  {
    id: 'A8',
    name: '历史删除的 insideOutput 守卫失效（可删输出目录外文件）',
    // 整行删除：target 下方 fsp.rm 仍在用，不会 TS6133；守卫没了 → 穿越行被 unlink。
    // dist 锚点用调用本身——构建器会把整行 if 断行，带 continue 的长锚点匹配不到。
    apply: (s) => deleteLine(s, 'if (!insideOutput(target)) continue;'),
    distAnchor: 'insideOutput(target)',
    expect: '指向输出目录外的账本行绝不能 unlink 其文件，突变后 escape.txt 被删 → 测试红',
    delete: true,
  },
  {
    id: 'A9',
    name: '硬件后端不再经过真机验证（设备检查形同虚设）',
    // deviceCheck 仍在调用（不能让它变成只声明不使用，否则 TS6133 构建失败
    // = 假红），只是它的结果不再决定选哪个后端。
    apply: (s) =>
      replaceOnce(
        s,
        '      await run(deviceArgs(candidate, candidate.encoder), DEVICE_TIMEOUT_MS);\n      return true;\n    } catch {\n      return false;\n    }',
        '      await run(deviceArgs(candidate, candidate.encoder), DEVICE_TIMEOUT_MS);\n      return true;\n    } catch {\n      return candidate.encoder.length > 0;\n    }',
      ),
    distAnchor: 'candidate.encoder.length > 0',
    expect: '显卡不能编码时不得给用户 GPU 开关，突变后坏设备也报 nvenc → 测试红',
  },
  {
    id: 'A10',
    name: 'Windows 候选后端被清空（Windows 永远没有硬件路径）',
    source: 'lib/platform.ts',
    test: 'test/platform.test.mjs',
    dist: 'dist/lib/platform.js',
    apply: (s) =>
      replaceOnce(
        s,
        "if (platform === 'win32') return ['nvenc', 'amf', 'qsv'];",
        "if (platform === 'win32') return [];",
      ),
    distAnchor: '        return [];',
    expect: 'win32 必须给出 nvenc/amf/qsv 三个候选，突变后为空 → 测试红',
  },
  {
    id: 'A11',
    name: 'NVENC 编码器名写错（真实转码会立刻失败）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, "encoder: 'h264_nvenc',", "encoder: 'h264_nvencc',"),
    distAnchor: 'h264_nvencc',
    expect: 'nvenc 后端必须用 h264_nvenc，突变后拼出 ffmpeg 不认识的编码器 → 测试红',
  },
  {
    id: 'A12',
    name: '设备检查又用回长超时（驱动挂住就拖住面板）',
    // 设备检查会启动显卡驱动，必须有自己的短时钟：挂住的驱动只该等一次。
    // Math.max 而不是直接换成 FFMPEG_TIMEOUT_MS：那样 DEVICE_TIMEOUT_MS
    // 就没人用了，TS6133 让构建炸掉——那是假红，不是测试红。突变点是
    // pickBackend 的 H.264 检查（第一个 color= 调用），探针断言按首个
    // color= 调用取超时。
    apply: (s) =>
      replaceOnce(
        s,
        'await run(deviceArgs(candidate, candidate.encoder), DEVICE_TIMEOUT_MS);',
        'await run(deviceArgs(candidate, candidate.encoder), Math.max(DEVICE_TIMEOUT_MS, FFMPEG_TIMEOUT_MS));',
      ),
    distAnchor: 'Math.max(DEVICE_TIMEOUT_MS',
    expect: '设备检查必须用比编码器列表更短的时钟，突变后驱动挂住会拖住面板 → 测试红',
  },
  {
    id: 'A13',
    name: '探测失败时格式表不再回退（面板一个格式都不能转）',
    // 回退表被掏空，而不是换成 supportedFormats([])：那样 FORMATS 没人用了，
    // TS6133 让构建炸掉——那是假红，不是测试红。
    apply: (s) =>
      replaceOnce(
        s,
        'build?.encoders.length ? supportedFormats(build.encoders) : FORMATS',
        'build?.encoders.length ? supportedFormats(build.encoders) : { ...FORMATS, video: [] }',
      ),
    distAnchor: 'video: []',
    expect: '列不出编码器的 ffmpeg 必须回退到内置格式表，突变后面板是空的 → 测试红',
  },
  {
    id: 'A15',
    name: '缓存命中时不落地判定（插件重载后永远「检测中」）',
    // 判定必须写进实例：缓存按 ffmpeg 路径活得更久，插件重载后的新实例只能
    // 接管已缓存的判定。把落地逻辑放回「缓存未命中」分支，命中缓存时就没人
    // 写新实例的状态了——面板会永远停在「显卡驱动检测中」。落地 then 必须
    // 原样返回 verdict（而不是返回 hwBackend），否则缓存类型对不上 TS 编译炸
    // = 假红；返回端用一次性的 then 摘出 backend 保持签名。
    apply: (s) =>
      replaceOnce(
        s,
        `    let pending = deviceCache.get(bin);
    if (!pending) {
      pending = probeFfmpegDevice(process.platform, build, execRunner(bin)).catch(() => null);
      deviceCache.set(bin, pending);
    }
    // The cache outlives the instance: whoever asks adopts the verdict, so a
    // reloaded plugin does not wait for a probe that already ran.
    return pending.then((verdict) => {
      hwBackend = verdict ? verdict.backend : null;
      hwHevc = verdict ? verdict.hevc : false;
      deviceSettled = true;
      return hwBackend;
    });`,
        `    let pending = deviceCache.get(bin);
    if (!pending) {
      pending = probeFfmpegDevice(process.platform, build, execRunner(bin))
        .catch(() => null)
        .then((verdict) => {
          hwBackend = verdict ? verdict.backend : null;
          hwHevc = verdict ? verdict.hevc : false;
          deviceSettled = true;
          return verdict;
        });
      deviceCache.set(bin, pending);
    }
    return pending.then((verdict) => (verdict ? verdict.backend : null));`,
      ),
    distAnchor: 'return pending.then((verdict) => {',
    delete: true,
    expect: '插件重载后的新实例必须接管已缓存的判定，突变后 GPU 开关永远不出现 → 测试红',
  },
  {
    id: 'A14',
    name: 'detecting 说反了（面板以为检测完了）',
    apply: (s) => replaceOnce(s, 'detecting: !deviceSettled,', 'detecting: deviceSettled,'),
    distAnchor: 'detecting: deviceSettled,',
    expect: '设备检查没跑完时 detecting 必须为真，突变后面板不再等判定 → 测试红',
  },
  {
    id: 'B1',
    name: '音频码率参数被旁路（applyAudioTune 恒写 192k）',
    // 钳制行已随助手抽取移到 applyAudioTune（内部没有 format 入参，旧突变
    // 形态 TS2304 编不过）；等价语义：替换值不再来自入参 —— 显式 128 也回 192。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "args[at + 1] = String(Math.min(320, Math.max(32, Math.round(Number(bitrate))))) + 'k';",
        "args[at + 1] = '192k';",
      ),
    distAnchor: "args[at + 1] = '192k'",
    expect: '显式码率必须替换 -b:a（128 → 128k），突变后恒为 192k → 测试红',
  },
  {
    id: 'B2',
    name: '码率 copy 规则反转（显式 128k 反而走拷贝）',
    // 仍读取 body.bitrate，不会 TS6133；语义反转后只有「恰好要默认码率」
    // 才重编码 —— 与需求正好相反。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        'Math.round(Number(body.bitrate)) !== defaultBitrate(format);',
        'Math.round(Number(body.bitrate)) === defaultBitrate(format);',
      ),
    distAnchor: 'Math.round(Number(body.bitrate)) === defaultBitrate(format)',
    expect: '显式非默认码率必须禁用 copy 走重编码，突变后 128k 被静默拷贝 → 测试红',
  },
  {
    id: 'B3',
    name: '/run 行级码率不再进 items（固定规则批量丢失码率）',
    // br 仍被读取使用，不会 TS6133；恒 0 越不过 >= 32 的闸 → 行级码率全丢。
    apply: (s) => replaceOnce(s, 'const br = Number(row.bitrate);', 'const br = Number(row.bitrate) * 0;'),
    distAnchor: 'Number(row.bitrate) * 0',
    expect: '固定规则批量的行级码率必须到达 planFor，突变后批量输出回到拷贝/192k → 测试红',
  },
  {
    id: 'B4',
    name: 'PTC convert 绑定丢弃码率（计划带了也白搭）',
    // 正式 planFor 的 bitrate 恒 0（被忽略），estimate 那处不动：调度权重
    // 照常，但产物回到拷贝/默认码率。锚点带 threads 上下文区分 estimate 调用。
    apply: (s) =>
      replaceOnce(
        s,
        `                  quality: Number(a.quality ?? quality),
                  bitrate: Number(a.bitrate ?? entry?.bitrate),
                  fps: Number(a.fps ?? entry?.fps),`,
        `                  quality: Number(a.quality ?? quality),
                  bitrate: Number(a.bitrate ?? entry?.bitrate) * 0,
                  fps: Number(a.fps ?? entry?.fps),`,
      ),
    distAnchor: 'Number(a.bitrate ?? entry?.bitrate) * 0',
    expect: 'PTC 计划里的码率必须作用到产物，突变后输出为拷贝/默认码率 → 测试红',
  },
  {
    id: 'B5',
    name: '音频声道/采样率被旁路（buildArgs 恒不写 -ac/-ar）',
    // channels/sampleRate 仍在条件里被读取（Number(...)），不会 TS6133；
    // 条件永假后任何 downmix 请求都静默丢弃。锚点是单行 if（无花括号）。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'if (supportsAudioTune(kind, format)) applyAudioTune(args, bitrate, channels, sampleRate);',
        'if (false && supportsAudioTune(kind, format)) applyAudioTune(args, bitrate, channels, sampleRate);',
      ),
    distAnchor: 'false && supportsAudioTune',
    expect: 'mono/22050 请求必须写出 -ac/-ar，突变后产物回源布局 → 测试红',
  },
  {
    id: 'B6',
    name: 'mono 请求被 copy 短路（audioTuned 门失效）',
    // 条件永假后 mono 请求拿回拷贝的立体声——host 的 copy-trap 探针必红。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        'supportsAudioTune(upload.kind, format) && (Number(body.channels) > 0 || Number(body.sampleRate) > 0);',
        'supportsAudioTune(upload.kind, format) && (Number(body.channels) < 0 || Number(body.sampleRate) < 0);',
      ),
    distAnchor: 'body.channels) < 0',
    expect: 'mono 请求必须绕开拷贝路径，突变后 result.copy 变 true → 测试红',
  },
  {
    id: 'B7',
    name: '/run 行级声道/采样率不进 items（固定批量丢失）',
    // ch 仍被 Number.isFinite 读取，不会 TS6133；范围永假后行参数被丢弃，
    // 批量 mono 请求回落拷贝路径。
    apply: (s) =>
      replaceOnce(
        s,
        'channels: Number.isFinite(ch) && ch >= 1 && ch <= 2 ? Math.round(ch) : undefined,',
        'channels: Number.isFinite(ch) && ch >= 9 && ch <= 2 ? Math.round(ch) : undefined,',
      ),
    distAnchor: 'ch >= 9 && ch <= 2',
    expect: '固定批量的行级声道必须到达编码器，突变后输出回源布局 → 测试红',
  },
  {
    id: 'B8',
    name: 'PTC convert 绑定丢弃声道/采样率（计划带了也白搭）',
    // 正式 planFor 的 channels 恒 0（被忽略），estimate 那处不动。锚点带
    // fps/width 上下文区分 estimate 调用。
    apply: (s) =>
      replaceOnce(
        s,
        `                  fps: Number(a.fps ?? entry?.fps),
                  width: Number(a.width ?? entry?.width),
                  channels: Number(a.channels ?? entry?.channels),`,
        `                  fps: Number(a.fps ?? entry?.fps),
                  width: Number(a.width ?? entry?.width),
                  channels: Number(a.channels ?? entry?.channels) * 0,`,
      ),
    distAnchor: 'Number(a.channels ?? entry?.channels) * 0',
    expect: 'PTC 计划里的声道必须作用到产物，突变后输出回立体声 → 测试红',
  },
  {
    id: 'B9',
    name: 'GPU 路径音轨参数被旁路（hardwareFor 恒写 HW_AUDIO 默认）',
    // Number() 包裹保持读取（裸 `bitrate * 0` 会撞 strict 空检查 TS18048，
    // 构建失败不是红）；恒 0 后任何音轨请求都静默丢弃，与软件路径分叉。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        '...applyAudioTune(audio.slice(), bitrate, channels, sampleRate),',
        '...applyAudioTune(audio.slice(), Number(bitrate) * 0, Number(channels) * 0, Number(sampleRate) * 0),',
      ),
    distAnchor: 'Number(bitrate) * 0, Number(channels) * 0, Number(sampleRate) * 0',
    expect: 'GPU 路径的 -b:a/-ac/-ar 必须来自入参，突变后音轨请求回配方默认 → 测试红',
  },
  {
    id: 'B10',
    name: 'GPU 音轨请求被 copy 短路（hwAudioTuned 门失效）',
    // 仍读取 body.bitrate/channels/sampleRate，不会 TS6133；门永假后
    // GPU+mono 请求拿回拷贝的立体声——host 的 GPU copy-trap 探针必红。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        `supportsHardwareAudio(format) &&
    (Number(body.bitrate) > 0 || Number(body.channels) > 0 || Number(body.sampleRate) > 0);`,
        `supportsHardwareAudio(format) &&
    (Number(body.bitrate) > 0 || Number(body.channels) < 0 || Number(body.sampleRate) > 0);`,
      ),
    distAnchor: 'Number(body.channels) < 0 || Number(body.sampleRate) > 0',
    expect: 'GPU 音轨请求必须绕开拷贝路径，突变后 result.copy 变 true → 测试红',
  },
  {
    id: 'B11',
    name: 'width 请求被 copy 短路（videoTuneTuned 门失效）',
    // body.width 仍被读取（< 0 永假），不会 TS6133；门失效后 width 请求拿回
    // 拷贝的源流——host 的 width copy 门用例必红。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        'supportsVideoTune(upload.kind, format) && (Number(body.fps) > 0 || Number(body.width) > 0);',
        'supportsVideoTune(upload.kind, format) && (Number(body.fps) > 0 || Number(body.width) < 0);',
      ),
    distAnchor: 'body.width) < 0',
    expect: '显式 width 必须绕开拷贝路径，突变后 result.copy 变 true → 测试红',
  },
  {
    id: 'B12',
    name: 'GPU 分支不拦 width 请求（-vf 打断零拷贝）',
    // videoTuneTuned 仍被 copy 门读取，不会 TS6133；有后端时 width 请求错误地
    // 骑上 GPU 计划——host 的 gpuWidth 用例必红。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(s, 'if (body.hardware && hwBackend && !videoTuneTuned) {', 'if (body.hardware && hwBackend) {'),
    distAnchor: 'if (body.hardware && hwBackend) {',
    expect: '带 width/fps 的请求必须走软件编码，突变后（有后端时）job.hardware 变 true → 测试红',
  },
  {
    id: 'C1',
    name: '视频 fps/width 被旁路（-vf 永不重建/生成）',
    // false && 仍读取 fps/width 与 supportsVideoTune，不会 TS6133；条件永假后
    // gif 回配方 12fps/640px、普通视频容器拿不到 -vf。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'if (supportsVideoTune(kind, format) && (Number(fps) > 0 || Number(width) > 0)) {',
        'if (false && supportsVideoTune(kind, format) && (Number(fps) > 0 || Number(width) > 0)) {',
      ),
    distAnchor: 'false && supportsVideoTune',
    expect: '显式 fps/width 必须生成/重建 -vf（gif 与普通容器），突变后 gif 回默认、mp4 无滤镜 → 测试红',
  },
  {
    id: 'C2',
    name: '字幕导出格式被旁路（恒写 srt 编码器）',
    // format 仍用于 ext 与白名单校验，不会 TS6133；编码器名恒 srt 后
    // vtt/ass 导出名对实不对。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "args: ['-map', `0:s:${Number(ordinal)}`, '-c:s', format === 'vtt' ? 'webvtt' : format],",
        "args: ['-map', `0:s:${Number(ordinal)}`, '-c:s', 'srt'],",
      ),
    distAnchor: "'-c:s', 'srt'",
    expect: 'vtt 导出必须用 webvtt 编码器、ass 用 ass，突变后全写成 srt → 测试红',
  },
  {
    id: 'C3',
    name: '/run 行级 GIF 参数不再进 items（固定批量丢失）',
    // gf/gw 仍被读取使用，不会 TS6133；恒 0 越不过 >= 1 / >= 16 的闸。
    apply: (s) =>
      replaceOnce(
        s,
        'const gf = Number(row.fps);\n              const gw = Number(row.width);',
        'const gf = Number(row.fps) * 0;\n              const gw = Number(row.width) * 0;',
      ),
    distAnchor: 'Number(row.fps) * 0',
    expect: '固定规则批量的行级 fps/width 必须到达 planFor，突变后批量产物回默认 12/640 → 测试红',
  },
  {
    id: 'C4',
    name: 'PTC convert 绑定丢弃 GIF 参数（计划带了也白搭）',
    // 正式 planFor 的 fps/width 恒 NaN（被忽略），estimate 那处本就不传。
    apply: (s) =>
      replaceOnce(
        s,
        `                  fps: Number(a.fps ?? entry?.fps),
                  width: Number(a.width ?? entry?.width),`,
        `                  fps: Number(a.fps ?? entry?.fps) * 0,
                  width: Number(a.width ?? entry?.width) * 0,`,
      ),
    distAnchor: 'Number(a.fps ?? entry?.fps) * 0',
    expect: 'PTC 计划里的 gif 参数必须作用到产物，突变后输出回默认 12fps/640px → 测试红',
  },
  {
    id: 'C5',
    name: '单任务 /convert 的 GIF 参数不进 buildArgs',
    // body.fps/width 仍被 /run 路由与 PTC 绑定读取，不会 TS6133；只有
    // planFor 这条汇流点被掐断。channels/sampleRate 保持入参——它们走的是
    // 同一调用但不是本突变的目标（B5-B8 守它们）。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        `      body.fps,
      body.width,
      body.channels,`,
        `      0,
      0,
      body.channels,`,
      ),
    distAnchor: 'body.bitrate, 0, 0',
    expect: '单任务转换的 fps/width 必须到达 ffmpeg 参数，突变后产物回默认 12/640 → 测试红',
  },
  {
    id: 'C6',
    name: '字幕导出丢面板选的格式（恒默认 srt）',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        'subtitlePlan(upload.streams, body.stream, body.format ? String(body.format) : undefined)',
        'subtitlePlan(upload.streams, body.stream)',
      ),
    distAnchor: 'subtitlePlan(upload.streams, body.stream)',
    expect: '面板/工具选的 vtt/ass 必须到达 subtitlePlan，突变后全部导成 srt → 测试红',
  },
  {
    id: 'C7',
    name: '普通视频容器的 -vf 被旁路（gif 分支正常）',
    // Number(fps) < 0 永假但保活读取，不会 TS6133；gif 走另一个分支不受影响，
    // 专守泛化后「非 gif 容器 push -vf」这条新路径。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "      args.push('-vf', parts.join(','));",
        "      if (Number(fps) < 0) args.push('-vf', parts.join(','));",
      ),
    distAnchor: 'Number(fps) < 0',
    expect: '普通视频容器的 fps/width 必须 push 出 -vf，突变后 gif 正常、mp4 无滤镜 → 测试红',
  },
  {
    id: 'D1',
    name: 'HEVC 的 hvc1 容器标签被旁路（Apple 播放器拒播）',
    // wantHevc 仍被编码器选择行读取，不会 TS6133；条件永假后 mp4/mov 不再
    // 补 -tag:v hvc1。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "...(wantHevc && (format === 'mp4' || format === 'mov') ? ['-tag:v', 'hvc1'] : []),",
        "...(wantHevc && false && (format === 'mp4' || format === 'mov') ? ['-tag:v', 'hvc1'] : []),",
      ),
    distAnchor: 'wantHevc && false',
    expect: 'HEVC 进 mp4/mov 必须带 hvc1 tag，突变后 Apple 播放器拒播 → 测试红',
  },
  {
    id: 'D2',
    name: 'HEVC 编码器选择被旁路（恒 h264_videotoolbox）',
    // wantHevc 仍被 hvc1 标签行读取，不会 TS6133；编码器不再随 codec 换。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'const encoder = wantHevc ? backend.hevcEncoder : backend.encoder;',
        'const encoder = backend.encoder;',
      ),
    distAnchor: 'const encoder = backend.encoder;',
    expect: 'codec=hevc 必须选 hevcEncoder，突变后恒 h264 → 测试红',
  },
  {
    id: 'D3',
    name: 'PTC 计划 codec 校验反转（非法值不再报错）',
    // 条件尾加 && false 后恒假不抛错；value 仍被读取使用，不会 TS6133。
    // （不能直接改成 === && ===：TS2367 会抓「无交集的比较」让构建炸 = 假红）
    apply: (s) =>
      replaceOnce(
        s,
        "if (value !== 'h264' && value !== 'hevc') {",
        "if (value !== 'h264' && value !== 'hevc' && false) {",
      ),
    distAnchor: "value !== 'hevc' && false",
    expect: '模型计划的非法 codec 必须让整批报错，突变后静默按 h264 跑 → 测试红',
  },
  {
    id: 'D4',
    name: 'HEVC 探测的编译清单闸名存实亡（拿 h264 编码器名过闸）',
    // 闸还在、编码器名被换成 backend.encoder（选中后端时它必在清单里）：
    // 没编译 hevc 的二进制也跑设备检查；假 runner 对任何编码都成功 →
    // info.hevc 谎报为 true。任何机器可测。（true || 短路会让 TS 收窄失效炸构建）
    apply: (s) =>
      replaceOnce(
        s,
        'if (build.encoders.includes(backend.hevcEncoder)) {',
        'if (build.encoders.includes(backend.encoder)) {',
      ),
    distAnchor: 'if (build.encoders.includes(backend.encoder)) {',
    expect: '二进制没有 hevc 编码器时 info.hevc 必须为 false，突变后谎报可用 → 测试红',
  },
  {
    id: 'D5',
    name: 'PTC 程序不再携带 codec（计划带了也白搭）',
    // replacer 在序列化时丢掉 codec 字段；程序里没有了，绑定自然拿不到。
    apply: (s) =>
      replaceOnce(
        s,
        `      'const plan = ' +
      JSON.stringify(rows) +`,
        `      'const plan = ' +
      JSON.stringify(rows, (key, value) => (key === 'codec' ? undefined : value)) +`,
      ),
    distAnchor: "key === 'codec' ? undefined",
    expect: '模型计划的 codec 必须进入 PTC 程序 JSON，突变后程序里无 codec → 测试红',
  },
  {
    id: 'D6',
    name: 'codec 绕过 tuned 门（HEVC 请求被 copy 短路）',
    // 语义反转后 codec=hevc 不再拦 copy：源可拷时拿到原样拷贝，HEVC 请求
    // 被静默吞掉。copy===false 断言在无显卡机器上同样红（走软件重编码）。
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, "String(body.codec || '') === 'hevc';", "String(body.codec || '') !== 'hevc';"),
    distAnchor: "String(body.codec || '') !== 'hevc';",
    expect: 'codec=hevc 必须禁用 copy 走真实重编码，突变后拿到原样拷贝 → 测试红',
  },
  {
    id: 'E1',
    name: 'webm 的 vp9 CRF 钳制反转',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'return Math.min(45, Math.max(15, Math.round(32 + (90 - quality) * 0.3)));',
        'return Math.min(15, Math.max(45, Math.round(32 + (90 - quality) * 0.3)));',
      ),
    distAnchor: 'Math.min(15, Math.max(45',
    expect: 'vp9 CRF 必须钳在 15–45，突变后恒 15 → 测试红',
  },
  {
    id: 'E2',
    name: '视频 CRF 映射按格式互换（webm 拿到 x264 映射）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "args[at + 1] = String(format === 'webm' ? vp9CrfOf(q) : crfOf(q));",
        "args[at + 1] = String(format === 'webm' ? crfOf(q) : vp9CrfOf(q));",
      ),
    distAnchor: "format === 'webm' ? crfOf(q) : vp9CrfOf(q)",
    expect: 'webm 必须用 vp9CrfOf、x264 容器用 crfOf，突变后两边互换 → 测试红',
  },
  {
    id: 'E3',
    name: '视频 qscale 映射按格式互换（ogv 拿到 mjpeg 映射）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "args[atq + 1] = String(format === 'ogv' ? theoraQscale(q) : jpegQscale(q));",
        "args[atq + 1] = String(format === 'ogv' ? jpegQscale(q) : theoraQscale(q));",
      ),
    distAnchor: "format === 'ogv' ? jpegQscale(q) : theoraQscale(q)",
    expect: 'ogv 必须用 theora 的 0-10 映射、avi/wmv 用 mjpeg 式 qscale，突变后互换 → 测试红',
  },
  {
    id: 'R1',
    name: '注册表摘除 convert 条目',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, "id: 'convert',", "id: 'convert-removed',"),
    distAnchor: "id: 'convert-removed'",
    expect: 'convert 被摘除后 planFor 失去条目，27 格式矩阵与工具枚举必须红',
  },
  {
    id: 'R2',
    name: 'actionFor 查找条件反转',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    test: 'test/plan.test.mjs',
    apply: (s) => replaceOnce(s, 'entry.id === mode', 'entry.id !== mode'),
    distAnchor: 'entry.id !== mode',
    expect: '查找反转后 actionFor 返回错误条目，注册表单测必须红',
  },
  {
    id: 'F1',
    name: 'features 白名单判定反转（停用的反而能跑）',
    apply: (s) => replaceOnce(s, '!features.includes(entry.id)', 'features.includes(entry.id)'),
    distAnchor: 'if (features.includes(entry.id))',
    expect: 'features 白名单必须拦住停用动作，突变后默认配置全被拒 → host 全量红',
  },
  {
    id: 'F2',
    name: 'features 空串默认被改成全禁用',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    test: 'test/plan.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        'return known.length ? known : ACTIONS.map((entry) => entry.id);',
        'return known.length ? known : [];',
      ),
    distAnchor: 'return known.length ? known : [];',
    expect: '空 features 必须全启用，突变后默认全禁用 → resolveFeatures 单测红',
  },
  {
    id: 'F3',
    name: 'features 未知 token 不再丢弃',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    test: 'test/plan.test.mjs',
    apply: (s) =>
      replaceOnce(s, '.filter((token) => ACTIONS.some((entry) => entry.id === token));', '.filter(() => true);'),
    distAnchor: '.filter(() => true);',
    expect: '未知 token 必须被丢弃，突变后混入白名单 → resolveFeatures 单测红',
  },
  {
    id: 'F4',
    name: '工具枚举的 features 过滤反转',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(s, 'entry.tool && enabled.includes(entry.id)', 'entry.tool && !enabled.includes(entry.id)'),
    distAnchor: 'entry.tool && !enabled.includes(entry.id)',
    expect: '枚举必须只含启用动作，突变后默认枚举为空 → host 工具枚举断言红',
  },
  {
    id: 'P1',
    name: '-filter_complex 永拒被摘除',
    source: 'lib/extensions.ts',
    dist: 'dist/lib/extensions.js',
    test: 'test/extensions.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        "if (token === '-i' || token === '-filter_complex') return `${what}：参数 ${token} 永远不允许`;",
        "if (token === '-i') return `${what}：参数 ${token} 永远不允许`;",
      ),
    distAnchor: "if (token === '-i')",
    expect: '-filter_complex 必须被永拒，突变后改走白名单报错、拒绝原因不符 → 测试红',
  },
  {
    id: 'P2',
    name: 'vf 值的危险源检查反转（movie= 被放行）',
    source: 'lib/extensions.ts',
    dist: 'dist/lib/extensions.js',
    test: 'test/extensions.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        'if (/movie|lavfi|amovie|filter/i.test(value)) return false;',
        'if (!/movie|lavfi|amovie|filter/i.test(value)) return false;',
      ),
    distAnchor: 'if (!/movie|lavfi|amovie|filter/i.test(value))',
    expect: 'vf 值必须拒 movie/lavfi/filter 子串且放行普通滤镜，反转后两头都错 → 测试红',
  },
  {
    id: 'P3',
    name: '未知标志白名单判定反转',
    source: 'lib/extensions.ts',
    dist: 'dist/lib/extensions.js',
    test: 'test/extensions.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        'if (!(token in ALLOWED_FLAGS)) return `${what}：参数 ${token} 不在白名单里`;',
        'if (token in ALLOWED_FLAGS) return `${what}：参数 ${token} 不在白名单里`;',
      ),
    distAnchor: 'if (token in ALLOWED_FLAGS)',
    expect: '已知标志必须放行，反转后合法配方也被拒 → 测试红',
  },
  {
    id: 'P4',
    name: '路径分隔符检查反转（合法值反而被拒）',
    source: 'lib/extensions.ts',
    dist: 'dist/lib/extensions.js',
    test: 'test/extensions.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        'if (/[\\\\/]/.test(value)) return `${what}：${token} 的值不允许包含路径分隔符`;',
        'if (!/[\\\\/]/.test(value)) return `${what}：${token} 的值不允许包含路径分隔符`;',
      ),
    distAnchor: 'if (!/[\\\\/]/.test(value))',
    expect: '含斜杠的值必须被拒、合法值放行，反转后合法配方全灭 → 测试红',
  },
  {
    id: 'P5',
    name: '扩展整包拒收被改成只警告',
    apply: (s) =>
      replaceOnce(
        s,
        'const parsed = parseExtensions(body.extensions);\n              // Reject the whole batch: a half-installed pack is worse than a refused one.\n              if (!parsed.ok) throw new Error(parsed.error);',
        'const parsed = parseExtensions(body.extensions);\n              // Reject the whole batch: a half-installed pack is worse than a refused one.\n              if (!parsed.ok) console.error(parsed.error);',
      ),
    distAnchor: 'console.error(parsed.error)',
    expect: '坏包必须整包拒收，突变后保存成功 → host 扩展保存断言红',
  },
  {
    id: 'P6',
    name: '扩展保存不进 patch（静默丢失）',
    apply: (s) => deleteLine(s, 'patch.extensions = body.extensions;'),
    distAnchor: 'patch.extensions = body.extensions;',
    expect: '保存必须把原文写进 patch，突变后 settings 收不到 → host 深比较红',
    delete: true,
  },
  {
    id: 'P7',
    name: '包 id 唯一性登记被摘除（重复 id 可存）',
    source: 'lib/extensions.ts',
    dist: 'dist/lib/extensions.js',
    test: 'test/extensions.test.mjs',
    apply: (s) => deleteLine(s, 'ids.add(manifest.id);'),
    distAnchor: 'ids.add(manifest.id);',
    expect: '重复包 id 必须整包拒收，突变后存入 → host 重复 id 断言红',
    delete: true,
  },
  {
    id: 'P8',
    name: '预设引用查找被改成永不命中',
    apply: (s) =>
      replaceOnce(
        s,
        'extensionEntries.find((e) => e.ref === ref)',
        "extensionEntries.find((e) => e.ref === ref + '!')",
      ),
    distAnchor: "e.ref === ref + '!'",
    expect: '已装预设必须可解析，突变后全部「扩展预设不存在」 → host 预设断言红',
  },
  {
    id: 'P9',
    name: 'preset 分支条件反转（空 preset 反而进预设解析）',
    apply: (s) =>
      replaceOnce(
        s,
        'if (preset) return planForPreset(upload, body, preset, threads);',
        'if (!preset) return planForPreset(upload, body, preset, threads);',
      ),
    // tsrs 把 71 列的该语句折行打印，锚点只取条件片段（全 dist 唯一）。
    distAnchor: 'if (!preset)',
    expect: 'preset 必须先于内置模式解析，反转后普通转换也炸 → host 预设断言红',
  },
  {
    id: 'P10',
    name: '扩展保存后不再重解析（条目清空）',
    // 整行删除会让 entriesOf 导入变成 TS6133 假红；改成「重解析空表」——
    // 语义等价于永不刷新，且保住 entriesOf 的读取。
    apply: (s) =>
      replaceOnce(s, 'extensionEntries = entriesOf(extensionManifests);', 'extensionEntries = entriesOf([]);'),
    distAnchor: 'entriesOf([])',
    expect: '保存扩展必须重解析条目，突变后任何保存都清空预设 → host 预设断言红',
  },
  {
    id: 'P11',
    name: 'PTC 预设引用校验反转（不存在的预设也放行）',
    apply: (s) =>
      replaceOnce(
        s,
        "if (!preset || preset.type !== 'macro' || preset.kind !== file.kind) {",
        "if (preset && preset.type === 'macro' && preset.kind === file.kind) {",
      ),
    distAnchor: "preset && preset.type === 'macro'",
    expect: '模型计划的预设引用必须经扩展表校验，反转后合法预设反而被拒 → host PTC 预设断言红',
  },
  {
    id: 'P12',
    name: '工具 preset 参数被忽略',
    apply: (s) =>
      replaceOnce(s, 'preset: a.preset !== undefined ? String(a.preset) : undefined,', 'preset: undefined,'),
    distAnchor: 'preset: undefined,',
    expect: '工具的 preset 参数必须到达 planFor，突变后按普通 convert 跑默认格式 → host 工具预设断言红',
  },
];

function build() {
  execFileSync('npm', ['run', 'build:host'], { cwd: ROOT, stdio: 'pipe' });
}

// A killed run (Ctrl+C, a CI timeout, a crash) never reaches the finally
// block, so the repository would keep the mutant and the next run's baseline
// would go red for the wrong reason. The pristine sources are therefore
// copied to a scratch directory before the first mutation, and a later run
// restores them before it looks at anything else.
const BACKUP = path.join(ROOT, '.mutation-backup');

/** @param {string} dir @param {string} prefix @returns {string[]} relative paths of every file below dir */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Restore a stale backup, then copy the pristine sources aside. @returns {boolean} true when a stale backup was restored */
function prepareSources() {
  let restored = false;
  if (fs.existsSync(BACKUP)) {
    for (const rel of listFiles(BACKUP)) {
      writeFileRobust(path.join(ROOT, rel), fs.readFileSync(path.join(BACKUP, rel), 'utf8'));
    }
    restored = true;
  }
  fs.rmSync(BACKUP, { recursive: true, force: true });
  for (const m of MUTANTS) {
    const source = pathOf(m, 'source');
    const dest = path.join(BACKUP, path.relative(ROOT, source));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(source));
  }
  return restored;
}

function clearBackup() {
  fs.rmSync(BACKUP, { recursive: true, force: true });
}

/** @param {string} testFile @returns {{ code: number, out: string }} */
function runTest(testFile) {
  try {
    execFileSync('node', [testFile], { cwd: ROOT, stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: `${err.stdout || ''}${err.stderr || ''}`,
    };
  }
}

/** @param {string} out @returns {string} */
function firstAssertion(out) {
  const match = out.match(/AssertionError[^\n]*\n[^\n]*/);
  return match ? match[0].replace(/\s+/g, ' ').slice(0, 140) : out.split('\n').filter(Boolean).slice(-2).join(' ');
}

// The baseline runs every test the mutants rely on, so a test that is already
// red is reported as a broken baseline instead of a mutant that did its job.
const baselineTests = [...new Set([DEFAULTS.test, ...MUTANTS.map((m) => m.test || DEFAULTS.test)])];

let failures = 0;
try {
  if (prepareSources()) {
    console.log('[mutation] 上一次运行被中断，已从备份恢复源码');
  }
  console.log('[mutation] 基线：构建 + 测试必须全绿…');
  build();
  for (const test of baselineTests) {
    const baseline = runTest(path.join(ROOT, test));
    if (baseline.code !== 0) {
      console.error(`[mutation] 基线即红（${test}），先修基线：\n${firstAssertion(baseline.out)}`);
      process.exit(2);
    }
  }
  for (const m of MUTANTS.filter((x) => x.delete)) {
    const baselineDist = fs.readFileSync(pathOf(m, 'dist'), 'utf8');
    if (!baselineDist.includes(m.distAnchor)) {
      console.error(`[mutation] 突变 ${m.id} 的 dist 锚点本就不在产物里，攻击无效`);
      process.exit(2);
    }
  }
  console.log('[mutation] 基线绿。开始逐突变注入…\n');

  for (const m of MUTANTS) {
    const source = pathOf(m, 'source');
    const test = pathOf(m, 'test');
    const dist = pathOf(m, 'dist');
    const original = originalOf(source);
    let mutated;
    try {
      mutated = m.apply(original);
    } catch (err) {
      console.error(`[mutation] ${m.id} 源码锚点断言失败（攻击脚本本身坏了，不许弱化被测代码）：${err.message}`);
      failures += 1;
      continue;
    }
    writeFileRobust(source, mutated);
    try {
      build();
    } catch {
      console.error(`[mutation] ${m.id} 构建失败——攻击形态会让 TS 编译炸（如 TS6133 参数未用），换等价语义突变`);
      failures += 1;
      // 必须当场恢复：残留的坏突变会让后续所有用例连坐构建失败（B1 曾
      // 拖垮 B2–B8），把一处攻击脚本问题放大成一片。
      writeFileRobust(source, original);
      continue;
    }
    const built = fs.readFileSync(dist, 'utf8');
    const present = built.includes(m.distAnchor);
    if (m.delete ? present : !present) {
      console.error(`[mutation] ${m.id} dist 层断言失败：产物${present ? '仍含' : '不含'}锚点，测试读的不是这份构建`);
      failures += 1;
      continue;
    }
    // test is already absolute (pathOf); joining ROOT again would hand node a
    // path that does not exist, and the child would die with MODULE_NOT_FOUND
    // instead of turning the assertion red.
    const result = runTest(test);
    if (result.code !== 0 && /AssertionError/.test(result.out)) {
      console.log(`[mutation] ${m.id} 转红 ✓  ${m.name}`);
      console.log(`         预期：${m.expect}`);
      console.log(`         实际：${firstAssertion(result.out)}\n`);
    } else if (result.code !== 0) {
      console.error(`[mutation] ${m.id} 非断言失败（崩溃/超时），视同攻击形态错误：${firstAssertion(result.out)}`);
      failures += 1;
    } else {
      console.error(`[mutation] ${m.id} 假绿 ✗  ${m.name}`);
      console.error(`         ${m.expect}`);
      console.error(`         突变后测试仍全绿——该用例没有守护住行为！\n`);
      failures += 1;
    }
    writeFileRobust(source, original);
  }

  console.log('[mutation] 恢复源码并做最终基线…');
  for (const [file, text] of originals) writeFileRobust(file, text);
  build();
  for (const test of baselineTests) {
    const finalRun = runTest(path.join(ROOT, test));
    if (finalRun.code !== 0) {
      console.error(`[mutation] 恢复后基线不绿（${test}）！${firstAssertion(finalRun.out)}`);
      failures += 1;
    }
  }
} finally {
  for (const [file, text] of originals) writeFileRobust(file, text);
  clearBackup();
}

if (failures > 0) {
  console.error(`[mutation] ${failures} 处失败：存在假绿或攻击脚本自身问题`);
  process.exit(1);
}
console.log('[mutation] 全部突变按预期转红，基线复绿。测试是真的在守护行为。');
