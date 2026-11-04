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

界面是一个「动作面板」：选文件 → 搜索或点动作 → 参数就地展开 → 结果就地显示。支持 `⌘K` 聚焦搜索、回车执行第一个动作、Esc 收起。

## 安装

这是 Harness 的本地 bundle，通过 profile 的 bundle 机制装载。

```bash
# 在仓库目录之外执行，或用 plugin_manager 安装
dsh plugin install /path/to/dsh-media-converter
```

或在 Harness 里用 `plugin_manager` 的 `install_bundle`，target 指向本仓库目录；它会做两件事：在 `~/.dsh/profiles/<profile>/package.json` 里登记 `@local/dsh-media-converter`，并在 `node_modules/@local/` 下建一条软链指向本目录。

装好后左侧栏出现「媒体工具箱」。

## 依赖

- **ffmpeg**：插件按顺序查找 `config.ffmpegPath` → `FFMPEG_PATH` → `PATH` → `/opt/homebrew/bin`、`/usr/local/bin` → imageio-ffmpeg 自带的静态包。找不到时页面顶部会提示安装方式。
- 没有 ffprobe 也能用：元数据从 `ffmpeg -i` 的输出解析。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件行：

```yaml
- id: media-converter
  name: '@local/dsh-media-converter'
  config:
    outputDir: ~/Movies/converted
    ffmpegPath: /opt/homebrew/bin/ffmpeg
```

默认输出到 `~/Downloads/media-toolbox`；上传的临时文件放 `$TMPDIR/dsh-media-toolbox`，插件卸载时清理。

## 开发

```bash
node test/plan.test.mjs     # 格式表、参数、元数据解析、裁剪
node test/base64.test.mjs   # 魔数嗅探、Base64 往返、文本回退
node test/host.test.mjs     # 真 ffmpeg 端到端：27 种格式矩阵 + 字幕 + 标签改写 + 失败路径
```

`test/host.test.mjs` 需要本机有 ffmpeg；没有则自动跳过。

## 结构

```
client.js        页面（动作面板、预览/对比、Base64、元数据编辑）
index.js         宿主：/api/media-convert/* 路由、ffmpeg 任务、预览与 Base64
lib/plan.js      格式表、参数生成、元数据解析、裁剪
lib/base64.js    Base64 嗅探与还原
test/            三个自检
```

## 限制

- Base64 单文件上限 24 MB。
- 裁剪区间必须落在文件时长内；区间无效时按钮不可用。
- 视频转 GIF 会缩到宽 640、12 fps。
- 没有取消按钮：转换开始后只能等它结束。
