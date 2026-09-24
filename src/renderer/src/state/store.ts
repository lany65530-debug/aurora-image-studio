/**
 * 渲染层 · 全局状态库（store）
 * ------------------------------------------------------------
 * 负责工作区的数据模型、构建工厂与 localStorage 持久化，
 * 以及运行时全局状态（presets / gallery）与每工作区瞬态（不持久化）。
 * 视图层只通过 import 本模块单例读写状态，不直接持有 DOM 状态源。
 */
import type { ImageRatio, ImageResolution } from './aurora'
import type { NovelChapterData, NovelFileData } from '../../../shared/novel'
import { createDefaultEditProject, type EditProject } from '../../../shared/editor'

/** localStorage 存储键（沿用 v1，保证跨版本数据兼容）。 */
export const WS_STORE_KEY = 'aurora_workspaces_v1'

/** 图片工作区（GPT Images API / Banana 聊天接口）。 */
export interface ImageWorkspace {
  id: string
  type: 'image'
  name: string
  icon: string | null
  /** 侧边栏专属配色在 WS_PALETTE 中的索引（缺失时按 id 散列兜底）。 */
  color?: number | null
  engine: 'gpt' | 'banana' // gpt = Images API；banana = 聊天接口引擎
  baseUrl: string
  apiKey: string
  model: string
  saveDir: string
  channels: any[]
  provider: Record<string, any> | null
  showAllModels: boolean
  size: string
  count: number
  resolution: string
  transparentBackground?: boolean
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

/** 聊天工作区。 */
export interface ChatWorkspace {
  id: string
  type: 'chat'
  name: string
  icon: string | null
  /** 侧边栏专属配色在 WS_PALETTE 中的索引（缺失时按 id 散列兜底）。 */
  color?: number | null
  baseUrl: string
  apiKey: string
  model: string
  chat: {
    temperature: number
    contextRounds: number
    fontSize: number
    systemPrompt: string
    drawModel: string
    drawWsId?: string
  }
  drawEnabled: boolean
  searchEnabled: boolean
  deepThink: boolean
  thinkLevel: string
  novelMode?: boolean
  lastSessionId: string
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export type NovelChapter = NovelChapterData
export interface NovelWorkspace {
  id: string
  type: 'novel'
  name: string
  icon: string | null
  /** 侧边栏专属配色在 WS_PALETTE 中的索引（缺失时按 id 散列兜底）。 */
  color?: number | null
  novels: NovelFileData[]
  activeNovelId: string
  ai: { baseUrl: string; apiKey: string; model: string; temperature: number; systemPrompt: string }
  reader: {
    fontSize: number
    lineSpacing: number
    theme: 'day' | 'green' | 'night'
    mode: 'scroll' | 'pagination'
    /** 正文字体：default / song / kai / hei */
    fontFamily?: string
    /** 回车换段时自动补全角缩进（中文小说惯例） */
    autoIndent?: boolean
  }
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

/** 剪辑工作区（视频 / 音频多轨编辑）。 */
export interface EditWorkspace {
  id: string
  type: 'edit'
  name: string
  icon: string | null
  /** 侧边栏专属配色在 WS_PALETTE 中的索引（缺失时按 id 散列兜底）。 */
  color?: number | null
  project: EditProject
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export type Workspace = ImageWorkspace | ChatWorkspace | NovelWorkspace | EditWorkspace

/** 每工作区瞬态：参考图、进行中任务、进度卡片（切换工作区再切回时重新附着）。 */
export interface WsTransient {
  refImages: any[]
  jobs: any[]
  progressCards: any[]
}

/** 持久化数据结构。 */
interface StoredState {
  v: number
  workspaces: Workspace[]
  activeId: string
}

/* ===== 持久化 store ===== */
export const store: {
  workspaces: Workspace[]
  activeId: string
  view: 'workspace' | 'gallery'
} = { workspaces: [], activeId: '', view: 'workspace' }

/** 运行时全局状态（非持久化）。 */
export const state: { presets: Record<string, any> | null; gallery: any[] } = {
  presets: null,
  gallery: []
}

/** 每工作区瞬态表（不持久化）。 */
export const transient = new Map<string, WsTransient>()

/** 获取某工作区的瞬态对象，为空则创建。 */
export function wsTransient(ws: Workspace): WsTransient {
  if (!transient.has(ws.id)) transient.set(ws.id, { refImages: [], jobs: [], progressCards: [] })
  return transient.get(ws.id) as WsTransient
}

/** 按 id 查找工作区。 */
export function findWs(id: string): Workspace | null {
  return store.workspaces.find((w) => w.id === id) || null
}

/** 当前激活的工作区（视图非 gallery 时）。 */
export function activeWorkspace(): Workspace | null {
  return findWs(store.activeId)
}

/** 当前激活的图片工作区（仅当视图在工作区且为 image 类型）。 */
export function activeImageWs(): ImageWorkspace | null {
  const w = activeWorkspace()
  return store.view === 'workspace' && w && w.type === 'image' ? (w as ImageWorkspace) : null
}

/** 当前激活的聊天工作区。 */
export function activeChatWs(): ChatWorkspace | null {
  const w = activeWorkspace()
  return store.view === 'workspace' && w && w.type === 'chat' ? (w as ChatWorkspace) : null
}

/* ===== 持久化（防抖写 localStorage） ===== */
let wsPersistTimer: ReturnType<typeof setTimeout> | null = null
export function persistWorkspaces(): void {
  if (wsPersistTimer) clearTimeout(wsPersistTimer)
  wsPersistTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        WS_STORE_KEY,
        JSON.stringify({ v: 1, workspaces: store.workspaces, activeId: store.activeId } satisfies StoredState)
      )
    } catch (e) {
      console.warn('工作区持久化失败', e)
    }
  }, 250)
}

/** 从 localStorage 读取持久化数据（供初始化时调用）。 */
export function readStoredState(): StoredState | null {
  try {
    const raw = localStorage.getItem(WS_STORE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as StoredState
    if (!data || !Array.isArray(data.workspaces)) return null
    return data
  } catch {
    return null
  }
}

/* ===== 工作区工厂 ===== */
export function newWsId(): string {
  return 'ws-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export function makeImageWorkspace(name?: string, icon?: string | null, extra?: Partial<ImageWorkspace>): ImageWorkspace {
  const ws: ImageWorkspace = {
    id: newWsId(),
    type: 'image',
    name: name || '新图片工作区',
    icon: icon || null,
    color: null,
    engine: 'gpt',
    baseUrl: '',
    apiKey: '',
    model: '',
    saveDir: '',
    channels: [],
    provider: null,
    showAllModels: false,
    size: '1:1',
    count: 1,
    resolution: '2k',
    transparentBackground: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  return Object.assign(ws, extra || {})
}

export function makeChatWorkspace(name?: string, icon?: string | null, chat?: Partial<ChatWorkspace['chat']> & { baseUrl?: string; apiKey?: string; model?: string; thinkLevel?: string }): ChatWorkspace {
  chat = chat || {}
  return {
    id: newWsId(),
    type: 'chat',
    name: name || '新聊天工作区',
    icon: icon || null,
    color: null,
    baseUrl: chat.baseUrl || '',
    apiKey: chat.apiKey || '',
    model: chat.model || '',
    chat: {
      temperature: typeof chat.temperature === 'number' ? chat.temperature : 0.7,
      contextRounds: Number.isInteger(chat.contextRounds) && (chat.contextRounds as number) > 0 ? (chat.contextRounds as number) : 20,
      fontSize: typeof chat.fontSize === 'number' && chat.fontSize >= 12 && chat.fontSize <= 22 ? chat.fontSize : 14,
      systemPrompt: chat.systemPrompt || '',
      drawModel: chat.drawModel || ''
    },
    drawEnabled: true,
    searchEnabled: false,
    deepThink: false,
    thinkLevel: chat.thinkLevel || 'off',
    novelMode: false,
    lastSessionId: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export function makeEditWorkspace(name = '剪辑工作区', icon: string | null = null, extra?: Partial<EditWorkspace>): EditWorkspace {
  const now = Date.now()
  return Object.assign({
    id: newWsId(),
    type: 'edit' as const,
    name,
    icon,
    color: null,
    project: createDefaultEditProject(),
    createdAt: now,
    updatedAt: now
  }, extra || {})
}

export function makeNovelWorkspace(name = '小说工作区', icon: string | null = null, extra?: Partial<NovelWorkspace>): NovelWorkspace {
  const now = Date.now()
  return Object.assign({
    id: newWsId(), type: 'novel' as const, name, icon, color: null, novels: [], activeNovelId: '',
    reader: {
      fontSize: 25,
      lineSpacing: 1.9,
      theme: 'day' as const,
      mode: 'pagination' as const,
      fontFamily: 'default',
      autoIndent: true
    },
    ai: { baseUrl: '', apiKey: '', model: '', temperature: 0.8, systemPrompt: '你是一位专业的中文小说作家。请保持人物、世界观和叙事风格的一致性。' },
    createdAt: now, updatedAt: now
  }, extra || {})
}

/* ===== 通用辅助 ===== */
export const $ = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement
export const $$ = <T extends Element = Element>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel))

export function escapeHtml(s: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c)
}

/** 客户端模型识别兜底（不依赖主进程）。 */
export function isImageModelClient(id: string): boolean {
  const s = String(id).toLowerCase()
  const positive = ['image','gpt-image','dall-e','dalle','flux','midjourney','mj_','mj-','stable-diffusion','sdxl','sd3','sd-3','ideogram','recraft','kolors','wanx','wanxiang','万相','文生图','即梦','seedream','seededit','nano-banana','banana','doubao-seedream','hunyuan-image','cogview','playground-v','pixart','lumina','jimeng','irag','qwen-image','grok-2-image','grok-image']
  const negative = ['video','sora','veo','kling','可灵','runway','luma','vidu','pika','hailuo','seedance','快乐马','文生视频','图生视频','漫剧','tts','whisper','audio','speech','voice','suno','music','音乐','语音','realtime','embedding','embed','rerank','moderation','chat','gpt-3','gpt-4','gpt-5','gpt-oss','o1','o3','o4','claude','opus','sonnet','haiku','gemini','deepseek','kimi','qwen-max','qwen-plus','qwen-turbo','qwen3','qwen2','qwen-long','glm','grok-4','grok-3','grok-beta','grok-code','grok-build','mimo','minimax-m','step-','step3','doubao-seed-','doubao-pro','doubao-lite','ernie','spark','moonshot','yi-','baichuan','llama','mistral','gemma','command','fable','omni-flash']
  const hasP = positive.some((k) => s.includes(k))
  const hasN = negative.some((k) => s.includes(k))
  if (hasP && !hasN) return true
  if (hasP && hasN) return /(^|[-_ ])image($|[-_ ])|gpt-image|qwen-image|hunyuan-image|grok-2-image|cogview/.test(s)
  return false
}

export function isImageChannel(m: { image?: boolean; id: string }): boolean {
  return typeof m.image === 'boolean' ? m.image : isImageModelClient(m.id)
}

export type { ImageRatio, ImageResolution }
