# 方案：历史记录删除（单项 / 批量 / 可选连带真实文件）

> 状态：已发布（v1.7.0，2026-11-09）。决策已定稿并落地，见下方各节与 `decisions/history-delete-design.md`。

## 需求（原话）

历史记录页增加单项删除和批量删除；删除分为「只删记录」和「真实文件一起删」。

## 决策

1. **账本仍是追加式 JSONL，删除 = 过滤重写**。重写与追加共用一条 promise 写链（`withLedgerLock`），两者永不交错——否则重写可能吞掉正在途中的追加行。账本坏行（torn line）在重写中原样保留。
2. **路由 `POST /history/delete`**，body `{ items: [{ at, out }], deleteFiles }`，按键 `at:out` 匹配行。`at`+`out` 即前端 v-for 的行 key，同一毫秒同名输出视为同一行（重复行一并删，无害）。单次上限 500 条。
3. **删真实文件逐行防护**：`path.resolve(outDir, entry.out)` 必须过 `insideOutput`（isInsideDir）才 unlink；手工改过的账本行含 `../` 时只删记录不动文件。先删文件后写账本：账本写失败可重试，反之会留孤儿文件且无重试路径。
4. **响应** `{ ok, removed, filesDeleted }`；请求非法回 `ok:false`，方法错 405，认证篱笆照旧。
5. **客户端**：行首勾选框 + 「全选」；工具条常驻「同时删除真实文件」开关（checkbox）+「删除所选」；行内单项删除。删除键统一二次确认（再点一次，4 秒超时还原）；开关打开时确认文案明示文件将一并删除。删除成功后本地剔除行、扣 total，不整页重拉。
6. 同一个输出被多条记录引用时（同名重复转换），删一条带文件会把另一条变成「文件已删除」灰行——接受，下轮拉取自然呈现。

## 假绿防线

- host 测试新增删除路由用例：只删记录文件留存、deleteFiles 真删文件、批量、账本外路径拒绝 unlink、坏行重写后存活、非法请求 405/ok:false。
- mutation-check 新增 **A8**：删除路径的 `insideOutput` 守卫反转 → 穿越用例必须转红。

## 验证

- `npm test`（lint + format + typecheck + build + 6 测试文件）
- `npm run test:mutation`（A1–A8）
