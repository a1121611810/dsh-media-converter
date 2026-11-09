#!/usr/bin/env node
// 假绿防线：对源码逐一注入已知的「回归性突变」，断言 host 测试一定转红。
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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SOURCE = path.join(ROOT, 'index.ts');
const DIST_HOST = path.join(ROOT, 'dist', 'index.js');
const HOST_TEST = path.join(ROOT, 'test', 'host.test.mjs');

const original = fs.readFileSync(HOST_SOURCE, 'utf8');

/** @param {string} s @param {string} oldText @param {string} newText */
function replaceOnce(s, oldText, newText) {
  if (!s.includes(oldText)) throw new Error(`源码锚点缺失：${oldText.slice(0, 60)}…`);
  if (s.indexOf(oldText) !== s.lastIndexOf(oldText)) throw new Error(`源码锚点不唯一：${oldText.slice(0, 60)}…`);
  return s.replace(oldText, newText);
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
];

function build() {
  execFileSync('npm', ['run', 'build:host'], { cwd: ROOT, stdio: 'pipe' });
}

/** @returns {{ code: number, out: string }} */
function runHostTest() {
  try {
    execFileSync('node', [HOST_TEST], { cwd: ROOT, stdio: 'pipe' });
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

let failures = 0;
try {
  console.log('[mutation] 基线：构建 + host 测试必须全绿…');
  build();
  const baseline = runHostTest();
  if (baseline.code !== 0) {
    console.error(`[mutation] 基线即红，先修基线：\n${firstAssertion(baseline.out)}`);
    process.exit(2);
  }
  const baselineDist = fs.readFileSync(DIST_HOST, 'utf8');
  for (const m of MUTANTS.filter((x) => x.delete)) {
    if (!baselineDist.includes(m.distAnchor)) {
      console.error(`[mutation] 突变 ${m.id} 的 dist 锚点本就不在产物里，攻击无效`);
      process.exit(2);
    }
  }
  console.log('[mutation] 基线绿。开始逐突变注入…\n');

  for (const m of MUTANTS) {
    let mutated;
    try {
      mutated = m.apply(original);
    } catch (err) {
      console.error(`[mutation] ${m.id} 源码锚点断言失败（攻击脚本本身坏了，不许弱化被测代码）：${err.message}`);
      failures += 1;
      continue;
    }
    fs.writeFileSync(HOST_SOURCE, mutated);
    try {
      build();
    } catch {
      console.error(`[mutation] ${m.id} 构建失败——攻击形态会让 TS 编译炸（如 TS6133 参数未用），换等价语义突变`);
      failures += 1;
      continue;
    }
    const dist = fs.readFileSync(DIST_HOST, 'utf8');
    const present = dist.includes(m.distAnchor);
    if (m.delete ? present : !present) {
      console.error(`[mutation] ${m.id} dist 层断言失败：产物${present ? '仍含' : '不含'}锚点，测试读的不是这份构建`);
      failures += 1;
      continue;
    }
    const result = runHostTest();
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
    fs.writeFileSync(HOST_SOURCE, original);
  }

  console.log('[mutation] 恢复源码并做最终基线…');
  fs.writeFileSync(HOST_SOURCE, original);
  build();
  const finalRun = runHostTest();
  if (finalRun.code !== 0) {
    console.error(`[mutation] 恢复后基线不绿！${firstAssertion(finalRun.out)}`);
    failures += 1;
  }
} finally {
  if (fs.readFileSync(HOST_SOURCE, 'utf8') !== original) fs.writeFileSync(HOST_SOURCE, original);
}

if (failures > 0) {
  console.error(`[mutation] ${failures} 处失败：存在假绿或攻击脚本自身问题`);
  process.exit(1);
}
console.log('[mutation] 全部突变按预期转红，基线复绿。测试是真的在守护行为。');
