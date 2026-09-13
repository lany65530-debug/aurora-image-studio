/**
 * 渲染层 · 接口 provider 装配
 * ------------------------------------------------------------
 * 根据接口地址自动识别供应商类型，并把工作区配置组装成可下发给
 * 主进程的 provider（按次覆盖默认接口）。无需用户手动选择接口类型。
 */
import { loadPresets } from './aurora'
import type { Workspace } from './store'

/** 根据接口地址自动判断接口类型。 */
export function detectPreset(baseUrl: string): string {
  const u = String(baseUrl || '').toLowerCase()
  if (u.includes('openai.com')) return 'openai'
  if (u.includes('dragon3api')) return 'dragon3api'
  if (u.includes('lingwu')) return 'lingwu'
  if (u.includes('stability')) return 'stability'
  return 'openai_compat'
}

/** 由工作区配置构造 provider（用于按次覆盖主进程的默认接口）。 */
export async function wsProvider(ws: Workspace): Promise<Record<string, any>> {
  let p: Record<string, any> = {}
  if (ws.provider && typeof ws.provider === 'object' && (ws.provider as Record<string, any>).preset) {
    p = JSON.parse(JSON.stringify(ws.provider))
  } else {
    p = { preset: detectPreset(ws.baseUrl) }
  }
  if (ws.baseUrl && ws.baseUrl.trim()) p.baseUrl = ws.baseUrl.trim()
  if (!p.baseUrl) {
    const presets = await loadPresets()
    if (presets && presets[p.preset]) p.baseUrl = presets[p.preset].baseUrl || ''
  }
  p.apiKey = (ws.apiKey || '').trim()
  return p
}