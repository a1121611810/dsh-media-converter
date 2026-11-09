# 方案：Windows 显卡硬编（NVENC / Quick Sync / AMF）

> 状态：已实现。决策见下方各节。
>
> 评审后补的两条必修：驱动检测改成异步（面板不等显卡驱动），硬解重试路径补上测试。见「## 评审后的两条必修」。

## 需求（原话）

项目目前的硬件编码只是支持 macOS 的，现在需要支持 windows。

## 决策

1. **后端表驱动**。`lib/plan.ts` 里一张 `HW_BACKENDS` 表，每家厂商一行：编码器名、硬解参数、码率参数、显示名。加厂商 = 加一行，不改控制流。

   | 后端               | 编码器              | 硬解参数（`-i` 之前）                                       | 码率参数                   |
   | ------------------ | ------------------- | ----------------------------------------------------------- | -------------------------- |
   | Apple VideoToolbox | `h264_videotoolbox` | `-hwaccel videotoolbox -hwaccel_output_format videotoolbox` | `-allow_sw 1`              |
   | NVIDIA NVENC       | `h264_nvenc`        | `-hwaccel cuda -hwaccel_output_format cuda`                 | `-rc vbr`                  |
   | Intel Quick Sync   | `h264_qsv`          | `-hwaccel qsv -hwaccel_output_format qsv`                   | 无（通用 `-maxrate` 已够） |
   | AMD AMF            | `h264_amf`          | `-hwaccel d3d11va -hwaccel_output_format d3d11`             | `-rc vbr_peak`             |

   参数出自 FFmpeg 官方文档/源码与官方 wiki（NVENC 与 QSV 见 `doc/encoders.texi`，AMF 见 trac wiki `Hardware/AMF`）。**只写必需的选项**：少一个跨版本不兼容的选项，就少一处「这台机器整个后端被跳过」的风险。

2. **范围与 macOS 一致**：只做 H.264，容器限 mp4/mov/mkv/flv/ts。HEVC/AV1 硬编不在本次范围（flv/ts 不支持 HEVC，要另做「容器 × 编码」矩阵）。

3. **平台只给候选，机器说了算**。`lib/platform.ts` 的 `hardwareBackendsFor(platform)`：darwin → `[videotoolbox]`，win32 → `[nvenc, amf, qsv]`（独显优先），其它 → 空。真正的开关由探测决定。

4. **三重探测**（`index.ts`）：`--encoders` 看二进制里有没有该编码器 → `--hwaccels` 看硬解在不在 → **真编一帧**确认这台机器的显卡和驱动真的能用。三步都过才把开关露给用户。Windows 的 ffmpeg 构建普遍同时带 nvenc/qsv/amf 三个编码器，「二进制里有」不等于「机器能用」，第三步不能省。试编带上该后端的码率选项，选项名在这台机器的 ffmpeg 上不认识时，探测期就暴露，而不是在用户批量转码的中途。

5. **硬解优先 + 软解重试**。主路径是「GPU 硬解 → GPU 编码」零拷贝；显卡解不了这个文件时（老核显上的 VP9、ProRes 等），`startJob` 自动退回「CPU 解码 + 显卡编码」重跑一次，**编码器不变**，结果仍标「GPU 编码」。两次都失败才报错，不静默降级到 CPU 编码——那会让用户以为在用显卡。取消不重试。

6. **后端名进界面**：批量卡的开关从写死的「GPU 编码（VideoToolbox）」改成「GPU 编码（%s）」，由宿主把探测到的后端名传下去。

7. **Linux 维持现状**（无硬件路径），本次不做 VAAPI。

## 假绿防线

- `test/plan.test.mjs`：四个后端各自的编码器/硬解参数/码率参数/容器白名单/码率估算断言；QSV 必须带 `-maxrate`（不给会回落 CQP，码率失控）。
- `test/platform.test.mjs`：三个平台的候选后端列表。
- `test/host.test.mjs`：**注入式 runner**（探测链的接缝——`probeFfmpeg` 接受一个「跑 ffmpeg」的函数）报告 `h264_nvenc` + `cuda`，探测链整条都能在**没有显卡的机器上**跑：能用的假 runner → 报 `nvenc`；设备检查失败的假 runner → 不报后端（不给用户一个必然失败的开关）；Linux 平台 → 不报后端。
- **与 §5.2 的机制性偏离（行为不变）**：原计划用「仿现有假 ffprobe 的 POSIX sh 脚本」当假 ffmpeg，但仓库里那个假 ffprobe 是 `#!/bin/sh` 脚本，Windows 上 `execFile` 根本执行不了（Node 不经 shell 跑不了 sh 脚本），同一套断言在 Windows 必然跑不起来。改成把「跑 ffmpeg」这一步做成可注入的 runner 后，同一套断言在任何平台都能跑，探测链的行为一个字节没变。`lib/platform.ts` 的 `pickBackend` 同理：设备检查由调用方注入，所以选后端的判定也能在无显卡机器上确定性地验证。
- mutation 新增三条，都是**无显卡也能转红**的：A9（index.ts：设备检查不再决定后端）、A10（lib/platform.ts：Windows 候选被清空）、A11（lib/plan.ts：NVENC 编码器名写错）。为此 `scripts/mutation-check.mjs` 支持按突变指定源文件/测试/产物，默认仍是 index.ts + host.test.mjs。
- **mutation 脚本的崩溃恢复**：脚本会改源码注入突变，被强杀（Ctrl+C / CI 超时 / 崩溃）时 `finally` 不会执行，仓库就被留在突变态里——下一次运行的基线会因为「上次的突变」而变红，看起来像是本次改动坏了。现在脚本先把原始源码复制到 `.mutation-backup/`（已 gitignore），下次运行先恢复再干活，跑完删除。

## 顺带修的两处

- `test/i18n.test.mjs`：切行用 `split(/\r?\n/)`。Windows 检出是 CRLF，原来按 `'\n'` 切再比较整行会找不到字典块的结束行——这是本仓在 Windows 上的既有失败，与本次需求无关，但不修就没法在本机跑 `npm test`。
- `package.json`：`build`/`build:client` 里的 `rm -rf`、`cp` 是 POSIX 写法，cmd.exe 上不存在。改成 `node -e` 的等价写法，Windows 与 POSIX 都能构建。

## 验证

- `npm test`（lint + format + typecheck + build + 7 个测试文件）
- `npm run test:mutation`（A1–A11）
- `npm run check:build`（`client.js` 与源码一致）
- 真机（本机 Windows 11 + Intel UHD 630，ffmpeg 9.0.2 essentials，2026-11-09）：探测报 `Intel Quick Sync`；用插件自己的 `hardwareFor` 参数跑通「硬解 + 硬编」——ffmpeg 输出 `Stream #0:0 -> #0:0 (h264 (h264_qsv) -> h264 (h264_qsv))`、`encoder: Lavc63.1.102 h264_qsv`，像素格式 nv12（帧留在 GPU，没有下到 CPU），码率 1500k / maxrate 2250k 按计划生效（QSV 没回落 CQP）。同一台机器上 nvenc（无 N 卡，报 `Cannot load nvcuda.dll`）与 amf（无 A 卡，报 `amfrt64.dll failed to open`）被设备检查正确拒掉，不给用户一个必然失败的开关。
- 仍未真机验证：N 卡上的 NVENC、A 卡上的 AMD AMF（AMF 的 `-rc vbr_peak` 选项名也要在 A 卡上核对一次）。

## 真机 GUI 验证（系统上装的 DSH，2026-11-09）

在系统真实安装的 DeepSeek Harness（`%LOCALAPPDATA%\Programs\DeepSeek Harness`）里跑通了端到端：

1. **界面**：批量卡的开关显示「**GPU 编码（Intel Quick Sync）**」——后端名由宿主探测结果注入，默认勾选。
2. **真实转换**：队列里放一个 1080p30/10s 的 **mpeg4 视频码** mp4（源与目标同为 h264 时插件优先走流拷贝，编码器根本不启动，测不到硬件路径；mpeg4 码拷贝规则不匹配，才会真正走编码），点「开始处理」，行状态显示「完成 · 15.0 MB · -26% · **GPU 编码**」。
3. **产物核实**（`ffprobe -select_streams v:0 -show_entries stream_tags=encoder`）：`encoder=Lavc63.1.102 h264_qsv`（硬件），对照同源的 `libx264` 软编产物（7.0 MB / `encoder=Lavc63.1.102 libx264`）明显可区分。

### 两个只有真机才会暴露的坑

- **改了 `client.js` 必须重启整个 DSH 进程**。宿主重新 apply 时会读到新的 locale 词典，但**渲染进程里的 Vue 组件代码还是旧的**——两边错位就会渲染出字面量占位符（界面显示「GPU 编码（%s）」）。Ctrl+R、重新进面板都不行，只有重启进程才会重新加载磁盘上的 bundle。
- **验证硬件路径必须用不能流拷贝的源**，否则「完成」只是拷贝，编码器没启动。

## 评审后的两条必修（ponytail-review，2026-11-09）

评审结论是「先修 1 和 2」，其余 11 条（建议修 / 可选优化）不在本轮范围。

### 必修 1：硬解重试路径补测试

重试策略（硬件计划失败 → 去掉硬解参数再来一次）原先一行测试都没有，而它在真机上确实会被走到：本机 Intel UHD 630 + 10-bit HEVC 源，第一遍 `-hwaccel qsv` 解码器起来了（`Using device 8086:3e92`）但 `h264_qsv` 编码器打不开（退出码 -40），第二遍去掉 `-hwaccel` 后成功（退出码 0）。

做法：把重试策略抽成 `index.ts` 导出的纯函数 `runJobAttempts(plan, attempt, out, shouldStop)`，`startJob` 调用它，测试用假回调驱动三种结局（一次成功 / 第一次失败第二次成功 / 两次都失败）、取消不再重试、失败留下的半成品输出在重试前被清掉。`apply()` 的签名没动。

### 必修 2：驱动检测改成异步

原来的 `/status` 会等完整探测（含真编一帧），设备检查串行、每个 15 秒超时，Windows 上 3 个候选后端 → 最坏约 60 秒白屏，整块面板（格式列表、队列、设置）都不可用。

改成两半：

| 半     | 内容                        | 时钟  | 谁在等                             |
| ------ | --------------------------- | ----- | ---------------------------------- |
| build  | `--encoders` + `--hwaccels` | 15 秒 | `/status` 立即应答（本机 ~0.2 秒） |
| device | 真编一帧（启动显卡驱动）    | 8 秒  | 后台跑，判定落地后客户端轮询补上   |

- 客户端在检测没结束时显示「显卡驱动检测中…」，点「开始转换」会等判定再开始，不悄悄退回软编。
- 服务端也兜底：任何带 `hardware: true` 的请求，判定还没落地就先等（最多 8 秒）。
- 候选后端**并行**做设备检查：挂住的驱动只等一次，不是每个候选各等一次。代价是一次性初始化所有厂商的驱动（结果按 ffmpeg 路径缓存）。
- 顺带修了一个既有缺陷：`-encoders` 失败时 `supportedFormats([])` 会返回**空格式表**，面板一个格式都不能转；现在回退到内置 `FORMATS`。
- 显卡状态（后端判定）从模块级全局挪进 `apply()` 实例内——多实例测试里一个实例的判定会污染另一个。

两个用户决定：探测在**面板打开时就在后台开始**（不做额外触发协议）；检测没完成时点转换**等结果**，并显示提示。

### 验证时发现的第三个缺陷：判定落不到新实例

真机复验时用「停用插件 → 重新启用」把插件重新 apply 了一次，面板从此永远停在「显卡驱动检测中…」，GPU 开关再也不出现——而重启用之前一切正常。

根因：设备探测的**缓存按 ffmpeg 路径放在模块级**，判定（`hwBackend` / `deviceSettled`）放在 `apply()` **实例内**。缓存命中时（旧写法）判定只在「缓存未命中」分支里写进实例，于是新实例永远等不到判定，只能一直报「检测中」。

修法：把「落地判定」移出缓存分支——缓存活得比实例久，谁来问谁接管一次判定。配套：`test/host.test.mjs` 加一条「同一路径的第二个实例必须接管已缓存的判定」（`detecting` 由真变假），变异脚本加 A15 守这条（把落地逻辑挪回缓存未命中分支 → 转红）。
