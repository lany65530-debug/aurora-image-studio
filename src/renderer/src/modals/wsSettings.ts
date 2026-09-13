/**
 * 渲染层 · 工作区设置弹窗
 * ------------------------------------------------------------
 * 每个工作区独立配置：名称 / 图标 / 生图引擎（GPT / Banana）/ 接口地址 / 密钥 /
 * 模型（图片渠道分组 / 对话模型）/ 高级自定义 JSON / 保存目录 / 系统提示 / 温度。
 * 提供「拉取模型 / 测试连接 / 保存」。
 */
import {
  $,
  state,
  store,
  findWs,
  persistWorkspaces,
  activeImageWs,
  activeChatWs,
  escapeHtml,
  isImageChannel,
  type ImageWorkspace,
  type ChatWorkspace,
  type Workspace
} from '../state/store'
import { img, chat, provider as providerApi, dir } from '../state/aurora'
import { detectPreset } from '../state/provider'
import { toast } from '../components/toast'
import { readIconFile, renderIconPreview } from '../components/icon'
import { registerOverlay, openOverlay, closeOverlay } from './overlay'
import { renderSidebar } from '../nav'
import { bindCreateWorkspace } from '../workspaces/image'
import { bindChatWorkspace, chatModelsCache } from '../workspaces/chat'

/* ===== 弹窗状态 ===== */
const wsModalState: {
  wsId: string
  icon: string | null
  channels: any[] // 图片工作区：[{id, owned_by, image}]
  chatModels: string[] // 聊天工作区
  showAll: boolean
  saveDir: string
} = {
  wsId: '',
  icon: null,
  channels: [],
  chatModels: [],
  showAll: false,
  saveDir: ''
}

let wsEngineSel: 'gpt' | 'banana' = 'gpt'

export function openWsModal(ws: Workspace | null | undefined): void {
  if (!ws) return
  wsModalState.wsId = ws.id
  wsModalState.icon = ws.icon || null
  wsModalState.channels = Array.isArray((ws as ImageWorkspace).channels) ? (ws as ImageWorkspace).channels.slice() : []
  wsModalState.chatModels = []
  wsModalState.showAll = !!(ws as ImageWorkspace).showAllModels
  wsModalState.saveDir = (ws as ImageWorkspace).saveDir || ''

  const isImage = ws.type === 'image'
  $('#wsModalTitle').textContent = '工作区设置 · ' + ws.name
  ;($('.ws-only-image') as HTMLElement).style.display = isImage ? '' : 'none'
  ;($('.ws-only-chat') as HTMLElement).style.display = isImage ? 'none' : ''

  ;($('#wsName') as HTMLInputElement).value = ws.name
  ;($('#wsBaseUrl') as HTMLInputElement).value = ws.baseUrl || ''
  const keyInput = $('#wsApiKey') as HTMLInputElement
  keyInput.value = ws.apiKey || ''
  keyInput.type = 'password'
  ;($('#wsProviderJson') as HTMLTextAreaElement).value = ''
  ;($('#wsAllowPublicUpload') as HTMLInputElement).checked = (ws.provider as Record<string, unknown> | undefined)?.allowPublicUpload === true
  ;($('#wsConnectionDetails') as HTMLDetailsElement).open = !ws.apiKey?.trim() || !ws.baseUrl?.trim()
  ;($('#wsModel') as HTMLInputElement).value = ws.model || ''
  ;($('#wsModelSearch') as HTMLInputElement).value = ''
  renderIconPreview($('#wsIconPreview'), ws.name, wsModalState.icon)

  if (isImage) {
    setWsEngineUI((ws as ImageWorkspace).engine || 'gpt')
    updateWsSaveDirUI()
    const prov = (ws as ImageWorkspace).provider
    ;($('#wsProviderJson') as HTMLTextAreaElement).value =
      prov && (prov.preset === 'custom' || Object.keys(prov).some((key) => !['preset', 'allowPublicUpload'].includes(key))) ? JSON.stringify(prov, null, 2) : ''
    ;($('#wsAdvBody') as HTMLElement).style.display = 'none'
    $('#wsAdvToggle').setAttribute('aria-expanded', 'false')
    ;($('#wsAdvToggle .adv-arrow') as HTMLElement).textContent = '▾'
    ;($('#wsModelBox') as HTMLElement).style.display = wsModalState.channels.length ? 'block' : 'none'
    renderWsModelList()
  } else {
    const c = (ws as ChatWorkspace).chat || {}
    ;($('#wsSystemPrompt') as HTMLTextAreaElement).value = c.systemPrompt || ''
    ;($('#wsTemp') as HTMLInputElement).value = String(typeof c.temperature === 'number' ? c.temperature : 0.7)
    ;($('#wsTempVal') as HTMLElement).textContent = ($('#wsTemp') as HTMLInputElement).value
    fillDrawWsOptions((c as any).drawWsId)
    ;($('#wsDrawModel') as HTMLInputElement).value = c.drawModel || ''
    ;($('#wsModelBox') as HTMLElement).style.display = 'none'
    // 顺便填充已缓存的聊天模型
    wsModalState.chatModels = chatModelsCache.get(ws.id) || []
    if (wsModalState.chatModels.length) {
      ;($('#wsModelBox') as HTMLElement).style.display = 'block'
      renderWsModelList()
    }
  }
  updateDomainHints()
  openOverlay($('#wsModal'))
}

function updateDomainHints(): void {
  const baseUrl = ($('#wsBaseUrl') as HTMLInputElement).value.trim()
  let destination = '未填写接口地址，将使用接口预设地址'
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      destination = /^https?:$/.test(url.protocol) && !url.username && !url.password
        ? `请求及密钥将发送至 ${url.hostname}${url.protocol === 'http:' ? '（HTTP 未加密，建议使用 HTTPS）' : ''}`
        : '接口地址应为不含用户名和密码的 HTTP(S) 地址'
    } catch {
      destination = '接口地址格式无效，请填写完整的 HTTPS 地址'
    }
  }
  $('#wsDomainHint').textContent = `密钥保存在本机；${destination}。请确认域名可信。`
  let hosts = ['img.remit.ee', 'tmpfiles.org', 'catbox.moe', 'uguu.se', '0x0.st']
  try {
    const config = JSON.parse(($('#wsProviderJson') as HTMLTextAreaElement).value || '{}')
    if (Array.isArray(config.refHosts) && config.refHosts.length) {
      hosts = config.refHosts.map((host: { url: string }) => new URL(host.url).hostname)
    }
  } catch {
    hosts = ['自定义配置无效，请先检查 JSON 和图床地址']
  }
  $('#wsUploadHint').textContent = `默认关闭。启用后可能上传至：${hosts.join('、')}。参考图可能公开可访问，请勿上传敏感图片；开关优先于 JSON 中的 allowPublicUpload。`
}

/* ===== 生图引擎切换（GPT / Banana） ===== */
function setWsEngineUI(engine: 'gpt' | 'banana'): void {
  wsEngineSel = engine
  $('#wsEngineGpt').classList.toggle('selected', engine === 'gpt')
  $('#wsEngineBanana').classList.toggle('selected', engine === 'banana')
}

/* ===== 聊天工作区：AI 绘图工作区选项 ===== */
function fillDrawWsOptions(selected: string | undefined): void {
  const sel = $('#wsDrawWs') as HTMLSelectElement
  if (!sel) return
  const images = store.workspaces.filter((w): w is ImageWorkspace => w.type === 'image')
  sel.innerHTML = ''
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = '自动（优先 gpt-image 图片工作区）'
  sel.appendChild(auto)
  images.forEach((w) => {
    const op = document.createElement('option')
    op.value = w.id
    op.textContent = w.name + (w.model ? ' · ' + w.model : '')
    sel.appendChild(op)
  })
  sel.value = images.some((w) => w.id === selected) ? selected || '' : ''
}

function updateWsSaveDirUI(): void {
  const txt = $('#wsSaveDirText')
  const box = $('#wsSaveDirPath')
  if (wsModalState.saveDir) {
    txt.textContent = wsModalState.saveDir
    box.title = wsModalState.saveDir
  } else {
    txt.textContent = '默认图片文件夹'
    box.title = ''
  }
}

/* ===== 由弹窗表单构造 provider（测试连接 / 拉取渠道用） ===== */
function collectProviderFromForm(): Record<string, any> {
  const raw = ($('#wsProviderJson') as HTMLTextAreaElement).value.trim()
  const baseUrl = ($('#wsBaseUrl') as HTMLInputElement).value.trim()
  let preset = detectPreset(baseUrl)
  let p: Record<string, any> = { preset }
  if (raw) {
    try {
      p = Object.assign({ preset: 'custom' }, JSON.parse(raw))
      preset = 'custom'
    } catch (e) {
      toast('自定义接口配置格式有误：' + (e as Error).message, 'error')
    }
  }
  p.baseUrl = baseUrl || (state.presets && state.presets[preset] ? state.presets[preset].baseUrl : '') || ''
  p.apiKey = ($('#wsApiKey') as HTMLInputElement).value.trim()
  p.allowPublicUpload = ($('#wsAllowPublicUpload') as HTMLInputElement).checked
  return p
}

/* ===== 拉取模型列表 ===== */
async function fetchModels(): Promise<void> {
  const ws = findWs(wsModalState.wsId)
  if (!ws) return
  const btn = $('#wsFetchModelsBtn')
  const apiKey = ($('#wsApiKey') as HTMLInputElement).value.trim()
  const baseUrl = ($('#wsBaseUrl') as HTMLInputElement).value.trim()
  if (!apiKey) {
    toast('请先填写 API Key', 'error')
    return
  }

  btn.classList.add('loading')
  try {
    if (ws.type === 'chat') {
      const res = (await chat.modelsList({ baseUrl, apiKey })) as any
      if (!res.ok) return toast('获取模型失败：' + (res.error || '未知错误'), 'error', 4500)
      wsModalState.chatModels = res.models || []
      chatModelsCache.set(ws.id, wsModalState.chatModels)
      if (wsModalState.chatModels.length) {
        ;($('#wsModelBox') as HTMLElement).style.display = 'block'
      }
      renderWsModelList()
      toast(`识别到 ${wsModalState.chatModels.length} 个对话模型`, 'success')
    } else {
      const provider = collectProviderFromForm()
      const res = (await img.modelsList({ apiKey, baseUrl, provider })) as any
      if (!res.ok) return toast('获取渠道失败：' + (res.error || '未知错误'), 'error', 4500)
      if (!res.models || !res.models.length) return toast('该密钥下未发现可用渠道', 'error')
      wsModalState.channels = res.models
      ;($('#wsModelBox') as HTMLElement).style.display = 'block'
      renderWsModelList()
      const imgCount = res.models.filter(isImageChannel).length
      toast(`识别到 ${res.models.length} 个渠道，其中 ${imgCount} 个图片模型`, 'success', 4000)
    }
  } finally {
    btn.classList.remove('loading')
  }
}

/* ===== 模型 / 渠道列表渲染 ===== */
const VARIANT_RE =
  /[\s\-_/|]*(官转|官方|逆向|中转|高速|极速|快速|稳定|高清|标准|默认|镜像|付费|免费|测试|auth|official|mirror|pro|plus|max|mini|nano|turbo|flash|hd|\d+\.?\d*k|\d+x\d+|v\d+)\b.*$/gi

function baseModelKey(id: string): string {
  const key = String(id).replace(VARIANT_RE, '').replace(/[\s\-_/|]+$/, '').trim()
  return key || String(id)
}
function variantLabel(id: string, base: string): string {
  const tag = String(id).slice(base.length).replace(/^[\s\-_/|]+/, '').trim()
  return tag || '默认'
}
function groupChannels(list: any[]): Array<{ base: string; items: any[] }> {
  const map = new Map<string, any[]>()
  list.forEach((m) => {
    const base = baseModelKey(m.id)
    if (!map.has(base)) map.set(base, [])
    map.get(base)!.push(m)
  })
  return Array.from(map.entries()).map(([base, items]) => ({ base, items }))
}

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12l5 5 9-10" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function renderWsModelList(): void {
  const ws = findWs(wsModalState.wsId)
  const list = $('#wsModelList')
  const count = $('#wsModelCount')
  if (!ws || !list) return
  list.innerHTML = ''

  if (ws.type === 'chat') {
    // 聊天工作区：纯字符串模型列表
    ;($('#wsModelBar') as HTMLElement).style.display = 'none'
    const q = ($('#wsModelSearch') as HTMLInputElement).value.trim().toLowerCase()
    const models = wsModalState.chatModels.filter((m) => !q || m.toLowerCase().includes(q))
    count.textContent = wsModalState.chatModels.length ? `${models.length}/${wsModalState.chatModels.length}` : ''
    if (!models.length) {
      const e = document.createElement('div')
      e.className = 'channel-empty'
      e.textContent = wsModalState.chatModels.length ? '没有匹配的模型' : '尚无模型列表，点击右侧按钮拉取'
      list.appendChild(e)
      return
    }
    const cur = ($('#wsModel') as HTMLInputElement).value.trim()
    models.forEach((m) => {
      const el = document.createElement('div')
      el.className = 'channel-item' + (m === cur ? ' active' : '')
      el.innerHTML = `
        <span class="channel-avatar">${(m[0] || '?').toUpperCase()}</span>
        <span class="channel-meta"><span class="channel-id">${escapeHtml(m)}</span></span>
        <span class="channel-check">${CHECK_SVG}</span>`
      el.title = m
      el.addEventListener('click', () => {
        ;($('#wsModel') as HTMLInputElement).value = m
        renderWsModelList()
      })
      list.appendChild(el)
    })
    return
  }

  // 图片工作区：分组渠道列表
  ;($('#wsModelBar') as HTMLElement).style.display = ''
  const q = ($('#wsModelSearch') as HTMLInputElement).value.trim().toLowerCase()
  const current = ($('#wsModel') as HTMLInputElement).value.trim()
  const pool = wsModalState.showAll ? wsModalState.channels : wsModalState.channels.filter(isImageChannel)
  const filtered = pool.filter((m) => m.id.toLowerCase().includes(q))
  const imgCount = wsModalState.channels.filter(isImageChannel).length
  count.textContent = `${filtered.length}/${pool.length}`

  const toggle = $('#wsModelFilterToggle')
  toggle.classList.toggle('on', wsModalState.showAll)
  toggle.textContent = wsModalState.showAll
    ? `显示全部模型 (${wsModalState.channels.length})`
    : `仅图片模型 (${imgCount})`

  if (!filtered.length) {
    const e = document.createElement('div')
    e.className = 'channel-empty'
    e.textContent = wsModalState.showAll ? '没有匹配的渠道' : '没有匹配的图片模型，可切换为「显示全部模型」'
    list.appendChild(e)
    return
  }

  const groups = groupChannels(filtered)
  groups.forEach((g) => {
    const multi = g.items.length > 1
    const group = document.createElement('div')
    group.className = 'channel-group'

    if (multi) {
      const head = document.createElement('div')
      head.className = 'channel-group-head'
      head.innerHTML = `<span class="channel-avatar">${escapeHtml((g.base[0] || '?').toUpperCase())}</span>
        <span class="channel-group-name">${escapeHtml(g.base)}</span>
        <span class="channel-group-count">${g.items.length} 个渠道</span>`
      group.appendChild(head)
    }

    g.items.forEach((m) => {
      const item = document.createElement('div')
      item.className = 'channel-item' + (m.id === current ? ' active' : '') + (multi ? ' variant' : '')
      const label = multi ? variantLabel(m.id, g.base) : m.id
      const initial = (m.id[0] || '?').toUpperCase()
      item.innerHTML = `
        ${multi ? '<span class="channel-variant-dot"></span>' : `<span class="channel-avatar">${initial}</span>`}
        <span class="channel-meta">
          <span class="channel-id">${escapeHtml(label)}</span>
          ${!multi && m.owned_by ? `<span class="channel-owner">${escapeHtml(m.owned_by)}</span>` : ''}
          ${multi ? `<span class="channel-owner">${escapeHtml(m.id)}</span>` : ''}
        </span>
        <span class="channel-check">${CHECK_SVG}</span>`
      item.addEventListener('click', () => {
        ;($('#wsModel') as HTMLInputElement).value = m.id
        renderWsModelList()
      })
      group.appendChild(item)
    })
    list.appendChild(group)
  })
}

/* ===== 保存 ===== */
function saveWsSettings(): void {
  const ws = findWs(wsModalState.wsId)
  if (!ws) return
  const name = ($('#wsName') as HTMLInputElement).value.trim()
  if (!name) {
    toast('请填写工作区名称', 'error')
    return
  }
  const raw = ($('#wsProviderJson') as HTMLTextAreaElement).value.trim()
  if (ws.type === 'image' && raw) {
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象')
    } catch (e) {
      toast('自定义接口配置格式有误：' + (e as Error).message, 'error')
      return
    }
  }

  ws.name = name
  ws.icon = wsModalState.icon
  ws.baseUrl = ($('#wsBaseUrl') as HTMLInputElement).value.trim()
  ws.apiKey = ($('#wsApiKey') as HTMLInputElement).value.trim()
  ws.model = ($('#wsModel') as HTMLInputElement).value.trim()
  ws.updatedAt = Date.now()

  if (ws.type === 'image') {
    ws.engine = wsEngineSel || 'gpt'
    ws.saveDir = wsModalState.saveDir || ''
    ws.channels = wsModalState.channels
    ws.showAllModels = wsModalState.showAll
    if (raw) {
      try {
        ws.provider = Object.assign({ preset: 'custom' }, JSON.parse(raw))
      } catch {
        /* 已校验 */
      }
    } else {
      ws.provider = { preset: detectPreset(ws.baseUrl) }
    }
    ws.provider!.allowPublicUpload = ($('#wsAllowPublicUpload') as HTMLInputElement).checked
  } else {
    ws.chat = Object.assign({}, ws.chat, {
      systemPrompt: ($('#wsSystemPrompt') as HTMLTextAreaElement).value.trim(),
      temperature: parseFloat(($('#wsTemp') as HTMLInputElement).value) || 0.7,
      drawWsId: ($('#wsDrawWs') as HTMLSelectElement).value || '',
      drawModel: ($('#wsDrawModel') as HTMLInputElement).value.trim()
    })
  }

  persistWorkspaces()
  renderSidebar()
  closeOverlay($('#wsModal'))

  // 若正在查看该工作区，立即重绑定视图
  if (store.view === 'workspace' && ws.id === store.activeId) {
    if (ws.type === 'image') bindCreateWorkspace(ws as ImageWorkspace)
    else void bindChatWorkspace(ws as ChatWorkspace)
  }
  toast('工作区设置已保存', 'success')
}

/* ===== 测试连接 ===== */
async function testConnection(): Promise<void> {
  const ws = findWs(wsModalState.wsId)
  if (!ws) return
  const btn = $('#wsTestBtn')
  const apiKey = ($('#wsApiKey') as HTMLInputElement).value.trim()
  const baseUrl = ($('#wsBaseUrl') as HTMLInputElement).value.trim()
  if (!apiKey) {
    toast('请先填写 API Key', 'error')
    return
  }

  btn.classList.add('testing')
  btn.textContent = '测试中…'
  try {
    let ok = false
    let msg = ''
    if (ws.type === 'chat') {
      const res = (await chat.modelsList({ baseUrl, apiKey })) as any
      ok = !!res.ok
      if (ok) {
        wsModalState.chatModels = res.models || []
        chatModelsCache.set(ws.id, wsModalState.chatModels)
        if (wsModalState.chatModels.length) {
          ;($('#wsModelBox') as HTMLElement).style.display = 'block'
          renderWsModelList()
        }
        msg = res.models && res.models.length ? `发现 ${res.models.length} 个模型` : ''
      } else {
        msg = res.error || '未知错误'
      }
    } else {
      const res = (await providerApi.test({
        apiKey,
        baseUrl,
        model: ($('#wsModel') as HTMLInputElement).value.trim() || 'gpt-image-2',
        provider: collectProviderFromForm()
      })) as any
      ok = !!res.ok
      msg = ok ? (res.count ? `发现 ${res.count} 个模型` : '') : res.error || '未知错误'
    }
    if (ok) toast('连接成功，密钥有效' + (msg ? `（${msg}）` : '') + '，测试不消耗生图额度', 'success')
    else toast('连接失败：' + msg, 'error', 4500)
  } finally {
    btn.classList.remove('testing')
    btn.textContent = '测试连接'
  }
}

/* ===== 装配（模块加载时执行一次） ===== */
export function initWsSettings(): void {
  registerOverlay($('#wsModal'))
  $('#wsModalClose').addEventListener('click', () => closeOverlay($('#wsModal')))

  // 头部齿轮入口：创作页 / 聊天页
  $('#createWsSettingsBtn').addEventListener('click', () => openWsModal(activeImageWs()))
  $('#chatWsSettingsBtn').addEventListener('click', () => openWsModal(activeChatWs()))

  // 引擎切换
  $('#wsEngineGpt').addEventListener('click', () => setWsEngineUI('gpt'))
  $('#wsEngineBanana').addEventListener('click', () => setWsEngineUI('banana'))

  // 名称联动字母头像
  ;($('#wsName') as HTMLInputElement).addEventListener('input', () => {
    if (!wsModalState.icon) renderIconPreview($('#wsIconPreview'), ($('#wsName') as HTMLInputElement).value, null)
  })

  // 图标上传 / 重置
  $('#wsIconUploadBtn').addEventListener('click', () => ($('#wsIconInput') as HTMLInputElement).click())
  ;($('#wsIconInput') as HTMLInputElement).addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files && (e.target as HTMLInputElement).files![0]
    if (f) {
      readIconFile(f, (dataUrl) => {
        wsModalState.icon = dataUrl
        renderIconPreview($('#wsIconPreview'), ($('#wsName') as HTMLInputElement).value, dataUrl)
      })
    }
    ;(e.target as HTMLInputElement).value = ''
  })
  $('#wsIconResetBtn').addEventListener('click', () => {
    wsModalState.icon = null
    renderIconPreview($('#wsIconPreview'), ($('#wsName') as HTMLInputElement).value, null)
  })

  // 密钥显示切换
  $('#wsRevealKey').addEventListener('click', () => {
    const input = $('#wsApiKey') as HTMLInputElement
    input.type = input.type === 'password' ? 'text' : 'password'
  })

  // 温度滑杆
  ;($('#wsTemp') as HTMLInputElement).addEventListener('input', () => {
    ;($('#wsTempVal') as HTMLElement).textContent = ($('#wsTemp') as HTMLInputElement).value
  })

  // 高级自定义配置折叠
  $('#wsAdvToggle').addEventListener('click', () => {
    const body = $('#wsAdvBody') as HTMLElement
    body.style.display = body.style.display === 'none' ? 'block' : 'none'
    ;($('#wsAdvToggle .adv-arrow') as HTMLElement).textContent = body.style.display === 'none' ? '▾' : '▴'
    $('#wsAdvToggle').setAttribute('aria-expanded', String(body.style.display !== 'none'))
  })
  $('#wsBaseUrl').addEventListener('input', updateDomainHints)
  $('#wsProviderJson').addEventListener('input', updateDomainHints)

  // 保存目录
  $('#wsChooseDirBtn').addEventListener('click', async () => {
    const res = await dir.choose()
    if (res.ok) {
      wsModalState.saveDir = (res as any).dir || ''
      updateWsSaveDirUI()
      toast('保存目录已更新', 'success')
    } else if (!(res as any).canceled) {
      toast('选择目录失败', 'error')
    }
  })
  $('#wsOpenDirBtn').addEventListener('click', () => {
    void dir.open(wsModalState.saveDir)
  })

  // 拉取模型
  $('#wsFetchModelsBtn').addEventListener('click', () => void fetchModels())

  // 模型搜索 / 图片模型过滤
  ;($('#wsModelSearch') as HTMLInputElement).addEventListener('input', () => renderWsModelList())
  $('#wsModelFilterToggle').addEventListener('click', () => {
    wsModalState.showAll = !wsModalState.showAll
    renderWsModelList()
  })

  // 保存 / 测试
  $('#wsSaveBtn').addEventListener('click', () => saveWsSettings())
  $('#wsTestBtn').addEventListener('click', () => void testConnection())
}
