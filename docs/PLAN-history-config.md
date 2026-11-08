# 方案：历史记录 + 可配置 TTL/队列上限 + 重启告知

> 状态：第一期已开工。决策已定稿，改动按三期推进，每期独立可验。

## 背景

队列/任务/批次全在进程内 Map，重启即丢（ffmpeg 子进程随插件 dispose 被 SIGTERM）。本方案不解决「重启续跑」（对本地桌面工具过度），解决的是：记录消失、参数写死、用户不知情。

## 决策（已拍板）

1. 历史条目含 cancelled；条数不限，JSONL 追加（整读 + append 一行，永不重写全文件）。
2. 账本文件 `~/.media-toolbox-history.json`，env `MEDIA_TOOLBOX_HISTORY` 可覆盖（测试隔离）。
3. 重启告知 = instanceId 检测横幅（挂载 + 可见性变化的 /status 拉取点比对 sessionStorage）+ 设置页静态文案。
4. sweep 修复：跳过被 running job 引用的 upload。
5. 设置卡分两组（常规 / 队列与保留），hint 压一行。
6. 新增配置：`uploadTtlMinutes`（默认 120，钳 ≥5）、`queueLimit`（默认 2000，钳 ≥10），取代常量 UPLOAD_TTL_MS / QUEUE_LIMIT。

## 三期

### 一期：配置项 + sweep 修复

- `index.ts`：两配置字段 + 钳制；常量改运行时变量；status 带两值；sweep 跳过 running 引用。
- 客户端：设置卡分组 + 两数字字段 + 组底重启静态文案；locale zh/en。

### 二期：历史记录

- `index.ts`：JSONL 账本（settle 处 append：done/error/cancelled）；`GET /history?offset&limit`（倒序，仅当页 stat 出 deleted）。
- 客户端：历史页签；deleted 行灰显 + 红字「文件已删除」，预览禁用，reveal 保留；翻页。

### 三期：重启告知

- `index.ts`：`instanceId = randomUUID()` 进 /status。
- `App.vue`：instanceId 变化 → 可关闭横幅。

## 假绿防线

三个测试面全吃构建产物（`dist/index.js`、`dist/src/client/lib.js`、`client.js`）——突变必须过 build 并在对应 dist 产物 grep 验证已应用。

`scripts/mutation-check.mjs`（A1–A7）+ `npm run test:mutation`，不进 `npm test`。纪律：路径单一 ROOT 派生；突变双重断言（源层 + dist 层）；逐条期望/实际；每条还原复跑基线；脚本自验（至少手工复现 1 条）。

## 验证

每期：常规测试绿 → 攻击全红 → 还原基线绿 → 真机 curl。三期完跑全量攻击。

- 常规：`npm test`（lint + format + typecheck + build + 6 测试文件）
- 攻击：`npm run test:mutation`
