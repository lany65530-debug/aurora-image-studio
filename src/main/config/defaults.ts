import { defaultSaveDir } from './paths'

/** 全局设置的基础默认值。接口地址一律默认留空，由用户自行填写。 */
export interface ChatSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
  contextRounds?: number
  fontSize?: number
  [key: string]: unknown
}

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  saveDir: string
  provider: unknown | null
  chat: ChatSettings
  /** 剪辑工作区使用的 ffmpeg 路径（留空则自动查找） */
  ffmpegPath?: string
}

/** 构造一份全量默认设置（每次返回新对象，避免共享引用相互污染）。 */
export function defaultSettings(): AppSettings {
  return {
    apiKey: '',
    baseUrl: '',
    model: 'gpt-image-2',
    saveDir: defaultSaveDir(),
    provider: null,
    chat: {}
  }
}

/** 应用级常量。 */
export const APP_NAME = 'Aurora Image Studio'
export const MODEL_DEFAULT = 'gpt-image-2'