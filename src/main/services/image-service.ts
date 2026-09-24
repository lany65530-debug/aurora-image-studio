import { downloadBuffer, requestForm, requestJson, throwIfAborted, uploadToHost, waitFor } from '../common/http'
import { extractImages, getPath, joinUrl, parseJsonTemplate, ratioHint, renderTemplate } from '../common/utils'
import { resolvePixelSize, type ProviderGenerate } from '../config'
import type { ResolvedProvider } from './provider'

/** 生图引擎服务：把 provider 配置渲染成真实请求并执行，拦截响应与异步轮询，归一化为图片条目。 */

export type ImageEmit = (phase: string, data?: Record<string, unknown>) => void

export interface ImageVars {
  baseUrl?: string
  apiKey?: string
  model?: string
  prompt?: string
  n?: number
  size?: string
  sizePx?: string
  resolution?: string
  group?: string
  transparentBackground?: boolean
  images?: string[]
  imagesFirst?: string
  [key: string]: any
}

export interface CallResult {
  images: Array<{ type: 'url' | 'b64'; value: string }>
  raw?: string
  data?: any
}

/** 渲染 {{placeholder}} 表单字段。 */
export function renderForm(form: Record<string, string> | undefined | null, vars: ImageVars): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  Object.keys(form || {}).forEach((k) => {
    out[k] = renderTemplate((form as any)[k], vars)
  })
  return out
}

/** 构建一次图片 API 调用的 headers/body/form/path。 */
export function buildImageCall(provider: ResolvedProvider, cfg: ProviderGenerate, vars: ImageVars) {
  const headers = cfg.headers && typeof cfg.headers === 'string'
    ? parseJsonTemplate(cfg.headers, vars)
    : (cfg.headers || parseJsonTemplate(provider.headers, vars) || {})
  let body = null
  let form = cfg.form ? renderForm(cfg.form, vars) : null
  if (cfg.body) body = parseJsonTemplate(cfg.body, vars)
  if (vars.transparentBackground) {
    if (form) {
      form = { ...form, background: 'transparent', output_format: 'png' }
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      body.background = 'transparent'
      body.output_format = 'png'
    } else {
      throw new Error('当前接口没有可写入透明背景参数的请求体')
    }
  }
  return {
    headers,
    body,
    form,
    path: renderTemplate(cfg.path, vars),
    method: cfg.method || 'POST'
  }
}

export interface RunCallOpts {
  emit?: ImageEmit
  signal?: AbortSignal
}

export async function runImageCall(provider: ResolvedProvider, cfg: ProviderGenerate, vars: ImageVars, emit: ImageEmit | undefined, signal?: AbortSignal): Promise<CallResult> {
  const call = buildImageCall(provider, cfg, vars)
  const endpoint = joinUrl(provider.baseUrl, call.path)

  const authHeaders = Object.assign({}, call.headers || {})
  const onProgress = (p: { received: number; total: number }) => {
    if (emit) emit('receiving', p)
  }

  if (signal && signal.aborted) throw new Error('已取消生成')
  if (emit) emit('requesting')

  let resp: any
  if (call.form) {
    // multipart form payload (Stability / OpenAI edits style)
    // 若 vars.images 里是 data URL（edit + images:'file' 模式），直接作为文件上传，无需图床；
    // 远程 URL 则先下载为二进制再上传。
    const files: Array<{ field: string; filename: string; contentType: string; buffer: Buffer }> = []
    const imgList = Array.isArray(vars.images) ? vars.images : []
    for (let i = 0; i < imgList.length; i++) {
      throwIfAborted(signal)
      const im = String(imgList[i] || '')
      const m = /^data:(.*?);base64,(.*)$/.exec(im)
      if (m) {
        files.push({
          field: 'image',
          filename: `image_${i + 1}.png`,
          contentType: m[1] || 'image/png',
          buffer: Buffer.from(m[2], 'base64')
        })
      } else if (/^https?:\/\//i.test(im)) {
        const buf = await downloadBuffer(im, undefined, { signal })
        if (!buf.length) throw new Error('参考图下载为空')
        files.push({ field: 'image', filename: `image_${i + 1}.png`, contentType: 'image/png', buffer: buf })
      } else {
        throw new Error('参考图格式无效')
      }
    }
    resp = await requestForm(endpoint, authHeaders, call.form, files, onProgress, signal)
  } else {
    resp = await requestJson(endpoint, { method: call.method, headers: authHeaders, onProgress, signal }, call.body)
  }

  if (!resp.ok) {
    const msg =
      (resp.data && (resp.data.error?.message || resp.data.msg || resp.data.message)) ||
      (resp.raw && resp.raw.trim()) ||
      `请求失败 (HTTP ${resp.status})`
    throw new Error(msg)
  }

  const asyncCfg = cfg.async && cfg.async.enabled ? cfg.async : null
  if (!asyncCfg) {
    // sync response: extract images directly
    const images = extractImages(resp.data, resp, cfg as any)
    if (!images.length && resp.dataUrl) images.push({ type: 'b64', value: resp.dataUrl })
    return { images, raw: resp.raw, data: resp.data }
  }

  // ---- async pipeline: submit -> poll status -> collect results ----
  const sd = resp.data || {}
  // new-api / DragonAPI 的任务标识是字符串 task_id（如 "task_xxx"）。
  // 创建任务响应里的 "id" 可能是数据库自增主键（数字），不能用于 /v1/videos/{task_id} 查询。
  let taskId = getPath(sd, asyncCfg.taskIdPath || 'task_id')
  if (!taskId) {
    const viaPath = getPath(sd, 'task_id')
    if (typeof viaPath === 'string' && viaPath) taskId = viaPath
  }
  if (!taskId) {
    const d = (sd.data && typeof sd.data === 'object' && !Array.isArray(sd.data)) ? sd.data : null
    if (d) {
      taskId = d.task_id || d.taskId
        || (typeof d.id === 'string' && d.id ? d.id : null)
        || (Array.isArray(d['任务ids']) && d['任务ids'][0])
        || (Array.isArray(d.task_ids) && d.task_ids[0])
        || null
    }
  }
  if (typeof taskId === 'number') taskId = String(taskId)

  if (typeof taskId !== 'string' || !taskId.trim()) {
    const msg = (sd.msg || sd.message || (sd.error && sd.error.message)) || '未获取到任务 ID，接口返回异常。'
    throw new Error(msg)
  }

  const started = Date.now()
  const positiveMs = (value: unknown, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.min(Number(value), 2147483647) : fallback
  const timeoutMs = positiveMs(asyncCfg.timeoutMs, 480000)
  const intervalMs = positiveMs(asyncCfg.pollIntervalMs, 4000)
  if (!asyncCfg.statusPath) throw new Error('未配置任务状态查询地址')
  const statusPath = renderTemplate(asyncCfg.statusPath, { baseUrl: provider.baseUrl, apiKey: provider.apiKey, taskId: encodeURIComponent(taskId) })
  const statusUrl = new URL(joinUrl(provider.baseUrl, statusPath))
  if (asyncCfg.taskIdQuery) {
    statusUrl.searchParams.set(asyncCfg.taskIdQuery, taskId)
  }

  const doneStates = String(asyncCfg.doneStates || 'success').split(',').map((s) => s.trim()).filter(Boolean)
  const failStates = String(asyncCfg.failStates || 'failed').split(',').map((s) => s.trim()).filter(Boolean)

  if (emit) emit('processing', { percent: 0 })

  let result: CallResult | null = null
  while (Date.now() - started < timeoutMs) {
    await waitFor(Math.min(intervalMs, timeoutMs - (Date.now() - started)), signal)
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) break
    let st: any
    try {
      st = await requestJson(statusUrl.href, { method: 'GET', headers: { ...authHeaders }, signal, timeout: remaining }, null)
    } catch (e) {
      throwIfAborted(signal)
      continue
    }
    throwIfAborted(signal)
    if (!st.ok) {
      if (st.status === 429 || st.status >= 500) continue
      throw new Error(st.data?.error?.message || st.data?.message || `状态查询失败 (HTTP ${st.status})`)
    }
    const body = st.data && typeof st.data === 'object' ? st.data : null
    if (!body) continue
    const d = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : body
    // 优先读取顶层 status/state/progress，再回退到 data 子对象，避免状态字段被 data 包裹时读不到
    const state = String(getPath(body, asyncCfg.statePath || 'state') || getPath(d, asyncCfg.statePath || 'state') || '')
    const pctRaw = getPath(body, 'progress') ?? getPath(d, 'progress') ?? ''
    const percent = parseInt(String(pctRaw).replace('%', ''), 10)
    if (emit) emit('processing', { percent: isNaN(percent) ? null : percent, state })

    const isDone = (doneStates.length && doneStates.includes(state)) || (asyncCfg.doneFlagPath && (getPath(body, asyncCfg.doneFlagPath) ?? getPath(d, asyncCfg.doneFlagPath)) === true) || d.is_final === true
    if (isDone || (failStates.length && failStates.includes(state)) || state === 'failed') {
      if (failStates.includes(state) || state === 'failed') {
        throw new Error(d.error || d.message || '任务失败（已自动退款）。')
      }
      // collect result urls / base64
      const images: Array<{ type: 'url' | 'b64'; value: string }> = []
      const pushVal = (v: any) => {
        if (!v) return
        if (Array.isArray(v)) {
          v.forEach(pushVal)
          return
        }
        if (typeof v === 'string') {
          if (/^(https?:\/\/|\/|data:image\/)/i.test(v)) {
            images.push(/^data:image\//i.test(v) ? { type: 'b64', value: v } : { type: 'url', value: new URL(v, provider.baseUrl).href })
          }
          return
        }
        if (typeof v === 'object') {
          if (typeof v.b64_json === 'string' && v.b64_json) {
            images.push({ type: 'b64', value: v.b64_json })
            return
          }
          pushVal(v.url || v.image_url || v.image || v.result_url || v.data)
        }
      }
      // DragonAPI/异步媒体管线：查询接口只返回状态，结果通过 /content 接口读取二进制文件内容（文档指定的下载方式）。
      // 优先走 content 下载，失败时再回退到状态响应体里的 URL 字段。
      if (asyncCfg.contentPath) {
        const contentUrl = joinUrl(provider.baseUrl, renderTemplate(asyncCfg.contentPath, { baseUrl: provider.baseUrl, apiKey: provider.apiKey, taskId: encodeURIComponent(taskId) }))
        try {
          const remaining = timeoutMs - (Date.now() - started)
          if (remaining <= 0) throw new Error('任务超时')
          const cresp = await requestJson(contentUrl, { method: 'GET', headers: { ...authHeaders }, signal, timeout: remaining }, null)
          if (cresp && cresp.ok) {
            if (cresp.dataUrl) {
              images.push({ type: 'b64', value: cresp.dataUrl })
            } else {
              const cimgs = extractImages(cresp.data, cresp, cfg as any)
              images.push(...cimgs)
            }
          }
        } catch (e) {
          throwIfAborted(signal)
          // content 下载失败，继续回退到 URL 提取
        }
      }
      // 回退：从状态响应体解析图片 URL
      if (!images.length) {
        const rPath = asyncCfg.resultPath
        const rListPath = asyncCfg.resultListPath
        if (rListPath) {
          const list = getPath(body, rListPath) ?? getPath(d, rListPath)
          if (Array.isArray(list)) list.forEach(pushVal)
        }
        if (rPath) pushVal(getPath(body, rPath) ?? getPath(d, rPath))
        pushVal(d.result_url)
        if (Array.isArray(d.result_urls)) d.result_urls.forEach(pushVal)
        if (Array.isArray(d.results)) d.results.forEach((r: any) => pushVal(r && (r.url || r)))
      }
      if (!images.length) {
        const fallback = extractImages(d, st, cfg as any)
        images.push(...fallback)
      }
      if (!images.length) throw new Error('任务完成但未返回图片地址。')
      const unique = images.filter((image, index) => images.findIndex((other) => other.type === image.type && other.value === image.value) === index)
      result = { images: unique, raw: st.raw, data: d }
      break
    }
  }

  if (!result) throw new Error('任务超时，请稍后在中转站查看或重试。')
  return result
}

// Images API 下很多平台（gpt-image 系）不允许多张 n>1，或直接忽略 n 只返回 1 张。
// 为保证「生成 N 张」对 Images API 引擎同样稳定成立，这里按请求张数串行请求，
// 每次请求 n=1 逐张收敛结果，避免选 4 张却只出 1 张。
export async function runImagesByCount(provider: ResolvedProvider, cfg: ProviderGenerate, vars: ImageVars, emit: ImageEmit | undefined, signal: AbortSignal | undefined, count: number): Promise<Array<{ type: 'url' | 'b64'; value: string }>> {
  const reqVars: ImageVars = Object.assign({}, vars, { n: 1 })
  const all: Array<{ type: 'url' | 'b64'; value: string }> = []
  for (let i = 0; i < count; i++) {
    if (signal && signal.aborted) throw new Error('已取消生成')
    const batch = (await runImageCall(provider, cfg, reqVars, emit, signal)).images
    if (Array.isArray(batch) && batch.length) all.push(...batch)
  }
  return all.slice(0, count)
}

export interface ChatImageOpts {
  size?: string
  resolution?: string
  transparentBackground?: boolean
}

export async function runChatImageCall(provider: ResolvedProvider, model: string, prompt: string, refImages: string[], emit: ImageEmit | undefined, signal: AbortSignal | undefined, opts: ChatImageOpts): Promise<Array<{ type: 'url' | 'b64'; value: string }>> {
  if (emit) emit('requesting')
  opts = opts || {}
  const refs = (Array.isArray(refImages) ? refImages.slice(0, 14) : [])
    .map((r) => String(r || ''))
    .filter(Boolean)

  const sizePx = resolvePixelSize(opts.size, opts.resolution || '2k')
  const hint = ratioHint(opts.size || '')

  // 参考图以 image_url 直传（dataUrl 或远程 URL 均可）。
  // 不再先传第三方图床：图床链接常有防盗链/过期/地域限制，模型后端拉不到图
  // 时会静默忽略参考图，导致“图生图没有任何效果”。
  // dataUrl 直传与 AI 对话界面上传图片是同一条已验证可用的链路。
  const buildMessages = (urls: string[]) => {
    const text = (prompt || '') + (hint ? '\n\n' + hint : '')
    if (!urls.length) {
      return [{ role: 'user', content: [{ type: 'text', text }] }]
    }
    if (urls.length === 1) {
      // 单图：与提示词同一条消息
      return [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: urls[0] } }] }]
    }
    // 多图：拆成逐图独立的 user 消息（每张图一行引导文本 + 该图）,
    // 最后再追加带提示词的消息。部分 Gemini 系中转在"同一条消息混排多图"时
    // 会静默丢弃全部参考图（表现为多张上传后图生图完全失效）；
    // 拆成独立消息后每张图都能作为独立上下文被识别。
    const msgs = urls.map((u, i) => ({
      role: 'user',
      content: [
        { type: 'text', text: `参考图 ${i + 1}（共 ${urls.length} 张，请以上图为准）` },
        { type: 'image_url', image_url: { url: u } }
      ]
    }))
    msgs.push({ role: 'user', content: [{ type: 'text', text }] })
    return msgs
  }
  const endpoint = joinUrl(provider.baseUrl, '/v1/chat/completions')
  // 比例参数（size/image_config）并非所有平台都接受——严格的 OpenAI 兼容实现
  // 会对未知参数返回 400（Unrecognized request argument）。因此先带参请求，
  // 若被拒绝则去掉这两个参数用最小请求体重试一次（提示词中的比例描述仍兜底）。
  const doRequest = (messages: any[], withSizeParams: boolean) => {
    const body: any = { model, messages }
    if (opts.transparentBackground) {
      body.background = 'transparent'
      body.output_format = 'png'
    }
    if (withSizeParams) {
      body.size = sizePx // 部分中转站识别 top-level size
      body.image_config = { size: sizePx } // Gemini 原生风格参数
    }
    return requestJson(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      signal
    }, body)
  }
  const isParamRejected = (r: any) => {
    if (r.ok) return false
    const t = String(
      (r.data && (r.data.error?.message || r.data.msg || r.data.message)) || r.raw || ''
    )
    // 必须同时出现“参数名”与“拒绝词”才判定为参数被拒，避免普通错误触发无谓重试
    const hasParam = /\bsize\b|image_config|参数/i.test(t)
    const hasReject = /unrecognized|unknown|unexpected|invalid|unsupported|not\s*suggest|not\s*support|extra|不允许|不支持|未知|无效|无法识别|多余/i.test(t)
    return hasParam && hasReject
  }

  let resp = await doRequest(buildMessages(refs), true)
  if (isParamRejected(resp)) {
    resp = await doRequest(buildMessages(refs), false)
  }

  // 直传被拒（如体积过大）→ 尝试把 dataUrl 转图床 URL 再发一次
  if (!resp.ok && provider.allowPublicUpload === true && refs.some((u) => /^data:/i.test(u))) {
    const hosted: string[] = []
    for (let i = 0; i < refs.length; i++) {
      let u = refs[i]
      if (/^data:/i.test(u)) {
        if (emit) emit('uploading', { index: i + 1, count: refs.length })
        // 参考图以 dataUrl 直传被拒时，转第三方图床再发。
        u = await uploadToHost(u, `ref_${i + 1}.png`, provider.refHosts, { allowPublicUpload: provider.allowPublicUpload, signal })
      }
      hosted.push(u)
    }
    resp = await doRequest(buildMessages(hosted), true)
    if (isParamRejected(resp)) {
      resp = await doRequest(buildMessages(hosted), false)
    }
  }

  if (!resp.ok) {
    const msg =
      (resp.data && (resp.data.error?.message || resp.data.msg || resp.data.message)) ||
      (resp.raw && resp.raw.trim()) ||
      `请求失败 (HTTP ${resp.status})`
    throw new Error(msg)
  }

  const raw = getPath(resp.data, 'choices.0.message.content')
  const urls: string[] = []
  let text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw)) {
    raw.forEach((p: any) => {
      if (p && typeof p.text === 'string') text += p.text + '\n'
      if (p && p.type === 'image_url' && p.image_url && p.image_url.url) urls.push(p.image_url.url)
    })
  }
  // markdown 图片 ![...](url)
  const mdRe = /!\[[^\]]*\]\(\s*(data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^)\s]+)\s*\)/g
  let m: RegExpExecArray | null
  while ((m = mdRe.exec(text))) urls.push(m[1])
  // 裸链接 / data URL 兜底
  if (!urls.length) {
    const bareRe = /(data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]{100,}|https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?)/gi
    while ((m = bareRe.exec(text))) urls.push(m[0])
  }
  if (!urls.length) {
    // 把模型的文字回复带进错误信息，方便排查（例如模型回复“我无法生成图片”）
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(snippet ? `接口未返回图片数据。模型回复：${snippet}` : '接口未返回图片数据。')
  }
  return urls.map((u) => (/^data:/i.test(u) ? { type: 'b64', value: u } : { type: 'url', value: u }))
}

// runChatImageCall 不接收 n；聊天接口模型（nano-banana / gemini 系）单次只稳定输出 1 张。
// 这里按请求张数 n 串行调用，收集全部结果，保证图片工作区「生成 N 张」对 chat-image 引擎同样生效。
export async function runChatImages(provider: ResolvedProvider, model: string, prompt: string, refImages: string[], emit: ImageEmit | undefined, signal: AbortSignal | undefined, opts: ChatImageOpts, n: number): Promise<Array<{ type: 'url' | 'b64'; value: string }>> {
  const count = Math.max(1, parseInt(String(n), 10) || 1)
  const all: Array<{ type: 'url' | 'b64'; value: string }> = []
  for (let i = 0; i < count; i++) {
    if (signal && signal.aborted) throw new Error('已取消生成')
    const batch = await runChatImageCall(provider, model, prompt, refImages, emit, signal, opts)
    if (Array.isArray(batch)) all.push(...batch)
  }
  return all
}
