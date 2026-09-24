/** 全局共享类型：主进程、preload、渲染层共同消费的数据契约。 */

/** 主进程应用版本信息。 */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: NodeJS.Platform
}

/** GPU / 硬件加速运行状态（用于设置页与性能自检）。 */
export interface GpuStatus {
  /** 当前进程是否启用了硬件加速。 */
  hardwareAcceleration: boolean
  /** Chromium 各 GPU 特性的状态，例如 gpu_compositing: 'enabled'。 */
  featureStatus: Record<string, string>
  /** 启动时是否成功注入了强制启用 GPU 的开关。 */
  forcedFlags: string[]
}

/* ===== 自动更新（GitHub Releases） ===== */

/** 自动更新状态机的阶段。 */
export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** 自动更新状态快照：主进程推送给渲染层，渲染层也可主动查询。 */
export interface UpdaterStatus {
  state: UpdaterState
  /** 当前安装的版本号。 */
  currentVersion: string
  /** 检测到 / 正在下载 / 已下载完成的版本号。 */
  version?: string
  /** 新版本更新说明（纯文本）。 */
  notes?: string
  /** 发布时刻（ISO 字符串）。 */
  releaseDate?: string
  /** 下载进度 0 ~ 100。 */
  percent?: number
  /** 下载速度（字节/秒）。 */
  bytesPerSecond?: number
  /** 已下载字节数。 */
  transferred?: number
  /** 安装包总字节数。 */
  total?: number
  /** 失败原因（已转成中文提示）。 */
  error?: string
  /** 本次是否为用户手动触发的检查。 */
  manual?: boolean
}

/* ===== 界面设置（主题 / 字号 / 密度 / 动效） ===== */

/**
 * 六套主题，每套是一套独立的视觉语言。
 *  - aurora   极简光感：白底、中性灰阶、柔和投影、圆润系统字
 *  - nocturne 夜幕放映：深蓝黑幕、暖金焦点、收敛的影院式层次
 *  - botanical 植物画室：暖白画纸、深松绿、编辑式排版
 */
export const UI_THEMES = ['aurora', 'nocturne', 'botanical', 'frosted', 'ios', 'comic'] as const
export type UiTheme = (typeof UI_THEMES)[number]

/** 主题的展示元信息（设置界面用）。 */
export interface ThemeMeta {
  id: UiTheme
  /** 主题名（中文） */
  name: string
  /** 设计语言一句话说明 */
  desc: string
  /** 预览用的代表色，依次为：底色 / 表面 / 主色 / 强调色 */
  swatch: [string, string, string, string]
}

/** 界面字号档位。 */
export const UI_FONT_SCALES = ['sm', 'md', 'lg', 'xl'] as const
export type UiFontScale = (typeof UI_FONT_SCALES)[number]

/** 界面密度。 */
export const UI_DENSITIES = ['compact', 'cozy', 'roomy'] as const
export type UiDensity = (typeof UI_DENSITIES)[number]

/** 用户可调的界面设置。 */
export interface UiSettings {
  theme: UiTheme
  fontScale: UiFontScale
  density: UiDensity
  /** 关闭后停用大部分过渡/动画（对低性能机器或无动画偏好者友好） */
  reduceMotion: boolean
  /** 启动后是否自动检查更新 */
  autoCheckUpdate: boolean
}

/** 主题元信息表（设置界面渲染 / 排序依据）。 */
export const THEME_META: ThemeMeta[] = [
  {
    id: 'aurora',
    name: '极简光感',
    desc: '白底留白 · 柔和投影 · 中性无衬线，最耐看的一版',
    swatch: ['#ffffff', '#f4f4f4', '#0d0d0d', '#0a7d43']
  },
  {
    id: 'nocturne',
    name: '夜幕放映',
    desc: '深蓝黑幕 · 暖金焦点 · 收敛的影院式层次',
    swatch: ['#10151c', '#1d2731', '#e1b977', '#91a9b6']
  },
  {
    id: 'botanical',
    name: '植物画室',
    desc: '暖白画纸 · 深松绿 · 轻盈的编辑式排版',
    swatch: ['#f4f2e9', '#fffef9', '#29564b', '#cc885f']
  },
  {
    id: 'frosted',
    name: '雾光玻璃',
    desc: '冰蓝渐变 · 半透明叠层 · 柔焦折射',
    swatch: ['#dce9f3', '#eaf4fa', '#345e92', '#c1a5d8']
  },
  {
    id: 'ios',
    name: 'iOS 灵动',
    desc: '分组面板 · 系统蓝 · 精致圆润控件',
    swatch: ['#f2f2f7', '#ffffff', '#007aff', '#d1d1d6']
  },
  {
    id: 'comic',
    name: '漫画卡片',
    desc: '奶油底色 · 粗线框 · 活泼错位卡片',
    swatch: ['#fff4d8', '#fffdf6', '#ec6047', '#496bdb']
  }
]

/** 界面设置默认值。 */
export function defaultUiSettings(): UiSettings {
  return {
    theme: 'aurora',
    fontScale: 'md',
    density: 'cozy',
    reduceMotion: false,
    autoCheckUpdate: true
  }
}

/**
 * 把任意输入归一成合法 UiSettings（主进程落盘与渲染层读缓存共用同一份规则，
 * 保证「手改配置文件 / 旧版本数据 / 脏缓存」都不会把界面搞坏）。
 */
export function normalizeUiSettings(raw: unknown): UiSettings {
  const d = defaultUiSettings()
  if (!raw || typeof raw !== 'object') return d
  const s = raw as Partial<UiSettings>
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fb
  const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb)
  return {
    theme: pick<UiTheme>(s.theme, UI_THEMES, d.theme),
    fontScale: pick<UiFontScale>(s.fontScale, UI_FONT_SCALES, d.fontScale),
    density: pick<UiDensity>(s.density, UI_DENSITIES, d.density),
    reduceMotion: bool(s.reduceMotion, d.reduceMotion),
    autoCheckUpdate: bool(s.autoCheckUpdate, d.autoCheckUpdate)
  }
}

/** 字号档位 → 根字号（px）。 */
export const FONT_SCALE_PX: Record<UiFontScale, string> = {
  sm: '13.5px',
  md: '14.5px',
  lg: '15.5px',
  xl: '17px'
}

/** 密度档位 → 间距缩放系数。 */
export const DENSITY_SCALE: Record<UiDensity, string> = {
  compact: '0.86',
  cozy: '1',
  roomy: '1.14'
}

/** 图片保存/编辑相关的组合尺寸比例。 */
export const IMAGE_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21'] as const
export type ImageRatio = (typeof IMAGE_RATIOS)[number]

/** 分辨率档位。 */
export const IMAGE_RESOLUTIONS = ['1k', '2k', '4k'] as const
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]

/* ===== 图片库 ===== */

/** 图片库条目（结构与旧版 library.json 保持一致，字段均为可选以兼容历史数据）。 */
export interface LibraryItem {
  id: string
  prompt?: unknown
  model?: unknown
  size?: unknown
  resolution?: string
  mode?: string
  wsId?: string
  filePath?: string
  fileUrl?: string
  remoteUrl?: string
  ts?: number
  [key: string]: unknown
}

export interface DeleteLibraryArgs {
  id?: string
  deleteFile?: boolean
}

/** 请求某张本地图片的缩略图（网格卡片用，避免解码 2K/4K 原图）。 */
export interface LibraryThumbArgs {
  path: string
  /** 缩略图最长边，默认 360。 */
  size?: number
}

export interface LibraryThumbResult {
  ok: boolean
  /** data:image/jpeg;base64,...，仅在 ok=true 时存在。 */
  dataUrl?: string
  error?: string
}

/* ===== 图片生成 ===== */

/** 单张原始图片（URL 或 base64）。 */
export interface RawImageInput {
  type?: 'url' | 'b64'
  value: string
}

/** 已持久化入库的图片结果（主进程返回）。 */
export interface SavedImage {
  id: string
  prompt?: unknown
  model?: unknown
  size?: unknown
  resolution?: string
  mode?: string
  wsId?: string
  filePath: string
  fileUrl: string
  remoteUrl?: string
  ts?: number
  [key: string]: unknown
}

/** 图片生成请求参数。 */
export interface GenerateImageParams {
  jobId?: string
  provider?: Record<string, any> | null
  baseUrl?: string
  apiKey?: string
  engine?: string
  mode?: string
  wsId?: string
  model?: string
  prompt?: string
  n?: number
  size?: string
  resolution?: string
  transparentBackground?: boolean
  group?: string
  saveDir?: string
}

/** 图片编辑请求参数（在原 generate 基础上增加参考图）。 */
export interface EditImageParams extends GenerateImageParams {
  images?: Array<{ url?: string; dataUrl?: string; name?: string }>
}

/** 模型/渠道条目。 */
export interface ModelItem {
  id: string
  owned_by?: string
  image?: boolean
}

/** 分组条目（new-api /api/pricing）。 */
export interface GroupItem {
  id: string
  name: string
  ratio: unknown
}

export interface GroupsResult {
  ok: boolean
  error?: string
  groups?: GroupItem[]
  modelGroups?: Record<string, string[]>
  raw?: Record<string, any>
}

/* ===== 聊天 ===== */

/** 聊天会话（持久化对象，字段可变）。 */
export interface ChatSession {
  id: string
  [key: string]: unknown
}

/** 聊天消息（发送给接口的历史消息）。 */
export interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
  [key: string]: unknown
}

/** 聊天配置覆盖参数。 */
export interface ChatConfigOverride {
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
  contextRounds?: number
  /** 单次回复的最大 token 数（不传则由中转接口决定，可能很小导致长 JSON 输出被截断） */
  maxTokens?: number
}

export interface ChatSendParams {
  cfg?: ChatConfigOverride
  sessionId?: string
  systemPrompt?: string
  messages?: ChatMessage[]
  tools?: { draw?: boolean; search?: boolean }
  deepThink?: boolean
  thinkLevel?: string
  model?: string
  /** 覆盖单次回复的 max_tokens（检测 / 改写这类需要长 JSON 输出的场景） */
  maxTokens?: number
}

/** 工具调用增量结果。 */
export interface ChatToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** 聊天发送结果。 */
export type ChatResult =
  | {
      ok: true
      content: string
      reasoning?: string
      toolCalls?: ChatToolCall[]
      toolUnsupported?: boolean
      model?: string
      /** 结束原因：length 表示被 max_tokens 截断 */
      finishReason?: string
    }
  | { ok: true; aborted: true; content: string; reasoning?: string }
  | { ok: false; error: string }

export interface ChatSearchArgs {
  query?: string
}

export interface AttachmentSaveArgs {
  kind?: string
  name?: string
  data?: string
}

export interface AttachmentReadArgs {
  path?: string
}

export interface SessionDeleteArgs {
  id?: string
}

export interface ChatModelsParams {
  baseUrl?: string
  apiKey?: string
}

/* ===== 设置 ===== */

/** 全局设置。 */
export interface AppSettings {
  apiKey?: string
  baseUrl?: string
  model?: string
  saveDir?: string
  provider?: Record<string, any> | null
  chat?: Record<string, any>
  /** 剪辑工作区使用的 ffmpeg 可执行文件路径（留空则自动查找） */
  ffmpegPath?: string
  [key: string]: unknown
}

/* ===== Provider 接口测试 ===== */

export interface ProviderTestParams {
  provider?: Record<string, any> | null
  baseUrl?: string
  apiKey?: string
  [key: string]: any
}

/* ===== 目录 / 打开 ===== */

export interface ChooseDirResult {
  ok: boolean
  canceled?: boolean
  dir?: string
}

/* ===== 主进程推送到渲染层的事件负载 ===== */

export interface ImageProgressEvent {
  jobId: string
  phase: string
  [key: string]: unknown
}

export interface ChatChunkEvent {
  sessionId: string
  delta: string
}

export type ChatReasoningEvent = ChatChunkEvent