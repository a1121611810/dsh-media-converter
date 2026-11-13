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
    apply: (s) =>
      replaceOnce(
        s,
        '  queueLimit,\n  nameTemplate,\n  instanceId,',
        '  queueLimit: queueLimit && 0,\n  nameTemplate,\n  instanceId,',
      ),
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
        '      } catch {\n        // next render node, or the plain attempt\n      }\n    }\n    return false;\n  };',
        '      } catch {\n        // next render node, or the plain attempt\n      }\n    }\n    return candidate.encoder.length > 0;\n  };',
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
        'await run(deviceArgs(candidate, encoder, device), DEVICE_TIMEOUT_MS);',
        'await run(deviceArgs(candidate, encoder, device), Math.max(DEVICE_TIMEOUT_MS, FFMPEG_TIMEOUT_MS));',
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
      pending = probeFfmpegDevice(process.platform, build, execRunner(bin), listVaapiDevices()).catch(() => null);
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
      pending = probeFfmpegDevice(process.platform, build, execRunner(bin), listVaapiDevices())
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
      replaceOnce(
        s,
        'if (body.hardware && hwBackend && !videoTuneTuned && !geometryTuned && !filtersTuned) {',
        'if (body.hardware && hwBackend && !geometryTuned && !filtersTuned) {',
      ),
    distAnchor: 'hwBackend && !geometryTuned && !filtersTuned) {',
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
        `  if (
    supportsVideoTune(kind, format) &&`,
        `  if (
    false &&
    supportsVideoTune(kind, format) &&`,
      ),
    // dist 打印器把条件接在 if ( 同行：锚点只取这一小段（基线三份产物零命中）。
    distAnchor: 'if (false &&',
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
        `        body.fps,
        body.width,
        body.channels,`,
        `        0,
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
        "if (value !== 'h264' && value !== 'hevc' && value !== 'av1') {",
        "if (value !== 'h264' && value !== 'hevc' && value !== 'av1' && false) {",
      ),
    distAnchor: "value !== 'av1' && false",
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
    apply: (s) =>
      replaceOnce(
        s,
        "upload.kind === 'video' && (String(body.codec || '') === 'hevc' ||",
        "upload.kind === 'video' && (String(body.codec || '') === 'vp9' ||",
      ),
    distAnchor: "String(body.codec || '') === 'vp9'",
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
        "pick === 'av1' ? svtCrfOf(q) : format === 'webm' ? vp9CrfOf(q) : crfOf(q);",
        "pick === 'av1' ? svtCrfOf(q) : format === 'webm' ? crfOf(q) : vp9CrfOf(q);",
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
    apply: (s) => replaceOnce(s, 'return known.length ? known : knownIds;', 'return known.length ? known : [];'),
    distAnchor: 'return known.length ? known : [];',
    expect: '空 features 必须全启用，突变后默认全禁用 → resolveFeatures 单测红',
  },
  {
    id: 'F5',
    name: 'features 白名单不再认扩展 ref（扩展停用失效）',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    test: 'test/host.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        'filter((token) => knownIds.includes(token))',
        'filter((token) => ACTIONS.some((entry) => entry.id === token))',
      ),
    distAnchor: 'ACTIONS.some((entry) => entry.id === token)',
    expect: "features 含 'x:wechat-image/wx-webp' 时必须放行该预设；突变后 token 被丢 → WP3 恢复用例红",
  },
  {
    id: 'V8',
    name: '监视目录 TTL 豁免被摘除（监视行被清扫）',
    source: 'index.ts',
    test: 'test/host.test.mjs',
    apply: (s) =>
      replaceOnce(
        s,
        'if (watched.length && isPathInsideAny(watched, upload.path)) continue;',
        'if (watched.length && false) continue;',
      ),
    distAnchor: 'watched.length && false',
    expect: '监视目录内的行必须豁免 TTL 清扫；突变后被清 → pruneUploads 纯测红',
  },
  {
    id: 'F3',
    name: 'features 未知 token 不再丢弃',
    source: 'lib/actions.ts',
    dist: 'dist/lib/actions.js',
    test: 'test/plan.test.mjs',
    apply: (s) => replaceOnce(s, '.filter((token) => knownIds.includes(token));', '.filter(() => true);'),
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
  // --- T 家族：选轨（R1，source/test/dist 都在注册表层）-----------------------
  {
    id: 'T1',
    name: '选画面轨的 map 被写成音轨',
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, "trackMaps.push('-map', `0:v:${vtrack}`)", "trackMaps.push('-map', `0:a:${vtrack}`)"),
    distAnchor: "trackMaps.push('-map', `0:a:${vtrack}`)",
    expect: 'videoTrack=1 必须注入 0:v:1，突变后写成 0:a:1 → plan 选轨断言红',
  },
  {
    id: 'T2',
    name: '选音轨的 map 被写成画面轨',
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, "trackMaps.push('-map', `0:a:${atrack}`)", "trackMaps.push('-map', `0:v:${atrack}`)"),
    distAnchor: "trackMaps.push('-map', `0:v:${atrack}`)",
    expect: 'audioTrack=1 必须注入 0:a:1，突变后写成 0:v:1 → plan 选轨断言红',
  },
  {
    id: 'T3',
    name: '选轨 copy 门禁被反转（不选轨也禁拷贝）',
    // 不能删 `&& !trackTuned`：那是 trackTuned 的唯一使用点，删除即 TS6133
    // 构建失败（假红）。反转成“必须选轨才给拷贝”：未选轨的直拷贝被堵死。
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, '!trackTuned &&', '!!trackTuned &&'),
    distAnchor: '!!trackTuned &&',
    expect: '未选轨的 mp4 直拷贝必须保留，突变后永不拷贝 → plan copy 断言红',
  },
  // --- U 家族：软件编码 codec（R2）--------------------------------------------
  {
    id: 'U1',
    name: '软件 codec 参数不进 buildArgs（hevc 请求回退 x264）',
    // body.codec 在 codecTuned 与 hardwareFor 调用里仍被读取，删这行不会 TS6133。
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        `        body.sampleRate,
        body.codec,
        geometry,
        filters,
      ),`,
        `        body.sampleRate,
        undefined,
        geometry,
        filters,
      ),`,
      ),
    distAnchor: 'body.sampleRate, undefined,',
    expect: 'codec=hevc 必须产出 libx265 配方，突变后回退默认 x264 → plan 断言红',
  },
  {
    id: 'U2',
    name: 'x265 质量曲线被 x264 曲线替换',
    // x265CrfOf 只有这一个调用点，直接换成 crfOf 会让它 TS6133 构建失败
    // （假红）；保活读取：x265 结果乘 0 加进 crfOf，语义等同替换。
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(s, "pick === 'hevc' ? x265CrfOf(q) :", "pick === 'hevc' ? Math.round(x265CrfOf(q) * 0 + crfOf(q)) :"),
    distAnchor: 'x265CrfOf(q) * 0 + crfOf(q)',
    expect: 'hevc 质量 100 必须映射 x265 CRF 27，突变后走 x264 曲线得 22 → 断言红',
  },
  // --- W 家族：合并与章节分割（R3）--------------------------------------------
  {
    id: 'W1',
    name: '拷贝合并的音轨 map 被摘除',
    source: 'lib/plan.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        `export function concatCopyArgs(format: string): string[] {
  const args = ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
  if (format === 'mp4') args.push('-movflags', '+faststart');`,
        `export function concatCopyArgs(format: string): string[] {
  const args = ['-map', '0:v:0?', '-c', 'copy'];
  if (format === 'mp4') args.push('-movflags', '+faststart');`,
      ),
    distAnchor: "'-map', '0:v:0?', '-c', 'copy'",
    expect: '拷贝合并产物必须带一条音轨，突变后只剩画面 → 合并断言红',
  },
  {
    id: 'W2',
    name: '章节零长跳过被反转（窗口多算）',
    source: 'lib/plan.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, 'if (!(end - start > 0.01)) continue;', 'if (end - start > 0.01) continue;'),
    // dist 打印器把 if 与 continue 拆行：锚点只取条件本身（基线是 !== 形态，不会撞）。
    distAnchor: 'if (end - start > 0.01)',
    expect: '零长章节必须被跳过（3 个窗口），突变后只剩正片 1 个 → 分割断言红',
  },
  {
    id: 'W3',
    name: '章节越界 clamp 被反转',
    source: 'lib/plan.ts',
    // e2e 夹具的章节都被容器钳在时长内，守不住 clamp；plan.test 的
    // chapterWindows 用例带越界章节（[4,12]→[4,10]），是这条防线的家。
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'if (meta.duration > 0) end = Math.min(end, meta.duration);',
        'if (meta.duration < 0) end = Math.min(end, meta.duration);',
      ),
    distAnchor: 'if (meta.duration < 0)',
    expect: '越界章节必须 clamp 到时长内（plan 用例 [4,10]），突变后保持 [4,12] → 断言红',
  },
  {
    id: 'W4',
    name: '拷贝合并的画面编码校验被反转',
    source: 'lib/plan.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "if ((meta.video ? meta.video.codec : '') !== videoCodec) return '画面编码不一致';",
        "if ((meta.video ? meta.video.codec : '') === videoCodec) return '画面编码不一致';",
      ),
    distAnchor: '=== videoCodec)',
    expect: '编码一致的文件必须放行合并，反转后同类也被拒 → POST 层断言红',
  },
  // --- X 家族：画面几何与强制 remux（R4）--------------------------------------
  {
    id: 'X1',
    name: '几何段被静默踢出 -vf 链',
    // geo.rotate === 91 永假但保持对 geo 的读取（if(false) 形态会让
    // tsrs 构建炸）；crop 永不入链而 rotate/flip 不受影响。
    source: 'lib/plan.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, 'if (geo.crop) geoParts.push(', 'if (geo.crop && geo.rotate === 91) geoParts.push('),
    distAnchor: 'geo.rotate === 91',
    expect: 'crop 必须进入 -vf 链（产物 48x32），突变后原尺寸 → 反读断言红',
  },
  {
    id: 'X2',
    name: '强制 remux 分支被短路（退回重编码）',
    source: 'lib/actions.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, 'if (body.remux === true) {', 'if (body.remux === false) {'),
    distAnchor: 'body.remux === false',
    expect: 'remux+trim 必须报互斥错误；突变后退回重编码成功 → 错误行断言红',
  },
  {
    id: 'X3',
    name: 'crop 偶数校验被 && 弱化',
    source: 'lib/plan.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'if (w % 2 || h % 2) throw new Error(`crop 宽高必须是偶数（yuv420p 要求）: ${crop}`);',
        'if (w % 2 && h % 2) throw new Error(`crop 宽高必须是偶数（yuv420p 要求）: ${crop}`);',
      ),
    distAnchor: 'w % 2 && h % 2',
    expect: '奇宽偶高必须被 plan 层拒绝；突变后放行、x264 运行时炸 → 断言红',
  },
  {
    id: 'X4',
    name: '几何 copy 门禁被反转（不选几何也禁拷贝）',
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, '!geometryTuned &&\n    !filtersTuned', '!!geometryTuned &&\n    !filtersTuned'),
    distAnchor: '!!geometryTuned &&',
    expect: '未选几何的 mp4 直拷贝必须保留；突变后永不拷贝 → copy 断言红',
  },
  // --- Y 家族：变速/响度/水印/烧录/截图（R5）----------------------------------
  {
    id: 'Y1',
    name: '滤镜探测被短路（scale canary 谎报）',
    source: 'index.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/index.js',
    // scale 每个 ffmpeg 都有：任何机器上突变都必被 e2e 的独立探针对照抓住
    // （drawtext/subtitles 在本机缺失，不能当靶子）。
    apply: (s) => replaceOnce(s, "scale: build ? build.filters.includes('scale') : false,", 'scale: false,'),
    distAnchor: 'scale: false',
    expect: '本机有 drawtext 时 /status 必须如实报 true，突变后恒 false → 门控 e2e 断言红',
  },
  {
    id: 'Y2',
    name: 'atempo 链退化成单段（极值即非法参数）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        'parts.push(`atempo=${String(Math.round(rest * 1000) / 1000)}`);',
        'parts.push(`atempo=${String(speed)}`);',
      ),
    distAnchor: 'atempo=${String(speed)}',
    expect: 'speed=4 必须拆 atempo=2,atempo=2；突变后第二段 atempo=4 非法 → plan 断言红',
  },
  {
    id: 'Y6',
    name: 'loudnorm 注入条件反转（响度归一化静默丢失）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, 'filters?.loudnorm === true', 'filters?.loudnorm !== true'),
    distAnchor: 'filters?.loudnorm !== true',
    expect: 'loudnorm: true 时 -af 链必须含 loudnorm=I=-16:TP=-1.5:LRA=11；突变后恒空 → plan.test 链序断言红',
  },
  {
    id: 'V1',
    name: 'eq 亮度负值钳制失效（-0.5 被钳到 0）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, 'Math.min(1, Math.max(-1, b))', 'Math.min(1, Math.max(0, b))'),
    distAnchor: 'Math.max(0, b)',
    expect: 'brightness=-0.5 必须保留负值；突变后钳到 0 → plan.test eq clamp 断言红',
  },
  {
    id: 'V2',
    name: '变调段 asetrate 写错（变调静默丢失）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, 'return `asetrate=', 'return `asrate='),
    distAnchor: 'asrate=',
    expect: 'pitch 段必须是 asetrate=；突变后拼错滤镜名 → plan.test 变调断言红',
  },
  {
    id: 'V3',
    name: 'fxTuned 门禁被掏空（画质滤镜请求被 copy 短路）',
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        'const fxTuned = eqAsked || denoiseAsked || sharpenAsked || pitchAsked;',
        'const fxTuned = pitchAsked;',
      ),
    distAnchor: 'const fxTuned = pitchAsked;',
    expect: '画质滤镜显式请求必须禁直接拷贝；突变后 eq 请求走 copy → plan.test 门禁断言红',
  },
  {
    id: 'V4',
    name: 'GPU 分支不再拦滤镜请求（-vf 打断零拷贝）',
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) =>
      replaceOnce(
        s,
        'if (body.hardware && hwBackend && !videoTuneTuned && !geometryTuned && !filtersTuned) {',
        'if (body.hardware && hwBackend && !videoTuneTuned && !geometryTuned) {',
      ),
    distAnchor: 'if (body.hardware && hwBackend && !videoTuneTuned && !geometryTuned) {',
    expect: '画质滤镜请求不得走 GPU 零拷贝路径；突变后进硬件分支 → plan.test 断言红',
  },
  {
    id: 'V5',
    name: '水印图 extraInputs 被掏空（overlay 无第二输入）',
    source: 'lib/actions.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/actions.js',
    apply: (s) => replaceOnce(s, '...(wmImg ? { extraInputs: [wmImg.path] } : {})', '...(wmImg ? {} : {})'),
    distAnchor: '...(wmImg ? {} : {})',
    expect: '水印图必须作为第二输入进 extraInputs；突变后丢失 → plan.test 断言红（且 e2e ffmpeg 会因缺输入 1 失败）',
  },
  {
    id: 'V6',
    name: '水印图片目录围栏被摘除（系统路径被放行）',
    source: 'index.ts',
    test: 'test/host.test.mjs',
    apply: (s) => replaceOnce(s, 'if (!browseAllowed(String(body.watermarkImage))) {', 'if (false) {'),
    distAnchor: 'if (false)',
    expect: '/etc/hosts 作水印图必须被围栏拒绝；突变后放行 → host.test 负向用例红',
  },
  {
    id: 'V7',
    name: '空链占位滤镜写错（null→anull，图炸）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(
        s,
        "const chain = parts.length ? parts.join(',') : 'null';",
        "const chain = parts.length ? parts.join(',') : 'anull';",
      ),
    distAnchor: "'anull'",
    expect: '空链 overlay 的占位必须是 null 滤镜；突变后 anull（音频滤镜）→ plan.test 图结构断言红（e2e ffmpeg 亦炸）',
  },
  {
    id: 'Y3',
    name: '水印 textfile 退回内联 text=（转义地狱回归）',
    source: 'lib/plan.ts',
    // plan 级守护：宿主端路径在 macOS 上无特殊字符，内联 text= 也能跑成，
    // e2e 判别不了；段形态由 plan.test 的 textfile= 断言钉住。
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) => replaceOnce(s, ":textfile='${text}'", ":text='${text}'"),
    distAnchor: ":text='${text}'",
    expect: '水印段必须用 textfile=；突变后段断言（textfile= 存在 / 内联 text= 不存在）红',
  },
  {
    id: 'Y4',
    name: '烧录 fontsdir 被写死（字体目录逃逸）',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    // void fontsDir 保活参数，避免 noUnusedParameters 让构建炸。
    apply: (s) =>
      replaceOnce(
        s,
        'return `subtitles=filename=${esc(srtFile)}:fontsdir=${esc(fontsDir)}`;',
        'void fontsDir;\n  return `subtitles=filename=${esc(srtFile)}:fontsdir=/tmp`;',
      ),
    distAnchor: 'fontsdir=/tmp',
    expect: '烧录段必须用传入的系统字体目录；突变后写死 /tmp → 段断言红',
  },
  {
    id: 'Y5',
    name: '截图单帧约束被放宽（-frames:v 2）',
    source: 'lib/plan.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/plan.js',
    apply: (s) =>
      replaceOnce(s, "args: ['-frames:v', '1', ...(ext === 'jpg'", "args: ['-frames:v', '2', ...(ext === 'jpg'"),
    distAnchor: "'-frames:v', '2'",
    expect: 'png 单帧容器收到第 2 帧必报错；突变后截图任务失败 → e2e 断言红',
  },
  // --- G 家族：扩展页沙箱桥（R6，第 3 期）------------------------------------
  // 桥的安全面全部落在纯函数上（src/client/lib.ts），测试读的是
  // dist/src/client/lib.js——build() 的 tsrs 每次都会重编它，无需改构建链。
  {
    id: 'G1',
    name: '桥路径白名单放宽（前缀仿冒放行）',
    source: 'src/client/lib.ts',
    test: 'test/client-lib.test.mjs',
    dist: 'dist/src/client/lib.js',
    apply: (s) =>
      replaceOnce(s, "!m.path.startsWith(BRIDGE_PATH_PREFIX + '/')", "!m.path.startsWith('/api/media-convert')"),
    distAnchor: "'/api/media-convert')",
    expect: '/api/media-convert-evil 前缀仿冒必须拒，突变后放行 → client-lib 桥用例红',
  },
  {
    id: 'G2',
    name: '桥 token 校验被绕过（错配令牌放行）',
    source: 'src/client/lib.ts',
    test: 'test/client-lib.test.mjs',
    dist: 'dist/src/client/lib.js',
    apply: (s) =>
      replaceOnce(
        s,
        'if (m.token !== token) return false;',
        "if (m.token !== token && String(m.token).startsWith('mc-forged')) return false;",
      ),
    distAnchor: "'mc-forged'",
    expect: '错配 token 必须拒；突变后仅拒 mc-forged 前缀 → 错配用例红',
  },
  {
    id: 'G3',
    name: '扩展页 html 单页上限失效（256KB → 25MB）',
    source: 'lib/extensions.ts',
    test: 'test/extensions.test.mjs',
    dist: 'dist/lib/extensions.js',
    apply: (s) => replaceOnce(s, 'MAX_PAGE_HTML: 262144,', 'MAX_PAGE_HTML: 26214400,'),
    distAnchor: 'MAX_PAGE_HTML: 26214400',
    expect: '超 256KB 的页面必须拒收，突变后放行 → extensions html 超限用例红',
  },
  {
    id: 'G4',
    name: '扩展页每包页数上限失效（3 → 300）',
    source: 'lib/extensions.ts',
    test: 'test/extensions.test.mjs',
    dist: 'dist/lib/extensions.js',
    apply: (s) => replaceOnce(s, 'MAX_PAGES_PER_MANIFEST: 3,', 'MAX_PAGES_PER_MANIFEST: 300,'),
    distAnchor: 'MAX_PAGES_PER_MANIFEST: 300',
    expect: '每包超过 3 页必须拒收，突变后放行 → extensions 页数上限用例红',
  },
  {
    id: 'G5',
    name: '桥消息来源校验被绕过',
    source: 'src/client/lib.ts',
    test: 'test/client-lib.test.mjs',
    dist: 'dist/src/client/lib.js',
    apply: (s) =>
      replaceOnce(
        s,
        'return source === contentWindow && source !== null;',
        "return source === contentWindow && source !== null || source === 'mc-forged-source';",
      ),
    distAnchor: "'mc-forged-source'",
    expect: '非本 iframe 窗口的来源必须拒；突变后伪造字面量放行 → isExpectedSource 用例红',
  },
  {
    id: 'G6',
    name: '桥 POST body 上限失效（1MB → 64MB）',
    source: 'src/client/lib.ts',
    test: 'test/client-lib.test.mjs',
    dist: 'dist/src/client/lib.js',
    apply: (s) =>
      replaceOnce(s, 'export const BRIDGE_MAX_BODY = 1024 * 1024;', 'export const BRIDGE_MAX_BODY = 1024 * 1024 * 64;'),
    distAnchor: '1024 * 1024 * 64',
    expect: '超 1MB 的请求体必须拒，突变后 64MB 内全放行 → body 超限用例红',
  },
  {
    id: 'G7',
    name: '桥回复封套 ok 映射被翻转',
    source: 'src/client/lib.ts',
    test: 'test/client-lib.test.mjs',
    dist: 'dist/src/client/lib.js',
    apply: (s) =>
      replaceOnce(
        s,
        '? { __mc: 1, id, ok: true, status: result.status, json: result.json }',
        "? { __mc: 1, id, ok: false, error: 'mc-flipped-reply' }",
      ),
    distAnchor: "'mc-flipped-reply'",
    expect: '成功回复必须 ok:true 带 status/json；突变后成功也回 ok:false → 封套用例红',
  },
  {
    id: 'G8',
    name: '计划失败时 scratch 清理被摘除（burn srt 泄漏）',
    apply: (s) =>
      replaceOnce(
        s,
        'await Promise.all(scratch.map((f) => fsp.rm(f, { force: true }).catch(() => {})));',
        'void scratch;',
      ),
    distAnchor: 'void scratch;',
    expect: 'plan 抛错时 prepareBurn 的 srt 必须被清理；突变后只读不删 → burn 计数断言红',
  },
  {
    id: 'G9',
    name: '章节上限守卫失效（65 章静默切片）',
    apply: (s) => replaceOnce(s, 'if (windows.length > 64) {', 'if (windows.length > 6400) {'),
    distAnchor: 'windows.length > 6400',
    expect: '65 章必须报错拒收；突变后静默切 64 → host 65 章用例红',
  },
  {
    id: 'G10',
    name: '预设拦截的假值白名单被掏空（rotate:0 也算拦截）',
    source: 'src/client/lib.ts',
    test: 'test/client-lib.test.mjs',
    dist: 'dist/src/client/lib.js',
    apply: (s) =>
      replaceOnce(
        s,
        "return Object.values(extras).some((v) => v !== undefined && v !== null && v !== false && v !== '' && v !== 0);",
        'return Object.values(extras).some((v) => v !== undefined);',
      ),
    distAnchor: 'some((v) => v !== undefined);',
    expect: 'rotate:0/speed:1 等假值不得拦截；突变后全拦截 → client-lib 假值边界用例红',
  },
  {
    id: 'G11',
    name: '水印位置白名单校验反转（非法位置被放行）',
    source: 'lib/actions.ts',
    test: 'test/host.test.mjs',
    dist: 'dist/lib/actions.js',
    // 本机 homebrew ffmpeg 无 drawtext，水印 e2e 被能力门跳过（/status 如实
    // 报告有 Y1 守着）——所以锚环境无关的 plan 层校验：非法位置必须在建计划
    // 时被拒，与 ffmpeg 能力无关。
    apply: (s) =>
      replaceOnce(
        s,
        "if (!WM_POS_KEYS.includes(pos)) throw new Error('水印位置必须是 tl/tr/bl/br 之一');",
        "if (WM_POS_KEYS.includes(pos)) throw new Error('水印位置必须是 tl/tr/bl/br 之一');",
      ),
    // tsrs 对超长行在 emit 时折行：锚只取条件部分（基线是 !includes 形态，不会误撞）。
    distAnchor: 'if (WM_POS_KEYS.includes(pos))',
    expect: 'watermarkPos=center 必须在 plan 层被拒；突变后放行 → host 非法位置用例红',
  },
  {
    id: 'H1',
    name: '完成时间戳被摘除（面板摘要窗口永不命中）',
    apply: (s) => replaceOnce(s, 'run.finishedAt = Date.now();', 'run.finishedAt = 0;'),
    distAnchor: 'run.finishedAt = 0',
    expect:
      '已完成的 run 必须带 finishedAt，面板才能在 10 分钟窗口内恢复批次摘要；突变后窗口永不命中 → host finishedAt 断言红',
  },
  {
    id: 'H2',
    name: '计划分页被关掉（页宽 120→1200，125 文件一次装完）',
    apply: (s) => replaceOnce(s, 'const PTC_PLAN_PAGE = 120;', 'const PTC_PLAN_PAGE = 1200;'),
    distAnchor: 'PTC_PLAN_PAGE = 1200',
    expect: '125 文件必须分 2 次模型调用；突变后 1 次装完 → 分页用例 ptcPrompts.length 断言红',
  },
  {
    id: 'H3',
    name: '分页切片差一（首页 119 行、末页 6 行）',
    apply: (s) =>
      replaceOnce(
        s,
        'files.slice(start, start + PTC_PLAN_PAGE)',
        'files.slice(start, Math.max(start + 1, start + PTC_PLAN_PAGE - 1))',
      ),
    distAnchor: 'Math.max(start + 1',
    expect: '首页必须恰好 120 行；突变后 119 行 → 分页用例 pageLines 断言红',
  },
  {
    id: 'H4',
    name: '命名模板被旁路（输出仍用源名）',
    apply: (s) =>
      replaceOnce(
        s,
        'const base = renderNameTemplate(nameTemplate, safeBaseName(name), extension) + suffix;',
        'const base = safeBaseName(name) + suffix;',
      ),
    distAnchor: 'const base = safeBaseName(name) + suffix;',
    expect: '模板命名必须生效；突变后恒用源名 → host tpl-n.jpg 断言红',
  },
  {
    id: 'H5',
    name: 'Linux 显卡后端被摘除（VAAPI 不出现）',
    source: 'lib/platform.ts',
    test: 'test/platform.test.mjs',
    dist: 'dist/lib/platform.js',
    apply: (s) =>
      replaceOnce(s, "  if (platform === 'linux') return ['vaapi'];", "  if (platform === 'linux') return [];"),
    distAnchor: "if (platform === 'linux')\n        return [];",
    expect: 'linux 必须有 vaapi 后端；突变后回退空表 → platform.test linux 断言红',
  },
  {
    id: 'H6',
    name: 'VAAPI 软解重试的帧上传被摘除',
    source: 'lib/plan.ts',
    test: 'test/plan.test.mjs',
    dist: 'dist/lib/plan.js',
    delete: true,
    apply: (s) => replaceOnce(s, "    retryArgs: ['-vf', 'format=nv12|vaapi,hwupload'],\n", ''),
    distAnchor: 'format=nv12|vaapi',
    expect: 'vaapi retryArgs 必须存在；摘除后 plan.test 的 hwupload 断言红',
  },
  {
    id: 'H7',
    name: '恢复决策被翻成一律采用（文件被改过也信旧元数据）',
    source: 'lib/state.ts',
    test: 'test/state.test.mjs',
    dist: 'dist/lib/state.js',
    apply: (s) =>
      replaceOnce(
        s,
        "if (stored.mTimeMs === undefined || stat.mtimeMs !== stored.mTimeMs || stat.size !== stored.size) return 'reprobe';",
        "if (stored.mTimeMs === undefined || stat.mtimeMs !== stored.mTimeMs || stat.size !== stored.size) return 'adopt';",
      ),
    distAnchor: "return 'adopt';",
    expect: '被改动的文件必须重探测；突变后照旧采用 → host 重探测用例红（kind 仍是 image）',
  },
  {
    id: 'H8',
    name: 'ptcRates 数值校验被掏空（video 投毒照单全收）',
    source: 'lib/state.ts',
    test: 'test/state.test.mjs',
    dist: 'dist/lib/state.js',
    apply: (s) => replaceOnce(s, '!Number.isFinite(rates.video) ||', '!Number.isFinite(rates.video) &&'),
    distAnchor: '!Number.isFinite(rates.video) &&',
    expect: '非数值 rate 必须整份拒收；突变后 video 投毒漏检 → state.test 投毒用例红',
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
    // 12 minutes: a scheduling-breaking mutant can make the heavy suites walk
    // nearly serially, but a true hang must not stall the whole run — kill it
    // and let the loop record the failure.
    execFileSync('node', [testFile], { cwd: ROOT, stdio: 'pipe', timeout: 12 * 60 * 1000, killSignal: 'SIGKILL' });
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

// DRYRUN=1: prove every attack still lands on the current source. A stale
// anchor is an attack-script bug; this finds the whole class in seconds
// instead of after a full run.
if (process.env.DRYRUN) {
  const stale = [];
  for (const m of MUTANTS) {
    try {
      m.apply(originalOf(pathOf(m, 'source')));
    } catch (err) {
      stale.push(`${m.id}(${m.name}): ${err.message}`);
    }
  }
  if (stale.length) {
    console.error(`[mutation] ${stale.length} 个源码锚点已失效：\n${stale.join('\n')}`);
    process.exit(1);
  }
  console.log('[mutation] DRYRUN：全部源码锚点可命中');
  process.exit(0);
}

// ONLY=Y2,Y6: 只跑名单内突变（新锚点入库的单点验证），基线仍全跑。
const ONLY = process.env.ONLY ? new Set(String(process.env.ONLY).split(',')) : null;
const RUN = ONLY ? MUTANTS.filter((m) => ONLY.has(m.id)) : MUTANTS;

let failures = 0;
const failed = [];
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
  for (const m of RUN.filter((x) => x.delete)) {
    const baselineDist = fs.readFileSync(pathOf(m, 'dist'), 'utf8');
    if (!baselineDist.includes(m.distAnchor)) {
      console.error(`[mutation] 突变 ${m.id} 的 dist 锚点本就不在产物里，攻击无效`);
      process.exit(2);
    }
  }
  console.log('[mutation] 基线绿。开始逐突变注入…\n');

  for (const m of RUN) {
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
      failed.push(`${m.id} 源码锚点失效`);
      continue;
    }
    writeFileRobust(source, mutated);
    try {
      build();
    } catch {
      console.error(`[mutation] ${m.id} 构建失败——攻击形态会让 TS 编译炸（如 TS6133 参数未用），换等价语义突变`);
      failures += 1;
      failed.push(`${m.id} 构建失败`);
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
      failed.push(`${m.id} dist 锚点`);
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
      failed.push(`${m.id} 非断言失败`);
    } else {
      console.error(`[mutation] ${m.id} 假绿 ✗  ${m.name}`);
      console.error(`         ${m.expect}`);
      console.error(`         突变后测试仍全绿——该用例没有守护住行为！\n`);
      failures += 1;
      failed.push(`${m.id} 假绿`);
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
      failed.push(`恢复后基线 ${test}`);
    }
  }
} finally {
  for (const [file, text] of originals) writeFileRobust(file, text);
  clearBackup();
}

if (failures > 0) {
  console.error(`[mutation] ${failures} 处失败：存在假绿或攻击脚本自身问题`);
  console.error(`[mutation] 失败清单：${failed.join('；')}`);
  process.exit(1);
}
console.log('[mutation] 全部突变按预期转红，基线复绿。测试是真的在守护行为。');
