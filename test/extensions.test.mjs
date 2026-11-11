// The extension platform's pure validation: manifest parsing, caps, the
// ffmpeg argument whitelist, quality-map math, and the status projection.
// Runs against the compiled artifacts like every other suite here; there is
// nothing to skip — every input is inline.
import assert from 'node:assert/strict';
import { applyQualityMap, entriesOf, parseExtensions, refOf, statusOf, validateArgs } from '../dist/lib/extensions.js';

let passed = 0;
function ok(actual, expected, what) {
  assert.deepEqual(actual, expected, `${what}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  passed += 1;
}
function bad(raw, expectedError, what) {
  const result = parseExtensions(typeof raw === 'object' ? JSON.stringify(raw) : raw);
  assert.equal(result.ok, false, `${what}：应当被拒收`);
  ok(result.error, expectedError, `${what}：拒绝原因`);
}
function good(raw, what) {
  const result = parseExtensions(JSON.stringify(raw));
  assert.equal(result.ok, true, `${what}：应当被接受${result.ok ? '' : `（${result.error}）`}`);
  passed += 1;
  return result;
}

const macroManifest = {
  version: 1,
  id: 'wechat-image',
  name: { zh: '微信图', en: 'WeChat image' },
  actions: [
    {
      id: 'wx-webp',
      type: 'macro',
      kind: 'image',
      label: { zh: '微信压缩图', en: 'WeChat' },
      params: { format: 'webp', quality: 55, width: 1080 },
    },
  ],
};
const recipeManifest = {
  version: 1,
  id: 'slow-mp4',
  name: { zh: '慢速 MP4', en: 'Slow MP4' },
  description: { zh: 'x265 慢速预设', en: 'x265 slow preset' },
  actions: [
    {
      id: 'x265',
      type: 'recipe',
      kind: 'video',
      format: 'mp4',
      override: true,
      label: { zh: 'x265 慢速', en: 'x265 slow' },
      args: ['-c:v', 'libx265', '-preset', 'slow', '-crf', '20', '-c:a', 'copy'],
      quality: { flag: '-crf', at90: 20, min: 18, max: 28 },
    },
  ],
};

// --- happy paths -----------------------------------------------------------
good([macroManifest], '合法宏包');
{
  const { manifests } = good([recipeManifest], '合法配方包');
  const entries = entriesOf(manifests);
  assert.equal(entries.length, 1);
  ok(entries[0].ref, 'x:slow-mp4/x265', '配方 ref');
  ok(entries[0].args.includes('libx265'), true, '配方 args 保留');
}
ok(refOf('a', 'b'), 'x:a/b', 'refOf');
{
  const { manifests } = good([macroManifest, recipeManifest], '两个包共存');
  const list = statusOf(manifests);
  ok(list.length, 2, 'statusOf 两包');
  ok(list[0].actions[0].format, 'webp', 'statusOf 宏 format');
  ok(list[1].actions[0].format, 'mp4', 'statusOf 配方 format');
}
ok(parseExtensions('').ok, true, '空字符串 = 无扩展');
ok(parseExtensions('').manifests.length, 0, '空字符串解析为空');
ok(parseExtensions(undefined).ok, true, 'undefined = 无扩展');

// --- quality map math ------------------------------------------------------
{
  const args = ['-c:v', 'libx265', '-preset', 'slow', '-crf', '20'];
  const map = { flag: '-crf', at90: 20, min: 18, max: 28 };
  const at = (q) => applyQualityMap(args, map, q)[5];
  ok(at(90), '20', 'quality 90 = at90');
  ok(at(100), '18', 'quality 100 = min');
  ok(at(95), '19', 'quality 95 线性插值');
  ok(at(1), '28', 'quality 1 = max');
  ok(at(50), '24', 'quality 50 线性插值');
  ok(applyQualityMap(['-c:v', 'copy'], map, 100), ['-c:v', 'copy'], 'flag 缺失时原样返回');
}

// --- field validation ------------------------------------------------------
bad(123, 'extensions 必须是字符串', '非字符串');
bad('not json', 'extensions 不是合法 JSON', '坏 JSON');
bad('{}', 'extensions 必须是非空数组', '非数组');
bad([], 'extensions 必须是非空数组', '空数组');
bad([{ ...macroManifest, version: 2 }], 'manifests[0]：version 必须是 1', 'version');
bad([{ ...macroManifest, id: 'WeChat!' }], 'manifests[0]：id "WeChat!" 必须匹配 [a-z0-9-]{1,32}', 'id 字符集');
bad(
  [{ ...macroManifest, id: 'x'.repeat(33) }],
  `manifests[0]：id "${'x'.repeat(33)}" 必须匹配 [a-z0-9-]{1,32}`,
  'id 长度',
);
bad([{ ...macroManifest, name: { zh: '微信图' } }], 'manifests[0]：name.en 必须是 1-64 字的非空字符串', 'name.en 缺失');
bad(
  [{ ...macroManifest, name: { zh: '', en: 'x' } }],
  'manifests[0]：name.zh 必须是 1-64 字的非空字符串',
  'name.zh 空',
);
bad([{ ...macroManifest, actions: [] }], 'manifests[0]：actions 必须是非空数组', '空动作数组');
bad(
  [{ ...macroManifest, actions: Array.from({ length: 17 }, (_, i) => ({ ...macroManifest.actions[0], id: `a${i}` })) }],
  'manifests[0]：actions 超过每包上限 16',
  '每包上限',
);
bad(
  [{ ...macroManifest, actions: [{ ...macroManifest.actions[0], id: 'UPPER' }] }],
  'manifests[0]：actions[0].id 必须匹配 [a-z0-9-]{1,32}',
  '动作 id 字符集',
);
bad(
  [{ ...macroManifest, actions: [{ ...macroManifest.actions[0], kind: 'text' }] }],
  'manifests[0]：actions[0].kind 必须是 video/audio/image',
  'kind 范围',
);
bad(
  [{ ...macroManifest, actions: [macroManifest.actions[0], { ...macroManifest.actions[0], kind: 'video' }] }],
  'manifests[0]：actions[1].kind 与该扩展已声明的 kind 不一致',
  '一包单 kind',
);
bad(
  [{ ...macroManifest, actions: [{ ...macroManifest.actions[0], id: 'b', label: { zh: 'x' } }] }],
  'manifests[0]：actions[0].label.en 必须是 1-64 字的非空字符串',
  'label.en 缺失',
);

// --- macro params ----------------------------------------------------------
const macro = (params) => [{ ...macroManifest, actions: [{ ...macroManifest.actions[0], params }] }];
bad(
  macro({ format: 'mp4' }),
  'manifests[0]：actions[0]：format "mp4" 不属于 image 的可用格式',
  '宏 format 不属于该 kind',
);
bad(macro({ format: 'webp', quality: 0 }), 'manifests[0]：actions[0]：quality 必须是 1-100 的整数', 'quality 下限');
bad(
  macro({ format: 'webp', quality: 50.5 }),
  'manifests[0]：actions[0]：quality 必须是 1-100 的整数',
  'quality 非整数',
);
bad(macro({ format: 'webp', bitrate: 321 }), 'manifests[0]：actions[0]：bitrate 必须是 32-320 的整数', 'bitrate 上限');
bad(macro({ format: 'webp', channels: 3 }), 'manifests[0]：actions[0]：channels 必须是 1 或 2', 'channels');
bad(
  macro({ format: 'webp', sampleRate: 4000 }),
  'manifests[0]：actions[0]：sampleRate 必须是 8000-96000 的整数',
  'sampleRate 下限',
);
bad(macro({ format: 'webp', fps: 31 }), 'manifests[0]：actions[0]：fps 必须是 1-30 的整数', 'fps 上限');
bad(macro({ format: 'webp', width: 8 }), 'manifests[0]：actions[0]：width 必须是 16-7680 的整数', 'width 下限');
bad(macro({ format: 'webp', crf: 20 }), 'manifests[0]：actions[0]：params 有未知字段 crf', 'params 未知字段');
good(macro({ format: 'webp', bitrate: 320, channels: 1, sampleRate: 22050 }), '宏全旋钮边界内');

// --- recipes and the whitelist ---------------------------------------------
// 不带 quality 的 patch 会连带剥掉基础配方里的 quality 映射——白名单用例
// 只关心 args，quality 的校验另有一组用例。
const recipe = (patch) => [
  {
    ...recipeManifest,
    actions: [{ ...recipeManifest.actions[0], ...patch, ...(patch.quality ? {} : { quality: undefined }) }],
  },
];
bad(
  recipe({ override: false }),
  'manifests[0]：actions[0]：recipe 只支持 override: true（v1 不新增格式名）',
  '非 override 配方',
);
bad(recipe({ format: 'xyz' }), 'manifests[0]：actions[0]：format "xyz" 不属于 video 的可用格式', '配方 format 未知');
bad(recipe({ args: 'oops' }), 'manifests[0]：actions[0]：args 必须是 2-64 个字符串的数组', 'args 非数组');
bad(recipe({ args: ['-c:v'] }), 'manifests[0]：actions[0]：args 必须是 2-64 个字符串的数组', 'args 奇数');
bad(
  recipe({ args: ['foo', 'bar'] }),
  'manifests[0]：actions[0]：位置参数 "foo" 不允许，只能是 -标志 值 对',
  '位置参数',
);
bad(recipe({ args: ['-i', 'x.mp4'] }), 'manifests[0]：actions[0]：参数 -i 永远不允许', '-i 永拒');
bad(
  recipe({ args: ['-filter_complex', 'x'] }),
  'manifests[0]：actions[0]：参数 -filter_complex 永远不允许',
  '-filter_complex 永拒',
);
bad(recipe({ args: ['-foo', 'bar'] }), 'manifests[0]：actions[0]：参数 -foo 不在白名单里', '未知标志');
bad(recipe({ args: ['-f', 'lavfi'] }), 'manifests[0]：actions[0]：-f 的值 "lavfi" 不允许', 'lavfi 永拒');
bad(recipe({ args: ['-preset', 'a/b'] }), 'manifests[0]：actions[0]：-preset 的值不允许包含路径分隔符', '值带斜杠');
bad(recipe({ args: ['-preset', 'ultrafast', '-crf'] }), 'manifests[0]：actions[0]：-crf 缺少值', '末位缺值');
bad(
  recipe({ args: ['-vf', 'movie=secret.png'] }),
  'manifests[0]：actions[0]：-vf 值 "movie=secret.png" 不允许',
  'vf movie 源',
);
bad(
  recipe({ args: ['-vf', 'scale=640:-2;crop=0:0'] }),
  'manifests[0]：actions[0]：-vf 值 "scale=640:-2;crop=0:0" 不允许',
  'vf 多滤镜分隔符',
);
bad(
  recipe({ args: ['-vf', 'filter_complex=x'] }),
  'manifests[0]：actions[0]：-vf 值 "filter_complex=x" 不允许',
  'vf 内嵌 filter 字样',
);
good(recipe({ args: ['-c:v', 'libx264', '-vf', 'scale=640:-2', '-an'] }), 'vf scale 合法');
good(
  recipe({
    args: [
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-g',
      '250',
      '-maxrate',
      '2M',
      '-bufsize',
      '4M',
      '-threads',
      '4',
      '-vn',
      '-sn',
    ],
  }),
  '全合法标志组合',
);
ok(validateArgs(['-c:v', 'libx265'], 't'), null, 'validateArgs 合法');
ok(validateArgs(['-crf', 'abc'], 't'), 't：-crf 的值 "abc" 不允许', 'validateArgs 值不合法');
ok(validateArgs(['-map', '1:v:0'], 't'), 't：-map 的值 "1:v:0" 不允许', 'map 只允许 0:');

// --- quality maps ----------------------------------------------------------
bad(
  recipe({ quality: { flag: '-foo', at90: 20, min: 18, max: 28 } }),
  'manifests[0]：actions[0]：quality.flag "-foo" 不在白名单里',
  'quality flag 白名单',
);
bad(
  recipe({ quality: { flag: '-b:a', at90: 20, min: 18, max: 28 } }),
  'manifests[0]：actions[0]：quality.flag -b:a 必须出现在 args 里',
  'quality flag 必须在 args',
);
bad(
  recipe({ quality: { flag: '-crf', at90: 28, min: 18, max: 20 } }),
  'manifests[0]：actions[0]：quality 需要 min ≤ at90 ≤ max（quality 越大值越小=质量越好）',
  'min ≤ at90 ≤ max',
);

// --- aggregate caps & uniqueness -------------------------------------------
bad(
  [
    {
      ...macroManifest,
      actions: [
        { ...macroManifest.actions[0], id: 'dup' },
        { ...macroManifest.actions[0], id: 'dup' },
      ],
    },
  ],
  'manifests[0]：actions[1]：动作 id "dup" 重复',
  '包内动作 id 重复',
);
bad([macroManifest, macroManifest], 'manifest id "wechat-image" 重复', '包 id 重复');
bad(
  [recipeManifest, { ...recipeManifest, id: 'slow-mp4-2' }],
  'video:mp4 的覆盖配方重复（每个 kind+format 只允许一个）',
  '覆盖配方重复',
);
{
  const many = [];
  for (let i = 0; i < 16; i += 1) {
    many.push({
      ...macroManifest,
      id: `pack-${String(i).padStart(2, '0')}`,
      actions: [{ ...macroManifest.actions[0], id: `a${i}` }],
    });
  }
  good(many, '16 包边界');
  bad([...many, { ...macroManifest, id: 'pack-16' }], 'extensions 超过包数量上限 16', '包数量上限');
}
{
  // 文本字段上限（name ≤64、label ≤64、description ≤200）把单包体积压在
  // 数 KB，字节上限因此不可达——这类防御性死代码会被 mutation-check 判
  // 为不可杀，故不设字节上限；包数与动作数上限才是真实的闸门。
  const packs = [];
  for (let i = 0; i < 3; i += 1) {
    packs.push({
      ...macroManifest,
      id: `cap-${i}`,
      actions: Array.from({ length: 11 }, (_, j) => ({ ...macroManifest.actions[0], id: `a${i}-${j}` })),
    });
  }
  const r = parseExtensions(JSON.stringify(packs));
  assert.equal(r.ok, false, '动作总数超上限应拒收');
  ok(r.error, '动作总数超过上限 32', '动作总数上限');
}

console.log(`extensions: ${passed} 项断言全绿`);

// --- macro 的软件编码参数（R2）------------------------------------------------
good(
  [
    {
      version: 1,
      id: 'codec-pack',
      name: { zh: '编码包', en: 'Codec pack' },
      actions: [
        {
          id: 'hevc-mp4',
          type: 'macro',
          kind: 'video',
          label: { zh: 'HEVC', en: 'HEVC' },
          params: { format: 'mp4', codec: 'hevc' },
        },
        {
          id: 'av1-mkv',
          type: 'macro',
          kind: 'video',
          label: { zh: 'AV1', en: 'AV1' },
          params: { format: 'mkv', codec: 'av1', quality: 85 },
        },
      ],
    },
  ],
  '宏可携带软件编码选择',
);
bad(
  [
    {
      version: 1,
      id: 'codec-pack-bad',
      name: { zh: '编码包', en: 'Codec pack' },
      actions: [
        {
          id: 'x',
          type: 'macro',
          kind: 'video',
          label: { zh: 'x', en: 'x' },
          params: { format: 'mp4', codec: 'vp9' },
        },
      ],
    },
  ],
  'manifests[0]：actions[0]：codec 必须是 h264/hevc/av1',
  '宏的非法 codec 被拒',
);
console.log('extensions: 宏 codec 用例 ok');
