# dsh-media-converter

DeepSeek Harness 的本地多媒体工具箱插件：转换、裁剪、提取音轨/画面、字幕导出、图片压缩、元数据查看与改写、Base64 编解码。全部在本机用 ffmpeg 完成，文件不出本机。

![icon](icon.svg)

## 功能

| 动作 | 说明 |
| --- | --- |
| 转成 X | 视频 12 种（mp4/mov/mkv/webm/avi/flv/wmv/ts/ogv/gif/mp3/m4a）、音频 8 种（mp3/m4a/aac/wav/flac/ogg/opus/aiff）、图片 7 种（png/jpg/webp/gif/bmp/tiff/avif） |
| 裁一段 | 从播放器取起点/终点，或手填 `分:秒`；裁剪与转换一次完成 |
| 提取音频 / 提取画面 | 直接拷贝轨道，不重编码 |
| 提取字幕 | 内嵌字幕轨导出 `.srt`，文件名带语言码（如 `clip.chi.srt`） |
| 图片压缩 | 选 JPG / WEBP 时按质量滑杆重编码；右侧实时预览 + 并排/滑块对比 |
| 元数据 | 查看容器、章节、逐轨参数与全部标签；改写标题/作者/专辑/备注/日期/流派（另存为新文件） |
| Base64 | 当前文件 → `data:` URL；或粘贴 Base64 还原成文件 / 文本 |
| 取消 | 转换中随时点「取消」结束 ffmpeg；上传中也能中断传输 |

界面是一个「动作面板」：选文件 → 搜索或点动作 → 参数就地展开 → 结果就地显示。支持 `⌘K` 聚焦搜索、回车执行第一个动作、Esc 收起。

## 大文件

- **不整文件进内存**：上传边收边落盘；Base64 结果边编码边发回；预览走 HTTP Range，拖进度条不会整段下载。
- **不阻塞宿主**：文件读写全部用异步 API，转码期间 DSH 界面照常响应。
- **随时可取消**：每个任务带一个 `AbortSignal`，取消即向 ffmpeg 发终止信号并清掉半成品；ffmpeg 要到下一帧才真正退出，这期间界面显示「正在取消…」，退出后才是「已取消」。上传用 `AbortController` 中断传输，服务端不留残余副本。
- **临时文件会自我清理**：上传的副本放在 `$TMPDIR/dsh-media-toolbox`，超过 2 小时自动删除，插件卸载时也清空。

## 安装

已发布到 npm（`dsh-media-converter`）。在 Harness 里用 `plugin_manager` 的 `install_bundle` 装，或在 profile 目录里：

```sh
dsh plugin add dsh-media-converter --profile <profile>
```

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
  - 手动指定路径时，Windows 下写不写 `.exe` 都行。
- 没有 ffprobe 也能用：元数据从 `ffmpeg -i` 的输出解析。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件行：

```yaml
- id: media-converter
  name: 'dsh-media-converter'
  config:
    outputDir: ~/Movies/converted
    ffmpegPath: /opt/homebrew/bin/ffmpeg
```

默认输出到 `~/Downloads/media-toolbox`；上传的临时文件放 `$TMPDIR/dsh-media-toolbox`，插件卸载时清理。

## 开发

```bash
npm test              # 类型检查 + 构建（宿主 dist/ 与浏览器 client.js）+ 六套自检
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
node test/client-lib.test.mjs     # 面板纯函数：格式化、时间码、裁剪窗口
node test/plan.test.mjs           # 格式表、参数、元数据解析、裁剪
node test/base64.test.mjs         # 魔数嗅探、Base64 往返、文本回退
node test/platform.test.mjs       # ffmpeg 查找顺序、文件管理器命令、文件名规则（含 Windows 分支）
node test/host.test.mjs           # 真 ffmpeg 端到端：27 种格式矩阵 + 字幕 + 标签改写 + 取消 + 失败路径
```

`test/host.test.mjs` 需要本机有 ffmpeg；没有会**失败**（不是跳过——静默跳过等于假绿）。

## 代码风格

- **[oxlint](https://oxc.rs/docs/guide/usage/linter)**：只开 `correctness` 一类（`suspicious`/`perf`/`style` 全开是 1750 条风格意见，其中一半和这个仓库的写法冲突）；配置在 `.oxlintrc.json`。两处 `no-control-regex` 是故意的（文件名里的控制字符就是要剔掉），在代码里就地豁免。**oxlint 不读 `.vue` 的 `<script>` 块**——`.vue` 由类型检查兜底。
- **[oxfmt](https://oxc.rs/docs/guide/usage/formatter)**：Prettier 风格，配置在 `.oxfmtrc.json`（单引号、行宽 120）。`client.js`（压缩产物）、`README.md`、`package.json` 不进格式化范围：前者是产物，后两者一格式化就会动中文表格的排版和 npm 的 keywords 顺序。

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
src/client/index.ts       加载器握手 + React 8 行壳 + 侧边栏图标 + i18n 字典 + CSS
src/client/App.vue        <media-panel>：状态机、动作面板、预览/对比、Base64、元数据
src/client/vue/           CompareSlider、ResultBlock（普通 Vue 组件）
src/client/lib.ts         纯函数（格式化/时间码/裁剪窗口）+ fetch 封装，不碰 DOM
vite.config.ts            构建：IIFE + __ModuleLoader__ 握手 + React 走宿主模块表
client.js                 构建产物（提交进仓库，勿手改）
index.ts                  宿主：/api/media-convert/* 路由、ffmpeg 任务、预览与 Base64
lib/plan.ts               格式表、参数生成、元数据解析、裁剪（也定义面板要用的媒体类型）
lib/base64.ts             Base64 嗅探与还原
lib/platform.ts           ffmpeg 查找、文件管理器、文件名规则（纯函数，跨平台分支可测）
test/                     六套自检（.mjs，跑编译产物）
dist/                     构建产物：宿主入口 dist/index.js（npm 包入口）+ dist/lib/、dist/src/
```

React 只剩一个壳：把 `<media-panel>` 挂进槽位并传 `t`。面板本身是 Vue，`shadowRoot: false`（light DOM），样式由壳注入的 `<style>` 提供——Vue 的 `defineCustomElement` 在 light DOM 下不会注入 SFC 样式。

## 限制

- Base64 单文件上限 24 MB。
- 裁剪区间必须落在文件时长内；区间无效时按钮不可用。
- 视频转 GIF 会缩到宽 640、12 fps。
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

宿主的这些行在 DSH 的日志里；改了 `index.ts` 之后必须 `npm run build:host` 并**重启 DSH**才会生效（运行中的宿主用的是启动时那份代码）。
