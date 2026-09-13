import { PROVIDER_PRESETS, mergeProvider, resolvePresetId, type ProviderPreset } from '../config/provider-presets'
import type { AppSettings } from '../config/defaults'

/** Provider 服务：把「设置 + 请求参数」解析为生效的接口配置（预设 deep-merge 用户覆盖）。 */

export interface ResolveProviderParams {
  provider?: Record<string, any> | null
  baseUrl?: string
  apiKey?: string
  [key: string]: any
}

export type ResolvedProvider = ProviderPreset & {
  id?: string
  preset?: string
  apiKey: string
  baseUrl: string
  refHosts?: any[]
  [key: string]: any
}

export function resolveProvider(settings: AppSettings, params?: ResolveProviderParams): ResolvedProvider {
  const stored: Record<string, any> = (settings && settings.provider as any) || {}
  const override = (params && params.provider) || null
  const baseUrl = params?.baseUrl ?? override?.baseUrl ?? stored.baseUrl ?? ''
  const presetId = resolvePresetId(stored, override, baseUrl)
  const preset = PROVIDER_PRESETS[presetId as string] || PROVIDER_PRESETS.openai_compat
  let provider = mergeProvider<ResolvedProvider>(preset as any, stored)
  if (override) provider = mergeProvider<ResolvedProvider>(provider, override)
  // allow per-request override of baseUrl / apiKey / model (priority: params > stored > preset)
  if (params?.baseUrl !== undefined) provider.baseUrl = params.baseUrl
  if (params?.apiKey !== undefined) provider.apiKey = params.apiKey
  if (!provider.baseUrl) provider.baseUrl = preset.baseUrl || ''
  provider.baseUrl = String(provider.baseUrl || '').trim().replace(/\/+$/, '')
  provider.apiKey = String(provider.apiKey || '').trim()
  provider.allowPublicUpload = provider.allowPublicUpload === true
  return provider
}
