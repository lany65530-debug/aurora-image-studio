/**
 * 渲染层 · 聊天工作区（chat 视图）
 * ------------------------------------------------------------
 * 会话隔离（ID 前缀 ws_<工作区ID>_）、模型选择、深signature思考、AI 绘图/联网搜索、
 * 附件（图片 + 文本）、流式渲染、会话 CRUD 与发送 / 重新生成。
 * ============================================================

 * 分区：
 *   A. 状态单例与配置解析
 *   B. 深度思考 / 模型识别
 *   C. 视图重绑定 + 会话列表 + 消息渲染
 *   D. 对话收发流（含工具调用 : 绘图 / 搜索）
 *   E. 附件管理
 *   F. 事件绑定
 */
import {
  $,
  store,
  findWs,
  persistWorkspaces,
  activeChatWs,
  escapeHtml,
  type ChatWorkspace,
  type Workspace
} from '../state/store'
import { chat as chatApi, img } from '../state/aurora'
import { detectPreset } from '../state/provider'
import { toast } from '../components/toast'
import { openLightbox } from '../components/lightbox'
import { renderMarkdown } from '../components/markdown'
import { sendToComposer } from './image'

/* ============ A. 状态单例与配置解析 ============ */
interface ChatState {
  sessions: any[]
  wsId: string
  currentId: string | null
  generating: boolean
  streamingSessionId: string | null
  streamBuf: string
  streamEl: HTMLElement | null
  reasoningBuf: string
  reasoningEl: HTMLElement | null
  currentModel: string
  attachments: any[]
  inited: boolean
}
const chatState: ChatState = {
  sessions: [],
  wsId: '',
  currentId: null,
  generating: false,
  streamingSessionId: null,
  streamBuf: '',
  streamEl: null,
  reasoningBuf: '',
  reasoningEl: null,
  currentModel: '',
  attachments: [],
  inited: false
}
export const chatModelsCache = new Map<string, string[]>()

export function wsChatPrefix(ws: Workspace): string {
  return 'ws_' + ws.id + '_'
}

function chatConfig(ws?: Workspace | null): Record<string, any> {
  const w = ws || findWs(chatState.wsId)
  const c: any = (w && w.chat) || {}
  return {
    baseUrl: String((w && w.baseUrl) || '').trim(),
    apiKey: String((w && w.apiKey) || '').trim(),
    model: String((w && w.model) || '').trim(),
    temperature: typeof c.temperature === 'number' ? c.temperature : 0.7,
    contextRounds: Number.isInteger(c.contextRounds) && c.contextRounds > 0 ? c.contextRounds : 20,
    fontSize: typeof c.fontSize === 'number' && c.fontSize >= 12 && c.fontSize <= 22 ? c.fontSize : 14,
    systemPrompt: c.systemPrompt || '',
    drawModel: c.drawModel || ''
  }
}

/* ============ 小说模式：阅读器渲染 ============ */

/** 小说模式是否开启（以工具栏开关为唯一状态源）。 */
function novelModeOn(): boolean {
  const el = $('#chatNovelMode') as HTMLInputElement | null
  return !!(el && el.checked)
}

/** 解析章节内容：提取章节标题（首个标题行 / 首行「第X章」短行），其余为正文。 */
function parseNovelChapter(content: string): { title: string; body: string } {
  const lines = String(content || '').split(/\r?\n/)
  let title = ''
  let started = false
  const body: string[] = []
  for (const raw of lines) {
    const head = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (head && !title) {
      title = head[2].trim()
      started = true
      continue
    }
    if (!started && !title) {
      const t = raw.trim()
      if (
        t &&
        t.length <= 40 &&
        /^第\s*[\d〇一二三四五六七八九十百千万零]+\s*[章回节卷部篇]/.test(t)
      ) {
        title = t
        started = true
        continue
      }
    }
    body.push(raw)
  }
  return { title, body: body.join('\n').trim() }
}

/** 正文行内 Markdown 轻处理（加粗 / 斜体 / 行内代码），其余转义为纯文本。 */
function novelInlineMarkup(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** 正文段落渲染：空行分段、首行缩进 2 字符；章内小标题（# 行）居中加粗。 */
function renderNovelBodyMarkup(body: string): string {
  const paras = String(body || '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const p of paras) {
    const head = p.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
    if (head) {
      out.push(`<div class="chat-novel-section">${novelInlineMarkup(head[1].trim())}</div>`)
      continue
    }
    out.push(`<p>${novelInlineMarkup(p.replace(/\r?\n/g, ' '))}</p>`)
  }
  return out.join('')
}

/** 字数统计（中文按字符计）与预估阅读时长（约 380 字/分钟）。 */
function novelReadingMeta(content: string): { chars: number; minutes: number } {
  const chars = String(content || '').replace(/\s/g, '').length
  return { chars, minutes: Math.max(1, Math.round(chars / 380)) }
}

/** 构建小说阅读器卡片（章节标题 + 元信息 + 正文）。 */
function buildNovelCard(host: HTMLElement, content: string, fallbackTitle?: string): void {
  host.classList.add('chat-novel-bubble')
  const { title, body } = parseNovelChapter(content)
  const chapter = title || fallbackTitle || '未命名章节'
  const { chars, minutes } = novelReadingMeta(content)
  host.innerHTML = `
    <div class="chat-novel">
      <div class="chat-novel-bar">
        <span class="chat-novel-tag"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2V5Z" stroke-linejoin="round"/><path d="M8 7h8M8 10.5h6" stroke-linecap="round"/></svg>小说阅读</span>
        <span class="chat-novel-meta">约 ${chars.toLocaleString()} 字 · 约 ${minutes} 分钟</span>
      </div>
      <h2 class="chat-novel-title"></h2>
      <div class="chat-novel-body"></div>
    </div>`
  ;(host.querySelector('.chat-novel-title') as HTMLElement).textContent = chapter
  ;(host.querySelector('.chat-novel-body') as HTMLElement).innerHTML = renderNovelBodyMarkup(body)
}

/** 流式更新小说卡片：标题 / 字数随内容实时刷新。 */
function updateNovelStream(host: HTMLElement, content: string): void {
  const card = host.querySelector('.chat-novel')
  if (!card) return
  const { title, body } = parseNovelChapter(content)
  const titleEl = card.querySelector('.chat-novel-title')
  if (titleEl && title) titleEl.textContent = title
  const { chars, minutes } = novelReadingMeta(content)
  const metaEl = card.querySelector('.chat-novel-meta')
  if (metaEl && chars) metaEl.textContent = `约 ${chars.toLocaleString()} 字 · 约 ${minutes} 分钟`
  const bodyEl = card.querySelector('.chat-novel-body')
  if (!bodyEl) return
  const markup = renderNovelBodyMarkup(body)
  if (markup) bodyEl.innerHTML = markup + '<span class="chat-cursor"></span>'
}

/* ============ B. 深度思考 / 模型识别 ============ */

// 判断模型是否支持「深度思考」
function isThinkingModel(model: string): boolean {
  const m = String(model || '').toLowerCase()
  return (
    /(^|[^a-z0-9])o[1-9]($|[^a-z0-9])/.test(m) ||
    /\bclaude\b|thinking|reasoner|deepseek-r1|deepseek-v[0-9]|kimi|gpt-5|grok|glm-4\.[5-9]|glm-5|gemini-2\.5/.test(m)
  )
}

// 深度思考「控制方式」识别：level(力度可调) / switch(仅开关) / none(不可控)
function thinkControlOf(model: string): 'level' | 'switch' | 'none' {
  const m = String(model || '').toLowerCase()
  if (/gpt-5|grok/.test(m) || /(^|[^a-z0-9])o[1-9]($|[^a-z0-9])/.test(m)) return 'level'
  if (/\bclaude\b|glm-4\.[5-9]|glm-5|deepseek-v[0-9]/.test(m)) return 'switch'
  return 'none'
}

/** 深度思考力度唯一状态源（off/low/medium/high），由自定义下拉读写，替代冗余的原生 select。 */
let chatThinkLevel = 'medium'

/** 用户是否主动点击停止（用于抑制“对话失败”误报并标记已停止）。 */
let chatUserStop = false

function syncChatThinkLabel(): void {
  const lbl = $('#chatThinkDDLabel')
  if (!lbl) return
  const map: Record<string, string> = { off: '深度思考', low: '低', medium: '中', high: '高' }
  const v = chatThinkLevel
  lbl.textContent = map[v] || '深度思考'
  const menu = $('#chatThinkMenu')
  if (menu)
    menu.querySelectorAll<HTMLElement>('button[data-lv]').forEach((b) => b.classList.toggle('active', b.dataset.lv === v))
}

function syncThinkControl(model: string): void {
  const t = thinkControlOf(model)
  const sw = $('#chatDeepThinkLbl')
  const lv = $('#chatThinkingLevelLbl')
  if (sw) sw.style.display = t === 'switch' ? '' : 'none'
  if (lv) lv.style.display = t === 'level' ? '' : 'none'
  if (t === 'level') {
    const ws = findWs(chatState.wsId) as ChatWorkspace | null
    if (ws && ws.thinkLevel) chatThinkLevel = ws.thinkLevel as string
    syncChatThinkLabel()
  }
}

function currentSession(): any {
  return chatState.sessions.find((s) => s.id === chatState.currentId) || null
}

/* 相对时间格式化：刚刚 / x 分钟前 / 今天 HH:mm / 昨天 HH:mm / M月D日 HH:mm */
function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const diff = Math.floor((Date.now() - ts) / 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (new Date(Date.now()).getDate() === d.getDate()) return `今天 ${hm}`
  const yesterday = new Date(Date.now() - 86400e3)
  if (yesterday.getDate() === d.getDate()) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/* ---- 会话置顶（持久化到 ws.chat.pinnedIds） ---- */
function chatPinnedIds(ws?: Workspace | null): string[] {
  const w = ws || findWs(chatState.wsId)
  const c: any = (w && w.chat) || {}
  return Array.isArray(c.pinnedIds) ? c.pinnedIds.map(String) : []
}
function setChatPinned(ids: string[]): void {
  const ws = findWs(chatState.wsId) as ChatWorkspace | null
  if (!ws) return
  ws.chat = Object.assign({}, ws.chat, { pinnedIds: ids })
  persistWorkspaces()
}

/* ---- 会话搜索关键词 ---- */
let chatSessionKeyword = ''

/* 输入草稿暂存（防切换会话/工作区丢失未发送内容） */
function collectDraft(): { text: string; attachments: any[] } {
  return {
    text: ($('#chatInput') as HTMLTextAreaElement).value,
    attachments: chatState.attachments.slice()
  }
}
function saveDraft(s: any): void {
  if (!s) return
  const d = collectDraft()
  if (!d.text.trim() && !d.attachments.length) {
    if (s.draft) {
      delete s.draft
      void saveChatSessionQuiet(s)
    }
    return
  }
  s.draft = { text: d.text, attachments: d.attachments, ts: Date.now() }
  void saveChatSessionQuiet(s)
}
function restoreDraft(): void {
  const s = currentSession()
  const input = $('#chatInput') as HTMLTextAreaElement
  if (!s || !s.draft) {
    input.value = ''
    clearChatAttachments()
    autoGrowChatInput()
    return
  }
  input.value = String(s.draft.text || '')
  chatState.attachments = Array.isArray(s.draft.attachments) ? s.draft.attachments : []
  renderChatAttachments()
  autoGrowChatInput()
  updateChatSendState()
}

/* ============ F. 事件绑定（首次进入 chat 视图时执行一次） ============ */
function bindChatEvents(): void {
  $('#chatNewBtn').addEventListener('click', () => newChatSession())
  $('#chatSendBtn').addEventListener('click', () => void sendChatMessage())

  // 会话搜索过滤
  ;($('#chatSessionSearch') as HTMLInputElement).addEventListener('input', () => {
    chatSessionKeyword = ($('#chatSessionSearch') as HTMLInputElement).value
    renderChatSessionList()
  })

  // 空态示例问题
  chatEmptyEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.chat-suggest-btn')
    if (!btn) return
    const input = $('#chatInput') as HTMLTextAreaElement
    input.value = btn.textContent!.trim()
    autoGrowChatInput()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  })
  $('#chatStopBtn').addEventListener('click', () => {
    chatUserStop = true
    if (chatState.currentId) chatApi.stop(chatState.currentId)
  })

  // 导出当前对话
  $('#chatExportBtn').addEventListener('click', () => void exportCurrentChat())

  // 附件
  ;($('#chatAttachBtn') as HTMLButtonElement).addEventListener('click', () =>
    ($('#chatFileInput') as HTMLInputElement).click()
  )
  ;($('#chatFileInput') as HTMLInputElement).addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement
    handleChatFiles(Array.from(target.files || []))
    target.value = ''
  })
  const dropZone = $('.chat-input-wrap')
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropZone.classList.add('dragging')
  })
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragging'))
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault()
    dropZone.classList.remove('dragging')
    handleChatFiles(Array.from(e.dataTransfer?.files || []))
  })

  // 模型选择器
  $('#chatModelBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    const pop = $('#chatModelPop')
    const show = pop.style.display === 'none'
    pop.style.display = show ? 'block' : 'none'
    if (show) {
      renderChatModelPickList()
      if (!(chatModelsCache.get(chatState.wsId) || []).length) void refreshChatModels(null, false)
      setTimeout(() => ($('#chatModelSearch2') as HTMLInputElement).focus(), 50)
    }
  })
  ;($('#chatModelSearch2') as HTMLInputElement).addEventListener('input', renderChatModelPickList)
  $('#chatModelRefreshBtn').addEventListener('click', () => void refreshChatModels(null, false))
  document.addEventListener('click', (e) => {
    const sel = $('#chatModelSelect')
    if (sel && !sel.contains(e.target as Node)) $('#chatModelPop').style.display = 'none'
  })

  // 开关持久化
  ;($('#chatDrawEnabled') as HTMLInputElement).addEventListener('change', () => {
    const ws = findWs(chatState.wsId)
    if (ws) {
      ws.drawEnabled = ($('#chatDrawEnabled') as HTMLInputElement).checked
      persistWorkspaces()
    }
  })
  ;($('#chatSearchEnabled') as HTMLInputElement).addEventListener('change', () => {
    const ws = findWs(chatState.wsId)
    if (ws) {
      ws.searchEnabled = ($('#chatSearchEnabled') as HTMLInputElement).checked
      persistWorkspaces()
    }
  })
  ;($('#chatDeepThink') as HTMLInputElement).addEventListener('change', () => {
    const ws = findWs(chatState.wsId) as ChatWorkspace | null
    const on = ($('#chatDeepThink') as HTMLInputElement).checked
    if (ws) {
      ws.deepThink = on
      persistWorkspaces()
    }
    if (on && ws && !isThinkingModel(chatState.currentModel || ws.model)) {
      toast('当前模型不支持深度思考：请切换 o 系列 / deepseek-r1 / Claude 等思考模型后生效', 'warning', 5000)
    }
  })
  // 小说模式开关
  ;($('#chatNovelMode') as HTMLInputElement).addEventListener('change', () => {
    const ws = findWs(chatState.wsId)
    if (ws) {
      ws.novelMode = ($('#chatNovelMode') as HTMLInputElement).checked
      persistWorkspaces()
    }
    // 即时重绘当前会话，切换展示形态
    if (ws && ws.id === chatState.wsId) renderChatMessages()
  })
  // 自定义深度思考力度下拉（唯一状态源 chatThinkLevel）
  const ddBtn = $('#chatThinkDDBtn')
  const ddMenu = $('#chatThinkMenu')
  if (ddBtn && ddMenu) {
    const ddWrap = $('#chatThinkingLevelLbl')
    ddBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const show = (ddMenu as HTMLElement).hidden
      ;(ddMenu as HTMLElement).hidden = !show
      if (ddWrap) ddWrap.classList.toggle('open', show)
    })
    ddMenu.querySelectorAll('button[data-lv]').forEach((b) => {
      b.addEventListener('click', () => {
        chatThinkLevel = (b as HTMLElement).dataset.lv as string
        const ws = findWs(chatState.wsId) as ChatWorkspace | null
        if (ws) {
          ws.thinkLevel = chatThinkLevel
          persistWorkspaces()
        }
        syncChatThinkLabel()
        ;(ddMenu as HTMLElement).hidden = true
        if (ddWrap) ddWrap.classList.remove('open')
      })
    })
    document.addEventListener('click', (e) => {
      if ((ddMenu as HTMLElement).hidden) return
      if (!ddWrap || !ddWrap.contains(e.target as Node)) {
        ;(ddMenu as HTMLElement).hidden = true
        ddWrap.classList.remove('open')
      }
    })
  }

  // 字号
  $('#chatFontMinus').addEventListener('click', () => changeChatFontSize(-1))
  $('#chatFontPlus').addEventListener('click', () => changeChatFontSize(1))
  ;($('#chatInput') as HTMLTextAreaElement).addEventListener('input', () => {
    autoGrowChatInput()
    updateChatSendState()
  })
  ;($('#chatInput') as HTMLTextAreaElement).addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent
    if (k.key === 'Enter' && !k.shiftKey && !k.isComposing) {
      e.preventDefault()
      if (!(k.ctrlKey || k.metaKey) && !chatState.generating) void sendChatMessage()
      if (k.ctrlKey || k.metaKey) void sendChatMessage()
      return
    }
    if (k.key === 'Escape' && chatState.generating) {
      e.preventDefault()
      chatUserStop = true
      if (chatState.currentId) chatApi.stop(chatState.currentId)
    }
  })
  $('#chatGoSettingsBtn').addEventListener('click', () => {
    openWsSettings((findWs(chatState.wsId) || activeChatWs()) as ChatWorkspace | null)
  })

  // 人设弹层
  const pop = $('#chatPersonaPop')
  $('#chatPersonaBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    const s = currentSession()
    ;($('#chatPersonaInput') as HTMLTextAreaElement).value = (s && s.systemPrompt) || ''
    pop.style.display = 'block'
  })
  $('#chatPersonaClose').addEventListener('click', () => {
    pop.style.display = 'none'
  })
  $('#chatPersonaClear').addEventListener('click', () => {
    ;($('#chatPersonaInput') as HTMLTextAreaElement).value = ''
  })
  $('#chatPersonaSave').addEventListener('click', async () => {
    const s = currentSession()
    if (s) {
      s.systemPrompt = ($('#chatPersonaInput') as HTMLTextAreaElement).value.trim()
      s.updatedAt = Date.now()
      await chatApi.sessionsSave(JSON.parse(JSON.stringify(s)))
      toast(s.systemPrompt ? '已保存人设，下条消息生效' : '已清空人设', 'success')
    }
    pop.style.display = 'none'
  })
  document.addEventListener('click', (e) => {
    if (pop.style.display === 'block' && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest('#chatPersonaBtn')) {
      pop.style.display = 'none'
    }
  })

  // 智能滚动跟随 + “回到最新”悬浮按钮
  bindChatScrollFollow()
  const _msgWrap = $('#chatMessages')
  if (!_msgWrap.querySelector('#chatBackBottom')) {
    const bb = document.createElement('button')
    bb.id = 'chatBackBottom'
    bb.className = 'chat-back-bottom'
    bb.type = 'button'
    bb.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 13l7 6 7-6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 7l7 6 7-6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>回到最新</span>`
    bb.addEventListener('click', forceChatBottom)
    _msgWrap.appendChild(bb)
  }

  // 代码块复制（事件委托）
  $('#chatMessages').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.md-code-copy') as HTMLElement | null
    if (!btn) return
    const code = btn.closest('.md-code-block')?.querySelector('code')
    if (code) {
      void navigator.clipboard.writeText(code.textContent || '').then(() => {
        btn.textContent = '已复制'
        setTimeout(() => {
          btn.textContent = '复制'
        }, 1600)
      })
    }
  })
}

/* ============ C. 视图重绑定 + 会话列表 + 消息渲染 ============ */
async function bindChatWorkspace(ws: ChatWorkspace): Promise<void> {
  if (!chatState.inited) {
    chatState.inited = true
    bindChatEvents()
    chatApi.onChunk((d) => {
      // 跟随「正在流式生成的会话」，而非当前查看的工作区，避免切换工作区时中断累积导致丢字
      if (!chatState.streamingSessionId || d.sessionId !== chatState.streamingSessionId) return
      chatState.streamBuf += d.delta
      scheduleStreamRender()
    })
    chatApi.onReasoning((d) => {
      if (!chatState.streamingSessionId || d.sessionId !== chatState.streamingSessionId) return
      chatState.reasoningBuf += d.delta
      scheduleReasoningRender()
    })
  }

  // 离开当前会话前先暂存草稿（此时 sessions 仍为旧工作区数据）
  saveDraft(currentSession())

  chatState.wsId = ws.id
  chatState.currentModel = (ws.model || '').trim()
  clearChatAttachments()
  chatSessionKeyword = ''
  const searchInput = $('#chatSessionSearch') as HTMLInputElement
  if (searchInput) searchInput.value = ''

  // 开关状态回填（每工作区独立）
  ;($('#chatDrawEnabled') as HTMLInputElement).checked = ws.drawEnabled !== false
  ;($('#chatSearchEnabled') as HTMLInputElement).checked = !!ws.searchEnabled
  ;($('#chatDeepThink') as HTMLInputElement).checked = !!ws.deepThink
  ;($('#chatNovelMode') as HTMLInputElement).checked = !!ws.novelMode
  if (ws.thinkLevel) chatThinkLevel = ws.thinkLevel as string
  syncChatThinkLabel()
  syncThinkControl(chatState.currentModel)

  // 会话列表（按工作区前缀过滤；无前缀的旧版会话归首个聊天工作区）
  const all = await chatApi.sessionsList()
  const prefix = wsChatPrefix(ws)
  const isPrimaryChat = store.workspaces.find((w) => w.type === 'chat') === ws
  chatState.sessions = all.filter((s) => {
    const id = String(s.id || '')
    return id.startsWith(prefix) || (isPrimaryChat && !/^ws_/.test(id))
  })
  chatState.currentId =
    ws.lastSessionId && chatState.sessions.some((s) => s.id === ws.lastSessionId)
      ? ws.lastSessionId
      : chatState.sessions.length
        ? chatState.sessions[0].id
        : null

  applyChatFontSize(ws)
  updateChatModelTag(ws)
  renderChatSessionList()
  renderChatMessages()
  restoreDraft()
  updateChatSendState()
  void refreshChatModels(ws, true)
}

function updateChatModelTag(ws?: Workspace): void {
  ws = ws || findWs(chatState.wsId) || undefined
  const cfg = chatConfig(ws as ChatWorkspace)
  const name = $('#chatModelName')
  const goBtn = $('#chatGoSettingsBtn')
  const model = chatState.currentModel || cfg.model
  if (cfg.baseUrl && cfg.apiKey && model) {
    name.textContent = model
    $('#chatModelBtn').classList.add('ready')
    goBtn.style.display = 'none'
  } else {
    name.textContent = '未配置模型'
    $('#chatModelBtn').classList.remove('ready')
    goBtn.style.display = ''
  }
  const noSession = !currentSession()
  $('#chatEmptyHint').textContent = noSession
    ? '点击左侧「新对话」开始，可用于头脑风暴、润色提示词、或随便聊聊'
    : '发送第一条消息开始对话'
}

/* ---- 聊天模型列表（按工作区缓存） ---- */
async function refreshChatModels(ws: Workspace | null, silent: boolean): Promise<void> {
  ws = ws || findWs(chatState.wsId) || null
  if (!ws) return
  const cfg = chatConfig(ws)
  if (!cfg.baseUrl || !cfg.apiKey) return
  try {
    const res = await chatApi.modelsList({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })
    if (res && res.ok) {
      chatModelsCache.set(ws.id, (res.models as string[]) || [])
      if (ws.id === chatState.wsId) renderChatModelPickList()
    } else if (!silent) {
      toast('拉取模型失败：' + ((res && res.error) || '未知错误'), 'error')
    }
  } catch (e: any) {
    if (!silent) toast('拉取模型失败：' + e.message, 'error')
  }
}

function renderChatModelPickList(): void {
  const list = $('#chatModelList2')
  const count = $('#chatModelCount2')
  if (!list) return
  const models = chatModelsCache.get(chatState.wsId) || []
  const kw = (($('#chatModelSearch2') as HTMLInputElement).value || '').toLowerCase()
  const filtered = models.filter((m) => !kw || m.toLowerCase().includes(kw))
  count.textContent = models.length ? `${filtered.length}/${models.length}` : ''
  list.innerHTML = ''
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'channel-empty-item'
    empty.textContent = models.length ? '无匹配模型' : '尚无模型列表，点击下方按钮拉取'
    list.appendChild(empty)
    return
  }
  const cur = chatState.currentModel || ''
  filtered.forEach((m) => {
    const el = document.createElement('div')
    el.className = 'channel-item' + (m === cur ? ' active' : '')
    el.textContent = m
    el.title = m
    el.addEventListener('click', () => {
      chatState.currentModel = m
      const ws = findWs(chatState.wsId) as ChatWorkspace | null
      if (ws) {
        ws.model = m
        persistWorkspaces()
      }
      $('#chatModelName').textContent = m
      $('#chatModelBtn').classList.add('ready')
      $('#chatModelPop').style.display = 'none'
      renderChatModelPickList()
      syncThinkControl(m)
      toast('已切换模型：' + m, 'success', 2500)
      if (($('#chatDeepThink') as HTMLInputElement).checked && !isThinkingModel(m)) {
        toast('当前模型不支持深度思考：请切换 o 系列 / deepseek-r1 / Claude 等思考模型后生效', 'warning', 5000)
      }
    })
    list.appendChild(el)
  })
}

/* ---- 字号（持久化到工作区 chat.fontSize） ---- */
function applyChatFontSize(ws: Workspace): void {
  const cfg = chatConfig(ws)
  const size = cfg.fontSize || 14
  const msgs = $('#chatMessages')
  if (msgs) msgs.style.setProperty('--chat-font-size', size + 'px')
  const val = $('#chatFontVal')
  if (val) val.textContent = String(size)
  const input = $('#chatInput')
  if (input) input.style.fontSize = Math.min(size + 1, 17) + 'px'
}

function changeChatFontSize(delta: number): void {
  const ws = findWs(chatState.wsId) as ChatWorkspace | null
  if (!ws) return
  const cur = ws.chat && typeof ws.chat.fontSize === 'number' ? ws.chat.fontSize : 14
  const size = Math.max(12, Math.min(22, cur + delta))
  ws.chat = Object.assign({}, ws.chat, { fontSize: size })
  applyChatFontSize(ws)
  persistWorkspaces()
}

const PIN_ICON_OFF = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 10c0 4.4-8 11-8 11S4 14.4 4 10a8 8 0 1 1 16 0Z" stroke-linejoin="round"/><circle cx="12" cy="10" r="3"/></svg>'
const PIN_ICON_ON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M20 10c0 4.4-8 11-8 11S4 14.4 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3" fill="var(--surface)"/></svg>'

function renderChatSessionList(): void {
  const wrap = $('#chatSessionList')
  wrap.innerHTML = ''
  const kw = chatSessionKeyword.trim().toLowerCase()
  const pinned = chatPinnedIds()
  const list = chatState.sessions
    .filter((s) => !kw || String(s.title || '').toLowerCase().includes(kw))
    .slice()
    .sort((a, b) => {
      const ap = pinned.includes(a.id) ? 0 : 1
      const bp = pinned.includes(b.id) ? 0 : 1
      if (ap !== bp) return ap - bp
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })

  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'chat-session-empty'
    empty.textContent = chatState.sessions.length ? '无匹配会话' : '还没有会话'
    wrap.appendChild(empty)
    return
  }

  list.forEach((s) => {
    const isActive = s.id === chatState.currentId
    const isPinned = pinned.includes(s.id)
    const el = document.createElement('div')
    el.className = 'chat-session-item' + (isActive ? ' active' : '') + (isPinned ? ' pinned' : '')
    el.innerHTML = `<span class="chat-session-title"></span><time class="chat-session-time"></time><button class="chat-session-pin" title="置顶 / 取消置顶"></button><button class="chat-session-ren" title="重命名会话">✎</button><button class="chat-session-del" title="删除会话">✕</button>`
    const titleEl = el.querySelector('.chat-session-title') as HTMLElement
    titleEl.textContent = s.title || '新对话'
    titleEl.title = s.title || '新对话'
    const timeEl = el.querySelector('.chat-session-time') as HTMLElement
    timeEl.textContent = fmtTime(s.updatedAt) || ''
    const pinBtn = el.querySelector('.chat-session-pin') as HTMLButtonElement
    pinBtn.innerHTML = isPinned ? PIN_ICON_ON : PIN_ICON_OFF
    // 行内重命名
    ;(el.querySelector('.chat-session-ren') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation()
      const input = document.createElement('input')
      input.className = 'chat-session-rename-input'
      input.maxLength = 60
      input.value = s.title || '新对话'
      titleEl.replaceWith(input)
      input.focus()
      input.select()
      const commit = (): void => {
        const v = input.value.trim()
        if (v) s.title = v
        s.updatedAt = Date.now()
        void chatApi.sessionsSave(JSON.parse(JSON.stringify(s)))
        renderChatSessionList()
      }
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') commit()
        if (ev.key === 'Escape') renderChatSessionList()
      })
      input.addEventListener('blur', () => commit())
    })
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.chat-session-del')) return
      if ((e.target as HTMLElement).closest('.chat-session-pin')) return
      // 先保存当前会话草稿，再切换
      saveDraft(currentSession()) // 由 renderChatMessages 在当前会话渲染后恢复
      chatState.currentId = s.id
      const ws = findWs(chatState.wsId) as ChatWorkspace | null
      if (ws) {
        ws.lastSessionId = s.id
        persistWorkspaces()
      }
      renderChatSessionList()
      renderChatMessages()
      restoreDraft()
    })
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const now = chatPinnedIds()
      const idx = now.indexOf(s.id)
      if (idx >= 0) now.splice(idx, 1)
      else now.unshift(s.id)
      setChatPinned(now)
      renderChatSessionList()
    })
    ;(el.querySelector('.chat-session-del') as HTMLButtonElement).addEventListener('click', async () => {
      await chatApi.sessionsDelete(s.id)
      const delActive = chatState.currentId === s.id
      chatState.sessions = chatState.sessions.filter((x) => x.id !== s.id)
      if (delActive) {
        chatState.currentId = chatState.sessions.length ? chatState.sessions[0].id : null
      }
      const ws = findWs(chatState.wsId) as ChatWorkspace | null
      if (ws) {
        ws.lastSessionId = chatState.currentId || ''
        persistWorkspaces()
      }
      renderChatSessionList()
      renderChatMessages()
      if (delActive) restoreDraft()
      toast('已删除会话', 'success')
    })
    wrap.appendChild(el)
  })
}

function newChatSession(): void {
  const ws = findWs(chatState.wsId) as ChatWorkspace | null
  if (!ws) return
  saveDraft(currentSession())
  const s = {
    id: wsChatPrefix(ws) + 'cs-' + Date.now(),
    title: '新对话',
    systemPrompt: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  }
  chatState.sessions.unshift(s)
  chatState.currentId = s.id
  ws.lastSessionId = s.id
  persistWorkspaces()
  renderChatSessionList()
  renderChatMessages()
  restoreDraft()
  ;($('#chatInput') as HTMLTextAreaElement).focus()
}

// 空态节点在启动时捕获引用
const chatEmptyEl = $('#chatEmpty')

/** 将会话消息序列化为 Markdown 文本（用于导出）。 */
function sessionToMarkdown(s: any): string {
  const lines: string[] = [`# ${s.title || '新对话'}`, '']
  if (s.systemPrompt) lines.push(`> 系统提示词：${s.systemPrompt}`, '')
  ;(s.messages || []).forEach((m: any) => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : String(m.role || '')
    lines.push(`## ${role}`, '')
    if (m.error) lines.push(`_${m.error}_`, '')
    if (typeof m.content === 'string' && m.content) lines.push(m.content, '')
    if (Array.isArray(m.images)) m.images.forEach((im: any) => lines.push(`![图片](${im.url || im.dataUrl || ''})`, ''))
    if (Array.isArray(m.files)) m.files.forEach((f: any) => lines.push(`- [附件] ${f.name || f.path || '文件'}`, ''))
    if (Array.isArray(m.toolCalls)) m.toolCalls.forEach((t: any) => lines.push(`> [工具调用] ${t.function?.name || t.type || ''}`, ''))
  })
  return lines.join('\n').trim()
}

/** 导出当前会话为 Markdown 文件（另存为）。 */
async function exportCurrentChat(): Promise<void> {
  const s = currentSession()
  if (!s) {
    toast('没有可导出的会话', 'warning')
    return
  }
  if (!(s.messages || []).length) {
    toast('当前会话还没有内容', 'warning')
    return
  }
  const title = String(s.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const res = await chatApi.export({ name: title, content: sessionToMarkdown(s) })
  if (res.canceled) return
  if (res.ok) toast('已导出对话', 'success')
  else toast('导出失败：' + (res.error || '未知错误'), 'error')
}

/** 依据工作区已开启能力，动态生成空态建议词。 */
function renderChatSuggestions(): void {
  const ws = findWs(chatState.wsId) as ChatWorkspace | null
  const draw = !!(ws && ws.drawEnabled)
  const search = !!(ws && ws.searchEnabled)
  const novel = novelModeOn()
  const text = [
    novel ? '帮我写一篇仙侠小说开篇，带章节标题' : '帮我润色一段文字',
    draw ? '用一句话描述一个梦幻场景，并把它画出来' : '用简单的比喻解释一个复杂概念',
    search ? '联网搜索：最近一周的 AI 大新闻' : '帮我梳理一份周末计划',
    '给这段文案挑毛病并改得更好'
  ]
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('.chat-suggest-btn'))
  btns.forEach((b, i) => {
    if (text[i]) b.textContent = text[i]
  })
}

function renderChatMessages(): void {
  const wrap = $('#chatMessages')
  const wasNearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120
  const prevRatio = wrap.scrollHeight > 0 ? wrap.scrollTop / wrap.scrollHeight : 0
  wrap.innerHTML = ''
  const s = currentSession()
  if (!s || !s.messages.length) {
    renderChatSuggestions()
    chatEmptyEl.style.display = ''
    wrap.appendChild(chatEmptyEl)
    updateChatModelTag()
    return
  }
  s.messages.forEach((m: any) => wrap.appendChild(buildChatMsgEl(m)))
  chatEmptyEl.style.display = 'none'
  wrap.appendChild(chatEmptyEl)
  if (wasNearBottom) {
    scrollChatBottom(true)
  } else {
    wrap.scrollTop = prevRatio * wrap.scrollHeight
  }
}

function buildChatMsgEl(m: any): HTMLElement {
  const el = document.createElement('div')
  el.className = 'chat-msg ' + (m.role === 'user' ? 'chat-msg-user' : 'chat-msg-ai')

  // 深度思考区
  if (m.role === 'assistant' && m.reasoning) {
    const box = document.createElement('div')
    box.className = 'chat-reasoning'
    box.innerHTML = `
      <button class="chat-reasoning-toggle" type="button">
        <svg class="chat-reasoning-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="chat-reasoning-label done">已深度思考（点击展开）</span>
      </button>
      <pre class="chat-reasoning-body"></pre>`
    ;(box.querySelector('.chat-reasoning-body') as HTMLElement).textContent = m.reasoning
    box.querySelector('.chat-reasoning-toggle')?.addEventListener('click', () => box.classList.toggle('open'))
    el.appendChild(box)
  }

  const bubble = document.createElement('div')
  bubble.className = 'chat-bubble'

  if (m.role === 'user') {
    if (m.images && m.images.length) {
      const grid = document.createElement('div')
      grid.className = 'chat-img-grid'
      m.images.forEach((im: any) => {
        const imEl = document.createElement('img')
        imEl.src = im.fileUrl || im.dataUrl
        imEl.alt = im.name || ''
        imEl.loading = 'lazy'
        imEl.addEventListener('click', () => openLightbox(imEl.src))
        grid.appendChild(imEl)
      })
      bubble.appendChild(grid)
    }
    if (m.files && m.files.length) {
      m.files.forEach((f: any) => {
        const chip = document.createElement('div')
        chip.className = 'chat-file-chip'
        chip.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke-linejoin="round"/><path d="M14 3v5h5" stroke-linejoin="round"/></svg><span class="chat-file-name"></span>`
        ;(chip.querySelector('.chat-file-name') as HTMLElement).textContent = f.name
        bubble.appendChild(chip)
      })
    }
    const txt = document.createElement('div')
    txt.className = 'chat-text'
    txt.textContent = m.content || ''
    if (!m.content && (m.images || m.files)) txt.style.display = 'none'
    bubble.appendChild(txt)
  } else if (m.imageGen) {
    const wrap = document.createElement('div')
    wrap.className = 'chat-gen-img'
    const imEl = document.createElement('img')
    imEl.src = m.imageGen.fileUrl
    imEl.alt = m.imageGen.prompt || ''
    imEl.loading = 'lazy'
    imEl.addEventListener('click', () => openLightbox(m.imageGen.fileUrl))
    wrap.appendChild(imEl)
    const cap = document.createElement('div')
    cap.className = 'chat-gen-cap'
    cap.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.5 14.7 9l6.8.5-5.2 4.4 1.6 6.6L12 16.9l-5.9 3.6 1.6-6.6L2.5 9.5 9.3 9 12 2.5Z" stroke-linejoin="round"/></svg><span class="chat-gen-prompt"></span>`
    const p = m.imageGen.prompt || ''
    ;(cap.querySelector('.chat-gen-prompt') as HTMLElement).textContent = p.slice(0, 80) + (p.length > 80 ? '…' : '')
    wrap.appendChild(cap)
    bubble.appendChild(wrap)
  } else {
    if (m.role === 'assistant' && novelModeOn()) {
      buildNovelCard(bubble, m.content || '', currentSession()?.title)
    } else {
      bubble.innerHTML = renderMarkdown(m.content || '')
    }
    if (m.model) {
      const tag = document.createElement('div')
      tag.className = 'chat-model-chip'
      tag.textContent = m.model
      bubble.appendChild(tag)
    }
    if (m.error) {
      const err = document.createElement('div')
      err.className = 'chat-msg-error'
      const txt = document.createElement('span')
      txt.className = 'chat-msg-error-text'
      txt.textContent = m.error
      err.appendChild(txt)
      if (!chatState.generating) {
        const retry = document.createElement('button')
        retry.className = 'chat-msg-retry'
        retry.type = 'button'
        retry.textContent = '重试'
        retry.title = '重新生成这条回复'
        retry.addEventListener('click', (e) => {
          e.stopPropagation()
          void regenerateLast()
        })
        err.appendChild(retry)
      }
      bubble.appendChild(err)
    } else if (m.stopped) {
      const note = document.createElement('div')
      note.className = 'chat-stopped-note'
      note.textContent = '已停止生成'
      bubble.appendChild(note)
    }
  }
  el.appendChild(bubble)

  // 悬浮操作条
  const actions = document.createElement('div')
  actions.className = 'chat-msg-actions'
  const mkBtn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }
  const copyText = m.imageGen ? m.imageGen.prompt || '' : m.content || ''
  if (copyText.trim()) {
    actions.appendChild(mkBtn('复制', '复制内容', async () => {
      await navigator.clipboard.writeText(copyText)
      toast('已复制', 'success')
    }))
  }
  if (m.role === 'user') {
    actions.appendChild(mkBtn('编辑', '编辑这条消息并重新生成回复', () => void startEditChatMessage(m)))
  }
  if (m.role === 'assistant') {
    actions.appendChild(mkBtn('重新生成', '重新生成这条回复', () => void regenerateLast()))
    const toComposer = m.imageGen ? m.imageGen.prompt || '' : m.content || ''
    if (toComposer.trim()) {
      actions.appendChild(mkBtn('→ 创作', '把这条内容填入生图提示词', () => sendToComposer(toComposer)))
    }
  }
  el.appendChild(actions)

  // 消息时间戳
  if (m.ts) {
    const t = document.createElement('time')
    t.className = 'chat-ts'
    t.textContent = fmtTime(m.ts)
    el.appendChild(t)
  }
  return el
}

/* ============ D. 对话收发流 ============ */

/* 编辑已发送的用户消息 */
async function startEditChatMessage(m: any): Promise<void> {
  if (chatState.generating) {
    toast('正在生成中，请稍候', 'error')
    return
  }
  const s = currentSession()
  if (!s) return
  const idx = s.messages.indexOf(m)
  if (idx < 0) return
  s.messages.splice(idx)

  ;($('#chatInput') as HTMLTextAreaElement).value = m.content || ''
  autoGrowChatInput()

  clearChatAttachments()
  const toRestore: any[] = []
  if (m.images && m.images.length) {
    for (const im of m.images) {
      try {
        const localPath = String(im.fileUrl || '').replace(/^file:\/\/\//, '').replace(/\//g, '\\')
        const res = await chatApi.attachmentReadImage({ path: localPath })
        if (res && res.ok) {
          toRestore.push({ kind: 'image', name: im.name || 'image.png', dataUrl: res.dataUrl })
        }
      } catch {
        /* 单张恢复失败跳过 */
      }
    }
  }
  if (m.files && m.files.length) {
    m.files.forEach((f: any) => toRestore.push({ kind: 'file', name: f.name, text: f.text || '' }))
  }
  chatState.attachments = toRestore
  renderChatAttachments()

  renderChatMessages()
  void saveChatSessionQuiet(s)
  ;($('#chatInput') as HTMLTextAreaElement).focus()
  toast('已进入编辑模式：修改后重新发送，将重新生成回复', 'success', 3500)
}

async function saveChatSessionQuiet(s: any): Promise<void> {
  try {
    await chatApi.sessionsSave(JSON.parse(JSON.stringify(s)))
  } catch {
    /* 静默 */
  }
}

// 智能滚动跟随：仅在用户位于底部时粘底；用户上滚阅读时暂停，绝不“抢鼠标”。
let chatFollowBottom = true

function scrollChatBottom(_force: boolean): void {
  const wrap = $('#chatMessages')
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120
  if (atBottom) chatFollowBottom = true
  if (!chatFollowBottom) {
    setChatBackBottomVisible(true)
    return
  }
  setChatBackBottomVisible(false)
  wrap.scrollTop = wrap.scrollHeight
}

/** 暴露给发送等「应回到最新」场景：主动恢复跟随并立即滚动到底部 */
function forceChatBottom(): void {
  chatFollowBottom = true
  scrollChatBottom(true)
}

/** 用户手动滚动 -> 依所在位置切换跟随开关与“回到最新”按钮显隐 */
function bindChatScrollFollow(): void {
  const wrap = $('#chatMessages')
  wrap.addEventListener(
    'scroll',
    () => {
      const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120
      chatFollowBottom = atBottom
      setChatBackBottomVisible(!atBottom)
    },
    { passive: true }
  )
}

/** 悬浮“回到最新”按钮显隐 */
function setChatBackBottomVisible(v: boolean): void {
  const btn = $('#chatBackBottom') as HTMLButtonElement | null
  if (btn) btn.classList.toggle('show', v)
}

/* 流式渲染（节流） */
let streamRenderPending = false
let streamRenderTimer: number | null = null
let lastStreamRenderAt = 0
function scheduleStreamRender(): void {
  if (streamRenderPending) return
  if (streamRenderTimer) clearTimeout(streamRenderTimer)
  const wait = Math.max(0, 45 - (performance.now() - lastStreamRenderAt))
  streamRenderTimer = window.setTimeout(() => {
    streamRenderTimer = null
    lastStreamRenderAt = performance.now()
    if (chatState.streamEl) {
      if (chatState.streamEl.classList.contains('chat-novel-bubble')) {
        updateNovelStream(chatState.streamEl, chatState.streamBuf)
      } else {
        chatState.streamEl.innerHTML = renderMarkdown(chatState.streamBuf)
        const cursor = document.createElement('span')
        cursor.className = 'chat-cursor'
        chatState.streamEl.appendChild(cursor)
      }
      scrollChatBottom(false)
    }
  }, wait)
}

/** 结束流式渲染：清掉挂起的渲染定时器，避免完成后再重绘 */
function cancelStreamRender(): void {
  streamRenderPending = false
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer)
    streamRenderTimer = null
  }
}

/* 思考过程流式渲染（节流） */
let reasoningRenderPending = false
function scheduleReasoningRender(): void {
  if (reasoningRenderPending) return
  reasoningRenderPending = true
  requestAnimationFrame(() => {
    reasoningRenderPending = false
    if (!chatState.streamEl) return
    if (!chatState.reasoningEl || !chatState.reasoningEl.isConnected) {
      const box = document.createElement('div')
      box.className = 'chat-reasoning'
      box.innerHTML = `
        <button class="chat-reasoning-toggle" type="button">
          <svg class="chat-reasoning-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="chat-reasoning-label">思考中…</span>
        </button>
        <pre class="chat-reasoning-body"></pre>`
      chatState.streamEl.parentElement!.insertBefore(
        box,
        chatState.streamEl.parentElement!.querySelector(':scope > .chat-bubble:last-of-type') as Node | null
      )
      chatState.reasoningEl = box
      box.querySelector('.chat-reasoning-toggle')?.addEventListener('click', () => box.classList.toggle('open'))
    }
    const body = chatState.reasoningEl.querySelector('.chat-reasoning-body')
    if (body) body.textContent = chatState.reasoningBuf
    const label = chatState.reasoningEl.querySelector('.chat-reasoning-label')
    if (label && !label.classList.contains('done')) label.textContent = '深度思考中…'
    scrollChatBottom(false)
  })
}

/* 发送消息（含附件） */
async function sendChatMessage(): Promise<void> {
  if (chatState.generating) return
  const ws = activeChatWs() || (findWs(chatState.wsId) as ChatWorkspace | null)
  if (!ws) return
  const input = $('#chatInput') as HTMLTextAreaElement
  const text = input.value.trim()
  const atts = chatState.attachments.slice()
  if (!text && !atts.length) return

  const cfg = chatConfig(ws)
  const useModel = (chatState.currentModel || cfg.model || '').trim()
  if (!cfg.baseUrl || !cfg.apiKey || !useModel) {
    toast('请先在工作区设置中配置 AI 对话接口', 'error')
    openWsSettings(ws)
    return
  }

  let s = currentSession()
  if (!s) {
    newChatSession()
    s = currentSession()
  }

  const userMsg: any = { role: 'user', content: text, ts: Date.now() }
  const savedAtts: any[] = []
  for (const a of atts) {
    const res = await chatApi.attachmentSave(
      a.kind === 'image' ? { kind: 'image', name: a.name, data: a.dataUrl } : { kind: 'file', name: a.name, data: a.text }
    )
    if (res.ok) {
      if (a.kind === 'image') {
        ;(userMsg.images = userMsg.images || []).push({ name: a.name, fileUrl: res.fileUrl })
        savedAtts.push({ kind: 'image', dataUrl: a.dataUrl })
      } else {
        ;(userMsg.files = userMsg.files || []).push({ name: a.name, text: String(a.text || '').slice(0, 4000) })
      }
    } else {
      toast('附件保存失败：' + (res.error || ''), 'error')
    }
  }

  s.messages.push(userMsg)
  if (s.title === '新对话') {
    s.title = (text || atts[0]?.name || '图片').slice(0, 24)
    renderChatSessionList()
  }
  input.value = ''
  autoGrowChatInput()
  clearChatAttachments()
  if (s.draft) {
    delete s.draft
    void saveChatSessionQuiet(s)
  }

  chatEmptyEl.style.display = 'none'
  $('#chatMessages').appendChild(buildChatMsgEl(userMsg))
  forceChatBottom()

  await runAssistantTurn(s, savedAtts, ws)
}

/* 重新生成最后一条 AI 回复 */
async function regenerateLast(): Promise<void> {
  if (chatState.generating) return
  const ws = activeChatWs() || (findWs(chatState.wsId) as ChatWorkspace | null)
  if (!ws) return
  const s = currentSession()
  if (!s || !s.messages.length) return
  while (s.messages.length && s.messages[s.messages.length - 1].role !== 'user') {
    s.messages.pop()
  }
  if (!s.messages.length) {
    renderChatMessages()
    return
  }
  renderChatMessages()
  const cfg = chatConfig(ws)
  if (!cfg.baseUrl || !cfg.apiKey || !(chatState.currentModel || cfg.model)) {
    toast('请先在工作区设置中配置 AI 对话接口', 'error')
    return
  }
  await runAssistantTurn(s, [], ws)
}

/* 一轮完整的 AI 回复（流式 + 工具调用） */
async function runAssistantTurn(s: any, imageParts: any[], ws: ChatWorkspace): Promise<void> {
  const cfg = chatConfig(ws)
  chatState.generating = true
  chatUserStop = false
  setChatGenerating(true)

  const drawOn = ($('#chatDrawEnabled') as HTMLInputElement).checked
  const searchOn = ($('#chatSearchEnabled') as HTMLInputElement).checked
  const model = chatState.currentModel || cfg.model
  const ctrl = thinkControlOf(model)
  let deepThink: boolean
  let thinkLevel: string
  if (ctrl === 'level') {
    thinkLevel = chatThinkLevel
    deepThink = thinkLevel !== 'off'
  } else if (ctrl === 'switch') {
    deepThink = ($('#chatDeepThink') as HTMLInputElement).checked
    thinkLevel = 'medium'
  } else {
    deepThink = false
    thinkLevel = 'off'
  }
  const toolFlags = { draw: drawOn, search: searchOn }

  try {
    const r1 = await chatStreamCall(s, { tools: toolFlags, deepThink, thinkLevel, imageParts }, ws)

    if (!r1.ok) {
      if (chatUserStop) {
        // 用户主动停止：保留已生成内容，仅标记停止，不当作错误
        if (chatState.streamBuf || chatState.reasoningBuf) {
          const stoppedMsg: any = { role: 'assistant', content: chatState.streamBuf || '', ts: Date.now(), stopped: true }
          if (chatState.reasoningBuf) stoppedMsg.reasoning = chatState.reasoningBuf
          s.messages.push(stoppedMsg)
        }
        return
      }
      const errMsg: any = {
        role: 'assistant',
        content: chatState.streamBuf || '（生成失败）',
        error: (r1 as any).error || '未知错误',
        ts: Date.now()
      }
      if (chatState.reasoningBuf) errMsg.reasoning = chatState.reasoningBuf
      s.messages.push(errMsg)
      toast('对话失败：' + errMsg.error, 'error', 5000)
      return
    }

    if ((r1 as any).toolUnsupported && (drawOn || searchOn || deepThink)) {
      toast('当前模型不支持该能力，本轮已自动降级为普通对话', 'success', 4000)
    }

    if (!r1.toolCalls || !r1.toolCalls.length) {
      if (r1.content || chatState.streamBuf || r1.reasoning || chatState.reasoningBuf) {
        const msg: any = { role: 'assistant', content: r1.content || chatState.streamBuf, ts: Date.now(), model: r1.model }
        if (r1.reasoning || chatState.reasoningBuf) msg.reasoning = r1.reasoning || chatState.reasoningBuf
        s.messages.push(msg)
      }
      return
    }

    const asstMsg: any = {
      role: 'assistant',
      content: r1.content || '',
      ts: Date.now(),
      model: r1.model,
      toolCalls: r1.toolCalls.map((tc: any) => ({ id: tc.id, type: 'function', function: tc.function }))
    }
    if (r1.reasoning || chatState.reasoningBuf) asstMsg.reasoning = r1.reasoning || chatState.reasoningBuf
    s.messages.push(asstMsg)

    for (const tc of r1.toolCalls) {
      let args: any = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        /* 容错 */
      }
      let result: any
      if (tc.function.name === 'web_search') {
        result = await executeChatSearch(args)
      } else {
        result = await executeChatDraw(args, tc, ws)
      }
      s.messages.push({ role: 'tool', toolCallId: tc.id, name: tc.function.name, content: result.summary })
      if (result.imageGen) {
        s.messages.push({ role: 'assistant', imageGen: result.imageGen, ts: Date.now() })
      }
    }

    const r2 = await chatStreamCall(s, { tools: { draw: false, search: false }, deepThink, thinkLevel, imageParts: [] }, ws)
    if (r2.ok && (r2.content || chatState.streamBuf)) {
      const msg: any = { role: 'assistant', content: r2.content || chatState.streamBuf, ts: Date.now(), model: r2.model }
      if (r2.reasoning || chatState.reasoningBuf) msg.reasoning = r2.reasoning || chatState.reasoningBuf
      s.messages.push(msg)
    }
  } finally {
    cancelStreamRender()
    chatState.generating = false
    setChatGenerating(false)
    chatState.streamEl = null
    chatState.reasoningEl = null
    chatState.streamingSessionId = null
    s.updatedAt = Date.now()
    await chatApi.sessionsSave(JSON.parse(JSON.stringify(s)))
    if (ws.id === chatState.wsId) renderChatMessages()
  }
}

/* 执行联网搜索 */
async function executeChatSearch(args: any): Promise<{ summary: string }> {
  const query = String(args.query || '').trim()
  if (!query) return { summary: '搜索失败：关键词为空。' }

  const el = document.createElement('div')
  el.className = 'chat-msg chat-msg-ai'
  el.innerHTML = `
    <div class="chat-bubble chat-drawing">
      <div class="chat-drawing-inner">
        <div class="pc-spinner"><span></span><span></span><span></span></div>
        <div class="chat-drawing-text"></div>
      </div>
    </div>`
  const textEl = el.querySelector('.chat-drawing-text') as HTMLElement
  textEl.textContent = `正在联网搜索：${query}`
  $('#chatMessages').appendChild(el)
  scrollChatBottom(true)

  try {
    const res = await chatApi.search({ query })
    el.remove()
    const result = (res && (res as any).result) || '搜索失败。'
    return { summary: (Array.isArray(result) ? JSON.stringify(result) : String(result)).slice(0, 6000) }
  } catch (err: any) {
    el.remove()
    return { summary: `搜索失败：${err.message || err}` }
  }
}

/* 一次流式调用（创建气泡、累积 chunk/reasoning、返回结果） */
async function chatStreamCall(
  s: any,
  opts: { tools: { draw: boolean; search: boolean }; deepThink: boolean; thinkLevel: string; imageParts: any[] },
  ws: ChatWorkspace
): Promise<any> {
  chatState.streamBuf = ''
  chatState.reasoningBuf = ''
  chatState.streamingSessionId = s.id

  const aiEl = document.createElement('div')
  aiEl.className = 'chat-msg chat-msg-ai'
  const bubble = document.createElement('div')
  bubble.className = 'chat-bubble'
  // 阶段反馈：等待首个 token 前显示“正在思考…”（小说模式显示“正在构思小说…”）
  if (novelModeOn()) {
    bubble.classList.add('chat-novel-bubble')
    bubble.innerHTML = `
      <div class="chat-novel">
        <div class="chat-novel-bar">
          <span class="chat-novel-tag"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2V5Z" stroke-linejoin="round"/><path d="M8 7h8M8 10.5h6" stroke-linecap="round"/></svg>小说阅读</span>
          <span class="chat-novel-meta"></span>
        </div>
        <h2 class="chat-novel-title">构思中…</h2>
        <div class="chat-novel-body"><span class="chat-stream-waiting"><span class="chat-stream-dot"></span><span class="chat-stream-waiting-text">正在构思小说…</span></span></div>
      </div>`
  } else {
    bubble.innerHTML = '<span class="chat-stream-waiting"><span class="chat-stream-dot"></span><span class="chat-stream-waiting-text">正在思考…</span></span>'
  }
  aiEl.appendChild(bubble)
  $('#chatMessages').appendChild(aiEl)
  chatState.streamEl = bubble
  chatState.reasoningEl = null
  scrollChatBottom(true)

  const cfg = chatConfig(ws)
  const useModel = (chatState.currentModel || cfg.model || '').trim()
  const messages = buildApiMessages(s, opts.imageParts, ws)
  const res = await chatApi.send({
    sessionId: s.id,
    systemPrompt: s.systemPrompt || cfg.systemPrompt || '',
    messages,
    tools: opts.tools,
    deepThink: !!opts.deepThink,
    thinkLevel: opts.thinkLevel || (opts.deepThink ? 'medium' : 'off'),
    model: useModel,
    cfg: {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: useModel,
      temperature: cfg.temperature,
      contextRounds: cfg.contextRounds
    }
  })

  if (!res.ok) {
    if (bubble.classList.contains('chat-novel-bubble')) {
      updateNovelStream(bubble, chatState.streamBuf || '')
    } else {
      bubble.innerHTML = renderMarkdown(chatState.streamBuf || '（生成失败）')
    }
    const err = document.createElement('div')
    err.className = 'chat-msg-error'
    err.textContent = (res as any).error || '未知错误'
    bubble.appendChild(err)
  } else if (!chatState.streamBuf && !chatState.reasoningBuf) {
    aiEl.remove()
  }
  return res
}

/* 把会话消息转成 API 消息格式 */
function buildApiMessages(s: any, imageParts: any[], ws: ChatWorkspace): any[] {
  const cfg = chatConfig(ws)
  const msgs: any[] = []
  const list = s.messages.slice(-cfg.contextRounds)
  const lastUserIdx = list.map((m: any) => m.role).lastIndexOf('user')

  list.forEach((m: any, i: number) => {
    if (m.role === 'user') {
      let text = m.content || ''
      if (m.files && m.files.length) {
        m.files.forEach((f: any) => {
          text += `\n\n[文件 ${f.name}]\n${(f.text || '').slice(0, 4000)}`
        })
      }
      const hasImages = m.images && m.images.length
      if (hasImages && i === lastUserIdx && imageParts && imageParts.length) {
        const content: any[] = [{ type: 'text', text: text || '请看这张图片' }]
        imageParts.forEach((p) => content.push({ type: 'image_url', image_url: { url: p.dataUrl } }))
        msgs.push({ role: 'user', content })
      } else {
        if (hasImages) text += '\n[用户发送过图片]'
        msgs.push({ role: 'user', content: text })
      }
    } else if (m.role === 'tool') {
      msgs.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content })
    } else if (m.toolCalls) {
      msgs.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc: any) => ({ id: tc.id, type: 'function', function: tc.function }))
      })
    } else {
      const text = m.imageGen ? `已为用户生成图片：${m.imageGen.prompt || ''}` : m.content || ''
      msgs.push({ role: 'assistant', content: text })
    }
  })
  return msgs
}

/* AI 绘图使用的图片工作区 */
function pickDrawWs(chatWs: ChatWorkspace): any {
  const images = store.workspaces.filter((w) => w.type === 'image')
  if (!images.length) return null
  const id = chatWs.chat && chatWs.chat.drawWsId
  if (id) {
    const hit = images.find((w) => w.id === id)
    if (hit) return hit
  }
  return images.find((w) => /gpt-image/i.test(String(w.model || ''))) || images[0]
}

/* 执行 AI 绘图 */
async function executeChatDraw(args: any, _tc: any, ws: ChatWorkspace): Promise<{ summary: string; imageGen?: any }> {
  const prompt = String(args.prompt || '').trim()
  const size = args.size || '1:1'
  if (!prompt) return { summary: '绘图失败：提示词为空。' }

  const cfg = chatConfig(ws)
  const drawWs = pickDrawWs(ws)
  const drawBaseUrl = (drawWs && String(drawWs.baseUrl).trim()) || cfg.baseUrl
  const drawApiKey = (drawWs && String(drawWs.apiKey).trim()) || cfg.apiKey
  const drawModel = (cfg.drawModel || '').trim() || (drawWs && String(drawWs.model).trim()) || 'gpt-image-2'
  if (!drawApiKey) {
    return { summary: '绘图失败：请先在图片工作区或聊天工作区设置中配置 API 密钥。' }
  }
  const provider = { preset: detectPreset(drawBaseUrl), baseUrl: drawBaseUrl, apiKey: drawApiKey }

  const drawEl = document.createElement('div')
  drawEl.className = 'chat-msg chat-msg-ai'
  drawEl.innerHTML = `
    <div class="chat-bubble chat-drawing">
      <div class="chat-drawing-inner">
        <div class="pc-spinner"><span></span><span></span><span></span></div>
        <div class="chat-drawing-text"></div>
      </div>
    </div>`
  const textEl = drawEl.querySelector('.chat-drawing-text') as HTMLElement
  textEl.textContent = `AI 正在绘制：${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`
  $('#chatMessages').appendChild(drawEl)
  scrollChatBottom(true)

  const jobId = 'chatdraw-' + Date.now()
  try {
    const isBananaStyle = (drawWs && drawWs.engine === 'banana') || /banana|gemini/i.test(drawModel)
    const res = await img.generate({
      jobId,
      prompt,
      wsId: ws.id,
      model: drawModel,
      size,
      n: 1,
      resolution: '2k',
      engine: isBananaStyle ? 'banana' : 'gpt',
      provider,
      baseUrl: drawBaseUrl,
      apiKey: drawApiKey
    })
    drawEl.remove()
    if (!res.ok || !res.images || !res.images.length) {
      toast('AI 绘图失败：' + (res.error || '未返回图片'), 'error', 5000)
      return { summary: `绘图失败：${res.error || '未返回图片'}` }
    }
    const im = res.images[0]
    const imageGen = { fileUrl: im.fileUrl || im.remoteUrl, prompt, size }
    $('#chatMessages').appendChild(buildChatMsgEl({ role: 'assistant', imageGen }))
    scrollChatBottom(false)
    return { summary: `图片已生成并展示给用户（比例 ${size}，提示词：${prompt}）。`, imageGen }
  } catch (err: any) {
    drawEl.remove()
    return { summary: `绘图失败：${err.message || err}` }
  }
}

function setChatGenerating(on: boolean): void {
  if (!on) chatUserStop = false
  $('#chatSendBtn').style.display = on ? 'none' : ''
  $('#chatStopBtn').style.display = on ? '' : 'none'
  updateChatSendState()
}

/* 发送按钮空态禁用：无法输入内容且非生成状态时置灰 */
function updateChatSendState(): void {
  const input = $('#chatInput') as HTMLTextAreaElement
  const has = !!(input && input.value.trim()) || chatState.attachments.length > 0
  const btn = $('#chatSendBtn') as HTMLButtonElement
  btn.classList.toggle('disabled', !has || chatState.generating)
}

function autoGrowChatInput(): void {
  const el = $('#chatInput') as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 224) + 'px'
}

/* ============ E. 附件管理 ============ */
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yml', 'yaml', 'log', 'ini', 'sh', 'bat']

function handleChatFiles(files: File[]): void {
  const MAX_IMG = 6
  files.forEach((file) => {
    const isImage = /^image\//.test(file.type)
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const isText = !isImage && TEXT_EXTS.includes(ext)

    if (isImage) {
      if (chatState.attachments.filter((a) => a.kind === 'image').length >= MAX_IMG) {
        toast(`最多附加 ${MAX_IMG} 张图片`, 'error')
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        toast('图片过大（超过 10MB）：' + file.name, 'error')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        chatState.attachments.push({ kind: 'image', name: file.name, dataUrl: reader.result })
        renderChatAttachments()
      }
      reader.readAsDataURL(file)
    } else if (isText) {
      if (file.size > 200 * 1024) {
        toast('文件过大（超过 200KB）：' + file.name, 'error')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        chatState.attachments.push({ kind: 'file', name: file.name, text: reader.result })
        renderChatAttachments()
      }
      reader.readAsText(file)
    } else {
      toast('仅支持图片或文本类文件：' + file.name, 'error')
    }
  })
}

function renderChatAttachments(): void {
  const strip = $('#chatAttachStrip')
  strip.innerHTML = ''
  if (!chatState.attachments.length) {
    strip.style.display = 'none'
    updateChatSendState()
    return
  }
  strip.style.display = 'flex'
  chatState.attachments.forEach((a, i) => {
    const elx = document.createElement('div')
    elx.className = 'chat-attach-item'
    if (a.kind === 'image') {
      elx.innerHTML = `<img src="${a.dataUrl}" alt=""><button class="chat-attach-del" title="移除">✕</button>`
    } else {
      elx.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke-linejoin="round"/><path d="M14 3v5h5" stroke-linejoin="round"/></svg><span class="chat-attach-name"></span><button class="chat-attach-del" title="移除">✕</button>`
      ;(elx.querySelector('.chat-attach-name') as HTMLElement).textContent = a.name
    }
    ;(elx.querySelector('.chat-attach-del') as HTMLButtonElement).addEventListener('click', () => {
      chatState.attachments.splice(i, 1)
      renderChatAttachments()
    })
    strip.appendChild(elx)
  })
  updateChatSendState()
}

function clearChatAttachments(): void {
  chatState.attachments = []
  renderChatAttachments()
}

/** 工作区设置弹窗入口（由 modals 注入，避免循环依赖）。 */
let _openWsSettings: ((ws: ChatWorkspace) => void) | null = null
export function setOpenWsSettings(fn: (ws: ChatWorkspace) => void): void {
  _openWsSettings = fn
}
function openWsSettings(ws: ChatWorkspace | null): void {
  if (ws && _openWsSettings) _openWsSettings(ws)
}

export { bindChatWorkspace }