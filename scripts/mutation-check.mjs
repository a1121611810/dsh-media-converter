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
    distAnchor: 'job.uploadId === id',
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
        '      await run(deviceArgs(backend), DEVICE_TIMEOUT_MS);\n      return true;\n    } catch {\n      return false;\n    }',
        '      await run(deviceArgs(backend), DEVICE_TIMEOUT_MS);\n      return true;\n    } catch {\n      return backend.encoder.length > 0;\n    }',
      ),
    distAnchor: 'backend.encoder.length > 0',
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
    // 就没人用了，TS6133 让构建炸掉——那是假红，不是测试红。
    apply: (s) =>
      replaceOnce(
        s,
        'await run(deviceArgs(backend), DEVICE_TIMEOUT_MS);',
        'await run(deviceArgs(backend), Math.max(DEVICE_TIMEOUT_MS, FFMPEG_TIMEOUT_MS));',
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
    // 写实例状态了——面板会永远停在「显卡驱动检测中」。
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
    return pending.then((backend) => {
      hwBackend = backend;
      deviceSettled = true;
      return backend;
    });`,
        `    let pending = deviceCache.get(bin);
    if (!pending) {
      pending = probeFfmpegDevice(process.platform, build, execRunner(bin))
        .catch(() => null)
        .then((backend) => {
          hwBackend = backend;
          deviceSettled = true;
          return backend;
        });
      deviceCache.set(bin, pending);
    }
    return pending;`,
      ),
    distAnchor: 'pending.then((backend)',
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
