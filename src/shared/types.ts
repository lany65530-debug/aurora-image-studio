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