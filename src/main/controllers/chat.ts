import { app, dialog, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC } from '../../shared/ipc'
import { loadSettings } from '../services/settings'
import { getChatConfig, loadChatSessions, saveChatSessions, type ChatConfig } from '../services/chat-session'
import { searchWeb } from '../services/web-search'
import { getPath } from '../common/utils'
import { requestJson } from '../common/http'
import { notify, getMainWindow } from '../window-store'

// 每个会话独立的中止控制器（会话 id -> AbortController）
const chatAbortMap = new Map<string, AbortController>()

const CHAT_DRAW_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: '调用 AI 绘图模型生成一张图片并直接展示给用户。当用户明确想要图片/插画/绘画，或文字描述视觉场景并希望配图时调用。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '绘画提示词。若用户用中文描述，转写为细节丰富的英文提示词以获得最佳效果。'
        },
        size: {
          type: 'string',
          enum: ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21'],
          description: '图片比例，默认 1:1。'
        }
      },
      required: ['prompt']
    }
  }
}

const CHAT_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '联网搜索最新信息。当用户询问实时新闻、价格、天气、近期事件、最新版本等你的训练数据可能过时或不覆盖的内容时调用。用与用户提问相同的语言进行搜索。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（与用户提问同语言，可适当精简以提升搜索质量）。'
        }
      },
      required: ['query']
    }
  }
}

interface ChatSendParams {
  cfg?: Partial<ChatConfig> & { maxTokens?: number }
  sessionId?: string
  systemPrompt?: string
  messages?: any[]
  tools?: { draw?: boolean; search?: boolean }
  deepThink?: boolean
  thinkLevel?: string
  model?: string
  maxTokens?: number
}

/**
 * 拼接聊天接口地址。
 * 用户常见的填写方式有 `https://host` 和 `https://host/v1`，
 * 两者都应最终指向同一个 `/v1/...` 端点，避免出现 `/v1/v1/...`。
 */
function chatUrl(baseUrl: string, endpoint: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const path = endpoint.replace(/^\/+/, '')
  if (/\/v1$/i.test(base) && /^v1\//i.test(path)) {
    return `${base}/${path.slice(3)}`
  }
  return `${base}/${path}`
}

export function registerChatIpc(): void {
  ipcMain.handle(IPC.Chat.sessionsList, () => loadChatSessions())

  ipcMain.handle(IPC.Chat.sessionsSave, (_e, session) => {
    if (!session || !session.id) return { ok: false, error: '无效的会话数据。' }
    const list = loadChatSessions()
    const idx = list.findIndex((s) => s.id === session.id)
    if (idx >= 0) list[idx] = session
    else list.unshift(session)
    saveChatSessions(list)
    return { ok: true }
  })

  ipcMain.handle(IPC.Chat.sessionsDelete, (_e, args: { id?: string }) => {
    const list = loadChatSessions().filter((s) => s.id !== args?.id)
    saveChatSessions(list)
    const c = chatAbortMap.get(args?.id as string)
    if (c) c.abort()
    return { ok: true }
  })

  // 拉取对话接口下可用的聊天模型（过滤掉图片/音频等非聊天模型）
  ipcMain.handle(IPC.Chat.modelsList, async (_e, params) => {
    const settings = loadSettings()
    const cfg = getChatConfig(settings)
    if (params && typeof params === 'object') {
      if ((params as any).baseUrl) cfg.baseUrl = String((params as any).baseUrl).trim()
      if ((params as any).apiKey) cfg.apiKey = String((params as any).apiKey).trim()
    }
    if (!cfg.baseUrl) return { ok: false, error: '请先填写 AI 对话接口地址。' }
    if (!cfg.apiKey) return { ok: false, error: '请先填写 AI 对话 API 密钥。' }

    const endpoint = chatUrl(cfg.baseUrl, '/v1/models')
    try {
      const resp = await requestJson(
        endpoint,
        { method: 'GET', headers: { Authorization: `Bearer ${cfg.apiKey}` } },
        null
      )
      if (!resp.ok) {
        const msg = (resp.data && (resp.data.error?.message || resp.data.message)) || `获取模型失败 (HTTP ${resp.status})`
        return { ok: false, error: msg }
      }
      const raw = resp.data ? getPath(resp.data, 'data') : null
      const models = (Array.isArray(raw) ? raw : [])
        .map((m: any) => (typeof m === 'string' ? m : (m && m.id) || ''))
        .filter(Boolean)
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })

  ipcMain.handle(IPC.Chat.send, async (_e, params: ChatSendParams) => {
    const settings = loadSettings()
    const cfg = getChatConfig(settings)
    if (params && params.cfg && typeof params.cfg === 'object') {
      if (params.cfg.baseUrl) cfg.baseUrl = String(params.cfg.baseUrl).trim()
      if (params.cfg.apiKey) cfg.apiKey = String(params.cfg.apiKey).trim()
      if (typeof params.cfg.temperature === 'number') cfg.temperature = params.cfg.temperature
      const round = params.cfg.contextRounds
      if (typeof round === 'number' && Number.isInteger(round) && round > 0) cfg.contextRounds = round
      if (typeof params.cfg.model === 'string' && params.cfg.model.trim()) cfg.model = params.cfg.model.trim()
    }
    // 聊天工作区可独立配置模型，优先取请求 cfg.model，其次顶层 model 字段；合并进 cfg 统一校验
    const modelFromParams = String(params.model || '').trim()
    if (modelFromParams && !cfg.model) cfg.model = modelFromParams
    if (!cfg.baseUrl) return { ok: false, error: '未配置 AI 对话接口地址，请到「设置」中填写。' }
    if (!cfg.apiKey) return { ok: false, error: '未配置 AI 对话 API 密钥，请到「设置」中填写。' }
    if (!cfg.model) return { ok: false, error: '未选择对话模型，请到「设置」中选择。' }

    const sessionId = params.sessionId || ''
    const systemPrompt = String(params.systemPrompt || '').trim()
    const history = Array.isArray(params.messages) ? params.messages : []
    const toolFlags = params.tools || {}
    const deepThink = !!params.deepThink
    const thinkLevel = String(params.thinkLevel || (deepThink ? 'medium' : 'off')).toLowerCase()
    const modelOverride = String(params.model || '').trim()

    // 组装消息：system + 最近 N 轮上下文
    const messages: any[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    for (const m of history.slice(-cfg.contextRounds)) {
      const msg: any = { role: m.role }
      if (m.content !== undefined && m.content !== null) msg.content = m.content
      if (m.tool_calls) msg.tool_calls = m.tool_calls
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
      if (m.name) msg.name = m.name
      messages.push(msg)
    }

    const controller = new AbortController()
    chatAbortMap.set(sessionId, controller)

    const useModel = modelOverride || cfg.model
    const useTools = !!(toolFlags.draw || toolFlags.search)

    let full = ''
    let reasoning = ''
    let finishReason = ''
    const toolAcc = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()
    let toolUnsupported = false

    const emitChunk = (delta: string) => {
      full += delta
      notify(IPC.Events.chatChunk, { sessionId, delta })
    }
    const emitReasoning = (delta: string) => {
      reasoning += delta
      notify(IPC.Events.chatReasoning, { sessionId, delta })
    }

    const wantMaxTokens = Number(params.maxTokens ?? params.cfg?.maxTokens ?? 0) > 0

    /** plain=true 时只发最基础的参数（用于中转接口不支持高级参数时的降级重试）。 */
    const doFetch = (withTools: boolean, plain = false) => {
      const body: any = {
        model: useModel,
        messages,
        stream: true
      }
      // 长 JSON 输出（检测 / 改写）必须显式给 max_tokens，否则中转接口的默认值可能很小导致截断
      const maxTokens = Number(params.maxTokens ?? params.cfg?.maxTokens ?? 0)
      if (!plain && Number.isFinite(maxTokens) && maxTokens > 0) {
        body.max_tokens = Math.max(256, Math.min(32000, Math.round(maxTokens)))
      }
      const isClaude = /claude/i.test(useModel)
      const isOpenaiO = /(^|[^a-z0-9])o[1-9]($|[^a-z0-9])/i.test(useModel)
      const isGPT5 = /gpt-5/i.test(useModel)
      const isGLM = /glm-4\.[5-9]|glm-5/i.test(useModel)
      const isThinkingSwitch = isClaude || isGLM || /deepseek-v[0-9]/i.test(useModel)
      if (plain) {
        body.temperature = cfg.temperature
      } else if (isThinkingSwitch) {
        body.thinking = deepThink ? { type: 'enabled', budget_tokens: 4000 } : { type: 'disabled' }
        body.temperature = cfg.temperature
      } else if (isOpenaiO || isGPT5 || /grok/i.test(useModel)) {
        const level = ['low', 'medium', 'high'].includes(thinkLevel) ? thinkLevel : 'medium'
        body.reasoning_effort = deepThink && level !== 'off' ? level : 'low'
      } else {
        body.temperature = cfg.temperature
      }
      if (withTools) {
        const tools = []
        if (toolFlags.draw) tools.push(CHAT_DRAW_TOOL)
        if (toolFlags.search) tools.push(CHAT_SEARCH_TOOL)
        body.tools = tools
        body.tool_choice = 'auto'
      }
      return fetch(chatUrl(cfg.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    }

    try {
      let resp = await doFetch(useTools)

      // 工具 / 高级参数 / max_tokens 不被支持时自动降级重试一次
      if (!resp.ok && (useTools || deepThink || wantMaxTokens)) {
        const text = await resp.text().catch(() => '')
        if (/tool|function|函数|reasoning|thinking|temperature|max.?tokens|max_completion/i.test(text)) {
          toolUnsupported = true
          resp = await doFetch(false, true)
        }
        if (!resp.ok && !toolUnsupported) {
          let msg = text.slice(0, 500)
          try {
            const j = JSON.parse(text)
            msg = (j.error && j.error.message) || msg
          } catch (e) {
            /* 非 JSON 错误体 */
          }
          return { ok: false, error: `HTTP ${resp.status}：${msg}` }
        }
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        let msg = text.slice(0, 500)
        try {
          const j = JSON.parse(text)
          msg = (j.error && j.error.message) || msg
        } catch (e) {
          /* 非 JSON 错误体 */
        }
        return { ok: false, error: `HTTP ${resp.status}：${msg}` }
      }

      // 解析 SSE 流（content / reasoning_content / tool_calls 三种 delta）
      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const data = t.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const j = JSON.parse(data)
            const choice = j.choices && j.choices[0]
            if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
              finishReason = choice.finish_reason
            }
            const delta = choice && choice.delta
            if (!delta) continue
            if (delta.content) emitChunk(delta.content)
            const rdelta = delta.reasoning_content !== undefined ? delta.reasoning_content : delta.reasoning
            if (typeof rdelta === 'string' && rdelta) emitReasoning(rdelta)
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0
                if (!toolAcc.has(idx)) {
                  toolAcc.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } })
                }
                const acc = toolAcc.get(idx)!
                if (tc.id) acc.id = tc.id
                if (tc.function) {
                  if (tc.function.name) acc.function.name += tc.function.name
                  if (tc.function.arguments) acc.function.arguments += tc.function.arguments
                }
              }
            }
          } catch (e) {
            /* 忽略无法解析的行 */
          }
        }
      }

      const toolCalls = [...toolAcc.values()].filter((tc) => tc.function.name)
      return {
        ok: true,
        content: full,
        reasoning: reasoning || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        toolUnsupported,
        model: useModel,
        finishReason: finishReason || undefined
      }
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        return { ok: true, aborted: true, content: full, reasoning: reasoning || undefined }
      }
      return { ok: false, error: (err as Error).message || String(err) }
    } finally {
      chatAbortMap.delete(sessionId)
    }
  })

  // 联网搜索（DuckDuckGo，免费无密钥）——渲染进程调用后把结果作为 tool 消息回填
  ipcMain.handle(IPC.Chat.search, async (_e, args: { query?: string }) => {
    const result = await searchWeb(args?.query || '')
    return { ok: true, result }
  })

  // 附件落盘
  ipcMain.handle(IPC.Chat.attachmentSave, (_e, args: { kind?: string; name?: string; data?: string }) => {
    try {
      const dir = path.join(app.getPath('userData'), 'chat_files')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const safeName = String(args?.name || 'file').replace(/[\\/:*?"<>|]/g, '_')
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
      const filePath = path.join(dir, fileName)
      if (args?.kind === 'image') {
        const m = /^data:[^;]+;base64,(.+)$/.exec(String(args.data || ''))
        if (!m) return { ok: false, error: '无效的图片数据。' }
        fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'))
      } else {
        fs.writeFileSync(filePath, String(args?.data || ''), 'utf-8')
      }
      return { ok: true, path: filePath, fileUrl: 'file:///' + filePath.replace(/\\/g, '/') }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })

  // 导出对话为文本文件（另存为对话框）
  ipcMain.handle(IPC.Chat.export, async (_e, args: { name?: string; content?: string }) => {
    const win = getMainWindow()
    const safeName = String(args?.name || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const opts = {
      title: '导出对话',
      defaultPath: `${safeName}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '文本文件', extensions: ['txt'] }
      ]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    const { canceled, filePath } = res
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, String(args?.content ?? ''), 'utf-8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })

  // 读取文本文件内容
  ipcMain.handle(IPC.Chat.attachmentReadText, (_e, args: { path?: string }) => {
    try {
      const stat = fs.statSync(args?.path as string)
      if (stat.size > 200 * 1024) return { ok: false, error: '文件过大（超过 200KB），请精简后再上传。' }
      const text = fs.readFileSync(args?.path as string, 'utf-8')
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })

  // 读取图片文件为 dataURL
  ipcMain.handle(IPC.Chat.attachmentReadImage, (_e, args: { path?: string }) => {
    try {
      const buf = fs.readFileSync(args?.path as string)
      const ext = (path.extname(args?.path as string) || '.png').slice(1).toLowerCase()
      const mime =
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'gif' ? 'image/gif'
        : ext === 'bmp' ? 'image/bmp'
        : 'image/png'
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })

  // 停止某个会话的生成
  ipcMain.on(IPC.Chat.stop, (_e, sessionId: string) => {
    const c = chatAbortMap.get(sessionId)
    if (c) c.abort()
  })

  }
