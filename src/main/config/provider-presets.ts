/* ================= Provider 平台预设与像素尺寸（config 层，纯数据+解析函数）================= */

/**
 * 比例 + 分辨率档位 -> 像素尺寸。
 * /v1/images/generations 与 /v1/images/edits 要求 size 为 WIDTHxHEIGHT 格式，
 * 而 UI 传的是比例字符串（如 16:9）+ 分辨率档位（1k/2k/4k）。
 * 尺寸表使用数学上精确的比例值（变体模型会原样透传请求尺寸），
 * 4k 档需满足平台总像素上限 8,294,400（宽x高 ≤ 上限）。
 */
export const SIZE_PIXELS: Record<string, Record<string, string>> = {
  '1:1':  { '1k': '1024x1024', '2k': '2048x2048', '4k': '2880x2880' },
  '3:2':  { '1k': '1536x1024', '2k': '2040x1360', '4k': '3510x2340' },
  '2:3':  { '1k': '1024x1536', '2k': '1360x2040', '4k': '2340x3510' },
  '4:3':  { '1k': '1024x768',  '2k': '2048x1536', '4k': '3320x2490' },
  '3:4':  { '1k': '768x1024',  '2k': '1536x2048', '4k': '2490x3320' },
  '5:4':  { '1k': '1280x1024', '2k': '2560x2048', '4k': '3215x2572' },
  '4:5':  { '1k': '1024x1280', '2k': '2048x2560', '4k': '2572x3215' },
  '16:9': { '1k': '1536x864',  '2k': '2048x1152', '4k': '3840x2160' },
  '9:16': { '1k': '864x1536',  '2k': '1152x2048', '4k': '2160x3840' },
  '2:1':  { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
  '1:2':  { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' },
  '21:9': { '1k': '2016x864',  '2k': '2688x1152', '4k': '3780x1620' },
  '9:21': { '1k': '864x2016',  '2k': '1152x2688', '4k': '1620x3780' }
}

/**
 * 将「比例 + 分辨率」解析为像素尺寸字符串。
 * 已传入像素尺寸（形如 1920x1080）时原样返回。
 */
export function resolvePixelSize(size: unknown, resolution: unknown): string {
  const s = String(size || '').trim()
  if (/^\d+x\d+$/.test(s)) return s
  const row = Object.hasOwn(SIZE_PIXELS, s) ? SIZE_PIXELS[s] : undefined
  const res = String(resolution || '1k')
  if (row) return Object.hasOwn(row, res) ? row[res] : row['1k']
  return '1024x1024'
}

/* ---- 接口引擎类型 ---- */

export interface ProviderAsyncConfig {
  enabled: boolean
  taskIdPath?: string
  statusPath?: string
  taskIdQuery?: string
  statePath?: string
  doneStates?: string
  failStates?: string
  resultPath?: string
  resultListPath?: string
  pollIntervalMs?: number
  timeoutMs?: number
  doneFlagPath?: string
  contentPath?: string
}

export interface ProviderGenerate {
  method: 'GET' | 'POST'
  path: string
  headers?: string | null
  body?: string | null
  images?: string
  form?: Record<string, string> | null
  imagesPath?: string | null
  urlField?: string
  b64Field?: string
  binary?: boolean
  async?: ProviderAsyncConfig
}

export interface ProviderModels {
  method: string
  path: string
  listPath?: string
  idField?: string
  ownerField?: string
  headers?: string
}

export interface ProviderGroups {
  method: string
  path: string
  groupsPath?: string
  groupNamePath?: string
  modelGroupsPath?: string
  modelGroupIdField?: string
  modelGroupListField?: string
}

export interface ProviderPreset {
  allowPublicUpload?: boolean
  name: string
  baseUrl: string
  headers: string
  models: ProviderModels | null
  groups: ProviderGroups | null
  generate: ProviderGenerate
  edit: ProviderGenerate | null
}

/**
 * 完全由用户定义的接口引擎预设。所有请求的 URL / 方法 / 请求头 / 请求体
 * / 响应解析路径 / 异步轮询规则均由用户控制，不做任何限制。
 *
 * 模板占位符（在 path / headers / body 中可用）：
 *   {{baseUrl}} {{apiKey}} {{model}} {{prompt}} {{n}} {{size}} {{resolution}} {{group}}
 *   {{images}} {{imagesFirst}} {{sizePx}}
 * 修饰符：
 *   {{prompt:json}}       值作为 JSON 字符串字面量（自动转义引号/换行）-> "my prompt"
 *   {{images:jsonraw}}    值作为 JSON 对象/数组原样输出（如 ["url1","url2"]）
 *   {{images:imageobj}}   值作为 [{image_url:"url1"},...] 对象数组输出（新版 /v1/images/edits 规范）
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com',
    headers: '{"Authorization":"Bearer {{apiKey}}"}',
    models: { method: 'GET', path: '/v1/models', listPath: 'data', idField: 'id', ownerField: 'owned_by' },
    groups: null,
    generate: {
      method: 'POST',
      path: '/v1/images/generations',
      body: '{"model":{{model:json}},"prompt":{{prompt:json}},"n":{{n}},"size":{{sizePx:json}}}',
      imagesPath: 'data',
      urlField: 'url',
      b64Field: 'b64_json',
      binary: false,
      async: { enabled: false }
    },
    edit: {
      method: 'POST',
      path: '/v1/images/edits',
      images: 'file',
      form: { model: '{{model}}', prompt: '{{prompt}}', n: '{{n}}', size: '{{sizePx}}' },
      imagesPath: 'data',
      urlField: 'url',
      b64Field: 'b64_json',
      binary: false,
      async: { enabled: false }
    }
  },
  openai_compat: {
    name: 'OpenAI 兼容 / 中转站 (new-api 等)',
    baseUrl: 'https://your-relay.example.com',
    headers: '{"Authorization":"Bearer {{apiKey}}"}',
    models: { method: 'GET', path: '/v1/models', listPath: 'data', idField: 'id', ownerField: 'owned_by' },
    groups: {
      method: 'GET',
      path: '/api/pricing',
      groupsPath: 'data.group_ratio',
      groupNamePath: 'data.usable_group',
      modelGroupsPath: 'data.data',
      modelGroupIdField: 'model_name',
      modelGroupListField: 'enable_groups'
    },
    generate: {
      method: 'POST',
      path: '/v1/images/generations',
      body: '{"model":{{model:json}},"prompt":{{prompt:json}},"n":{{n}},"size":{{sizePx:json}}}',
      imagesPath: 'data',
      urlField: 'url',
      b64Field: 'b64_json',
      binary: false,
      async: { enabled: false }
    },
    edit: {
      method: 'POST',
      path: '/v1/images/edits',
      images: 'file',
      form: { model: '{{model}}', prompt: '{{prompt}}', n: '{{n}}', size: '{{sizePx}}' },
      imagesPath: 'data',
      urlField: 'url',
      b64Field: 'b64_json',
      binary: false,
      async: { enabled: false }
    }
  },
  custom: {
    name: '完全自定义',
    baseUrl: 'https://your-api.example.com',
    headers: '{"Authorization":"Bearer {{apiKey}}"}',
    models: { method: 'GET', path: '/v1/models', listPath: 'data', idField: 'id', ownerField: 'owned_by' },
    groups: null,
    generate: {
      method: 'POST',
      path: '/v1/images/generations',
      body: '{"model":{{model:json}},"prompt":{{prompt:json}},"n":{{n}},"size":{{sizePx:json}}}',
      imagesPath: 'data',
      urlField: 'url',
      b64Field: 'b64_json',
      binary: false,
      async: { enabled: false }
    },
    edit: {
      method: 'POST',
      path: '/v1/images/edits',
      images: 'url',
      body: '{"model":{{model:json}},"prompt":{{prompt:json}},"n":{{n}},"size":{{sizePx:json}},"images":{{images:imageobj}}}',
      imagesPath: 'data',
      urlField: 'url',
      b64Field: 'b64_json',
      binary: false,
      async: { enabled: false }
    }
  }
}

// deep-merge preset into user provider config so partial overrides always work
export function mergeProvider<T extends Record<string, any> = Record<string, any>>(preset: T, user?: unknown): T {
  const out: Record<string, any> = {}
  const copy = (target: Record<string, any>, source: unknown): void => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return
    Object.keys((source as Record<string, any>) || {}).forEach((k) => {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') return
      const v = (source as Record<string, any>)[k]
      if (v === undefined) return
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {}
        copy(target[k], v)
      } else {
        target[k] = Array.isArray(v) ? cloneArray(v) : v
      }
    })
  }
  const cloneArray = (items: any[]): any[] => items.map((item) => Array.isArray(item)
    ? cloneArray(item)
    : item && typeof item === 'object' ? mergeProvider({}, item) : item)
  copy(out, preset)
  copy(out, (user as Record<string, any>) || {})
  return out as T
}

// resolve preset id: 'auto' -> guess by base URL; unknown -> openai_compat
export function resolvePresetId(stored: unknown, override: unknown, baseUrl: unknown): string {
  const p = (override as any)?.preset || (stored as any)?.preset || 'auto'
  let id = p
  if (id === 'auto') {
    const u = String(baseUrl || '').toLowerCase()
    id = u.includes('api.openai.com') ? 'openai' : 'openai_compat'
  }
  if (typeof id !== 'string' || !Object.hasOwn(PROVIDER_PRESETS, id)) id = 'openai_compat'
  return id
}
