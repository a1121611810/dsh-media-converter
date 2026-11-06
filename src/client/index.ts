// Client half of dsh-media-converter — the media toolbox page.
//
// Entry for the DSH client loader: the build wraps this module in
// window.__ModuleLoader__.load({ id, factory(require) }) and hands React in
// through globalThis.__dshReact (the loader's factory scope cannot be reached
// from inside the bundled IIFE).
//
// React only parks the <media-panel> custom element in the slot; the panel
// itself is Vue (src/client/App.vue).
import './vue/elements.js';
import type { StatusResponse } from '../../index.js';

// React is handed in by the loader, so the bundle carries no React of its
// own: only the three hooks this file touches are declared here.
interface ReactRef<T> {
  current: T;
}
interface ReactSurface {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useRef<T>(initial: T): ReactRef<T>;
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void];
}
// The <media-panel> custom element carries the translator on the element.
interface PanelElement extends HTMLElement {
  t: (key: string) => string;
}

declare global {
  // The loader's factory parks React here before the bundle runs.
  var __dshReact: ReactSurface;
}

// The plugin services this page uses: the locale translator and the slots
// it registers into. Only the calls below are declared.
interface SlotRegistration {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: () => string;
}
interface PluginContext {
  locale: {
    bind(namespace: string): (key: string) => string;
    register(namespace: string, language: string, dictionary: Record<string, string>): () => void;
  };
  slots: {
    inject(name: string, injector: () => void): void;
    register(registration: SlotRegistration, component: unknown): () => void;
  };
  effect(effect: () => void | (() => void)): void;
}
const React = globalThis.__dshReact;
const h = React.createElement;
const PANEL_ID = 'media-convert';
const NS = 'media-convert';

const ZH: Record<string, string> = {
  'nav.label': '媒体工具箱',
  'page.title': '媒体工具箱',
  'page.subtitle': '转换、裁剪、提取音轨、字幕、元数据、Base64——一次可以处理多个文件，全部在本机完成。',
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
  'action.cancel': '取消',
  'action.cancelling': '正在取消…',
  'action.cancelled': '已取消',
  'action.reveal.mac': '在 Finder 中显示',
  'action.reveal.win': '在资源管理器中显示',
  'action.reveal.linux': '在文件管理器中显示',
  'action.again': '再转一个',
  'action.toFormat': '转成 %s',
  'action.moreFormats': '更多格式…',
  'action.moreFormatsCount': '%s 种',
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
  'error.service': '本地服务拒绝了请求：%s。请重启 DSH 后再试。',
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
  'composer.label': '媒体工具箱',
  'composer.title': '把一条媒体处理指令插入输入框，改完发送即可',
  'settings.label': '媒体工具箱',
  'settings.title': '工具箱配置',
  'settings.current': '当前生效',
  'settings.field.outputDir': '输出目录',
  'settings.field.outputDir.hint': '留空则保持当前值',
  'settings.field.ffmpeg': 'ffmpeg 路径',
  'settings.field.ffmpeg.hint': '留空则自动查找',
  'settings.field.maxUpload': '上传上限（MB）',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.saved': '已保存并立即生效',
  'settings.error': '保存失败，请重试',
  'settings.hint':
    '保存写入 profile 配置并立即对本插件生效（无需重启）；直接手动编辑 cordis.patch.yml 则需要重启。同样的配置也驱动「内置插件」页里本插件的官方配置表单。',
  'settings.version': '版本',
  'settings.refresh': '刷新界面',
  'settings.refresh.title': '重新加载整个界面，等同于按 Ctrl+R（未保存的修改会丢失）',
  'settings.composerButton': '在输入框工具排显示「媒体工具箱」按钮',
  'settings.groups': '动作面板模块',
  'settings.groups.show': '显示',
  'settings.groups.up': '上移',
  'settings.groups.down': '下移',
  'queue.file': '文件',
  'queue.kind': '类型',
  'queue.duration': '时长',
  'queue.size': '大小',
  'queue.status': '状态',
  'queue.all': '全选',
  'queue.selected': '已选 %s / %s',
  'queue.select': '选择 %s',
  'queue.add': '添加文件',
  'queue.clear': '清空',
  'queue.confirmClear': '确认清空',
  'queue.emptyTitle': '拖入文件，或点击选择',
  'queue.emptyHint': '视频 · 音频 · 图片，可一次选多个',
  'queue.choose': '选择文件',
  'queue.privacy': '全部在本机用 ffmpeg 完成，文件不出本机。',
  'queue.dropNow': '松开以添加文件',
  'queue.cancelUpload': '取消上传',
  'item.uploading': '读取中…',
  'item.ready': '等待',
  'item.converting': '处理中…',
  'item.cancelling': '正在取消…',
  'item.cancelled': '已取消',
  'item.done': '完成',
  'item.copy': '直接拷贝',
  'item.gpu': 'GPU 编码',
  'item.failed': '失败',
  'item.skipped': '跳过',
  'item.details': '详情',
  'item.reveal': '显示',
  'item.remove': '移除 %s',
  'batch.title': '批量处理',
  'batch.count': '%s 个文件',
  'batch.operation': '处理方式',
  'batch.convert': '转换',
  'batch.audio': '提取音频',
  'batch.video': '提取画面',
  'batch.format': '目标格式',
  'batch.quality': '图片质量',
  'batch.start': '开始处理 %s 个文件',
  'batch.running': '正在处理 %s/%s',
  'batch.cancel': '取消',
  'batch.none': '勾选要处理的文件',
  'batch.skip': '跳过',
  'batch.missing': '模型没有返回这个文件',
  'batch.notApplicable': '不适用',
  'batch.ptcInfo': '说明',
  'batch.ptcOnlyBatch': 'PTC 只用于至少 2 个文件的批量转换',
  'batch.ptcOff': '关闭（默认）：固定规则，快，不花 token。',
  'batch.timing': '模型 %s 秒 · 转换 %s 秒',
  'batch.target': '目标',
  'batch.notConvert': '不参与转换',
  'queue.pending': '读取中/未识别',
  'queue.pendingNote': '正在读取或未能识别，不能批量处理',
  'queue.textNoBatch': '不参与转换，可进详情转 Base64',
  'queue.selectGroup': '全选 %s',
  'queue.defaultTarget': '默认目标',
  'queue.rowTargetFor': '目标 %s',
  'batch.gpu': 'GPU 编码（VideoToolbox）',
  'batch.gpuHint': '用 Apple 媒体引擎，速度快、CPU 占用低；画质/体积与软件编码不同',
  'ptc.model': '模型',
  'ptc.modelDefault': '跟随 DSH 默认',
  'ptc.modelHint': '默认用 DSH 当前主模型；换一个更快的已注册模型可以缩短等待',
  'ptc.modelLoading': '读取模型中…',
  'ptc.modelFailed': '模型列表读取失败，仍可用默认',
  'ptc.planning': '模型决定中 · %s 秒 · 已输出 %s 字',
  'ptc.converting': '转换 %s/%s（自适应并发）',
  'batch.noAudio': '勾选里没有带音轨的视频',
  'batch.noVideo': '勾选里没有视频',
  'extract.visualNote': '直接拷贝画面，不重新编码',
  'detail.back': '返回队列',
  'detail.recent': '最近输出',
  'ptc.label': '用 DSH PTC 调度',
  'ptc.running': 'PTC 正在调度…',
  'ptc.note':
    '关闭（默认）：这批任务由插件按每类文件的目标直接跑。快，不花 token。\n打开：主模型只返回每个文件的格式/质量计划（JSON），插件把它拼成程序交给 DSH PTC 在沙箱执行。会消耗 token；通常会多花几秒。\n适合需要逐文件调整的批次；统一转换关着更快。只影响「转成 X」；裁剪、提取、字幕、元数据仍按固定规则。\n大批量慎用：PTC 有执行时限（默认 2 分钟，最多 10 分钟），超时会整批中止。',
  'settings.groups.hint': '勾选控制显示，箭头调整顺序；隐藏的模块在面板中不显示。',
};
const EN: Record<string, string> = {
  'nav.label': 'Media Tools',
  'page.title': 'Media Toolbox',
  'page.subtitle': 'Convert, trim, split tracks, subtitles, metadata, and Base64 — several files at once, all locally.',
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
  'action.cancel': 'Cancel',
  'action.cancelling': 'Cancelling…',
  'action.cancelled': 'Cancelled',
  'action.reveal.mac': 'Show in Finder',
  'action.reveal.win': 'Show in Explorer',
  'action.reveal.linux': 'Show in file manager',
  'action.again': 'Do it again',
  'action.toFormat': 'Convert to %s',
  'action.moreFormats': 'More formats…',
  'action.moreFormatsCount': '%s more',
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
  'error.service': 'The local service refused the request: %s. Restart DSH and try again.',
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
  'composer.label': 'Media Toolbox',
  'composer.title': 'Insert a media-processing prompt into the input; edit and send',
  'settings.label': 'Media Toolbox',
  'settings.title': 'Toolbox configuration',
  'settings.current': 'Currently in effect',
  'settings.field.outputDir': 'Output directory',
  'settings.field.outputDir.hint': 'Leave empty to keep the current one',
  'settings.field.ffmpeg': 'ffmpeg path',
  'settings.field.ffmpeg.hint': 'Empty finds it automatically',
  'settings.field.maxUpload': 'Upload limit (MB)',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saved': 'Saved and applied immediately',
  'settings.error': 'Save failed, try again',
  'settings.hint':
    'Saving writes the profile config and applies to this plugin at once (no restart); editing cordis.patch.yml by hand does need one. It also drives this plugin’s generated form on the Built-in Plugins page.',
  'settings.version': 'Version',
  'settings.refresh': 'Refresh page',
  'settings.refresh.title': 'Reload the whole app, the same as pressing Ctrl+R (unsaved edits are lost)',
  'settings.composerButton': 'Show the Media Toolbox button in the composer tool row',
  'settings.groups': 'Action panel modules',
  'settings.groups.show': 'Show',
  'settings.groups.up': 'Up',
  'settings.groups.down': 'Down',
  'queue.file': 'File',
  'queue.kind': 'Type',
  'queue.duration': 'Duration',
  'queue.size': 'Size',
  'queue.status': 'Status',
  'queue.all': 'Select all',
  'queue.selected': '%s of %s selected',
  'queue.select': 'Select %s',
  'queue.add': 'Add files',
  'queue.clear': 'Clear',
  'queue.confirmClear': 'Confirm clear',
  'queue.emptyTitle': 'Drop files, or click to choose',
  'queue.emptyHint': 'Video · audio · image — multiple files at once',
  'queue.choose': 'Choose files',
  'queue.privacy': 'Everything runs locally with ffmpeg; files never leave this machine.',
  'queue.dropNow': 'Release to add files',
  'queue.cancelUpload': 'Cancel uploads',
  'item.uploading': 'Reading…',
  'item.ready': 'Queued',
  'item.converting': 'Working…',
  'item.cancelling': 'Cancelling…',
  'item.cancelled': 'Cancelled',
  'item.done': 'Done',
  'item.copy': 'Direct copy',
  'item.gpu': 'GPU encoded',
  'item.failed': 'Failed',
  'item.skipped': 'Skipped',
  'item.details': 'Details',
  'item.reveal': 'Show',
  'item.remove': 'Remove %s',
  'batch.title': 'Batch',
  'batch.count': '%s files',
  'batch.operation': 'Operation',
  'batch.convert': 'Convert',
  'batch.audio': 'Extract audio',
  'batch.video': 'Extract video',
  'batch.format': 'Target',
  'batch.quality': 'Image quality',
  'batch.start': 'Process %s files',
  'batch.running': 'Processing %s/%s',
  'batch.cancel': 'Cancel',
  'batch.none': 'Check the files to process',
  'batch.skip': 'Skipped',
  'batch.missing': 'The model returned no result for this file',
  'batch.notApplicable': 'Not applicable',
  'batch.ptcInfo': 'Details',
  'batch.ptcOnlyBatch': 'PTC is for batch conversion of at least 2 files',
  'batch.ptcOff': 'Off (default): fixed rules, fast, no tokens.',
  'batch.timing': 'Model %ss · convert %ss',
  'batch.target': 'Target',
  'batch.notConvert': 'not converted',
  'queue.pending': 'Reading / unrecognised',
  'queue.pendingNote': 'Still reading or not recognised; not batchable',
  'queue.textNoBatch': 'Not converted; open details for Base64',
  'queue.selectGroup': 'Select all %s',
  'queue.defaultTarget': 'Default target',
  'queue.rowTargetFor': 'Target for %s',
  'batch.gpu': 'GPU encoding (VideoToolbox)',
  'batch.gpuHint': 'Uses the Apple media engine: faster, lower CPU. Quality and size differ from software encoding.',
  'ptc.model': 'Model',
  'ptc.modelDefault': 'Follow DSH default',
  'ptc.modelHint': 'Defaults to the DSH model; a faster registered model shortens the wait.',
  'ptc.modelLoading': 'Loading models…',
  'ptc.modelFailed': 'Could not load the model list; the default still works',
  'ptc.planning': 'Planning · %ss · %s chars',
  'ptc.converting': 'Converting %s/%s (adaptive)',
  'batch.noAudio': 'No video with audio is selected',
  'batch.noVideo': 'No video is selected',
  'extract.visualNote': 'Stream copy — no re-encode',
  'detail.back': 'Back to queue',
  'detail.recent': 'Latest output',
  'ptc.label': 'Use DSH PTC scheduling',
  'ptc.running': 'PTC is scheduling…',
  'ptc.note':
    'Off (default): the plugin runs this batch with the target of each kind. Fast, no tokens.\nOn: the main model only returns a per-file format/quality plan (JSON); the plugin composes it into a program and runs it in the DSH PTC sandbox. Costs tokens and usually a few seconds.\nBest for batches that need per-file adjustments; for one uniform format, off is faster. Only affects "Convert to X"; trim, extract, subtitles and metadata keep the fixed rules.\nLarge batches: PTC has an execution deadline (2 min by default, 10 min max); a timeout aborts the whole batch.',
  'settings.groups.hint': 'Tick to show, arrows to order; hidden modules do not appear in the panel.',
};

function PanelIcon({ size }: { size?: number }) {
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
    h('path', { d: 'm10 12.5L6.5 16l3.5 3.5' }),
  );
}

// The composer slot entries receive its own edit face: undoable text
// insertion, not DOM poking.
interface InputActions {
  captureInsertion(): { start: number; end: number };
  insertText(text: string, span: { start: number; end: number }): boolean;
}

// Dropped into the draft on click; the user edits the placeholders (file,
// range, format) and sends. Chinese works for the model either way.
const COMPOSER_TEMPLATE = '把 xx.mov 裁 0:10 到 1:00 转成 mp4';

// One status read shared by every mount of the composer button, so disabling
// the button in settings actually removes it from the tool row.
let buttonStatusPromise: Promise<StatusResponse | null> | null = null;
const buttonConfig = () => {
  if (!buttonStatusPromise) {
    buttonStatusPromise = fetch('/api/media-convert/status')
      .then((resp) => resp.json())
      .then((data) => data as StatusResponse)
      .catch(() => null);
  }
  return buttonStatusPromise;
};

const COMPOSER_CSS = `
.mc-composer-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: background-color .2s, color .2s; }
.mc-composer-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mc-settings { padding: 4px 2px; display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); max-width: 560px; }
.mc-settings-title { margin: 0; font-size: 15px; font-weight: 600; }
.mc-settings-list { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
.mc-settings-list dt { color: var(--dsw-alias-label-secondary, inherit); }
.mc-settings-list dd { margin: 0; word-break: break-all; }
.mc-settings-form { display: flex; flex-direction: column; gap: 12px; }
.mc-settings-field { display: flex; flex-direction: column; gap: 4px; }
.mc-settings-field > span { color: var(--dsw-alias-label-secondary, inherit); }
.mc-settings-field > small { color: var(--dsw-alias-label-tertiary, inherit); font-size: 12px; }
.mc-settings-input { box-sizing: border-box; width: 100%; max-width: 420px; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
.mc-settings-input:focus { outline: none; border-color: var(--dsw-static-deepseek-500, #4d6bfe); }
.mc-settings-save { align-self: flex-start; padding: 6px 16px; border: 0; border-radius: 6px; background: var(--dsw-static-deepseek-500, #4d6bfe); color: #fff; font: inherit; font-size: 12px; cursor: pointer; }
.mc-settings-save:disabled { opacity: 0.6; cursor: default; }
.mc-settings-note { margin: 0; font-size: 12px; }
.mc-settings-note.ok { color: var(--dsw-alias-state-success-fg, #2ba471); }
.mc-settings-note.err { color: var(--dsw-alias-state-danger-fg, #d54941); }
.mc-settings-hint { margin: 0; color: var(--dsw-alias-label-secondary, inherit); line-height: 1.6; }
.mc-settings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mc-settings-refresh { padding: 5px 12px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: background-color .2s, color .2s; }
.mc-settings-refresh:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mc-settings-grouprow { display: flex; align-items: center; gap: 8px; }
.mc-settings-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.mc-settings-rowtail { margin-left: auto; display: inline-flex; gap: 6px; }
.mc-settings-mini { width: 24px; height: 24px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mc-settings-mini:disabled { opacity: 0.4; cursor: default; }
`;

// Editable form backed by the settings service: the POST merges into the
// profile document (validated against the exported Config schema) and the
// host applies it to its running state, so a save is effective at once —
// the desktop loader alone would not re-apply the plugin.
const GROUP_KEYS = ['convert', 'edit', 'view'];

function SettingsPage({ t }: { t: (key: string) => string }) {
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [form, setForm] = React.useState({
    outputDir: '',
    ffmpegPath: '',
    maxUploadMb: '2048',
    composerButton: true,
  });
  const [rows, setRows] = React.useState<{ key: string; on: boolean }[]>([]);
  const [phase, setPhase] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const readyRef = React.useRef(false);

  const load = () => {
    fetch('/api/media-convert/status')
      .then((resp) => resp.json())
      .then((data) => {
        const next = data as StatusResponse;
        setStatus(next);
        // Initialize the editable state once per page open; later refreshes
        // only update the "currently in effect" display.
        if (!readyRef.current) {
          readyRef.current = true;
          setForm({
            outputDir: '',
            ffmpegPath: '',
            maxUploadMb: String(next.maxUploadMb),
            composerButton: next.composerButton !== false,
          });
          setRows(
            [...next.groups, ...GROUP_KEYS.filter((key) => !next.groups.includes(key))].map((key) => ({
              key,
              on: next.groups.includes(key),
            })),
          );
        }
      })
      .catch(() => {});
  };
  React.useEffect(load, []);

  const save = () => {
    setPhase('saving');
    fetch('/api/media-convert/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        outputDir: form.outputDir,
        ffmpegPath: form.ffmpegPath,
        maxUploadMb: Number(form.maxUploadMb),
        composerButton: form.composerButton,
        groups: rows
          .filter((row) => row.on)
          .map((row) => row.key)
          .join(','),
      }),
    })
      .then((resp) => resp.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error || 'save failed');
        setPhase('saved');
        // The host applies the save to its running state, so re-reading shows
        // the now-effective values in the "currently in effect" block.
        setTimeout(() => {
          load();
          setPhase('idle');
        }, 700);
      })
      .catch(() => setPhase('error'));
  };

  if (!status) {
    return h('div', { className: 'mc-settings' }, h('p', { className: 'mc-settings-hint' }, t('error.network')));
  }
  const set = (key: 'outputDir' | 'ffmpegPath' | 'maxUploadMb') => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const field = (label: string, hint: string, key: 'outputDir' | 'ffmpegPath' | 'maxUploadMb', placeholder: string) =>
    h(
      'label',
      { className: 'mc-settings-field' },
      h('span', null, label),
      h('input', { className: 'mc-settings-input', value: form[key], placeholder, onInput: set(key) }),
      h('small', null, hint),
    );
  const move = (index: number, delta: number) =>
    setRows((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const toggle = (index: number) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, on: !row.on } : row)));
  return h(
    'div',
    { className: 'mc-settings' },
    h(
      'div',
      { className: 'mc-settings-head' },
      h(
        'h3',
        { className: 'mc-settings-title' },
        t('settings.title') + (status.version ? ` · v${status.version}` : ''),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'mc-settings-refresh',
          title: t('settings.refresh.title'),
          onClick: () => location.reload(),
        },
        t('settings.refresh'),
      ),
    ),
    h(
      'dl',
      { className: 'mc-settings-list' },
      h('dt', null, `${t('settings.field.outputDir')}（${t('settings.current')}）`),
      h('dd', null, status.outputDir),
      h('dt', null, `${t('settings.field.ffmpeg')}（${t('settings.current')}）`),
      h('dd', null, status.ffmpegPath || '—'),
      h('dt', null, `${t('settings.field.maxUpload')}（${t('settings.current')}）`),
      h('dd', null, String(status.maxUploadMb)),
    ),
    h(
      'div',
      { className: 'mc-settings-form' },
      field(t('settings.field.outputDir'), t('settings.field.outputDir.hint'), 'outputDir', status.outputDir),
      field(t('settings.field.ffmpeg'), t('settings.field.ffmpeg.hint'), 'ffmpegPath', status.ffmpegPath || ''),
      field(t('settings.field.maxUpload'), '', 'maxUploadMb', String(status.maxUploadMb)),
      h(
        'label',
        { className: 'mc-settings-check' },
        h('input', {
          type: 'checkbox',
          checked: form.composerButton,
          onChange: (event: { target: { checked: boolean } }) =>
            setForm((current) => ({ ...current, composerButton: event.target.checked })),
        }),
        t('settings.composerButton'),
      ),
    ),
    h(
      'div',
      { className: 'mc-settings-field' },
      h('span', null, t('settings.groups')),
      rows.map((row, index) =>
        h(
          'div',
          { className: 'mc-settings-grouprow', key: row.key },
          h(
            'label',
            { className: 'mc-settings-check' },
            h('input', { type: 'checkbox', checked: row.on, onChange: () => toggle(index) }),
            t(`group.${row.key}`),
          ),
          h(
            'span',
            { className: 'mc-settings-rowtail' },
            h(
              'button',
              {
                type: 'button',
                className: 'mc-settings-mini',
                disabled: index === 0,
                title: t('settings.groups.up'),
                onClick: () => move(index, -1),
              },
              '↑',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mc-settings-mini',
                disabled: index === rows.length - 1,
                title: t('settings.groups.down'),
                onClick: () => move(index, 1),
              },
              '↓',
            ),
          ),
        ),
      ),
      h('small', null, t('settings.groups.hint')),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'mc-settings-save',
        disabled: phase === 'saving',
        onClick: save,
      },
      t(phase === 'saving' ? 'settings.saving' : 'settings.save'),
    ),
    phase === 'saved' ? h('p', { className: 'mc-settings-note ok' }, t('settings.saved')) : null,
    phase === 'error' ? h('p', { className: 'mc-settings-note err' }, t('settings.error')) : null,
    h('p', { className: 'mc-settings-hint' }, t('settings.hint')),
  );
}

function ComposerButton({ inputActions, t }: { inputActions?: InputActions; t: (key: string) => string }) {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let disposed = false;
    buttonConfig().then((status) => {
      // A failed read defaults to showing the button: availability first.
      if (!disposed) setEnabled(status ? status.composerButton !== false : true);
    });
    return () => {
      disposed = true;
    };
  }, []);
  const onClick = () => {
    if (!inputActions || typeof inputActions.insertText !== 'function') return;
    const applied = inputActions.insertText(COMPOSER_TEMPLATE, inputActions.captureInsertion());
    if (!applied) return;
    const composer = document.querySelector('[data-composer-input]');
    if (composer instanceof HTMLElement) composer.focus({ preventScroll: true });
  };
  if (enabled !== true) return null;
  return h(
    'button',
    { type: 'button', className: 'mc-composer-btn', title: t('composer.title'), onClick },
    h(PanelIcon, { size: 14 }),
    t('composer.label'),
  );
}

const CSS = `
      .mc-host, media-panel { display: block; height: 100%; }
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
      .mc-fig img { max-width: 100%; max-height: 240px; border-radius: 8px; object-fit: contain; }
      .mc-fig-ph { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; min-height: 240px; padding: 12px; border-radius: 8px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; text-align: center; }
      .mc-cap { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); text-align: center; word-break: break-all; }
      compare-slider { display: block; }
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

      /* ---- queue workbench ------------------------------------------------ */
      .mc-page { max-width: 960px; position: relative; }
      .mc-queue { position: relative; display: flex; flex-direction: column; gap: 14px; }
      .mc-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .mc-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12.5px; }
      .mc-check input { width: 15px; height: 15px; accent-color: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 260px; padding: 64px 24px; border: 1.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); border-radius: 16px; text-align: center; cursor: pointer; transition: border-color .2s, background-color .2s; }
      .mc-empty:hover, .mc-empty.over { border-color: var(--dsw-static-deepseek-500, #4d6bfe); background: rgba(77, 107, 254, 0.04); }
      .mc-empty svg { width: 34px; height: 34px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-empty-title { margin: 0; font-size: 16px; font-weight: 600; }
      .mc-empty-hint { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-empty-privacy { margin: 4px 0 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-drop-overlay { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; border: 2px dashed var(--dsw-static-deepseek-500, #4d6bfe); border-radius: 14px; background: rgba(77, 107, 254, 0.06); font-weight: 600; pointer-events: none; }
      .mc-group { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 12px; margin: 10px 0; overflow: hidden; }
      .mc-group-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.06)); }
      .mc-group-check { font-size: 12.5px; font-weight: 600; }
      .mc-group-label { font-size: 13px; font-weight: 600; }
      .mc-group-count { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-group-target { margin-left: auto; }
      .mc-group .mc-list-wrap { border: 0; }
      .mc-group .mc-item:first-child { border-top: 0; }
      .mc-list-wrap { display: flex; flex-direction: column; }
      .mc-list-head, .mc-item { display: grid; grid-template-columns: 20px 36px minmax(0, 1fr) 112px 58px 76px minmax(130px, auto) auto; align-items: center; gap: 6px 12px; }
      .mc-kind { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .mc-kind > span { flex: none; }
      .mc-row-target { width: 72px; min-width: 0; padding: 2px 4px; height: 24px; font-size: 11px; }
      .mc-list-head { padding: 2px 8px 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-list { list-style: none; margin: 0; padding: 0; }
      .mc-item { padding: 10px 8px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); transition: background-color .15s; }
      .mc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-thumb { width: 36px; height: 36px; box-sizing: border-box; border-radius: 6px; overflow: hidden; display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); color: var(--dsw-alias-label-secondary, inherit); }
      .mc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .mc-thumb svg { width: 18px; height: 18px; }
      .mc-item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; }
      .mc-kind { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-row-target { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, inherit); white-space: nowrap; }
      .mc-num { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); text-align: right; white-space: nowrap; }
      .mc-status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, inherit); }
      .mc-dot.dot-ok { background: var(--dsw-alias-state-success-primary, #2ba471); }
      .mc-dot.dot-error { background: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-dot.dot-warn { background: var(--dsw-alias-state-warn-primary, #d5763f); }
      .mc-dot.dot-busy { background: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-row-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
      .mc-link { border: 0; background: transparent; color: var(--dsw-static-deepseek-500, #4d6bfe); font: inherit; font-size: 12px; cursor: pointer; padding: 3px 5px; border-radius: 5px; }
      .mc-link:hover { text-decoration: underline; }
      .mc-link:disabled { opacity: .5; cursor: default; text-decoration: none; }
      .mc-icon-btn { width: 26px; height: 26px; display: grid; place-items: center; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit); border-radius: 5px; cursor: pointer; }
      .mc-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); color: var(--dsw-alias-label-primary, inherit); }
      .mc-icon-btn:disabled { opacity: .45; cursor: default; }
      .mc-icon-btn svg { width: 14px; height: 14px; }
      .mc-rowbar { grid-column: 1 / -1; height: 3px; margin-top: -4px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); }
      .mc-rowbar > i { display: block; height: 100%; background: var(--dsw-static-deepseek-500, #4d6bfe); transition: width .2s var(--mc-ease); }
      .mc-rowbar.indet > i { width: 38%; animation: mc-slide 1.2s ease-in-out infinite; }
      .mc-row-error { grid-column: 3 / -1; margin: 0; color: var(--dsw-alias-state-error-primary, #d5483f); font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .mc-task { display: flex; flex-direction: column; gap: 11px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, transparent); }
      .mc-task-head { display: flex; align-items: baseline; gap: 10px; }
      .mc-task-title { font-size: 14px; font-weight: 600; }
      .mc-task-count { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-task-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
      .mc-seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; }
      .mc-seg button { padding: 5px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 12.5px; cursor: pointer; }
      .mc-seg button.on { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
      .mc-seg button:disabled { opacity: .45; cursor: default; }
      .mc-field { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-field .mc-select { padding: 5px 8px; font-size: 12.5px; }
      .mc-quality input[type='range'] { width: 120px; accent-color: var(--dsw-static-deepseek-500, #4d6bfe); }
      .mc-batch-note { font-size: 12px; }
      .mc-summary { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-ptc-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .mc-ptc-check { font-size: 12.5px; }
      .mc-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-ptc-copy { margin: 0; padding: 10px 12px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5)); color: var(--dsw-alias-label-secondary, inherit); font-size: 12px; line-height: 1.7; white-space: pre-line; max-width: 68ch; }
      .mc-task-foot { display: flex; align-items: center; gap: 10px; }
      .mc-batch-progress { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 5px; }
      .mc-batch-progress span { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-batch-result { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-btn-danger { color: var(--dsw-alias-state-error-primary, #d5483f); border-color: var(--dsw-alias-state-error-primary, #d5483f); }
      .mc-detail-head { display: flex; align-items: center; gap: 10px; }
      .mc-back { padding: 4px 8px 4px 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 12.5px; cursor: pointer; }
      .mc-back:hover { color: var(--dsw-alias-label-primary, inherit); }
      .mc-detail-title { display: flex; flex-direction: column; gap: 3px; }
      .mc-detail-name { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
      .mc-recent { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-action-groups { display: flex; flex-direction: column; gap: 12px; }
      .mc-group { display: flex; flex-direction: column; gap: 8px; }
      .mc-group-title { margin-top: 4px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, inherit); }
      .mc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
      .mc-tile { display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color .15s, border-color .15s; }
      .mc-tile:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); }
      .mc-tile.on { border-color: var(--dsw-static-deepseek-500, #4d6bfe); background: rgba(77, 107, 254, 0.06); }
      .mc-tile:disabled { opacity: .5; cursor: not-allowed; }
      .mc-tile-badge { flex: none; min-width: 38px; padding: 4px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 600; text-align: center; }
      .mc-tile-icon { flex: none; width: 18px; height: 18px; color: var(--dsw-alias-label-secondary, inherit); }
      .mc-tile-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .mc-tile-label { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-tile-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mc-empty-actions { padding: 24px 0; text-align: center; }
      .mc-panel { margin: 2px 0 0; }
      @media (max-width: 720px) {
        .mc-list-head { display: none; }
        .mc-item { display: flex; flex-wrap: wrap; align-items: center; gap: 7px 10px; }
        .mc-item-name { flex: 1 1 55%; }
        .mc-kind, .mc-num, .mc-status { flex: 0 0 auto; }
        .mc-num { text-align: left; }
        .mc-row-actions { margin-left: auto; }
        .mc-row-error, .mc-rowbar { flex: 1 0 100%; }
        .mc-row-error { grid-column: auto; }
        .mc-task-row { gap: 10px; }
        .mc-task-foot { flex-wrap: wrap; }
        .mc-task-foot .mc-btn { flex: 1 1 100%; }
        .mc-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 460px) {
        .mc-grid { grid-template-columns: 1fr; }
      }
    `;

// React face of the panel. Eight lines of React is the whole seam: the
// element mounts once, owns its own DOM, and only receives the translator.
function Shell({ t }: { t: (key: string) => string }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const panel = React.useRef<PanelElement | null>(null);
  React.useEffect(() => {
    const el = document.createElement('media-panel') as PanelElement;
    el.t = t; // set before connect so the first render is already translated
    panel.current = el; // firstElementChild is the <style>, not the panel
    ref.current!.appendChild(el);
    return () => {
      panel.current = null;
      el.remove();
    };
  }, []);
  React.useEffect(() => {
    if (panel.current) panel.current.t = t;
  }, [t]);
  // The stylesheet lives with the shell: Vue does not inject SFC styles when
  // the custom element uses light DOM.
  return h('div', { className: 'mc-host', ref }, h('style', null, CSS));
}

const plugin = {
  inject: ['slots', 'locale'],
  apply(ctx: PluginContext) {
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
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('nav.label') },
        PanelIcon,
      ),
    );
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Shell, { t })));

    // A compact button in the composer tool row (the "+" button's row): one
    // click puts the media instruction into the draft.
    ctx.effect(() => {
      // The loader also evaluates the bundle in a document-less sandbox (the
      // contract test); there is nothing to style there.
      if (typeof document === 'undefined') return () => {};
      const style = document.createElement('style');
      style.textContent = COMPOSER_CSS;
      document.head.appendChild(style);
      return () => style.remove();
    });
    ctx.slots.inject('conversation.input.left', () =>
      ctx.slots.register(
        { name: 'conversation.input.left', id: PANEL_ID + '-composer', order: 30, label: () => t('composer.label') },
        function ComposerEntry(props: { inputActions?: InputActions }) {
          return h(ComposerButton, { inputActions: props.inputActions, t });
        },
      ),
    );
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: PANEL_ID + '-settings', order: 50, label: () => t('settings.label') },
        () => h(SettingsPage, { t }),
      ),
    );
  },
};

export const inject = plugin.inject;
export const apply = plugin.apply;
