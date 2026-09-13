/**
 * 剪辑工作区 · 共享数据模型
 * ------------------------------------------------------------
 * 视频 / 音频统一建模：媒体库 + 多轨 + 片段。
 * 片段保存「时间线位置 + 素材入点 + 时长」，裁剪与变速都只改这几个字段。
 */

export type EditMediaKind = 'video' | 'audio'
export type EditTrackKind = 'video' | 'audio'

export interface EditMedia {
  id: string
  name: string
  /** 本地绝对路径 */
  path: string
  /** file:// URL（由主进程 pathToFileURL 生成） */
  url: string
  kind: EditMediaKind
  /** 秒；导入后由主进程 ffprobe / 渲染层元数据补齐 */
  duration: number
  width?: number
  height?: number
  /** 音频波形峰值（0~1），用于时间线绘制 */
  peaks?: number[]
  /** 容器 / 编码信息（ffprobe 探测） */
  container?: string
  videoCodec?: string
  audioCodec?: string
  /** 是否含音频轨（ffprobe 探测；undefined 表示未知，按「可能含音频」处理） */
  hasAudio?: boolean
  /** 原始格式 Chromium 无法直接播放时，转码出的代理文件 */
  proxyPath?: string
  proxyUrl?: string
  /** 需要转码代理（用于 UI 提示） */
  needsProxy?: boolean
}

export interface EditTrack {
  id: string
  name: string
  kind: EditTrackKind
  muted: boolean
  hidden: boolean
  locked: boolean
}

export interface EditClipFilter {
  /** 100 = 原始值 */
  brightness: number
  contrast: number
  saturate: number
  /** 0 = 不灰度，100 = 全灰 */
  grayscale: number
  /** 模糊半径（px） */
  blur: number
}

export type EditTransitionType = 'dissolve' | 'fadeblack' | 'wipeleft' | 'slideleft' | 'zoomin'

/** 转场：作用于「进入本片段」的切点，与同轨前一个相邻片段做过渡。 */
export interface EditTransition {
  type: EditTransitionType
  /** 转场时长（秒），以切点为中心各占一半 */
  duration: number
}

export const TRANSITIONS: Array<{ id: EditTransitionType; label: string; xfade: string }> = [
  { id: 'dissolve', label: '交叉溶解', xfade: 'dissolve' },
  { id: 'fadeblack', label: '黑场过渡', xfade: 'fadeblack' },
  { id: 'wipeleft', label: '左划像', xfade: 'wipeleft' },
  { id: 'slideleft', label: '左滑入', xfade: 'slideleft' },
  { id: 'zoomin', label: '缩放进入', xfade: 'zoomin' }
]

export type EditEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

/** 关键帧：t 为相对片段起点的秒数。 */
export interface EditKeyframe {
  t: number
  v: number
  e?: EditEasing
}

export const KEYFRAME_PROPS = [
  { id: 'opacity', label: '不透明度', min: 0, max: 1, step: 0.01, float: true },
  { id: 'volume', label: '音量', min: 0, max: 2, step: 0.01, float: true },
  { id: 'rotation', label: '旋转(°)', min: -180, max: 180, step: 1, float: false },
  { id: 'brightness', label: '亮度', min: 0, max: 200, step: 1, float: false },
  { id: 'contrast', label: '对比度', min: 0, max: 200, step: 1, float: false },
  { id: 'saturate', label: '饱和度', min: 0, max: 200, step: 1, float: false },
  { id: 'grayscale', label: '灰度', min: 0, max: 100, step: 1, float: false }
] as const

export type EditKeyframeProp = (typeof KEYFRAME_PROPS)[number]['id']

export type EditKeyframes = Partial<Record<EditKeyframeProp, EditKeyframe[]>>

function ease(u: number, e: EditEasing | undefined): number {
  const x = Math.min(1, Math.max(0, u))
  if (e === 'easeIn') return x * x
  if (e === 'easeOut') return 1 - (1 - x) * (1 - x)
  if (e === 'easeInOut') return x * x * (3 - 2 * x)
  return x
}

/**
 * 求某个属性在片段内 localT 秒处的值：
 * 没有关键帧时返回 fallback；有则按关键帧插值（超出范围取端点）。
 */
export function evalKeyframes(kfs: EditKeyframe[] | undefined, localT: number, fallback: number): number {
  if (!kfs || !kfs.length) return fallback
  const list = kfs
  if (localT <= list[0].t) return list[0].v
  const last = list[list.length - 1]
  if (localT >= last.t) return last.v
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i]
    const b = list[i + 1]
    if (localT >= a.t && localT <= b.t) {
      const span = b.t - a.t
      const u = span <= 0 ? 1 : (localT - a.t) / span
      return a.v + (b.v - a.v) * ease(u, a.e)
    }
  }
  return last.v
}

export type EditTextAlign = 'left' | 'center' | 'right'

/** 文字 / 字幕样式（叠加在画面上的标题层）。 */
export interface EditTextStyle {
  content: string
  /** CSS 字体栈（导出时会映射到系统字体文件） */
  fontFamily: string
  /** 以 1080p 画面高度为基准的字号（px） */
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  align: EditTextAlign
  /** 位置，0~1 相对画面宽高（align 决定 x 是左 / 中 / 右锚点） */
  x: number
  y: number
  background: boolean
  backgroundColor: string
  stroke: boolean
  strokeColor: string
  strokeWidth: number
  shadow: boolean
}

export interface EditClip {
  id: string
  /** 文字片段为空字符串 */
  mediaId: string
  trackId: string
  /** 时间线起点（秒） */
  start: number
  /** 素材入点（秒） */
  inPoint: number
  /** 时间线时长（秒）；素材实际消耗 = duration * speed */
  duration: number
  /** 0.25 ~ 4 */
  speed: number
  /** 0 ~ 2 */
  volume: number
  muted: boolean
  fadeIn: number
  fadeOut: number
  /** 0 ~ 1（仅视频） */
  opacity: number
  /** 0 / 90 / 180 / 270 */
  rotation: number
  filter: EditClipFilter
  label?: string
  /** A/V 链接组 id：同组片段一起选中 / 移动 / 裁剪 / 删除 / 分割 */
  linkId?: string
  /** 文字 / 字幕片段（存在时忽略 mediaId，渲染为叠加层） */
  text?: EditTextStyle
  /** 进入本片段的转场（需要同轨前一个相邻片段） */
  transition?: EditTransition
  /** 关键帧动画：属性 -> 关键帧列表 */
  keyframes?: EditKeyframes
}

export type EditResolution = '720p' | '1080p' | '4k'

export interface EditProject {
  media: EditMedia[]
  tracks: EditTrack[]
  clips: EditClip[]
  /** 像素 / 秒 */
  zoom: number
  playhead: number
  /** 项目总时长（秒），不小于 30，便于拖放 */
  duration: number
  snap: boolean
  resolution: EditResolution
  fps: number
}

export const EDIT_RESOLUTIONS: Record<EditResolution, { width: number; height: number; label: string }> = {
  '720p': { width: 1280, height: 720, label: '720P' },
  '1080p': { width: 1920, height: 1080, label: '1080P' },
  '4k': { width: 3840, height: 2160, label: '4K' }
}

export function createDefaultFilter(): EditClipFilter {
  return { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, blur: 0 }
}

/** 默认文字样式（标题居中偏下）。 */
export function createDefaultTextStyle(content = '文字'): EditTextStyle {
  return {
    content,
    fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif',
    fontSize: 64,
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    x: 0.5,
    y: 0.82,
    background: false,
    backgroundColor: '#000000',
    stroke: true,
    strokeColor: '#000000',
    strokeWidth: 4,
    shadow: true
  }
}

let seq = 0
/** 生成稳定唯一 id（媒体 / 轨道 / 片段共用）。 */
export function editUid(prefix: string): string {
  seq = (seq + 1) % 100000
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function createDefaultEditProject(): EditProject {
  return {
    media: [],
    tracks: [
      { id: editUid('t'), name: '视频 1', kind: 'video', muted: false, hidden: false, locked: false },
      { id: editUid('t'), name: '音频 1', kind: 'audio', muted: false, hidden: false, locked: false }
    ],
    clips: [],
    zoom: 90,
    playhead: 0,
    duration: 30,
    snap: true,
    resolution: '1080p',
    fps: 30
  }
}

/** 轨道顺序：数组靠前的视频轨显示在更上层。 */
export function clipEnd(clip: Pick<EditClip, 'start' | 'duration'>): number {
  return clip.start + clip.duration
}

/** 片段在时间线上的实际结束时间（数组最大值）。 */
export function projectContentEnd(project: EditProject): number {
  return project.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0)
}

/* ===== IPC 契约（主进程 <-> 渲染进程） ===== */

export interface EditFileInfo {
  name: string
  path: string
  url: string
  /** 无法识别时为 '' */
  kind: EditMediaKind | ''
  ext: string
  size: number
}

export interface EditorImportResult {
  ok: boolean
  canceled?: boolean
  files: EditFileInfo[]
  error?: string
}

export interface EditorResolveArgs {
  paths: string[]
}

export interface EditorReadArgs {
  path: string
  maxBytes?: number
}

export interface EditorReadResult {
  ok: boolean
  data?: Uint8Array
  error?: string
}

export interface EditorWriteArgs {
  path: string
  data: Uint8Array
}

export interface EditorSaveArgs {
  /** 建议文件名（含扩展名） */
  name: string
  data: Uint8Array
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface EditorSaveResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/* ===== FFmpeg / 转码 / 导出 ===== */

export interface FfmpegStatus {
  available: boolean
  /** ffmpeg 可执行文件路径（未找到时为 ''） */
  ffmpeg: string
  /** ffprobe 可执行文件路径（可能为空，此时用 ffmpeg -i 兜底探测） */
  ffprobe: string
  /** 来源：bundled / settings / PATH / system / AURORA_FFMPEG_PATH */
  source: string
  /** 可用编码器名称（用于选择硬件/软件编码） */
  encoders: string[]
  error?: string
}

export interface EditorProbeResult {
  ok: boolean
  path: string
  duration: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  container: string
  videoCodec?: string
  audioCodec?: string
  /** Chromium 能否直接播放；false 表示需要转码代理 */
  playable: boolean
  error?: string
}

export interface EditorTranscodeArgs {
  path: string
  mediaId: string
  /** 代理最长边上限，默认 1920 */
  maxSize?: number
}

export interface EditorTranscodeResult {
  ok: boolean
  proxyPath?: string
  proxyUrl?: string
  duration?: number
  canceled?: boolean
  error?: string
}

export interface EditorThumbArgs {
  path: string
  /** 抽帧时间点（秒），默认 0 */
  at?: number
}

export interface EditorThumbResult {
  ok: boolean
  dataUrl?: string
  error?: string
}

export type ExportQuality = 'high' | 'medium' | 'fast'

export interface ExportTimelineArgs {
  project: EditProject
  /** 指定输出路径（自检用）；不传则弹保存框 */
  outputPath?: string
  width: number
  height: number
  fps: number
  quality?: ExportQuality
  /** 目标视频码率 kbps；>0 时优先生效 */
  videoBitrate?: number
  /** 文字 / 字幕：clipId -> 透明 PNG 文件路径（由渲染层生成） */
  textImages?: Record<string, string>
}

export interface EditorPickSubtitleResult {
  ok: boolean
  canceled?: boolean
  name?: string
  content?: string
  error?: string
}

/* ===== 自动保存 / 崩溃恢复 ===== */

export interface EditorRecoveryData {
  savedAt: number
  project: unknown
}

export interface EditorRecoverySaveArgs {
  id: string
  project: unknown
}

export interface EditorRecoverySaveResult {
  ok: boolean
  savedAt?: number
  error?: string
}

/** 获取一个位于用户数据目录下的临时文件路径（文字 PNG 等中间产物）。 */
export interface EditorTempFileArgs {
  name: string
}

export interface EditorTempFileResult {
  ok: boolean
  path?: string
  error?: string
}

export interface ExportTimelineResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface EditorProgressEvent {
  stage: 'probe' | 'transcode' | 'export' | 'done'
  /** 0 ~ 100 */
  percent: number
  message?: string
}

/** 以秒为单位格式化为 mm:ss.cc / hh:mm:ss.cc。 */
export function formatTime(sec: number): string {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.floor((s - Math.floor(s)) * 100)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const base = `${pad(m)}:${pad(ss)}.${pad(cs)}`
  return h > 0 ? `${pad(h)}:${base}` : base
}
