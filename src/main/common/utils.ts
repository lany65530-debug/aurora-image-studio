import fs from 'fs'

/** 生成进度 / 阶段的回调类型（原 main.js emit）。 */
export type EmitFn = (phase: string, data?: Record<string, unknown>) => void

/** 确保目录存在（递归创建），失败返回 false。 */
export function ensureDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (e) {
    console.error('ensureDir failed', e)
    return false
  }
}

/** 清理文件名中的非法字符，限制长度 40，空则回退 'aurora'。 */
export function sanitizeName(s: unknown): string {
  const out = String(s || 'aurora').replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 40).trim()
  return out || 'aurora'
}

/** 深拷贝（JSON 序列化，undefined 会丢失——仅用于纯数据对象）。 */
export function deepClone<T>(obj: T): T {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj))
}

/** 拼接 base URL 与 endpoint，去除多余斜杠。 */
export function joinUrl(base: string, endpoint: string): string {
  const b = (base || '').replace(/\/+$/, '')
  const e = endpoint.replace(/^\/+/, '')
  return `${b}/${e}`
}

/** 延时。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 点路径取值：支持 "data"、"data.0.url"、"data.*.url"、"a.b.c"。 */
export function getPath(obj: unknown, path: string): any {
  if (obj == null) return undefined
  if (path == null || path === '') return undefined
  const parts = String(path).split('.')
  const walk = (cur: any, i: number): any => {
    if (cur == null) return undefined
    const p = parts[i]
    if (p === undefined) return cur
    if (Array.isArray(cur)) {
      if (p === '*') {
        const arr = cur.map((x) => walk(x, i + 1)).filter((v) => v !== undefined)
        return arr.flat(Infinity)
      }
      const idx = parseInt(p, 10)
      if (Number.isInteger(idx) && idx >= 0) return walk(cur[idx], i + 1)
      return undefined
    }
    if (typeof cur === 'object') return walk((cur as Record<string, any>)[p], i + 1)
    return undefined
  }
  return walk(obj, 0)
}

/**
 * 渲染 {{placeholder}} 模板。
 * 修饰符：:json（字符串字面量转义）、:jsonraw（对象/数组原样）、:imageobj（[{image_url}] 数组）。
 */
export function renderTemplate(tpl: unknown, vars: Record<string, any>): string {
  if (tpl == null) return ''
  return String(tpl).replace(/\{\{\s*([\w]+)\s*(:\s*([\w]+))?\s*\}\}/g, (_m: string, key: string, _sep: string, modifier?: string) => {
    let v = vars[key]
    if (v === undefined || v === null) v = ''
    if (modifier === 'json') return JSON.stringify(String(v))
    if (modifier === 'jsonraw') return typeof v === 'string' ? v : JSON.stringify(v)
    if (modifier === 'imageobj') {
      const arr = Array.isArray(v) ? v : v ? [v] : []
      return JSON.stringify(arr.map((u: unknown) => ({ image_url: String(u) })))
    }
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  })
}

/** 解析 JSON 字符串模板为对象/数组（用于 headers 与 body）。 */
export function parseJsonTemplate(str: unknown, vars: Record<string, any>): any {
  if (str == null || str === '') return null
  const rendered = renderTemplate(str, vars)
  try {
    return JSON.parse(rendered)
  } catch (e) {
    throw new Error('请求体/请求头模板不是合法 JSON：' + rendered)
  }
}

/** 归一化任意响应为图片数组 [{ type: 'url'|'b64', value }]。 */
export function extractImages(respData: any, resp: any, cfg: any): Array<{ type: 'url' | 'b64'; value: string }> {
  if (!cfg) return []
  if (cfg.binary && resp && resp.dataUrl) {
    return [{ type: 'b64', value: resp.dataUrl }]
  }
  if (!respData) return []
  if (typeof respData === 'string' && /^data:image\//.test(respData)) {
    return [{ type: 'b64', value: respData }]
  }
  if (typeof respData === 'string') {
    return [{ type: 'url', value: respData }]
  }
  if (Array.isArray(respData)) return extractFromList(respData, cfg)
  if (cfg.urlField && respData[cfg.urlField]) return [{ type: 'url', value: respData[cfg.urlField] }]
  if (cfg.b64Field && respData[cfg.b64Field]) return [{ type: 'b64', value: 'data:image/png;base64,' + respData[cfg.b64Field] }]

  let list = getPath(respData, cfg.imagesPath || 'data')
  if (list == null && Array.isArray(respData.data)) list = respData.data
  if (Array.isArray(list)) return extractFromList(list, cfg)

  if (list && typeof list === 'object') {
    const sub = extractImages(list, resp, { ...cfg, imagesPath: null })
    if (sub.length) return sub
    for (const k of ['images', 'urls', 'result_images', 'output', 'result']) {
      if (Array.isArray(list[k])) {
        const sub2 = extractFromList(list[k], cfg)
        if (sub2.length) return sub2
      }
    }
    if (typeof list.url === 'string') return [{ type: 'url', value: list.url }]
    if (typeof list.image === 'string') return [{ type: /^data:/.test(list.image) ? 'b64' : 'url', value: list.image }]
  }
  return []
}

/** 从图片列表数组提取 { type, value }。 */
export function extractFromList(list: unknown[], cfg: any): Array<{ type: 'url' | 'b64'; value: string }> {
  const out: Array<{ type: 'url' | 'b64'; value: string }> = []
  list.forEach((it: any) => {
    if (typeof it === 'string') {
      if (/^data:image\//.test(it)) out.push({ type: 'b64', value: it })
      else if (it.trim()) out.push({ type: 'url', value: it })
      return
    }
    if (!it || typeof it !== 'object') return
    let hit: { type: 'url' | 'b64'; value: string } | null = null
    if (cfg.urlField && getPath(it, cfg.urlField)) hit = { type: 'url', value: getPath(it, cfg.urlField) }
    else if (cfg.b64Field && getPath(it, cfg.b64Field)) {
      const b = getPath(it, cfg.b64Field)
      hit = { type: 'b64', value: /^data:/.test(b) ? b : 'data:image/png;base64,' + b }
    } else if (it.url) hit = { type: 'url', value: it.url }
    else if (it.b64_json) hit = { type: 'b64', value: 'data:image/png;base64,' + it.b64_json }
    else if (it.image_url) hit = { type: 'url', value: it.image_url }
    else if (it.image) hit = { type: /^data:/.test(it.image) ? 'b64' : 'url', value: it.image }
    if (hit) out.push(hit)
  })
  return out
}

/** 比例字符串 -> 中文/英文画面方向提示（追加到提示词兜底比例）。 */
export function ratioHint(ratio: string): string {
  const s = String(ratio || '').trim()
  if (!s || !/^\d+[:x]\d+$/.test(s)) return ''
  const [w, h] = s.split(/[:x]/).map(Number)
  const ori = w === h ? '正方形' : w > h ? '横版 landscape' : '竖版 portrait'
  return `[画面比例 ${w}:${h} ${ori}]`
}

/** 判断模型 id 是否为图像生成/编辑模型。 */
export function isImageModel(id: unknown): boolean {
  const s = String(id).toLowerCase()
  const positive = [
    'image', 'gpt-image', 'dall-e', 'dalle', 'flux', 'midjourney', 'mj_', 'mj-', 'stable-diffusion',
    'stable_diffusion', 'sdxl', 'sd3', 'sd-3', 'ideogram', 'recraft', 'kolors', 'wanx', 'wanxiang', '万相', '文生图',
    '即梦', 'seedream', 'seededit', 'nano-banana', 'banana', 'doubao-seedream', 'hunyuan-image', 'cogview',
    'playground-v', 'pixart', 'lumina', 'jimeng', 'irag', 'qwen-image', 'grok-2-image', 'grok-image'
  ]
  const negative = [
    'video', 'sora', 'veo', 'kling', '可灵', 'runway', 'luma', 'vidu', 'pika', 'hailuo', 'seedance', '快乐马',
    'wan-video', '文生视频', '图生视频', 'mv', '漫剧',
    'tts', 'whisper', 'audio', 'speech', 'voice', 'suno', 'music', '音乐', '语音', 'realtime',
    'embedding', 'embed', 'rerank', 'moderation',
    'chat', 'gpt-3', 'gpt-4', 'gpt-5', 'gpt-oss', 'o1', 'o3', 'o4', 'claude', 'opus', 'sonnet', 'haiku',
    'gemini', 'deepseek', 'kimi', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3', 'qwen2', 'qwen-long',
    'glm', 'grok-4', 'grok-3', 'grok-beta', 'grok-code', 'grok-build', 'mimo', 'minimax-m', 'step-', 'step3',
    'doubao-seed-', 'doubao-pro', 'doubao-lite', 'ernie', 'spark', 'moonshot', 'yi-', 'baichuan', 'llama',
    'mistral', 'gemma', 'command', 'fable', 'omni-flash', 'omni flash'
  ]
  const hasPositive = positive.some((k) => s.includes(k))
  const hasNegative = negative.some((k) => s.includes(k))
  if (hasPositive && !hasNegative) return true
  if (hasPositive && hasNegative) {
    if (/(^|[-_ ])image($|[-_ ])|gpt-image|qwen-image|hunyuan-image|grok-2-image|cogview/.test(s)) return true
    return false
  }
  return false
}