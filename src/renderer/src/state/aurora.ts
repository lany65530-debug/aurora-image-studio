/**
 * 渲染层 · API 适配映射层
 * ------------------------------------------------------------
 * 将旧版（v1）扁平化命名（window.aurora.chatListSessions / stopImage / listPresets ...）
 * 统一收敛到 v2 分组 API 面（window.aurora.chat.sessionsList / image.stop / provider.presets ...），
 * 全部类型化、单点收口，供各业务模块引用。业务代码不直接触碰预加载对象。
 */
import type {
  AttachmentReadArgs,
  AttachmentSaveArgs,
  ChatMessage,
  ChatModelsParams,
  ChatSearchArgs,
  ChatSendParams,
  ChatSession,
  DeleteLibraryArgs,
  EditImageParams,
  GenerateImageParams,
  ImageRatio,
  ImageResolution,
  ProviderTestParams
} from '../../../shared/types'

export type { Unsubscribe } from '../../../shared/aurora-api'

/** 预加载暴露的原始 API 面（渲染层唯一持有 window.aurora 的地方）。 */
const raw = window.aurora

/* ===== 应用/窗口 ===== */
export const app = raw.app
export const win = raw.window

/* ===== 自动更新（GitHub Releases） ===== */
export const updater = raw.updater

/* ===== 界面设置（主题 / 字号 / 密度 / 动效） ===== */
export const ui = raw.ui

/* ===== 全局设置 ===== */
export const settings = raw.settings

/* ===== 接口预设（内置地址兜底） ===== */
let _presetsCache: Record<string, any> | null = null
export async function loadPresets(): Promise<Record<string, any>> {
  if (_presetsCache) return _presetsCache
  try {
    const res = await raw.provider.presets()
    _presetsCache = res?.ok ? (res.presets || {}) : {}
  } catch {
    _presetsCache = {}
  }
  return _presetsCache
}

/* ===== 图片 ===== */
export const img = {
  /** 生成图片。 */
  generate: (p: GenerateImageParams) => raw.image.generate(p),
  /** 图生图编辑。 */
  edit: (p: EditImageParams) => raw.image.edit(p),
  /** 停止某任务。 */
  stop: (jobId: string) => raw.image.stop(jobId),
  /** 拉取模型列表。 */
  modelsList: (p: GenerateImageParams) => raw.image.modelsList(p),
  /** 拉取分组（new-api /api/pricing）。 */
  groupsList: (p: GenerateImageParams) => raw.image.groupsList(p),
  /** 生成进度事件。 */
  onProgress: raw.image.onProgress
}

/* ===== 聊天 ===== */
export const chat = {
  send: (p: ChatSendParams) => raw.chat.send(p),
  stop: (sessionId: string) => raw.chat.stop(sessionId),
  search: (a: ChatSearchArgs) => raw.chat.search(a),
  attachmentSave: (a: AttachmentSaveArgs) => raw.chat.attachmentSave(a),
  attachmentReadText: (a: AttachmentReadArgs) => raw.chat.attachmentReadText(a),
  attachmentReadImage: (a: AttachmentReadArgs) => raw.chat.attachmentReadImage(a),
  sessionsList: () => raw.chat.sessionsList(),
  sessionsSave: (s: ChatSession) => raw.chat.sessionsSave(s),
  sessionsDelete: (id: string) => raw.chat.sessionsDelete({ id }),
  modelsList: (p: ChatModelsParams) => raw.chat.modelsList(p),
  export: (a: { name?: string; content: string }) => raw.chat.export(a),
  onChunk: raw.chat.onChunk,
  onReasoning: raw.chat.onReasoning
}

/* ===== 图片库 ===== */
export const library = {
  get: () => raw.library.get(),
  delete: (a: DeleteLibraryArgs) => raw.library.delete(a),
  clear: () => raw.library.clear(),
  /** 取网格卡片缩略图（主进程生成并缓存），避免解码原图卡顿。 */
  thumb: (a: { path: string; size?: number }) => raw.library.thumb(a)
}

/* ===== 剪辑工作区（媒体导入 / 读取 / 导出） ===== */
export const editor = raw.editor

/* ===== AI 率检测（独立窗口） ===== */
export const detector = raw.detector

/* ===== 目录选择 / 打开 ===== */
export const dir = raw.dir
export const shell = raw.shell

/* ===== 接口测试（provider 汇总测试） ===== */
export const provider = {
  test: (p: ProviderTestParams) => raw.provider.test(p)
}

/* ===== 导出常用比值/分辨率常量，供工具栏回填使用 ===== */
export const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21'] as const
export type { ImageRatio, ImageResolution }

export type { ChatMessage }