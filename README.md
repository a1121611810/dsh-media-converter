# dsh-media-converter

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/a1121611810/dsh-media-converter)

DeepSeek Harness 的本地多媒体工具箱插件：转换、裁剪、提取音轨/画面、字幕导出、图片压缩、元数据查看与改写、Base64 编解码。支持一次处理多个文件，全部在本机用 ffmpeg 完成，文件不出本机。

![icon](icon.svg)

## 功能

| 动作 | 说明 |
| --- | --- |
| 转成 X | 视频 12 种（mp4/mov/mkv/webm/avi/flv/wmv/ts/ogv/gif/mp3/m4a）、音频 8 种（mp3/m4a/aac/wav/flac/ogg/opus/aiff）、图片 7 种（png/jpg/webp/gif/bmp/tiff/avif）；按本机 ffmpeg 实际具备的编码器过滤——如 homebrew ffmpeg 9 缺 libtheora/libvorbis/libaom/libwebp，则不显示 ogv/ogg/avif/webp；多轨文件可选轨：视频转视频选画面轨、带音频输出选音轨（详情页下拉，第 2 条起，显式选轨将禁用直接拷贝）；mp4/mov/mkv 软件编码可选编码器：H.264（默认）/ HEVC（libx265，体积更小）/ AV1（libsvtav1），按本机编码器探测显隐，显式选择将禁用直接拷贝；画面几何：裁剪（`宽:高[:x[:y]]`，宽高偶数）、旋转 90/180/270、翻转（水平/垂直），任一存在即重编码；「仅换封装（remux）」直接拷贝到目标容器、绝不重编码，不兼容组合报错、与裁剪互斥 |
| 裁一段 | 从播放器取起点/终点，或手填 `分:秒`；裁剪与转换一次完成 |
| 提取音频 / 提取画面 | 直接拷贝轨道，不重编码 |
| 提取字幕 | 内嵌字幕轨导出 `.srt`/`.ass`/`.vtt`（可选），文件名带语言码（如 `clip.chi.srt`） |
| 合并 | 队列勾选 ≥2 个同类视频/音频 → 批量卡选「直接拷贝」（要求编码与分辨率一致，最快）或「重编码」（不要求源一致）→ 一键合并；产物只保留主画面与第一条音轨；经 `/run` 执行，支持取消与恢复 |
| 按章节分割 | 元数据视图的章节列表 → 每个章节一个文件（「直接拷贝」按关键帧裁剪、快但起止不精确；「精确重编码」可选；命名带章节号与标题，如 `clip-ch2-正片.mp4`） |
| 变速 / 响度 | 详情页/裁剪：变速 0.25–4 倍（视频 setpts + 音频 atempo 联动、强制重编码）、单遍响度归一化（EBU R128，-16 LUFS） |
| 文字水印 | 详情页/裁剪：水印文字 + 四角位置，白字黑底半透明；本机 ffmpeg 需带 drawtext（libfreetype），`/status` 探测后无则隐藏控件 |
| 字幕烧录 | 详情页/裁剪：内嵌字幕轨烧进画面（subtitles 滤镜 + 系统字体目录），强制重编码；本机 ffmpeg 需带 subtitles（libass），探测后无则隐藏 |
| 截图 | 详情页「截个图」：按时间点输出单帧 png/jpg 到输出目录 |
| 质量滑杆 | 软件编码视频调各编码的质量参数（mp4/mov/mkv/flv/ts → x264 CRF，webm → vp9 CRF，avi/wmv/ogv → qscale）、GPU 硬编调目标码率倍率、JPG/WEBP/AVIF 调质量（AVIF 映射 AV1 CRF）；图片带右侧实时预览 + 并排/滑块对比 |
| 音频参数 | 音频文件与视频转 mp3/m4a：可选码率（64-320k）、声道（单声道/立体声）与采样率（8k-48k 常用值），语音场景一键 mono + 22050 Hz |
| 元数据 | 查看容器、章节、逐轨参数与全部标签；改写标题/作者/专辑/备注/日期/流派（另存为新文件） |
| Base64 | 当前文件 → `data:` URL；或粘贴 Base64 还原成文件 / 文本 |
| 扩展平台 | 设置页导入 JSON 扩展包（数据包，非代码）：宏 = 固定参数组合的新动作，出现在文件详情动作网格与批量目标里；配方 = 覆盖内置格式的 ffmpeg 参数（白名单校验，quality 滑杆可映射）；删除即恢复内置 |
| 批量处理 | 按类型分组：视频/音频/图片各自一个目标；文本单独一段、不参与转换；读取中/未识别单独一段；逐组全选/质量、码率/声道采样率下拉，逐行进度/结果/取消 |
| PTC 调度 | 批量转换可选：在 DSH 已注册模型里选一个（默认跟随主模型），模型只返回每文件 JSON 计划，宿主校验后交给 PTC 沙箱执行；整批按组多次求值，可超过单次 10 分钟上限；批次由宿主持有，切会话/关页面后继续；低推理档、分阶段进度；默认关，耗 token |
| GPU / 直接拷贝 | 显卡硬编可勾选 GPU 编码（mp4/mov/mkv/flv/ts），探测到 HEVC 能力后还可选 H.264 / HEVC：macOS 走 VideoToolbox，Windows 走 NVENC / Intel Quick Sync / AMD AMF（自动探测后选一个）；兼容编码/容器直接 `-c copy`，不重编码 |
| 取消 | 批量中途取消停当前 ffmpeg 并不再排队；单文件任务可随时取消；上传中也能中断传输 |

界面分两层：**队列**是首页，负责一次处理多个文件；点某一行进入**文件详情**，那里是单个文件的操作页。

- **队列**：拖入或选择多个文件 → 可转换的默认勾选 → 顶部「批量处理」卡选处理方式（转换 / 提取音频 / 提取画面）、PTC/GPU；目标格式和图片质量在各自的类型组标题里。每一行有自己的上传/处理状态、进度、结果与「显示」；可全选、按组全选、取消勾选、移除、清空（两步确认）。除了原生选择器和拖拽，面板还支持**从路径添加**：宿主直接浏览本机目录并登记绝对路径，几百个文件不经过浏览器上传、也不复制文件（登记的文件属于用户，永远不会被插件删除）。可浏览范围限于家目录、`/Volumes`、临时目录和输出目录；点文件不列出。
- **文件详情**：点某行的「详情」进入。这里是单文件工作台：预览/图片对比、搜索、按「转换 / 编辑 / 查看」分组的动作网格（转格式、裁一段、提取、字幕、元数据、Base64），参数就地展开、结果就地显示。`⌘K` 聚焦搜索，回车执行第一个动作，Esc 收起；「返回队列」保留队列与结果。
- **处理范围**：批量动作只处理勾选的可转换行；文本、读取中、未识别不参与批量；详情页的动作只处理当前打开的那个文件。PTC 只出现在批量转换面板，且勾选 ≥2 时才可用；打开后才出现模型下拉，进度分“模型决定中”和“转换 N/M”两段；单个文件不走 PTC。PTC 批次由宿主执行，切走会话或关掉页面都会继续，重新打开会恢复进度。

## 批量、调度、GPU 与 PTC

- **分组与目标**：视频、音频、图片各自一段，组标题有“默认目标”；每一行还有自己的目标格式下拉，改单行只影响该行。视频段和图片段还有质量滑杆（视频在 GPU 开关打开时映射为码率倍率）；音频目标出现码率、声道/采样率下拉。文本单独一段、勾选禁用，详情只保留 Base64；读取中/上传失败单独一段，没有目标、不可批量。
- **固定规则 vs PTC**：固定规则批量按三条车道并行——软件重编码视频 1 路（最重的活不并发）、GPU 硬编 3 路、其余轻任务（copy/音频/图片）最多 4 路；运行中的任务不抢占。PTC 批量走自适应 CPU 队列。
- **自适应 CPU 调度**：[lib/schedule.ts](lib/schedule.ts) 每秒用 `os.cpus()` 的差值采样，EMA 平滑；平滑使用率 >60% 只跑 1 个，35–60% 2 个，<35% 最多 4 个。任务权重：视频 1、音频/图片 0.5、copy 0.25、GPU 0.5；GPU 另限 2 路。容量 >1 时给每个软件编码 ffmpeg 分 `-threads/-filter_threads`；运行中的任务不抢占。
- **GPU（显卡硬编）**：批量卡出现“GPU 编码（后端名）”——macOS 是 VideoToolbox，Windows 是 NVIDIA NVENC / Intel Quick Sync / AMD AMF，按这个优先级自动选一个。探测分三步：`--encoders` 看二进制里有没有该编码器、`--hwaccels` 看硬解在不在、最后真编一帧确认这台机器的显卡和驱动真的能用；三步都过才显示开关，所以“ffmpeg 里有 nvenc 但机器没 N 卡”不会给出一个必然失败的开关。面板打开即在后台跑第三步，不阻塞界面；检测没结束时批量卡显示“显卡驱动检测中…”，点“开始转换”会等结果，不会悄悄退回软编（服务端也会等，最长 8 秒）。选中 GPU 后若该后端的 HEVC 兄弟编码器也通过了同样的一帧实测，可再选 H.264 / HEVC（HEVC 仅 mp4/mov/mkv/ts，自动补 `hvc1` 标签；体积更小，面板内能否预览取决于系统解码）。对 mp4/mov/mkv/flv/ts 走硬解+硬编的零拷贝路径（NVENC `-hwaccel cuda`、QSV `-hwaccel qsv`、AMF `-hwaccel d3d11va`）；按源码率估 `-b:v/-maxrate/-bufsize`。显卡解不了这个文件时（例如老核显上的 VP9）自动退回 CPU 解码 + 显卡编码重跑一次，编码器不变，结果仍标“GPU 编码”。WebM/VP9/AV1、图片、音频没有对应硬件编码，仍走 CPU。
- **直接拷贝**：h264/hevc + aac/mp3 等兼容组合直接 `-c copy`（mp4/mov/mkv/webm/ts 与同编码音频容器），有裁剪或编码不兼容才重编码；行上显示“直接拷贝”。
- **PTC 可选模型**：默认跟随 DSH 当前主模型；下拉列出已注册模型；显式模型不在目录里会报错，不回退默认。对选中模型取最低推理档，`maxTokens` 6000；模型只返回 `{"files":[{"id","format",...}]}`，可选 `quality`（1-100）、`bitrate`（kbps，音频编码目标）、`channels`/`rate`（1/2 与采样率 Hz，音频编码目标）、`fps`/`width`（帧率与宽度上限，视频目标）、`codec`（h264/hevc/av1：开 GPU 走硬编 hevc 限 mp4/mov/mkv/ts；未开 GPU 走软件编码 hevc/av1 限 mp4/mov/mkv），宿主校验后拼程序交给 PTC 执行。分组和时限都按实际情况动态算：每个文件的耗时由本机实测吞吐（copy / 硬件编码 / 视频 / 音频各自维护，跑过的任务会持续校准）估算，按「整组估算 ≤ 运行时上限」装组；组内文件数上限随 CPU（约 4×核心数，夹在 4–64），并发波宽随当前 CPU 负载（4–16 个 binding 调用）。每组一次沙箱求值、各自限时，整批可以超过单次 10 分钟；面板会显示基于同一估算的剩余时间。
- **实测**（10 秒 1080p30 合成样本，机器负载约 4.6；不是你的真实文件）：

  | 路径 | 耗时 | 输出 | VMAF |
  | --- | --- | --- | --- |
  | libx264 veryfast CRF 23 | 2.1–2.3 s | 6.35 MB | 95.02 |
  | h264_videotoolbox 5 Mbps | 2 路并行 3.2 s（每路约 1.6 s） | 6.45 MB | 95.15 |
  | 直接拷贝 | 0.02 s | 11.48 MB | — |

  结论：可拷贝时最快；GPU 画质与 CPU 接近，CPU 占用/内存明显更低，适合机器本来就很忙时；真实文件、分辨率和负载不同，以现场为准。

> 新界面的截图会在手工验收后补上。

## 给 Agent 用的工具

同一个引擎也注册成工具 `media_toolbox`，助手可以直接调用：

| action | 作用 |
| --- | --- |
| `probe` | 读时长、分辨率、编码、音轨、字幕轨、标签 |
| `convert` | 转格式（可带 `trim` 裁剪；`quality` 1-100：软件编码视频映射各编码质量参数——mp4/mov/mkv/flv/ts 为 x264 CRF、webm 为 vp9 CRF、avi/wmv/ogv 为 qscale，软件 hevc/av1 映射各自 CRF——GPU 硬编映射目标码率倍率，图片 jpg/webp/avif 有效；转 mp3/m4a/aac/opus 可带 `bitrate` kbps 32-320，音频编码目标可带 `channels` 1/2 与 `sampleRate` Hz 8000-96000——GPU 硬编时这三个音轨参数对 mp4/mov/mkv/flv/ts 的输出音轨同样生效；指定 `codec`（h264/hevc/av1）选输出编码器——软件编码 hevc=libx265、av1=libsvtav1 仅 mp4/mov/mkv 有效（本机缺编码器时任务报错，其它容器回退 H.264），不填 `hardware` 时指定 codec 视同请求 GPU 硬编（h264/hevc，hevc 限 mp4/mov/mkv/ts）；`hardware` 显式 false 强制软件编码；画面几何 `crop`（宽:高[:x[:y]]，偶数）/`rotate`（90/180/270）/`flip`（h/v），任一存在即强制重编码；`remux: true` 仅换封装（直接拷贝，绝不重编码，不兼容组合报错、与 trim 互斥）；多轨文件可带 `videoTrack`/`audioTrack` 选类型内第几条画面/音轨，1=第二条，0 或不填走默认轨，显式选轨将禁用直接拷贝） |
| `extract-audio` / `extract-video` | 抽音轨 / 抽画面，不重编码（多轨文件可带 `stream` 选类型内第几条，0=第一条） |
| `concat` | 合并多个同类型文件（`paths[]` 本机绝对路径，≥2 ≤64；`mode` = `copy` 直接拷贝（要求编码与分辨率一致）/ `encode` 重编码（可带 `format`/`quality`）；产物只有主画面+第一条音轨） |
| `split-chapters` | 按内嵌章节分割（默认 copy 关键帧裁剪；`mode=encode` 精确重编码；返回 `files[]`，每章一个，命名带章节号） |
| `snapshot` | 单帧截图（`at` 秒 + `format` png/jpg，默认 png；仅视频文件，时间点须小于时长） |
| `subtitle` | 导出内嵌字幕为 `.srt`/`.ass`/`.vtt`（`format` 选格式，默认 srt） |
| `rewrite-tags` | 改写标题/作者/专辑/备注/日期/流派 |

convert 可带 `preset`（`x:<包id>/<动作id>`）：按扩展预设转换，覆盖 format/quality；预设不存在会报错。PTC 批量同样可选预设（模型只回宿主校验过的引用）。

工具吃的是**本机绝对路径**，不走上传：产物写在同一个输出目录，返回新文件路径。调用被取消或超时（30 分钟）时，ffmpeg 会被终止，半成品会被清掉。

输入框工具排（「+」按钮那一排）有一个「媒体工具箱」按钮：点一下把示例指令 `把 xx.mov 裁 0:10 到 1:00 转成 mp4` 插进输入框，改成你的文件和区间后发送即可。

## 大文件

- **不整文件进内存**：上传边收边落盘；Base64 结果边编码边发回；预览走 HTTP Range，拖进度条不会整段下载。
- **不阻塞宿主**：文件读写全部用异步 API，转码期间 DSH 界面照常响应。
- **随时可取消**：每个任务带一个 `AbortSignal`，取消即向 ffmpeg 发终止信号并清掉半成品；ffmpeg 要到下一帧才真正退出，这期间界面显示「正在取消…」，退出后才是「已取消」。上传用 `AbortController` 中断传输，服务端不留残余副本。
- **临时文件会自我清理**：上传的副本放在 `$TMPDIR/dsh-media-toolbox`，超过 2 小时自动删除，插件卸载时也清空。

## 安装

已发布到 npm（`dsh-media-converter`）。一行装完：

```sh
dsh plugin --profile web add dsh-media-converter
```

`web` 换成你自己的 profile 名即可。也可以在 Harness 里用 `plugin_manager` 的 `install_bundle` 装。

从源码装（开发用）：`plugin_manager` 的 `install_bundle`，target 指向本仓库目录——它会在 profile 的 `package.json` 里登记包名，并在 `node_modules/` 下建一条软链指向本目录。

从 GitHub 装（未发布 npm 时的退路）：

```sh
dsh plugin add github:a1121611810/dsh-media-converter --profile <profile>
```

装好后左侧栏出现「媒体工具箱」。

> 换包名后需要**重启应用**：运行中的 Host 会缓存旧包名的客户端条目，热装清不掉。

## 依赖

- **ffmpeg**：插件按顺序查找 `config.ffmpegPath` → `FFMPEG_PATH` → `PATH` → 常见安装目录 → imageio-ffmpeg 自带的静态包。找不到时页面顶部会提示安装方式。
  - macOS/Linux：`/opt/homebrew/bin`、`/usr/local/bin`；imageio 静态包在 `~/Library/Python/*/lib/python/site-packages/imageio_ffmpeg/binaries` 或 `~/.local/lib/python*/site-packages/...`。
  - Windows：`PATH` 里找 `ffmpeg.exe`（装在 `C:\ffmpeg\bin` 也认），imageio 静态包在 `%LOCALAPPDATA%\imageio_ffmpeg\binaries` 或 `%APPDATA%\Python\Python*\site-packages\...`。
  - GPU 编码需要 ffmpeg 带对应编码器：macOS `h264_videotoolbox`（本机 imageio 7.1 自带），Windows `h264_nvenc` / `h264_qsv` / `h264_amf`（gyan.dev、BtbN 的 Windows 构建都带）；HEVC 另需同族编码器（`hevc_videotoolbox` / `hevc_nvenc` / `hevc_qsv` / `hevc_amf`）且通过一帧实测。插件探测后显示开关，没有就隐藏。
  - 手动指定路径时，Windows 下写不写 `.exe` 都行。
- **ffprobe（可选增强）**：找到 ffprobe 时元数据改用它输出结构化 JSON 解析（封面图、5.1 这类带数字的声道布局、负 start 时间等边界情况更可靠）。探测顺序是 ffmpeg 同目录（完整安装两者成对出现）→ `PATH` → 常见安装目录；找不到（imageio-ffmpeg 只带 ffmpeg 单个二进制）自动回退到解析 `ffmpeg -i` 的 stderr，功能不受影响。设置页「当前生效」列表会显示当前解析模式，兼容模式下给出安装指引——装好完整版 ffmpeg 后回本页点「保存」即切换，无需重启。

## 配置

设置弹窗侧边栏的「媒体工具箱」页可直接编辑配置：保存经宿主的 settings 服务校验并写入 profile（`cordis.patch.yml` 里会出现对应的 `config` 块），同时**立即应用到运行中的插件**——宿主加载器不会热重载，是插件在保存后自行应用合并，所以无需重启；直接手改 `cordis.patch.yml` 才需要重启。留空的字段保持默认（输出目录默认 `~/Downloads/media-toolbox`，ffmpeg 自动查找，上传上限 2048 MB）。

同一个配置也驱动「内置插件」页里本插件行的官方配置表单（来自插件导出的 Schemastery schema，字段标记 `volatile()` 才可编辑）：

```yaml
- id: media-converter
  name: 'dsh-media-converter'
  config:
    outputDir: ~/Movies/converted
    ffmpegPath: /opt/homebrew/bin/ffmpeg
    maxUploadMb: 2048
```

- `outputDir`：`~` 会展开成主目录，路径会被解析成绝对路径。
- `ffmpegPath`：找不到 ffmpeg 时手动指定。
- `maxUploadMb`：单次上传上限（默认 2048 MB），超了直接拒绝，不写盘。
- `composerButton`：是否在输入框工具排显示「媒体工具箱」按钮（默认开）。
- `extensions`：扩展包原文（JSON 文本），设置页的扩展管理卡读写；保存时整包校验，坏包拒收。
- `groups`：文件详情页动作模块的顺序与显隐（`convert,edit,view`，写进字符串的才显示）。
- `features`：功能白名单（逗号分隔的动作 id：`probe,convert,extract-audio,extract-video,subtitle,meta,base64`），留空全启用、未知 id 忽略；停用后对应入口（单任务转换、批量、Agent 工具、Base64）直接报「该功能已停用」，保存即生效。
- 设置页右上角还有版本号显示与「刷新界面」（等同 Ctrl+R）。

插件导出 `Config` schema 供宿主的 settings 服务投影表单（这是唯一的运行时依赖 `@deepseek-ai/schemastery`，由 npm 正常安装）。

## 开发

```bash
npm test              # 类型检查 + 构建（宿主 dist/ 与浏览器 client.js）+ 七套自检
npm run build         # 构建：宿主 tsrs → dist/，浏览器 vite → client.js
npm run build:host    # 只构建宿主半边（tsrs → dist/）
npm run build:client  # 只构建浏览器半边（vite → client.js + sourcemap）
npm run typecheck     # 只做类型检查（tsrs，连 .vue 一起查）
npm run check:build   # 改了源码却没重新构建时失败（CI 用）
```

源码是 TypeScript（strict）：宿主是 `index.ts` + `lib/*.ts`，浏览器是 `src/client/*.ts` + `.vue`（`<script setup lang="ts">`）。类型只进编译期，**运行时零新增依赖**——npm 包里只有编译好的 JS。测试保持 `test/*.test.mjs` 不转，但改成跑**编译产物**，测的正是发布形态的代码。

编译器用 [`tsrs`](https://github.com/oxc-project/tsrs)（TypeScript 7 的 Rust 移植版，drop-in 替换 `tsc`）：`.vue` 走 TypeScript 7 的 content-mapper 协议检查（`@vue/content-mapper` 把 SFC 变成虚拟 TS），所以**没有 `vue-tsc`**。副作用：检查时编译产物与 tsc 5.9 逐字节相同，宿主检查快约 3 倍。

两半都是**构建产物**：

- 浏览器半边：`src/client/` 是源码，`client.js` 提交进仓库（DSH 直接从包目录读它，链接安装不会触发构建）。改了 `src/client/` 之后必须 `npm run build:client`，否则 `check:build` 会红。
- 宿主半边：源码是 `index.ts` + `lib/*.ts`，`tsrs` 编到 `dist/`，npm 包的入口是 `dist/index.js`。改完必须 `npm run build:host`，再**重启 DSH**。

两半之间的 JSON 契约**没有单独一份文件**：类型就住在产出数据的那段代码旁边（`lib/plan.ts`、`index.ts`），能推导的就推导（`ReturnType<typeof parseMeta>`），只有被多状态改写的形状（Job 状态机）才手写一次。面板用 `import type` 引入——编译期完全擦除，浏览器包不会因此拖进 `node:fs`。

```bash
node test/client-bundle.test.mjs  # 产物契约：loader 握手、React 注入、两个槽位
node test/client-lib.test.mjs     # 面板纯函数：格式化、时间码、裁剪窗口、按类型目标
node test/plan.test.mjs           # 格式表、参数、元数据解析、裁剪、copy/显卡后端/容量/线程
node test/base64.test.mjs         # 魔数嗅探、Base64 往返、文本回退
node test/platform.test.mjs       # ffmpeg 查找顺序、文件管理器命令、文件名规则、目录归属判定、各平台显卡后端与并行设备检查（含 Windows 分支）
node test/host.test.mjs           # 真 ffmpeg 端到端：27 种格式矩阵 + 字幕 + 标签改写 + 取消 + 失败路径 + Agent 工具 + 上传上限 + PTC JSON 计划/模型目录/进度 + copy + 注入式探测显卡后端 + 硬解失败重试路径 + 坏 ffmpeg 的格式表回退
```

`test/host.test.mjs` 需要本机有 ffmpeg；没有会**失败**（不是跳过——静默跳过等于假绿）。

## 代码风格

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)**：配置在 `.oxlintrc.json`。只开 `correctness` 一类——`suspicious`/`perf`/`style`/`restriction` 全开是 11/13/1750/137 条意见，基本是风格口味，其中 `no-await-in-loop`（上传和转码是**故意**串行的）、`no-underscore-dangle`（`__dshReact` 是 loader 的契约名）和这个仓库的写法正面冲突。插件开 `typescript`/`oxc`/`unicorn`/`import`/`node`/`vue`；`.vue` 的 `<script>` 块会被查（`vue` 插件）。两处 `no-control-regex` 是故意的（文件名里的控制字符就是要剔掉），在代码里就地豁免；`reportUnusedDisableDirectives` 会把失效的豁免报成错——它已经抓到过一条 2024 年留下的死豁免。
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)**：配置在 `.oxfmtrc.json`（单引号、行宽 120、`sortPackageJson: false`——不动已发布的 keywords 顺序）。`client.js`（压缩产物）和 `README.md` 不进格式化范围：前者是产物，后者一格式化就会按字符数给中文表格补列宽（CJK 是双宽字符，补出来的分隔线长短不齐）。`.editorconfig` 让编辑器跟格式化器用同一套缩进和行宽。
- **类型相关的 lint 规则没开**：`oxlint --type-aware`（需要额外的 `oxlint-tsgolint`）在这个仓库只报出 4 条，全是误报——`const h = React.createElement`、`export const apply = plugin.apply` 这种解引用方法（本来就不依赖 `this`）、测试里故意用的 `new Function`、以及断言里的 `.sort()`。类型层面的问题由 `tsrs` 负责，重复跑一套类型引擎不值。

```bash
npm run lint          # oxlint
npm run lint:fix      # oxlint --fix
npm run format        # oxfmt，就地改写
npm run format:check  # oxfmt --check，只报不改
```

`npm test` 里已经带上 `lint` 与 `format:check`，所以 CI 和发版都会拦住风格漂移。

### 发版

```bash
npm run release -- 1.2.0
```

一条命令做完全部步骤：校验在 main、工作区干净、跑 `npm test`、确认产物不是旧的、bump 版本、打 tag、push。**tag 推上去之后由 CI 发布**——本地 `npm publish` 会被 `prepublishOnly` 拒绝，所以不存在"手动发一半"的状态。CI 发布前会重跑全部测试并比对 tag 与 `package.json` 的版本。

## 结构

```
src/client/index.ts       加载器握手 + React 8 行壳 + 侧边栏图标 + CSS
src/client/locales.ts     面板 i18n 字典（zh 为准，en 由类型保证齐平）
src/client/App.vue        <media-panel>：队列首页 + 文件详情、上传/批量/单文件任务、预览/对比、Base64、元数据
src/client/vue/           FileQueue（队列行）、QueueGroup（按类型分组的组头）、BatchCard（批量任务卡）、ActionGrid、CompareSlider、ResultBlock
src/client/lib.ts         纯函数（格式化/时间码/裁剪窗口）+ fetch 封装，不碰 DOM
vite.config.ts            构建：IIFE + __ModuleLoader__ 握手 + React 走宿主模块表
client.js                 构建产物（提交进仓库，勿手改）
index.ts                  宿主：/api/media-convert/* 路由、ffmpeg 任务、PTC 模型目录/计划/进度、自适应队列、显卡后端探测、预览与 Base64、Agent 工具 media_toolbox
lib/plan.ts               格式表、参数生成（含 copy/显卡硬编/线程）、显卡后端表（VideoToolbox/NVENC/QSV/AMF）、元数据解析（ffmpeg stderr 与 ffprobe JSON 两路，同一 MediaMeta）、裁剪（也定义面板要用的媒体类型）
lib/schedule.ts           自适应容量、任务权重、每任务线程数（纯函数）
lib/base64.ts             Base64 嗅探与还原
lib/extensions.ts         扩展包解析校验（包/动作上限、ffmpeg 参数白名单、quality 映射）与 /status 投影
lib/platform.ts           ffmpeg 查找、文件管理器、文件名规则、各平台可用的显卡后端（纯函数，跨平台分支可测）
test/                     七套自检（.mjs，跑编译产物）
dist/                     构建产物：宿主入口 dist/index.js（npm 包入口）+ dist/lib/、dist/src/
```

React 只剩一个壳：把 `<media-panel>` 挂进槽位。`t` 由平台按槽位的 `locale:` 声明注入，语言切换时换新引用，面板随之刷新。面板本身是 Vue，`shadowRoot: false`（light DOM），样式由壳注入的 `<style>` 提供——Vue 的 `defineCustomElement` 在 light DOM 下不会注入 SFC 样式。

## 限制

- Base64 单文件上限 24 MB。
- 扩展：每包 ≤16 动作、合计 ≤32、一包单一 kind；配方只许白名单内的输出侧 ffmpeg 参数（禁 `-i`/`-filter_complex`/lavfi/路径），不支持新格式名；宏只在匹配 kind 的文件上出现。
- 上传单文件上限 2048 MB（`maxUploadMb` 可调）。
- 裁剪区间必须落在文件时长内；区间无效时按钮不可用。
- 选轨（`videoTrack`/`audioTrack`/`stream`）是类型内序号，1=第二条，0/不填=默认轨；越界或误用（如给图片输出选音轨）直接报错；显式选轨禁用直接拷贝；批量转换不支持选轨，PTC 计划可带 `vtrack`/`atrack`（模型只能选探测到的范围）。
- 软件编码器（HEVC/AV1）只覆盖 mp4/mov/mkv，按本机 ffmpeg 探测显隐（`/status` 下发）；显式选择禁用直接拷贝；其它容器组合回退 H.264；固定规则批量不选软件编码器，PTC 计划可带 `codec: av1`（未开 GPU 时）。
- 用户预设存进保留扩展包 `user-presets-<类型>`（每类上限 16 个，同名覆盖）；预设的宏参数在保存时经宿主校验，使用时目标格式失效会报错。
- 合并只支持视频/音频（图片不可），一次 2–64 个同类文件；直接拷贝要求各文件编码与分辨率一致（POST 层即报错）；合并产物丢弃章节与字幕轨；PTC 批量不支持合并。
- 章节分割按容器内嵌章节执行，零长章节跳过、越界 clamp；「直接拷贝」按关键帧裁剪（起止不精确），要精确选「重编码」；单文件上限 64 章；分割进行中取消会停掉全部章节任务。
- 直接拷贝矩阵已放宽：mp4 收 h264/hevc/vp9/av1 视频与 aac/mp3/flac/alac/opus 音频、mov 收 h264/hevc 与 aac/mp3/alac；矩阵外组合选「仅换封装」显式拷贝（ffmpeg 自身报错，绝不静默重编码）。
- 画面几何（裁剪/旋转/翻转）任一存在即强制重编码且不进 GPU 零拷贝路径；crop 宽高必须偶数（yuv420p），旋转 90/270 会把宽高互换；几何在详情页、裁剪、工具与 PTC 计划（可带 crop/rotate/flip）可用，固定规则批量不携带。
- 变速（0.25–4）/响度归一化/文字水印/字幕烧录任一存在即强制重编码且不进 GPU；loudnorm 为单遍（shortcut: 精度弱于双遍分析，等真实需求再补）；文字水印需本机 ffmpeg 带 drawtext（libfreetype）、字幕烧录需系统字体目录，均探测后显隐；变速与响度同用时应答中 atempo 先于 loudnorm；截图仅视频文件。
- 本期明确不做：图片水印（需第二输入改造）、序列帧导出（需多输出改造）、外挂字幕文件烧录、双遍 loudnorm、pad。
- 视频转 GIF 默认缩到宽 640、12 fps；普通视频转换也可选输出宽度上限与帧率（等比不放大，留空保持源分辨率/帧率）。
- 批量按类型分组：视频/音频/图片各自一个目标；文本单独一段、不参与转换；读取中/未识别不可批量。
- 批量提取只处理视频；不适用或没有音轨的行标「跳过」，不算失败。
- 固定规则批量按车道并行（软编视频 1 路、GPU 3 路、轻任务 ≤4 路）；PTC 批量走自适应 CPU 队列（1–4 路，GPU 另限 2 路），并按组多次沙箱求值；上传中或处理中不能增删文件。
- PTC 只用于批量转换且至少 2 个文件；默认关，开关不随页面保存。可选已注册模型；模型只返回每文件计划；每次运行仍会调用一次主模型（消耗 token）；单次求值默认 2 分钟、最长 10 分钟；整批会拆成多组，因此可以超过 10 分钟。
- PTC 不提供合并或 remux 参数；视频目标可调输出宽度上限与帧率（`fps`/`width`，gif 与普通视频容器，不放大；带尺寸/帧率的请求走软件编码，不骑 GPU 硬编）；GPU 覆盖 mp4/mov/mkv/flv/ts 的 H.264，探测到 HEVC 能力后同格式可选 HEVC（自动补 `hvc1` 标签；macOS 用 VideoToolbox，Windows 用 NVENC/QSV/AMF 三者之一）；直接拷贝只覆盖兼容的编码/容器矩阵，显式调 quality/bitrate/channels/sampleRate/fps/width/codec 任一即禁用拷贝走重编码。
- 上传的临时副本保留 2 小时后自动删除。
- Windows 上「在资源管理器中显示」用 `explorer /select,`，macOS 用 `open -R`，Linux 用 `xdg-open`（打开所在目录）。

## 排查

页面打开时会向宿主取一次 `/status`（ffmpeg 路径、输出目录、可用格式）。宿主刚启动时这次请求可能失败，插件会**自动重试**（约 25 秒内最多 10 次），成功后就撤掉提示；选文件时若还没拿到，会再补一次。

上传失败时，**原因会直接显示在选择框上方**（而不是悄悄退回选择框），宿主同时往日志写一行：

```sh
[dsh-media-converter] upload truncated: big.mp4 got 4194304 of 8388608 bytes   # 传了一半
[dsh-media-converter] unrecognised media: clip.xyz (16 bytes)                  # ffmpeg 读不了
[dsh-media-converter] upload failed: aborted                                  # 连接中断
```

PTC 批量在点「开始处理」时才检查运行时与模型服务：缺任何一个会立即在批量卡里报错，不会退回固定规则。批次由宿主持有：切会话或关闭页面后继续执行，重新打开会恢复进度；取消走同一套信号，沙箱与 ffmpeg 一起停。

宿主的这些行在 DSH 的日志里；改了 `index.ts` 之后必须 `npm run build:host` 并**重启 DSH**才会生效（运行中的宿主用的是启动时那份代码）。
