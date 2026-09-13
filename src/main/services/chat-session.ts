import fs from 'fs'
import type { AppSettings } from '../config/defaults'
import { chatSessionsFile } from '../config/paths'

/** 聊天会话持久化服务：JSON 列表读写（文件名与旧版一致，沿用既有用户数据）。 */

export interface ChatSession {
  id: string
  [key: string]: unknown
}

export function loadChatSessions(): ChatSession[] {
  try {
    const p = chatSessionsFile()
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf-8'))
      return Array.isArray(arr) ? (arr as ChatSession[]) : []
    }
  } catch (e) {
    console.error('load chat sessions failed', e)
  }
  return []
}

export function saveChatSessions(list: ChatSession[]): boolean {
  try {
    fs.writeFileSync(chatSessionsFile(), JSON.stringify(list, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('save chat sessions failed', e)
    return false
  }
}

/** 从全局设置中提取 AI 对话专用配置（独立于生图接口）。 */
export interface ChatConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  contextRounds: number
  fontSize: number
}

export function getChatConfig(settings: AppSettings): ChatConfig {
  const c = (settings && settings.chat) || {}
  return {
    baseUrl: String(c.baseUrl || '').trim(),
    apiKey: String(c.apiKey || '').trim(),
    model: String(c.model || '').trim(),
    temperature: typeof c.temperature === 'number' ? c.temperature : 0.7,
    contextRounds: typeof c.contextRounds === 'number' && Number.isInteger(c.contextRounds) && c.contextRounds > 0 ? c.contextRounds : 20,
    fontSize: typeof c.fontSize === 'number' && c.fontSize >= 12 && c.fontSize <= 22 ? c.fontSize : 14
  }
}