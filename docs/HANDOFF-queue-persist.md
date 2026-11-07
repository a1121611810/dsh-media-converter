# 交接：媒体工具箱「切走再切回，运行状态丢失」问题（已修复）

> 状态：2026-11-07 修复并验证。本文记录根因、最终架构和验证方式，避免下一个接手的人重复之前 7 轮的弯路。
> 仓库：/Users/lilianda/develop/dsh-media-converter（DSH 客户端插件，Vue 面板 + Node 宿主）

## 1. 用户要的功能（原话）

1. "进入网页，选择文件，然后开始任务后，这时候若是关闭再进入发现就初始化了。改一下，工具箱设置那里增加开关，开了的话，无论什么情况，页面关了再开还是保持之前的状态。关了就是现在的情况。"
2. 后续追加（真正的痛点）："若是运行中，切出去，再切回来会又变回准备阶段"/"还是变成待开始的状态"。

即：开关打开时，无论页面关闭重开、切到别的会话再切回，队列和每个文件的运行状态都要保持/恢复。

## 2. 根因（已确认）

DSH 的面板主区域用 `retainMainPanels` + `entryKey` 切换（见 asar 里的 `@deepseek-ai/dsh-client-ui-layout`）：切到别的会话时 `<media-panel>` 会被卸载，切回来是一个全新的 Vue 实例。而**批次循环跑在浏览器里**（旧 `runSequential` 逐条 `POST /convert` + 轮询 `/job`），新实例只在 `loadServerQueue()` 那一刻对一次服务端，之后不再对账：

- 切回时若正好在两个 job 之间（或面板被重建），当前行没有 job → 显示「等待」（`item.ready` 的中文就是「等待」）；
- 旧实例继续在后台跑下一个 job，但新界面永远不会知道，后面每一行都停在「等待」；
- 批次进度条、X-Y 统计随卸载一起丢失，看起来就是「回到准备阶段」；
- `loadServerQueue()` 还是整表替换 rows，会把正在被本地轮询持有的行对象换掉，形成两份状态。

## 3. 最终架构：批次归宿主所有

- `POST /api/media-convert/run`：面板把勾选的一批交给宿主，宿主立即返回 `{ ok, run }`，然后在**后台**按顺序跑。每个条目仍是普通 `startJob`（所以 `/queue`、`/job` 全部照旧可查），走同一套 ffmpeg / 取消 / CPU 逻辑。页面关掉、重载、切走都不影响批次继续。
- `GET /api/media-convert/run`（不带 id = 最新一次）：返回 `{ ok, run }`，含每个条目的 `state / percent / jobId / error / result`。重建的页面用它恢复行状态与整体进度。
- `POST /api/media-convert/run/cancel`：取消 run，等待中的条目标记 cancelled，进行中的 job 走和单任务相同的 SIGTERM→SIGKILL 路径；如果取消落在「条目已开始、进程还没登记」之间，`executeRun` 在 `startJob` 之后会二次检查 run 状态并立刻 abort。
- 单个文件（详情页转换 / 裁剪 / 抽音轨）仍然走 `POST /convert` + `/job` 轮询，不受影响。
- 客户端：
  - `loadServerQueue()` 改为**按 upload id 增量合并**，保留行对象与勾选状态；
  - 批次改为 `POST /run` + 轮询 `/run?id=`（500ms），行状态由 `runItemPatch()` 推导；
  - 页面重建时 `/queue` 恢复文件与单任务 job，`/run` 恢复正在跑的批次；
  - 只恢复 `state === 'running'` 的 run：已结束的 run 不再重复应用，避免覆盖之后用户新做的转换。

## 4. 设计取舍（别当 bug 修）

- 队列来源是服务端内存：DSH 重启 → 队列空；上传超过 2h → 文件失效；完成的 job / run 保留 30 分钟。
- `/queue` 只回最新 200 条。
- 页面重建时勾选状态回到默认（恢复的行默认勾选、文本行不勾选）；逐行目标格式也重置为默认。同一实例内的增量合并则会保留原有勾选。
- PTC 批量（`usePtc` 勾选后）仍是旧的请求内调度：面板卸载会 abort 整个 PTC 请求。默认关闭；如果要它也在关页面后继续，需要把 PTC 计划执行也搬到 run 里。
- 被跳过的行（无声视频选纯音频格式）会在 run 里存一个 locale key 作为 `error`，恢复时再翻译。

## 5. 验证方式

- `npm test`：lint + format:check + typecheck + build + 6 个 `*.test.mjs`。host 测试新增 `/run`、`/run/cancel`、恢复与鉴权用例；`client-lib.test.mjs` 新增 `runItemPatch` 用例。
- 真机服务端验证（不需要页面）：认证 curl 上传一个视频 → `POST /run` 两项（一个转换、一个 skip）→ 每秒 `GET /run?id=`，应看到 `converting 9% → 34% → … → done`，输出文件落在 `~/Downloads/media-toolbox`。
- 真机 UI 验证（2026-11-07，KimiCU 操作真实面板）：两条 4 分钟 1080p 素材 → 面板「开始处理」→ 切到另一个会话 12 秒 → 切回。面板 AX 文本显示 `正在处理 0/2` + 取消按钮，运行行为 `27%`（不再是「等待」），排队行为「等待」；随后面板自行更新到 `85%`，最终两行都是 `完成 · 6.8 MB · -86%`。即：切回后既恢复了运行状态，也继续跟踪到结束。
- 改完代码后的生效方式：
  - 宿主（index.ts）改动 → **必须重启 DSH**（加载器不热重载宿主模块）；
  - 客户端（src/client）改动 → `npm run build` 生成 client.js，重启 DSH 或重新打开页面加载新 bundle。

## 6. 环境与调试手段

- **认证**：从桌面 App 的 Cookies 库里取最新一条（注意：DSH 重启后会 mint 新 cookie，旧的可能 401，等几秒再查）：
  `sqlite3 ~/Library/Application\ Support/@deepseek-ai/dsh-desktop/Cookies "select name||'='||value from cookies where host_key='127.0.0.1' order by last_access_utc desc limit 1;"`
  端口见 `lsof -nP -iTCP -sTCP:LISTEN -a -c DeepSeek`。
- 先看服务端（`/status`、`/queue`、`/run`），再看客户端，能省很多轮。
- 客户端 bundle 带 `&rev=<12位哈希>`，响应头 immutable；rev 只在 client.js 变化时更新。确认新 bundle 已生效：拉首页 HTML，看 `__DSH_BOOT__` 里 `dsh-media-converter` 的 `rev`。
- 本机屏幕捕获不可用（连 Finder 都取不到画面），无法用 GUI 自动化复现切换动作。

## 7. 文件地图

| 文件                       | 作用                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | 宿主：Config schema（含 persistState）、`/queue`、`/jobs`、`/run`、`/run/cancel`、`/source`、`/convert` 等全部路由；job / upload / run 表 |
| `src/client/App.vue`       | 队列 UI 与全部交互；`loadServerQueue()`、`applyRun()`、`pollRun()`、`runServerBatch()`                                                    |
| `src/client/lib.ts`        | 纯函数：`jobPatch()`、`runItemPatch()`、`sourceUrl()`、格式化等                                                                           |
| `src/client/index.ts`      | React 外壳 + 设置卡（persistState 开关）+ 文案                                                                                            |
| `test/host.test.mjs`       | 宿主路由集成测试（含 `/run` / `/run/cancel`）                                                                                             |
| `test/client-lib.test.mjs` | `jobPatch` / `runItemPatch` 等纯函数测试                                                                                                  |

## 8. 还值得做的事

- 如果用户实际在用 PTC 批量，把 PTC 也改成 run 驱动（服务端执行、页面只轮询）。
- 已完成 run 的批次摘要（完成 N · 失败 M）在重开页面后不恢复；行级结果由 `/queue` 恢复。若需要摘要，可让 `restoreRun` 对近期（如 10 分钟内）的已完成 run 也应用一次，但要按 job 时间戳避免覆盖新结果。
