// Browser half of @local/dsh-media-converter — the media toolbox page.
//
// Layout: an action list (converted from the "contextual command palette"
// pattern) instead of stacked forms. The file and its stage sit on top; below is
// a search field over the actions available for this file (convert to X, trim,
// extract, subtitles, metadata, Base64), and picking an action expands its
// parameters right under the row.
//
// Everything heavy happens on the Host (index.js) through same-origin routes;
// the page polls the job for progress. Styling uses --dsw-alias-* theme tokens.

window.__ModuleLoader__.load({
  id: '@local/dsh-media-converter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'media-convert';
    const NS = 'media-convert';
    const TAG_KEYS = ['title', 'artist', 'album', 'comment', 'date', 'genre'];

    const ZH = {
      'nav.label': '媒体工具箱',
      'page.title': '媒体工具箱',
      'page.subtitle': '转换、裁剪、提取音轨、图片压缩、Base64——都在本机完成，文件不出本机。',
      'page.caps': '转换 · 裁剪 · 提取音轨 · 字幕 · 元数据 · Base64',
      'drop.title': '拖入文件，或点击选择',
      'drop.hint': '视频 · 音频 · 图片',
      'kind.video': '视频',
      'kind.audio': '音频',
      'kind.image': '图片',
      'kind.file': '文件',
      'kind.text': '文本',
      'action.change': '换一个',
      'action.convert': '开始转换',
      'action.converting': '转换中…',
      'action.reveal': '在 Finder 中显示',
      'action.again': '再转一个',
      'action.toFormat': '转成 %s',
      'action.moreFormats': '更多格式…',
      'action.less': '收起',
      'action.trim': '裁一段',
      'action.extractAudio': '提取音频',
      'action.extractVideo': '提取画面',
      'action.subs': '提取字幕',
      'action.meta': '查看元数据',
      'action.b64': '转成 Base64',
      'act.empty': '没有匹配的动作',
      'group.convert': '转换',
      'group.edit': '编辑',
      'group.view': '查看',
      'search.placeholder': '想做什么？转成 MP4、裁一段、提取字幕…',
      'status.uploading': '正在读取文件…',
      'result.done': '完成',
      'result.size': '大小',
      'error.title': '出错了',
      'error.noffmpeg': '未找到 ffmpeg。先运行 brew install ffmpeg，或用 FFMPEG_PATH 指定路径。',
      'error.network': '无法连接到本地服务，请确认插件已启用。',
      'footer.out': '输出目录',
      'hint.formats': '输出格式',
      'name.label': '文件名',
      'hint.mp4': 'H.264 通用',
      'hint.webm': 'VP9 网页',
      'hint.mov': 'QuickTime',
      'hint.gif': '动图',
      'hint.mp3': '音频',
      'hint.m4a': 'AAC',
      'hint.wav': '无损 PCM',
      'hint.flac': '无损',
      'hint.png': '无损',
      'hint.jpg': '有损照片',
      'hint.webp': '网页图片',
      'hint.mkv': '万能封装',
      'hint.avi': '老设备',
      'hint.flv': 'Flash 流',
      'hint.wmv': 'Windows',
      'hint.ts': '流媒体',
      'hint.ogv': 'Theora',
      'hint.aac': '裸音频流',
      'hint.ogg': 'Vorbis',
      'hint.opus': '低码率语音',
      'hint.aiff': 'Apple 无损',
      'hint.bmp': '位图',
      'hint.tiff': '印刷',
      'hint.avif': '新一代压缩',
      'hint.noAudio': '没有音轨',
      'trim.title': '裁剪（可选）',
      'trim.start': '从',
      'trim.end': '到',
      'trim.full': '整段',
      'trim.invalid': '时间格式不对，用 秒 或 分:秒',
      'trim.order': '“到”必须晚于“从”',
      'trim.over': '“到”超出文件时长',
      'trim.setStart': '设为起点',
      'trim.setEnd': '设为终点',
      'trim.play': '试看选中段',
      'trim.apply': '裁剪并转换',
      'quality.label': '质量',
      'quality.hint': '越小文件越小',
      'extract.note': '直接拷贝轨道，不重新编码，速度很快',
      'sub.title': '字幕轨',
      'sub.extract': '提取字幕',
      'meta.title': '元数据',
      'meta.edit': '编辑元数据（另存为新文件）',
      'meta.save': '保存元数据',
      'meta.container': '容器',
      'meta.duration': '时长',
      'meta.size': '体积',
      'meta.bitrate': '码率',
      'meta.video': '视频',
      'meta.audio': '音频',
      'meta.subtitles': '字幕',
      'meta.tags': '标签',
      'meta.tracks': '轨道',
      'meta.chapters': '章节',
      'meta.chapter': '章节',
      'meta.start': '起始偏移',
      'meta.type.video': '视频',
      'meta.type.audio': '音频',
      'meta.type.subtitle': '字幕',
      'meta.type.data': '数据',
      'meta.type.attachment': '附件',
      'meta.key.title': '标题',
      'meta.key.artist': '作者',
      'meta.key.album': '专辑',
      'meta.key.comment': '备注',
      'meta.key.date': '日期',
      'meta.key.genre': '流派',
      'extract.audio': '只保留音频',
      'extract.video': '只保留画面（无声）',
      'compare.before': '原图',
      'compare.after': '输出',
      'compare.slot': '对比预览',
      'compare.live': '实时预览',
      'compare.pending': '正在生成预览…',
      'compare.mode': '对比方式',
      'compare.side': '并排对比',
      'compare.slider': '滑块对比',
      'compare.saved': '省了',
      'b64.title': 'Base64',
      'b64.encode': '当前文件 → Base64',
      'b64.encoding': '转换中…',
      'b64.copy': '复制',
      'b64.copied': '已复制',
      'b64.save': '保存为 .txt',
      'b64.decodeTitle': '从 Base64 还原',
      'b64.placeholder': '粘贴 data:image/png;base64,... 或纯 Base64 文本',
      'b64.decode': '还原',
      'b64.decoding': '还原中…',
      'b64.textResult': '还原为文本',
    };
    const EN = {
      'nav.label': 'Media Tools',
      'page.title': 'Media Toolbox',
      'page.subtitle': 'Convert, trim, split tracks, compress images, and move files to/from Base64 — all locally.',
      'page.caps': 'convert · trim · split tracks · subtitles · metadata · Base64',
      'drop.title': 'Drop a file here, or click to choose',
      'drop.hint': 'video · audio · image',
      'kind.video': 'Video',
      'kind.audio': 'Audio',
      'kind.image': 'Image',
      'kind.file': 'File',
      'kind.text': 'Text',
      'action.change': 'Change file',
      'action.convert': 'Convert',
      'action.converting': 'Converting…',
      'action.reveal': 'Show in Finder',
      'action.again': 'Do it again',
      'action.toFormat': 'Convert to %s',
      'action.moreFormats': 'More formats…',
      'action.less': 'Show less',
      'action.trim': 'Trim a clip',
      'action.extractAudio': 'Extract audio',
      'action.extractVideo': 'Extract video',
      'action.subs': 'Extract subtitles',
      'action.meta': 'Inspect metadata',
      'action.b64': 'To Base64',
      'act.empty': 'No matching actions',
      'group.convert': 'Convert',
      'group.edit': 'Edit',
      'group.view': 'Inspect',
      'search.placeholder': 'What do you need? Convert to MP4, trim, extract subtitles…',
      'status.uploading': 'Reading file…',
      'result.done': 'Done',
      'result.size': 'Size',
      'error.title': 'Something went wrong',
      'error.noffmpeg': 'ffmpeg not found. Run `brew install ffmpeg`, or point FFMPEG_PATH at it.',
      'error.network': 'Cannot reach the local service; check that the plugin is enabled.',
      'footer.out': 'Output folder',
      'hint.formats': 'Output format',
      'name.label': 'File name',
      'hint.mp4': 'H.264',
      'hint.webm': 'VP9 web',
      'hint.mov': 'QuickTime',
      'hint.gif': 'animation',
      'hint.mp3': 'audio',
      'hint.m4a': 'AAC',
      'hint.wav': 'lossless PCM',
      'hint.flac': 'lossless',
      'hint.png': 'lossless',
      'hint.jpg': 'photo',
      'hint.webp': 'web image',
      'hint.mkv': 'container',
      'hint.avi': 'legacy',
      'hint.flv': 'Flash',
      'hint.wmv': 'Windows',
      'hint.ts': 'streaming',
      'hint.ogv': 'Theora',
      'hint.aac': 'raw stream',
      'hint.ogg': 'Vorbis',
      'hint.opus': 'voice',
      'hint.aiff': 'Apple PCM',
      'hint.bmp': 'bitmap',
      'hint.tiff': 'print',
      'hint.avif': 'next-gen',
      'hint.noAudio': 'no audio track',
      'trim.title': 'Trim (optional)',
      'trim.start': 'From',
      'trim.end': 'To',
      'trim.full': 'Whole clip',
      'trim.invalid': 'Invalid time — use seconds or m:ss',
      'trim.order': '"To" must be after "From"',
      'trim.over': '"To" is past the end of the clip',
      'trim.setStart': 'Set start',
      'trim.setEnd': 'Set end',
      'trim.play': 'Play selection',
      'trim.apply': 'Trim & convert',
      'quality.label': 'Quality',
      'quality.hint': 'lower means smaller',
      'extract.note': 'stream copy — no re-encode, instant',
      'sub.title': 'Subtitle tracks',
      'sub.extract': 'Extract subtitles',
      'meta.title': 'Metadata',
      'meta.edit': 'Edit metadata (saved as a new file)',
      'meta.save': 'Save metadata',
      'meta.container': 'Container',
      'meta.duration': 'Duration',
      'meta.size': 'Size',
      'meta.bitrate': 'Bitrate',
      'meta.video': 'Video',
      'meta.audio': 'Audio',
      'meta.subtitles': 'Subtitles',
      'meta.tags': 'Tags',
      'meta.tracks': 'Streams',
      'meta.chapters': 'Chapters',
      'meta.chapter': 'Chapter',
      'meta.start': 'Start offset',
      'meta.type.video': 'Video',
      'meta.type.audio': 'Audio',
      'meta.type.subtitle': 'Subtitle',
      'meta.type.data': 'Data',
      'meta.type.attachment': 'Attachment',
      'meta.key.title': 'Title',
      'meta.key.artist': 'Artist',
      'meta.key.album': 'Album',
      'meta.key.comment': 'Comment',
      'meta.key.date': 'Date',
      'meta.key.genre': 'Genre',
      'extract.audio': 'Audio only',
      'extract.video': 'Video only (silent)',
      'compare.before': 'Original',
      'compare.after': 'Output',
      'compare.slot': 'Comparison',
      'compare.live': 'Live preview',
      'compare.pending': 'Rendering preview…',
      'compare.mode': 'Compare',
      'compare.side': 'Side by side',
      'compare.slider': 'Slider',
      'compare.saved': 'saved',
      'b64.title': 'Base64',
      'b64.encode': 'Current file → Base64',
      'b64.encoding': 'Encoding…',
      'b64.copy': 'Copy',
      'b64.copied': 'Copied',
      'b64.save': 'Save as .txt',
      'b64.decodeTitle': 'Restore from Base64',
      'b64.placeholder': 'Paste data:image/png;base64,... or raw Base64 text',
      'b64.decode': 'Restore',
      'b64.decoding': 'Restoring…',
      'b64.textResult': 'Restored as text',
    };

    function PanelIcon({ size }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 8h13' }),
        h('path', { d: 'm14 4.5 3.5 3.5L14 11.5' }),
        h('path', { d: 'M20 16H7' }),
        h('path', { d: 'm10 12.5L6.5 16l3.5 3.5' })
      );
    }

    const CSS = `
      .mc-page { width: 100%; max-width: 780px; margin: 0 auto; height: 100%; min-height: 0; overflow-y: auto; padding: 22px 26px 56px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; font-size: 14px; color: var(--dsw-alias-label-primary, inherit); }
      /* The page is a fixed-height flex column: without this, tall content
         squashes the player / compare box instead of scrolling. */
      .mc-page > * { flex-shrink: 0; }
      .mc-head { display: flex; flex-direction: column; gap: 4px; }
      .mc-title { margin: 0; font-size: 18px; font-weight: 600; }
      .mc-sub { margin: 0; line-height: 1.6; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 56px 20px; border-radius: 14px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); cursor: pointer; text-align: center; transition: border-color .15s, background .15s; }
      .mc-drop:hover, .mc-drop.over { border-color: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-drop:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 2px; }
      .mc-drop-title { font-weight: 600; font-size: 15px; }
      .mc-drop-hint, .mc-muted { color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; }
      .mc-file { display: flex; align-items: center; gap: 12px; }
      .mc-file-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
      .mc-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-tag { flex: none; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); }
      .mc-btn { padding: 7px 16px; border-radius: 8px; cursor: pointer; font: inherit; white-space: nowrap; }
      .mc-btn:disabled { opacity: 0.55; cursor: default; }
      .mc-btn-primary { border: none; color: #fff; background: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-btn-primary:not(:disabled):hover { background: var(--dsw-static-deepseek-400, #6b8cff); }
      .mc-btn-ghost { background: transparent; color: var(--dsw-alias-label-primary, inherit); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); }
      .mc-row { display: flex; align-items: center; gap: 12px; }
      .mc-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .mc-grow { flex: 1; }
      .mc-input { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; }
      .mc-input:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -1px; }
      .mc-name-input { flex: 0 1 300px; min-width: 120px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; }
      .mc-name-input:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -1px; }
      .mc-time { width: 76px; box-sizing: border-box; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; text-align: center; font-variant-numeric: tabular-nums; }
      .mc-time:focus-visible, .mc-b64:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: -1px; }
      .mc-select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 13px; }
      .mc-search { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, transparent); }
      .mc-search input { flex: 1; border: none; outline: none; background: transparent; color: inherit; font: inherit; font-size: 15px; }
      .mc-act-group { margin: 14px 0 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-act { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: none; background: transparent; color: inherit; font: inherit; font-size: 14px; text-align: left; border-radius: 9px; cursor: pointer; }
      .mc-act:hover:not(:disabled), .mc-act.on { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }
      .mc-act:disabled { opacity: 0.45; cursor: not-allowed; }
      .mc-act-icon { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); font-size: 13px; flex: none; }
      .mc-act-hint { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-panel { margin: 2px 0 8px 36px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); display: flex; flex-direction: column; gap: 10px; }
      .mc-player { display: block; width: 100%; max-height: 280px; border-radius: 10px; background: #000; object-fit: contain; }
      .mc-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .mc-toggle { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: inherit; font: inherit; font-size: 12.5px; cursor: pointer; }
      .mc-toggle.on { border-color: var(--dsw-static-deepseek-500, #4d6bfe); font-weight: 600; }
      .mc-fig { display: flex; flex-direction: column; align-items: center; gap: 6px; margin: 0; min-width: 0; }
      .mc-fig img { max-width: 100%; max-height: 190px; border-radius: 8px; object-fit: contain; }
      .mc-fig-ph { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; min-height: 190px; padding: 12px; border-radius: 8px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; text-align: center; }
      .mc-cap { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); text-align: center; word-break: break-all; }
      .mc-slider { position: relative; width: 100%; height: 300px; border-radius: 10px; overflow: hidden; cursor: ew-resize; touch-action: none; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-slider:focus-visible { outline: 2px solid var(--dsw-static-deepseek-500, #4d6bfe); outline-offset: 2px; }
      .mc-slider img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; user-select: none; }
      .mc-slider-clip { position: absolute; inset: 0; }
      .mc-slider-handle { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.25); pointer-events: none; }
      .mc-slider-handle::after { content: ''; position: absolute; top: 50%; left: 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.35); }
      .mc-slider-tag { position: absolute; bottom: 8px; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: rgba(0,0,0,0.55); color: #fff; pointer-events: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-slider-tag.left { left: 8px; }
      .mc-slider-tag.right { right: 8px; }
      .mc-bar { height: 6px; border-radius: 3px; overflow: hidden; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-bar > i { display: block; height: 100%; background: var(--dsw-static-deepseek-500, #4d6bfe); transition: width .25s; }
      .mc-bar.indet > i { width: 38%; animation: mc-slide 1.2s ease-in-out infinite; }
      @keyframes mc-slide { 0% { margin-left: -38%; } 100% { margin-left: 100%; } }
      .mc-error { color: var(--dsw-alias-state-error-primary, #d5483f); word-break: break-word; line-height: 1.6; }
      .mc-warn { color: var(--dsw-alias-state-warn-primary, #d5763f); line-height: 1.6; }
      .mc-ok { font-weight: 600; color: var(--dsw-alias-state-success-primary, #2ba471); }
      .mc-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-foot { display: flex; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); word-break: break-all; }
      .mc-sep { height: 1px; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-meta-head { margin: 10px 0 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-meta-grid { display: grid; grid-template-columns: minmax(64px, max-content) 1fr; gap: 6px 16px; margin: 8px 0; font-size: 13px; }
      .mc-meta-grid > span:nth-child(odd) { color: var(--dsw-alias-label-secondary, inherit); overflow-wrap: anywhere; }
      .mc-meta-grid > span:nth-child(even) { word-break: break-word; min-width: 0; }
      .mc-meta-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 8px 0; }
      .mc-meta-field { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .mc-meta-field > span { flex: none; width: 40px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-meta-field > input { flex: 1; min-width: 0; }
      .mc-b64 { width: 100%; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; }
      .mc-pre { white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; margin: 0; }
      .mc-result { display: flex; flex-direction: column; gap: 10px; }
      /* ---- motion: the DeepSeek harness motion language ----
         From www.deepseek.com/harness: expo-out entrances
         cubic-bezier(.19,1,.22,1), fade + rise (+ optional blur), 0.2s hovers,
         0.35s accent colours, and grid-template-rows 0fr->1fr disclosure. */
      .mc-page {
        --mc-ease: var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
        --mc-ease-out: cubic-bezier(.19, 1, .22, 1);
      }
      .mc-btn { transition: background-color .2s, border-color .2s, color .2s, opacity .2s, box-shadow .2s; }
      .mc-toggle, .mc-select, .mc-name-input, .mc-time, .mc-input { transition: border-color .2s, background-color .2s; }
      .mc-search { transition: border-color .2s, box-shadow .2s; }
      .mc-search:focus-within { border-color: var(--dsw-static-deepseek-500, #4d6bfe); box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.12); }
      .mc-act { transition: background-color .2s, color .2s; }
      .mc-act-icon { transition: background-color .35s, color .35s; }
      .mc-act.on .mc-act-icon { background: var(--dsw-static-deepseek-500, #4d6bfe); color: #fff; }
      .mc-collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .18s var(--mc-ease-out); }
      .mc-collapse.open { grid-template-rows: 1fr; }
      .mc-panel-clip { overflow: hidden; min-height: 0; contain: layout paint; }
      .mc-panel { animation: mc-fade .14s ease-out both; }
      .mc-result { animation: mc-rise .36s var(--mc-ease-out) both; }
      .mc-file, .mc-compare, .mc-slider { animation: mc-in .42s var(--mc-ease-out) both; }
      .mc-player { animation: mc-fade .2s ease-out both; }
      .mc-fig img { animation: mc-fade .14s ease-out both; }
      .mc-drop { transition: border-color .2s, background-color .2s, transform .3s var(--mc-ease-out); }
      .mc-drop.over { transform: scale(1.004); background: rgba(77, 107, 254, 0.05); }
      .mc-bar > i { transition: width .2s var(--mc-ease); }
      @keyframes mc-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes mc-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
      @keyframes mc-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) {
        .mc-page *, .mc-page *::before, .mc-page *::after {
          animation-duration: .001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: .001ms !important;
        }
      }
    `;

    function formatSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatDuration(seconds) {
      if (!seconds) return '';
      const s = Math.round(seconds);
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function formatClock(seconds) {
      const total = Math.max(0, Math.round((seconds || 0) * 10) / 10);
      const whole = Math.floor(total / 60);
      const rest = Math.round((total - whole * 60) * 10) / 10;
      const restText = (rest < 10 ? '0' : '') + (Number.isInteger(rest) ? String(rest) : rest.toFixed(1));
      return whole + ':' + restText;
    }

    // "12", "0:12", "0:12.5", "00:00:12" -> seconds; null when empty, NaN when
    // unparseable. The Host only ever sees numbers.
    function parseTimecode(text) {
      const value = String(text || '').trim();
      if (!value) return null;
      const parts = value.split(':');
      if (parts.length > 3) return NaN;
      let total = 0;
      for (const part of parts) {
        if (!/^\d+(\.\d+)?$/.test(part)) return NaN;
        total = total * 60 + Number(part);
      }
      return total;
    }

    function previewUrl(file) {
      return '/api/media-convert/preview?file=' + encodeURIComponent(file);
    }

    function downloadText(name, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    async function readJson(resp) {
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 120) || 'HTTP ' + resp.status);
      }
    }

    // Before/after slider: the original fills the left side, the converted (or
    // live-preview) image the right, split by a draggable divider. Both layers
    // share one box with object-fit: contain, so the split is always aligned.
    function CompareSlider({ before, after, leftLabel, rightLabel }) {
      const [position, setPosition] = React.useState(50);
      const [dragging, setDragging] = React.useState(false);
      const frameRef = React.useRef(null);

      const moveTo = (clientX) => {
        const frame = frameRef.current;
        if (!frame) return;
        const rect = frame.getBoundingClientRect();
        if (!rect.width) return;
        setPosition(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
      };

      React.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (event) => moveTo(event.clientX);
        const onUp = () => setDragging(false);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
      }, [dragging]);

      return h(
        'div',
        {
          className: 'mc-slider',
          ref: frameRef,
          role: 'slider',
          tabIndex: 0,
          'aria-label': leftLabel + ' / ' + rightLabel,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(position),
          onPointerDown: (event) => {
            event.preventDefault();
            setDragging(true);
            moveTo(event.clientX);
          },
          onKeyDown: (event) => {
            if (event.key === 'ArrowLeft') setPosition((value) => Math.max(0, value - 2));
            if (event.key === 'ArrowRight') setPosition((value) => Math.min(100, value + 2));
          },
        },
        h('img', { src: after, alt: '', draggable: false, decoding: 'async' }),
        h(
          'div',
          { className: 'mc-slider-clip', style: { clipPath: 'inset(0 ' + (100 - position) + '% 0 0)' } },
          h('img', { src: before, alt: '', draggable: false, decoding: 'async' })
        ),
        h('div', { className: 'mc-slider-handle', style: { left: position + '%' } }),
        h('span', { className: 'mc-slider-tag left' }, leftLabel),
        h('span', { className: 'mc-slider-tag right' }, rightLabel)
      );
    }

    function MediaToolbox({ t }) {
      const [status, setStatus] = React.useState(null);
      const [rawFile, setRawFile] = React.useState(null);
      const [blobUrl, setBlobUrl] = React.useState('');
      const [file, setFile] = React.useState(null);
      const [format, setFormat] = React.useState('');
      const [outputName, setOutputName] = React.useState('');
      const [quality, setQuality] = React.useState(90);
      const [phase, setPhase] = React.useState('idle');
      const [percent, setPercent] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [error, setError] = React.useState('');
      const [dragging, setDragging] = React.useState(false);
      const [jobId, setJobId] = React.useState(null);
      const [jobAction, setJobAction] = React.useState('');
      const [trimStart, setTrimStart] = React.useState('');
      const [trimEnd, setTrimEnd] = React.useState('');
      const [b64, setB64] = React.useState(null);
      const [metaTags, setMetaTags] = React.useState({});
      const [livePreview, setLivePreview] = React.useState('');
      const [compareMode, setCompareMode] = React.useState('side');
      const [b64Busy, setB64Busy] = React.useState(false);
      const [decodeInput, setDecodeInput] = React.useState('');
      const [decoded, setDecoded] = React.useState(null);
      const [decodeBusy, setDecodeBusy] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [action, setAction] = React.useState('');
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [moreFormats, setMoreFormats] = React.useState(false);
      const closeTimer = React.useRef(null);
      const inputRef = React.useRef(null);
      const mediaRef = React.useRef(null);
      const stopAtRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        fetch('/api/media-convert/status')
          .then(readJson)
          .then((data) => setStatus(data.ok ? data : null))
          .catch(() => setError(t('error.network')));
      }, []);

      // Local object URL: the preview player never needs the Host for input.
      React.useEffect(() => {
        if (!rawFile) {
          setBlobUrl('');
          return undefined;
        }
        const url = URL.createObjectURL(rawFile);
        setBlobUrl(url);
        return () => URL.revokeObjectURL(url);
      }, [rawFile]);

      // Real-time output preview: the browser re-encodes the picked image at the
      // chosen format/quality, so the right half updates before any conversion.
      React.useEffect(() => {
        if (!blobUrl || !file || file.kind !== 'image' || !format) {
          setLivePreview('');
          return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
          // Reuse the preview's object URL instead of minting a new one per
          // re-encode: the browser keeps the decoded image for a URL, so the
          // first (and every later) preview skips a full decode.
          const image = new Image();
          image.onload = () => {
            if (cancelled) return;
            try {
              const width = image.naturalWidth || 1;
              const height = image.naturalHeight || 1;
              const scale = Math.min(1, 900 / Math.max(width, height));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(width * scale));
              canvas.height = Math.max(1, Math.round(height * scale));
              canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
              // GIF has no canvas encoder; a still frame is what the eye compares anyway.
              const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
              setLivePreview(canvas.toDataURL(mime, Math.min(1, Math.max(0.05, quality / 100))));
            } catch {
              setLivePreview('');
            }
          };
          image.onerror = () => {
            setLivePreview('');
          };
          image.src = blobUrl;
        }, 120);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [blobUrl, file, format, quality]);

      // ⌘K focuses the action search; Escape dismisses whatever is open.
      React.useEffect(() => {
        const onKey = (event) => {
          if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
            event.preventDefault();
            if (searchRef.current) searchRef.current.focus();
            return;
          }
          if (event.key === 'Escape') {
            setQuery('');
            if (action) closePanel();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [action]);

      // Keep the expanded panel in view on short windows.
      React.useEffect(() => {
        if (!action || !panelOpen || !panelRef.current) return undefined;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const timer = setTimeout(() => {
          if (panelRef.current) panelRef.current.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
        }, 190);
        return () => clearTimeout(timer);
      }, [action, panelOpen]);

      React.useEffect(() => {
        if (phase !== 'converting' || !jobId) return undefined;
        const timer = setInterval(async () => {
          try {
            const data = await readJson(await fetch('/api/media-convert/job?id=' + encodeURIComponent(jobId)));
            if (!data.ok) return;
            if (data.percent !== null) setPercent(data.percent);
            if (data.state === 'done') {
              const done = { file: data.out, size: data.size, kind: data.kind };
              if (data.kind === 'text') {
                try {
                  done.text = await (await fetch(previewUrl(data.out))).text();
                } catch {
                  /* the path is still shown below */
                }
              }
              setResult(done);
              setPercent(100);
              setPhase('done');
            } else if (data.state === 'error') {
              setError(data.error || t('error.title'));
              setPhase('ready');
            }
          } catch {
            /* keep polling through transient errors */
          }
        }, 500);
        return () => clearInterval(timer);
      }, [phase, jobId]);

      const resetResult = () => {
        if (!result) return;
        setResult(null);
        setPercent(null);
        setPhase('ready');
      };

      // Trim window from the two fields; empty fields mean "start" / "end of file".
      const trimOf = () => {
        if (!file || file.kind === 'image') return { active: false, start: 0, end: 0, error: '' };
        if (!trimStart.trim() && !trimEnd.trim()) return { active: false, start: 0, end: file.duration || 0, error: '' };
        const start = trimStart.trim() ? parseTimecode(trimStart) : 0;
        const end = trimEnd.trim() ? parseTimecode(trimEnd) : (file.duration || 0);
        if (start === null || Number.isNaN(start) || end === null || Number.isNaN(end)) {
          return { active: false, error: t('trim.invalid') };
        }
        if (!(end > start)) return { active: false, error: t('trim.order') };
        if (file.duration > 0 && end > file.duration + 0.05) return { active: false, error: t('trim.over') };
        return { active: true, start, end, error: '' };
      };

      const pick = async (picked) => {
        if (!picked) return;
        setError('');
        setResult(null);
        setPercent(null);
        setB64(null);
        setDecoded(null);
        setTrimStart('');
        setTrimEnd('');
        setAction('');
        setPanelOpen(false);
        setQuery('');
        setMoreFormats(false);
        setRawFile(picked);
        setPhase('uploading');
        try {
          const data = await readJson(
            await fetch('/api/media-convert/upload?name=' + encodeURIComponent(picked.name), { method: 'POST', body: picked })
          );
          if (!data.ok) throw new Error(data.error || t('error.title'));
          setFile(data);
          setOutputName(String(data.name || '').replace(/\.[^.]*$/, ''));
          setMetaTags(Object.fromEntries(TAG_KEYS.map((key) => [key, (data.meta && data.meta.tags && data.meta.tags[key]) || ''])));
          if (status && status.formats[data.kind]) setFormat(status.formats[data.kind][0]);
          setPhase('ready');
        } catch (err) {
          setError(String((err && err.message) || err));
          setRawFile(null);
          setPhase('idle');
        }
      };

      const runJob = async (body, forAction) => {
        setError('');
        setResult(null);
        setPercent(null);
        setJobAction(forAction);
        setPhase('converting');
        try {
          const data = await readJson(
            await fetch('/api/media-convert/convert', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: file.id, name: outputName.trim() || undefined, ...body }),
            })
          );
          if (!data.ok) throw new Error(data.error || t('error.title'));
          setJobId(data.job.id);
        } catch (err) {
          setError(String((err && err.message) || err));
          setPhase('ready');
        }
      };

      const convert = () => {
        if (!file || !format) return;
        const usesQuality = file.kind === 'image' && (format === 'jpg' || format === 'webp');
        runJob({ format, quality: usesQuality ? quality : undefined }, 'fmt:' + format);
      };

      const applyTrim = () => {
        const trim = trimOf();
        if (trim.error) {
          setError(trim.error);
          return;
        }
        if (!trim.active) {
          setError(t('trim.full'));
          return;
        }
        runJob({ format, quality: file.kind === 'image' ? quality : undefined, trim: { start: trim.start, end: trim.end } }, 'trim');
      };

      const extract = (which) => {
        if (!file) return;
        runJob({ mode: which === 'audio' ? 'extract-audio' : 'extract-video' }, 'extract-' + which);
      };

      const reveal = async (target) => {
        try {
          const data = await readJson(
            await fetch('/api/media-convert/reveal', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ file: target }),
            })
          );
          if (!data.ok) setError(data.error || t('error.title'));
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      };

      const setTrimFromPlayer = (which) => {
        const el = mediaRef.current;
        if (!el) return;
        const value = String(Math.round((el.currentTime || 0) * 10) / 10);
        resetResult();
        if (which === 'start') setTrimStart(value);
        else setTrimEnd(value);
      };

      const playSelection = () => {
        const el = mediaRef.current;
        if (!el) return;
        const trim = trimOf();
        if (trim.error) return;
        const start = trim.active ? trim.start : 0;
        const end = trim.active ? trim.end : (el.duration || 0);
        if (stopAtRef.current) el.removeEventListener('timeupdate', stopAtRef.current);
        const stop = () => {
          if (el.currentTime >= end - 0.03) {
            el.pause();
            el.removeEventListener('timeupdate', stop);
            stopAtRef.current = null;
          }
        };
        stopAtRef.current = stop;
        el.currentTime = start;
        el.play().catch(() => {});
        el.addEventListener('timeupdate', stop);
      };

      const toBase64 = async () => {
        if (!file) return;
        setB64Busy(true);
        setError('');
        try {
          const data = await readJson(
            await fetch('/api/media-convert/base64', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: file.id }),
            })
          );
          if (!data.ok) throw new Error(data.error || t('error.title'));
          setB64(data);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setB64Busy(false);
        }
      };

      const decode = async () => {
        setDecodeBusy(true);
        setError('');
        setDecoded(null);
        try {
          const data = await readJson(
            await fetch('/api/media-convert/decode', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: decodeInput }),
            })
          );
          if (!data.ok) throw new Error(data.error || t('error.title'));
          setDecoded(data);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setDecodeBusy(false);
        }
      };

      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setError('复制失败，请手动选择文本');
        }
      };

      const onDrop = (event) => {
        event.preventDefault();
        setDragging(false);
        if (phase === 'uploading' || phase === 'converting') return;
        const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (dropped) pick(dropped);
      };

      const busy = phase === 'uploading' || phase === 'converting';
      const formats = status && file && status.formats[file.kind] ? status.formats[file.kind] : [];
      const trim = trimOf();
      const trimSummary = trim.error
        ? ''
        : trim.active
          ? formatClock(trim.start) + ' – ' + formatClock(trim.end) + ' · ' + formatClock(trim.end - trim.start)
          : t('trim.full') + (file && file.duration ? ' ' + formatClock(file.duration) : '');
      const usesQuality = Boolean(file && file.kind === 'image' && (format === 'jpg' || format === 'webp'));
      // Physical impossibility, not preference: a silent video has no audio to
      // encode or extract, so audio-only targets would only produce a failed job.
      const AUDIO_TARGETS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff'];
      const unavailable = (f) =>
        Boolean(file && file.kind === 'video' && AUDIO_TARGETS.includes(f) && file.streams && !file.streams.audio);
      const canExtractAudio = Boolean(file && file.kind === 'video' && file.streams && file.streams.audio);
      const canExtractVideo = Boolean(file && file.kind === 'video' && file.streams && file.streams.video);
      const meta = file && file.meta;
      const joinParts = (parts) => parts.filter(Boolean).join(' · ');
      const typeLabel = (type) =>
        t('meta.type.' + (['video', 'audio', 'subtitle', 'data', 'attachment'].includes(type) ? type : 'data'));
      const describeStream = (stream) =>
        joinParts([
          stream.codec + (stream.profile ? ' ' + stream.profile : ''),
          stream.tag,
          stream.width ? stream.width + '×' + stream.height : '',
          stream.pixFmt,
          stream.aspect ? 'SAR ' + stream.aspect : '',
          stream.displayAspect ? 'DAR ' + stream.displayAspect : '',
          stream.fps ? stream.fps + ' fps' : '',
          stream.sampleRate ? stream.sampleRate + ' Hz' : '',
          stream.channels,
          stream.sampleFmt,
          stream.bitrate ? stream.bitrate + ' kb/s' : '',
          stream.language,
          stream.tags && stream.tags.title ? '“' + stream.tags.title + '”' : '',
          ...(stream.flags || []),
        ]);
      const containerRows = meta
        ? [
            [t('meta.container'), meta.format || '—'],
            [t('meta.duration'), meta.duration ? formatClock(meta.duration) + ' · ' + meta.duration.toFixed(2) + 's' : '—'],
            [t('meta.bitrate'), meta.bitrate ? meta.bitrate + ' kb/s' : '—'],
            [t('meta.size'), formatSize(file.size) || '—'],
            [t('meta.start'), (meta.start || 0).toFixed(3) + ' s'],
          ]
        : [];
      const trackRows = meta ? meta.streams.map((stream) => ['#' + stream.index + ' ' + typeLabel(stream.type), describeStream(stream)]) : [];
      const chapterRows =
        meta && meta.chapters.length
          ? meta.chapters.map((chapter, index) => [
              t('meta.chapter') + ' ' + (index + 1),
              joinParts([chapter.tags.title, formatClock(chapter.start) + ' – ' + formatClock(chapter.end)]),
            ])
          : [];
      const tagRows = meta ? Object.entries(meta.tags) : [];
      const grid = (rows) =>
        h(
          'div',
          { className: 'mc-meta-grid' },
          rows.map(([label, value], index) => [
            h('span', { key: 'l' + index }, label),
            h('span', { key: 'v' + index }, value || '—'),
          ])
        );
      // The right half of the compare: real output when converted, otherwise the
      // live re-encode of the current format/quality.
      const afterSrc = result && result.kind === 'image' ? previewUrl(result.file) : livePreview;
      const afterLabel =
        result && result.kind === 'image'
          ? t('compare.after') + ' · ' + formatSize(result.size)
          : livePreview
            ? t('compare.live') + ' · ' + (format ? format.toUpperCase() : '') + (usesQuality ? ' ' + quality : '')
            : t('compare.slot');

      // ------------------------------------------------------------ actions
      const popular = formats.slice(0, 4);
      const extra = formats.slice(4);
      const searching = query.trim().length > 0;
      const showAllFormats = moreFormats || searching;
      const actions = [];
      for (const f of showAllFormats ? formats : popular) {
        actions.push({ id: 'fmt:' + f, group: 'convert', label: t('action.toFormat').replace('%s', f.toUpperCase()), hint: t('hint.' + f), off: unavailable(f), keys: f });
      }
      if (extra.length && !searching) {
        actions.push(moreFormats
          ? { id: 'less', group: 'convert', label: t('action.less'), hint: '', keys: '' }
          : { id: 'more', group: 'convert', label: t('action.moreFormats'), hint: extra.length + ' 种', keys: 'format' });
      }
      if (file && file.kind !== 'image') {
        actions.push({ id: 'trim', group: 'edit', label: t('action.trim'), hint: t('trim.full') + ' ' + formatClock(file.duration || 0), keys: 'trim cut 裁剪' });
      }
      if (canExtractAudio) actions.push({ id: 'extract-audio', group: 'edit', label: t('action.extractAudio'), hint: t('extract.note'), keys: 'extract audio 音轨' });
      if (canExtractVideo) actions.push({ id: 'extract-video', group: 'edit', label: t('action.extractVideo'), hint: t('extract.note'), keys: 'extract video 画面' });
      if (meta && meta.subtitles.length) actions.push({ id: 'subs', group: 'view', label: t('action.subs'), hint: meta.subtitles.length + ' 条', keys: 'subtitle srt 字幕' });
      actions.push({ id: 'meta', group: 'view', label: t('action.meta'), hint: joinParts([meta ? meta.video && meta.video.codec : '', meta ? meta.audio && meta.audio.codec : '']), keys: 'metadata info 元数据' });
      actions.push({ id: 'b64', group: 'view', label: t('action.b64'), hint: '', keys: 'base64 编码' });

      const needle = query.trim().toLowerCase();
      const visible = needle ? actions.filter((a) => (a.label + ' ' + a.keys).toLowerCase().includes(needle)) : actions;
      const groups = [
        ['convert', t('group.convert'), '⇄'],
        ['edit', t('group.edit'), '✂'],
        ['view', t('group.view'), '☰'],
      ];

      const closePanel = () => {
        setPanelOpen(false);
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setAction(''), 200);
      };

      const openPanel = (id) => {
        clearTimeout(closeTimer.current);
        if (action) {
          // Switching panels keeps the box open; only the contents swap.
          setAction(id);
          setPanelOpen(true);
          return;
        }
        setAction(id);
        setPanelOpen(false);
        requestAnimationFrame(() => requestAnimationFrame(() => setPanelOpen(true)));
      };

      const toggleAction = (id) => {
        if (id === 'more') {
          setMoreFormats(true);
          return;
        }
        if (id === 'less') {
          setMoreFormats(false);
          return;
        }
        if (id.startsWith('fmt:')) setFormat(id.slice(4));
        if (action === id) closePanel();
        else openPanel(id);
      };

      const panelProps = { className: 'mc-panel', ref: panelRef };

      const progress = jobAction && phase === 'converting'
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { className: 'mc-bar' + (percent === null ? ' indet' : '') }, h('i', { style: percent === null ? undefined : { width: Math.max(2, percent) + '%' } })),
            h('span', { className: 'mc-muted' }, percent === null ? t('action.converting') : percent + '%')
          )
        : null;

      // The result lives inside the panel that started it, so cause and effect
      // stay in one place.
      const resultBlock = (id) =>
        jobAction === id && (result || phase === 'converting')
          ? h(
              'div',
              { className: 'mc-result' },
              progress,
              result
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'mc-ok' }, t('result.done')),
                    result.kind === 'video' ? h('video', { className: 'mc-player', src: previewUrl(result.file), controls: true, playsInline: true, preload: 'metadata' }) : null,
                    result.kind === 'audio' ? h('audio', { src: previewUrl(result.file), controls: true, preload: 'metadata', style: { width: '100%' } }) : null,
                    result.kind === 'text' && result.text ? h('pre', { className: 'mc-pre' }, result.text.slice(0, 4000)) : null,
                    h('span', { className: 'mc-path' }, result.file),
                    h(
                      'div',
                      { className: 'mc-row' },
                      h('button', { className: 'mc-btn mc-btn-primary', onClick: () => reveal(result.file) }, t('action.reveal')),
                      file && result.size
                        ? h('span', { className: 'mc-muted' }, t('result.size') + ': ' + formatSize(result.size) + (file.size > result.size ? ' · ' + t('compare.saved') + ' ' + Math.round((1 - result.size / file.size) * 100) + '%' : ''))
                        : null,
                      h('span', { className: 'mc-grow' }),
                      h('button', { className: 'mc-btn mc-btn-ghost', onClick: resetResult }, t('action.again'))
                    )
                  )
                : null
            )
          : null;

      const nameRow = h(
        'div',
        { className: 'mc-row' },
        h('span', { className: 'mc-muted' }, t('name.label')),
        h('input', {
          className: 'mc-name-input',
          value: outputName,
          disabled: busy,
          placeholder: file ? String(file.name || '').replace(/\.[^.]*$/, '') : '',
          'aria-label': t('name.label'),
          onChange: (e) => setOutputName(e.target.value),
        }),
        h('span', { className: 'mc-muted' }, format ? '.' + format : '')
      );

      const renderPanel = (id) => {
        if (id.startsWith('fmt:')) {
          return h(
            'div',
            panelProps,
            nameRow,
            usesQuality && id === 'fmt:' + format
              ? h(
                  'div',
                  { className: 'mc-row' },
                  h('span', { className: 'mc-muted' }, t('quality.label')),
                  h('input', {
                    type: 'range',
                    min: 10,
                    max: 100,
                    step: 5,
                    value: quality,
                    disabled: busy,
                    'aria-label': t('quality.label'),
                    onChange: (e) => {
                      setQuality(Number(e.target.value));
                      resetResult();
                    },
                  }),
                  h('span', { className: 'mc-muted' }, String(quality)),
                  h('span', { className: 'mc-muted' }, t('quality.hint'))
                )
              : null,
            h('div', { className: 'mc-row' }, h('button', { className: 'mc-btn mc-btn-primary', disabled: busy || unavailable(format), onClick: convert }, t('action.convert'))),
            resultBlock(id)
          );
        }
        if (id === 'trim') {
          return h(
            'div',
            panelProps,
            h(
              'div',
              { className: 'mc-row' },
              h('span', { className: 'mc-muted' }, t('trim.start')),
              h('input', {
                className: 'mc-time',
                value: trimStart,
                disabled: busy,
                inputMode: 'decimal',
                placeholder: '0:00',
                'aria-label': t('trim.start'),
                onChange: (e) => {
                  setTrimStart(e.target.value);
                  resetResult();
                },
              }),
              h('span', { className: 'mc-muted' }, t('trim.end')),
              h('input', {
                className: 'mc-time',
                value: trimEnd,
                disabled: busy,
                inputMode: 'decimal',
                placeholder: file.duration ? formatClock(file.duration) : '0:00',
                'aria-label': t('trim.end'),
                onChange: (e) => {
                  setTrimEnd(e.target.value);
                  resetResult();
                },
              }),
              h('span', { className: 'mc-grow' }),
              h('span', { className: trim.error ? 'mc-error' : 'mc-muted' }, trim.error || trimSummary)
            ),
            h(
              'div',
              { className: 'mc-tools' },
              h('button', { className: 'mc-btn mc-btn-ghost', disabled: busy, onClick: () => setTrimFromPlayer('start') }, t('trim.setStart')),
              h('button', { className: 'mc-btn mc-btn-ghost', disabled: busy, onClick: () => setTrimFromPlayer('end') }, t('trim.setEnd')),
              h('button', { className: 'mc-btn mc-btn-ghost', disabled: busy || Boolean(trim.error), onClick: playSelection }, t('trim.play'))
            ),
            h(
              'div',
              { className: 'mc-row' },
              h('span', { className: 'mc-muted' }, t('hint.formats')),
              h(
                'select',
                { className: 'mc-select', value: format, disabled: busy, onChange: (e) => setFormat(e.target.value) },
                formats.map((f) => h('option', { key: f, value: f, disabled: unavailable(f) }, f.toUpperCase()))
              ),
              h('button', { className: 'mc-btn mc-btn-primary', disabled: busy || Boolean(trim.error) || !trim.active || unavailable(format), onClick: applyTrim }, t('trim.apply'))
            ),
            resultBlock(id)
          );
        }
        if (id === 'extract-audio' || id === 'extract-video') {
          const which = id === 'extract-audio' ? 'audio' : 'video';
          return h(
            'div',
            panelProps,
            nameRow,
            h(
              'div',
              { className: 'mc-row' },
              h('button', { className: 'mc-btn mc-btn-primary', disabled: busy, onClick: () => extract(which) }, which === 'audio' ? t('extract.audio') : t('extract.video')),
              h('span', { className: 'mc-muted' }, t('extract.note'))
            ),
            resultBlock(id)
          );
        }
        if (id === 'subs') {
          return h(
            'div',
            panelProps,
            meta.subtitles.map((track, index) =>
              h(
                'div',
                { key: index, className: 'mc-row' },
                h('span', null, '#' + track.index + ' · ' + (track.language || '?') + ' · ' + track.codec + (track.title ? ' · ' + track.title : '')),
                h('button', { className: 'mc-btn mc-btn-ghost', style: { marginLeft: 'auto' }, disabled: busy, onClick: () => runJob({ mode: 'subtitle', stream: index }, 'subs') }, t('sub.extract'))
              )
            ),
            resultBlock(id)
          );
        }
        if (id === 'meta') {
          return h(
            'div',
            panelProps,
            grid(containerRows),
            chapterRows.length ? h('div', { className: 'mc-meta-head' }, t('meta.chapters')) : null,
            chapterRows.length ? grid(chapterRows) : null,
            h('div', { className: 'mc-meta-head' }, t('meta.tracks')),
            grid(trackRows),
            tagRows.length ? h('div', { className: 'mc-meta-head' }, t('meta.tags')) : null,
            tagRows.length ? grid(tagRows) : null,
            h('div', { className: 'mc-muted' }, t('meta.edit')),
            h(
              'div',
              { className: 'mc-meta-fields' },
              TAG_KEYS.map((key) =>
                h(
                  'label',
                  { key, className: 'mc-meta-field' },
                  h('span', null, t('meta.key.' + key)),
                  h('input', { className: 'mc-name-input', value: metaTags[key] || '', disabled: busy, onChange: (e) => setMetaTags({ ...metaTags, [key]: e.target.value }) })
                )
              )
            ),
            h('div', { className: 'mc-row' }, h('button', { className: 'mc-btn mc-btn-primary', disabled: busy, onClick: () => runJob({ mode: 'meta', tags: metaTags }, 'meta') }, t('meta.save'))),
            resultBlock(id)
          );
        }
        if (id === 'b64') {
          return h(
            'div',
            panelProps,
            h(
              'div',
              { className: 'mc-tools' },
              h('button', { className: 'mc-btn mc-btn-ghost', disabled: busy || b64Busy, onClick: toBase64 }, b64Busy ? t('b64.encoding') : t('b64.encode')),
              b64 ? h('span', { className: 'mc-muted' }, formatSize(b64.size) + ' · ' + b64.mime) : null
            ),
            b64
              ? h(
                  React.Fragment,
                  null,
                  h('textarea', { className: 'mc-b64', readOnly: true, rows: 4, value: b64.data }),
                  h(
                    'div',
                    { className: 'mc-tools' },
                    h('button', { className: 'mc-btn mc-btn-ghost', onClick: () => copy(b64.data) }, copied ? t('b64.copied') : t('b64.copy')),
                    h('button', { className: 'mc-btn mc-btn-ghost', onClick: () => downloadText((file ? file.name : 'media') + '.base64.txt', b64.data) }, t('b64.save'))
                  )
                )
              : null,
            h('div', { className: 'mc-sep' }),
            h('div', { className: 'mc-muted' }, t('b64.decodeTitle')),
            h('textarea', { className: 'mc-b64', rows: 3, value: decodeInput, placeholder: t('b64.placeholder'), onChange: (e) => setDecodeInput(e.target.value) }),
            h(
              'div',
              { className: 'mc-tools' },
              h('button', { className: 'mc-btn mc-btn-ghost', disabled: decodeBusy || !decodeInput.trim(), onClick: decode }, decodeBusy ? t('b64.decoding') : t('b64.decode'))
            ),
            decoded && decoded.kind === 'text'
              ? h(
                  React.Fragment,
                  null,
                  h('div', { className: 'mc-muted' }, t('b64.textResult')),
                  h('pre', { className: 'mc-pre' }, decoded.text),
                  h(
                    'div',
                    { className: 'mc-tools' },
                    h('button', { className: 'mc-btn mc-btn-ghost', onClick: () => copy(decoded.text) }, copied ? t('b64.copied') : t('b64.copy')),
                    h('button', { className: 'mc-btn mc-btn-ghost', onClick: () => downloadText('decoded.txt', decoded.text) }, t('b64.save'))
                  )
                )
              : null,
            decoded && decoded.kind !== 'text'
              ? h(
                  React.Fragment,
                  null,
                  decoded.kind === 'image' ? h('img', { className: 'mc-player', style: { width: 'auto', maxWidth: '100%', background: 'transparent' }, src: previewUrl(decoded.file), alt: '' }) : null,
                  decoded.kind === 'video' ? h('video', { className: 'mc-player', src: previewUrl(decoded.file), controls: true, playsInline: true, preload: 'metadata' }) : null,
                  decoded.kind === 'audio' ? h('audio', { src: previewUrl(decoded.file), controls: true, preload: 'metadata', style: { width: '100%' } }) : null,
                  h('span', { className: 'mc-path' }, decoded.file),
                  h('div', { className: 'mc-row' }, h('button', { className: 'mc-btn mc-btn-primary', onClick: () => reveal(decoded.file) }, t('action.reveal')))
                )
              : null
          );
        }
        return null;
      };

      return h(
        'div',
        { className: 'mc-page' },
        h('style', null, CSS),
        status && !status.ffmpegPath ? h('div', { className: 'mc-warn' }, t('error.noffmpeg')) : null,
        !file
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'mc-head' },
                h('h2', { className: 'mc-title' }, t('page.title')),
                h('p', { className: 'mc-sub' }, t('page.subtitle'))
              ),
              h(
                'div',
                {
                  className: 'mc-drop' + (dragging ? ' over' : ''),
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => inputRef.current && inputRef.current.click(),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (inputRef.current) inputRef.current.click();
                    }
                  },
                  onDragOver: (e) => {
                    e.preventDefault();
                    setDragging(true);
                  },
                  onDragLeave: () => setDragging(false),
                  onDrop,
                },
                h('span', { className: 'mc-drop-title' }, phase === 'uploading' ? t('status.uploading') : t('drop.title')),
                h('span', { className: 'mc-drop-hint' }, t('drop.hint')),
                h('span', { className: 'mc-muted', style: { marginTop: 10, fontSize: 12 } }, t('page.caps'))
              )
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'mc-file' },
                h(
                  'div',
                  { className: 'mc-file-main' },
                  h('span', { className: 'mc-name', title: file.name }, file.name),
                  h('span', { className: 'mc-muted' }, [formatSize(file.size), formatDuration(file.duration)].filter(Boolean).join(' · '))
                ),
                h('span', { className: 'mc-tag' }, t('kind.' + file.kind)),
                h(
                  'button',
                  {
                    className: 'mc-btn mc-btn-ghost',
                    disabled: busy,
                    onClick: () => {
                      setFile(null);
                      setRawFile(null);
                      setFormat('');
                      setOutputName('');
                      setResult(null);
                      setError('');
                      setB64(null);
                      setDecoded(null);
                      setTrimStart('');
                      setTrimEnd('');
                      setAction('');
                      setPanelOpen(false);
                      setQuery('');
                      setMoreFormats(false);
                      setPhase('idle');
                    },
                  },
                  t('action.change')
                )
              ),
              blobUrl && file.kind === 'video' ? h('video', { ref: mediaRef, className: 'mc-player', src: blobUrl, controls: true, playsInline: true, preload: 'metadata' }) : null,
              blobUrl && file.kind === 'audio' ? h('audio', { ref: mediaRef, src: blobUrl, controls: true, preload: 'metadata', style: { width: '100%' } }) : null,
              blobUrl && file.kind === 'image'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'mc-tools', style: { justifyContent: 'flex-end' } },
                      h('span', { className: 'mc-muted' }, t('compare.mode')),
                      h('button', { className: 'mc-toggle' + (compareMode === 'side' ? ' on' : ''), 'aria-pressed': compareMode === 'side', onClick: () => setCompareMode('side') }, t('compare.side')),
                      h('button', { className: 'mc-toggle' + (compareMode === 'slider' ? ' on' : ''), 'aria-pressed': compareMode === 'slider', onClick: () => setCompareMode('slider') }, t('compare.slider'))
                    ),
                    compareMode === 'slider' && afterSrc
                      ? h(CompareSlider, {
                          before: blobUrl,
                          after: afterSrc,
                          leftLabel: t('compare.before') + ' · ' + formatSize(file.size),
                          rightLabel: afterLabel,
                        })
                      : h(
                          'div',
                          { className: 'mc-compare' },
                          h('figure', { className: 'mc-fig' }, h('img', { src: blobUrl, alt: '', decoding: 'async' }), h('figcaption', { className: 'mc-cap' }, t('compare.before') + ' · ' + formatSize(file.size))),
                          h(
                            'figure',
                            { className: 'mc-fig' },
                            afterSrc
                              ? h('img', { key: afterSrc, src: afterSrc, alt: '', decoding: 'async' })
                              : h('div', { className: 'mc-fig-ph' }, phase === 'converting' ? t('action.converting') + (percent === null ? '' : ' ' + percent + '%') : t('compare.pending')),
                            h('figcaption', { className: 'mc-cap' }, afterLabel)
                          )
                        )
                  )
                : null,
              h(
                'div',
                { className: 'mc-search' },
                h('span', { className: 'mc-muted' }, '⌘'),
                h('input', {
                  ref: searchRef,
                  placeholder: t('search.placeholder'),
                  value: query,
                  'aria-label': t('search.placeholder'),
                  onChange: (e) => setQuery(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      const first = visible.find((item) => !item.off);
                      if (first) toggleAction(first.id);
                    } else if (e.key === 'Escape') {
                      e.currentTarget.blur();
                    }
                  },
                }),
                h('span', { className: 'mc-muted', style: { fontSize: 11, border: '1px solid currentColor', borderRadius: 5, padding: '0 6px' } }, '⌘K')
              ),
              error ? h('div', { className: 'mc-error' }, t('error.title') + '：' + error) : null,
              groups.map(([key, label, icon]) => {
                const items = visible.filter((a) => a.group === key);
                if (!items.length) return null;
                return h(
                  React.Fragment,
                  { key },
                  h('div', { className: 'mc-act-group' }, label),
                  items.map((item) =>
                    h(
                      React.Fragment,
                      { key: item.id },
                      h(
                        'button',
                        {
                          className: 'mc-act' + (action === item.id ? ' on' : ''),
                          disabled: Boolean(item.off) || busy,
                          title: item.off ? t('hint.noAudio') : undefined,
                          onClick: () => toggleAction(item.id),
                        },
                        h('span', { className: 'mc-act-icon' }, icon),
                        item.label,
                        item.hint ? h('span', { className: 'mc-act-hint' }, item.off ? t('hint.noAudio') : item.hint) : null
                      ),
                      action === item.id
                        ? h(
                            'div',
                            { className: 'mc-collapse' + (panelOpen ? ' open' : '') },
                            h('div', { className: 'mc-panel-clip' }, renderPanel(item.id))
                          )
                        : null
                    )
                  )
                );
              }),
              !visible.length ? h('div', { className: 'mc-muted', style: { padding: '24px 0', textAlign: 'center' } }, t('act.empty')) : null
            ),
        h('input', {
          ref: inputRef,
          type: 'file',
          hidden: true,
          onChange: (e) => {
            pick(e.target.files && e.target.files[0]);
            e.target.value = '';
          },
        }),
        status && status.outputDir ? h('div', { className: 'mc-foot' }, h('span', null, t('footer.out') + ':'), h('span', null, status.outputDir)) : null
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', ZH);
          const offEn = ctx.locale.register(NS, 'en', EN);
          return () => {
            offZh();
            offEn();
          };
        });

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('nav.label') }, PanelIcon)
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(MediaToolbox, { t })));
      },
    };
  },
});
