# 交接：状态持久化（R5）设计评审稿

> 状态：设计稿，评审逐条过完后动工（R5b）。本文是 R5a 的交付物。
> 前置事实：0–3 期已完成（注册表/扩展平台/功能补齐/iframe），第 4 期 R1–R3 已发版（v1.12.1 摘要恢复 / v1.13.0 PTC 分页 / v1.13.1 命名模板）；R4（Linux VAAPI）在途。

## 1. 目标与非目标

**目标**：DSH 重启后，队列（uploads）、进行中的批次（runs）、实测吞吐校准（ptcRates）可恢复；中断任务的半成品被清扫；批次自动继续执行（语义与「切页面继续」一致：重跑，非断点续转）。

**非目标**：不持久化 job 过程状态（进程已死，无可恢复）；不持久化已完成的 run（30 分钟内存窗口 + R1 的摘要恢复已覆盖）；不做崩溃一致性（见 §5 一致性级别）；不动扩展包/预设/features 配置（它们已走宿主 settings 管道持久化，天然跨重启）。

## 2. 存储

- 路径：`~/.media-toolbox-state.json`，与既有历史账本 `~/.media-toolbox-history.json` 同风格（home 下扁平点文件）。**从方案原定的 `~/.dsh-media-toolbox/state.json` 调整**——代码里已有 `MEDIA_TOOLBOX_HISTORY` env 覆盖的先例，state 同样支持 `MEDIA_TOOLBOX_STATE` 覆盖（测试与异构宿主可用）。
- 写入：原子写（同目录 tmp 文件 + rename）。
- 损坏：改名 `.corrupt-<ts>` 保留现场，**空状态启动**——插件绝不能因 state 损坏而起不来（与历史账本「丢失一行不阻塞转换」的哲学一致）。
- `schemaVersion: 1`；恢复时忽略未知字段（前向兼容），缺失字段走默认值。

## 3. 持久化范围与形态

```jsonc
{
  "schemaVersion": 1,
  "uploads": [
    // owned（$TMPDIR 副本）：path/size/mTime 校验用；meta 直接复用（省 re-probe）
    // registered（用户文件）：path/size/mTime + meta
    { "id", "name", "path", "owned", "kind", "duration", "size", "mTimeMs", "streams", "meta", "at" }
  ],
  "runs": [ /* 仅 state==='running' 的 run 全量（含 items 快照）+ finishedAt 无关 */ ],
  "latestRun": "r…",
  "ptcRates": { "copy", "hardware", "video", "audio", "imageMs" },
  "interrupted": [ /* 未达终态的 job：{ "out" } —— 启动清扫半成品用 */ ]
}
```

- **写策略（write-through + 快照）**：upload 增删、run 创建/终态、interrupted 登记、rate blend 立即落盘；另加 60s 周期快照（unref）；`beforeExit`/SIGTERM 尽力 flush。
- **一致性级别**：最多丢失最近一分钟内未触发 write-through 的变动。可接受：队列变动大都伴随 upload 增删（write-through）。

## 4. 恢复语义（apply 启动时）

1. 读 state → 校验 schemaVersion → 逐 upload 校验：`fs.stat` 存在且 size+mTimeMs 匹配 → 直接采用存储 meta（**省 re-probe，这是持久化的主要收益**）；不匹配 → 重新 probe（文件被改过）；消失 → 丢弃该行（owned 副本被系统清 tmp 自然落入此分支）。
2. **中断清扫**：`interrupted[]` 里的 out 路径逐一无条件 `rm`（半成品绝不留给用户；$TMPDIR 副本同理）。
3. **批次恢复**：run 快照里 `converting`/`waiting` 归一为 `waiting`，`run.state` 保持 `'running'`，然后照常 `void executeRun/executePtcRun`——现有循环头跳过非 waiting 项，幂等成立，**自动继续执行**。
4. 面板契约：`/status` 的 `persistState` 语义扩展为「跨页面 + 跨重启都恢复」；**`restart.banner` 文案必须改**（现在写「DSH 已重启，此前的转换队列已清空」——R5 后不再总成立，改成中性提示）。
5. 与扩展/预设的交互：恢复后的实例重放 extensions/presets（宿主配置管道天然携带）；R5 集成测试必须带「一个已装载扩展 + 一个已存预设」的场景，验证重启后二者仍可用。

## 5. 测试形态（R5c 的验收清单）

- 核心集成用例：`apply → 上传 + 起批次 → dispose（=杀宿主）→ 重新 apply → 断言`：uploads 恢复（meta 未 re-probe 的断言点：probe 计数）、interrupted 半成品已清、run 恢复为 waiting 且自动跑完、ptcRates 延续。
- 场景用例：state 损坏（写字节垃圾）→ 改名 + 空启动；owned 文件丢失 → 行丢弃；registered 文件 mTime 变化 → re-probe；带扩展+预设的恢复。
- 变异锚点（新增）：恢复校验分支（size/mTime 不匹配 → re-probe）、中断清扫分支（interrupted 未清 → 半成品存在）。
- 判别力自检按第 4 期既定三道门槛。

## 6. 评审点（动工前逐条过）

1. 路径调整是否认可：`~/.media-toolbox-state.json` + `MEDIA_TOOLBOX_STATE`（与 history 账本一致）vs 原方案的 `~/.dsh-media-toolbox/state.json`。
2. 「中断项重跑」语义是否照此写死（README 明示）——ffmpeg 无法断点续转，重跑是唯一诚实选择。
3. 60s 快照 + write-through 的一致性级别是否接受；uploads 大队列（2000 行）每次 write-through 全量写盘的成本（JSON 约数百 KB，可接受？）。
4. `interrupted` 清单的登记时机：job 创建即登记、终态即移除——确认无遗漏窗口（job 创建与登记之间宿主死掉 → 半成品路径未知）。候选：登记写进 startJob 的同步段。
5. 恢复后自动继续 vs 等用户手动继续：本文按「自动继续」（宿主持有 run 的承诺）设计，是否有产品异议。
