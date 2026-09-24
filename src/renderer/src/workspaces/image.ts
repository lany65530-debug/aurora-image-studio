/**
 * 渲染层 · 图片工作区（create 视图）
 * ------------------------------------------------------------
 * 负责创作视图的完整能力：提示词、参考图（图生图）、工具栏弹层、
 * 模型渠道选择、生成任务（多任务并行 + 进度卡片）、结果历史与一键引用提示词。
 * 工作区设置弹窗通过 modals/wsSettings 协作（保存后重绑定本视图）。
 */
import {
  $,
  $$,
  state,
  store,
  persistWorkspaces,
  wsTransient,
  activeImageWs,
  isImageChannel,
  escapeHtml,
  type ImageWorkspace
} from '../state/store'
import { img, library } from '../state/aurora'
import { wsProvider } from '../state/provider'
import { toast } from '../components/toast'
import { buildProgressCard, type ProgressCardHandle } from '../components/progressCard'
import { buildCard, sizeToShape } from '../components/imageCard'
import { appendInChunks } from '../components/chunkedRender'

/** 结果区渲染代次：切换工作区 / 重新渲染时让上一批未挂载的卡片立即作废。 */
let resultRenderToken = 0

/** 模型渠道搜索防抖：避免每次按键都重建选项列表。 */
let modelSearchTimer: ReturnType<typeof setTimeout> | null = null

/* ===== 提示词 ===== */
const promptEl = $('#prompt') as HTMLTextAreaElement

function autoGrow(): void {
  promptEl.style.height = 'auto'
  promptEl.style.height = Math.min(promptEl.scrollHeight, 260) + 'px'
}
promptEl.addEventListener('input', autoGrow)

$$<HTMLElement>('#promptChips .feature-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    const add = pill.dataset.append
    if (!add) return
    const cur = promptEl.value.trim()
    promptEl.value = cur ? `${cur}, ${add}` : add
    autoGrow()
    promptEl.focus()
  })
})

/* ===== 参考图上传（图生图，按工作区瞬态保存） ===== */
const refInput = $('#refInput') as HTMLInputElement
const MAX_REF = 14 // 与主进程 image:edit 的截断上限一致
const MAX_REF_SIZE = 10 * 1024 * 1024 // 单张参考图上限 10MB

$('#uploadPill').addEventListener('click', () => refInput.click())
refInput.addEventListener('change', () => {
  addRefFiles(Array.from(refInput.files || []))
  refInput.value = ''
})

$('#composer').addEventListener('dragover', (e) => {
  e.preventDefault()
  $('#composer').classList.add('dragging')
})
$('#composer').addEventListener('dragleave', (e) => {
  if (e.target === $('#composer')) $('#composer').classList.remove('dragging')
})
$('#composer').addEventListener('drop', (e) => {
  e.preventDefault()
  $('#composer').classList.remove('dragging')
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
  addRefFiles(files)
})
promptEl.addEventListener('paste', (e) => {
  const imgs = Array.from(e.clipboardData?.items || [])
    .filter((it) => it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
  if (imgs.length) {
    e.preventDefault()
    addRefFiles(imgs)
  }
})

function addRefFiles(files: File[]): void {
  const ws = activeImageWs()
  if (!ws) return
  const t = wsTransient(ws)
  const room = MAX_REF - t.refImages.length
  if (room <= 0) {
    toast(`最多上传 ${MAX_REF} 张参考图`, 'error')
    return
  }
  ;(files as File[]).slice(0, room).forEach((file) => {
    if (file.size > MAX_REF_SIZE) {
      toast(`「${file.name}」超过 10MB，已跳过`, 'error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      t.refImages.push({ name: file.name, dataUrl: reader.result as string })
      renderRefStrip(ws)
    }
    reader.readAsDataURL(file)
  })
}

function renderRefStrip(ws?: ImageWorkspace | null): void {
  ws = ws || activeImageWs()
  if (!ws) return
  const t = wsTransient(ws)
  const strip = $('#refStrip')
  strip.innerHTML = ''
  if (!t.refImages.length) {
    strip.style.display = 'none'
    updateSendMode(ws)
    return
  }
  strip.style.display = 'flex'
  t.refImages.forEach((im, i) => {
    const chip = document.createElement('div')
    chip.className = 'ref-thumb'
    chip.innerHTML = `<img src="${im.dataUrl}" alt="ref" /><button class="ref-remove" title="移除">✕</button>`
    ;(chip.querySelector('.ref-remove') as HTMLButtonElement).addEventListener('click', () => {
      t.refImages.splice(i, 1)
      renderRefStrip(ws as ImageWorkspace)
    })
    strip.appendChild(chip)
  })
  updateSendMode(ws)
}

function updateSendMode(ws: ImageWorkspace): void {
  const t = wsTransient(ws)
  const has = t.refImages.length > 0
  $('#uploadPill').classList.toggle('active', has)
  const eyebrow = document.querySelector('.hero-eyebrow')
  const model = (ws.model || '').trim()
  if (eyebrow) eyebrow.textContent = has ? 'Aurora · 图生图 Image Edit' : model ? 'Aurora · ' + model : 'Aurora · GPT Image 2'
  promptEl.placeholder = has
    ? '描述你想在参考图基础上做的修改，例如：把背景换成雪山，保留人物…'
    : '描述你想要的画面，例如：黄昏的海边，一只鲸鱼跃出水面，电影质感…'
}

/* ===== 工具栏 popover ===== */
function closeAllPops(except: HTMLElement | null = null): void {
  $$('.tool-pill.has-pop').forEach((p) => {
    if (p !== except) p.classList.remove('open')
  })
}
$$<HTMLElement>('.tool-pill.has-pop').forEach((pill) => {
  pill.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.pop')) return
    const willOpen = !pill.classList.contains('open')
    closeAllPops(pill)
    pill.classList.toggle('open', willOpen)
  })
})
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.tool-pill.has-pop')) closeAllPops()
})

/* count（写入当前图片工作区） */
$$('#countPop .pop-opt').forEach((opt) => {
  opt.addEventListener('click', () => {
    const ws = activeImageWs()
    if (!ws) return
    ;$$('#countPop .pop-opt').forEach((o) => o.classList.toggle('active', o === opt))
    ws.count = Number((opt as HTMLElement).dataset.count)
    $('#countText').textContent = String(ws.count)
    persistWorkspaces()
    closeAllPops()
  })
})

/* ratio */
$$('#ratioPop .pop-ratio').forEach((opt) => {
  opt.addEventListener('click', () => {
    const ws = activeImageWs()
    if (!ws) return
    const o = opt as HTMLElement
    ;$$('#ratioPop .pop-ratio').forEach((x) => x.classList.toggle('active', x === o))
    ws.size = o.dataset.size as string
    $('#ratioText').textContent = o.dataset.r || ''
    const mini = $('#ratioMini') as HTMLElement
    mini.style.setProperty('--w', o.dataset.w || '1')
    mini.style.setProperty('--h', o.dataset.h || '1')
    persistWorkspaces()
    closeAllPops()
  })
})

/* resolution */
$$('#resolutionPop .pop-opt').forEach((opt) => {
  opt.addEventListener('click', () => {
    const ws = activeImageWs()
    if (!ws) return
    const o = opt as HTMLElement
    ;$$('#resolutionPop .pop-opt').forEach((x) => x.classList.toggle('active', x === o))
    ws.resolution = o.dataset.resolution as string
    $('#resolutionText').textContent = (o.dataset.resolution as string).toUpperCase()
    persistWorkspaces()
    closeAllPops()
  })
})

const transparentPill = $('#transparentPill')
transparentPill.addEventListener('click', () => {
  const ws = activeImageWs()
  if (!ws) return
  ws.transparentBackground = !ws.transparentBackground
  transparentPill.classList.toggle('active', ws.transparentBackground)
  transparentPill.setAttribute('aria-pressed', String(ws.transparentBackground))
  persistWorkspaces()
})

/* ===== 创作视图重绑定 ===== */
const generateBtn = $('#generateBtn')

export function bindCreateWorkspace(ws: ImageWorkspace): void {
  transparentPill.classList.toggle('active', ws.transparentBackground === true)
  transparentPill.setAttribute('aria-pressed', String(ws.transparentBackground === true))
  updateModelPill(ws)
  renderModelPop(ws)
  updateSendMode(ws)

  // 恢复该工作区的生成中状态（各工作区生成任务互不影响）
  const t = wsTransient(ws)
  generateBtn.classList.toggle('loading', t.jobs.length > 0)
  generateBtn.classList.remove('stoppable')
  generateBtn.title = '生成 (Ctrl+Enter)'

  // 数量 / 比例 / 分辨率回填
  $('#countText').textContent = String(ws.count || 1)
  ;$$('#countPop .pop-opt').forEach((o) =>
    o.classList.toggle('active', Number((o as HTMLElement).dataset.count) === (ws.count || 1))
  )

  $('#ratioText').textContent = ws.size || '1:1'
  const ratioBtn = $(`#ratioPop .pop-ratio[data-size="${ws.size || '1:1'}"]`)
  ;$$('#ratioPop .pop-ratio').forEach((o) => o.classList.toggle('active', o === ratioBtn))
  const mini = $('#ratioMini') as HTMLElement
  if (ratioBtn) {
    mini.style.setProperty('--w', (ratioBtn as HTMLElement).dataset.w || '1')
    mini.style.setProperty('--h', (ratioBtn as HTMLElement).dataset.h || '1')
  } else {
    mini.style.setProperty('--w', '1')
    mini.style.setProperty('--h', '1')
  }

  $('#resolutionText').textContent = (ws.resolution || '2k').toUpperCase()
  ;$$<HTMLElement>('#resolutionPop .pop-opt').forEach((o) =>
    o.classList.toggle('active', o.dataset.resolution === (ws.resolution || '2k'))
  )

  renderRefStrip(ws)
  void renderResultHistory()
}

function updateModelPill(ws: ImageWorkspace): void {
  const name = (ws && ws.model) || ''
  const pretty = name.trim() === 'gpt-image-2' ? 'GPT Image 2' : name.trim() || '选择模型'
  const el = $('#modelPillText')
  if (el) el.textContent = pretty
}

/* ===== 模型弹层（绑定当前工作区渠道） ===== */
function renderModelPop(ws: ImageWorkspace): void {
  if (modelSearchTimer) {
    clearTimeout(modelSearchTimer)
    modelSearchTimer = null
  }
  const empty = $('#modelPopEmpty')
  const listWrap = $('#modelPopList')
  const channels = ws && Array.isArray(ws.channels) ? ws.channels : []
  const imgModels = channels.filter(isImageChannel)
  if (!imgModels.length) {
    empty.style.display = 'block'
    listWrap.style.display = 'none'
    listWrap.innerHTML = ''
    return
  }
  empty.style.display = 'none'
  listWrap.style.display = 'flex'

  const current = (ws && ws.model) || ''
  const hasSearch = imgModels.length > 8
  listWrap.innerHTML = ''

  if (hasSearch) {
    const box = document.createElement('div')
    box.className = 'pop-model-search'
    box.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg><input type="text" placeholder="搜索渠道…" />`
    const input = box.querySelector('input') as HTMLInputElement
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase()
      if (modelSearchTimer) clearTimeout(modelSearchTimer)
      modelSearchTimer = setTimeout(() => {
        modelSearchTimer = null
        fillModelOpts(q, current.trim(), ws)
      }, 120)
    })
    listWrap.appendChild(box)
  }
  const optsWrap = document.createElement('div')
  optsWrap.id = 'modelOpts'
  optsWrap.style.display = 'flex'
  optsWrap.style.flexDirection = 'column'
  optsWrap.style.gap = '3px'
  listWrap.appendChild(optsWrap)
  fillModelOpts('', current.trim(), ws)
}

function fillModelOpts(q: string, current: string, ws: ImageWorkspace): void {
  const wrap = $('#modelOpts')
  if (!wrap) return
  const channels = ws && Array.isArray(ws.channels) ? ws.channels : []
  const cur = current || (ws && ws.model) || ''
  wrap.innerHTML = ''
  ;(channels as any[])
    .filter(isImageChannel)
    .filter((m) => m.id.toLowerCase().includes(q))
    .slice(0, 100)
    .forEach((m) => {
      const b = document.createElement('button')
      b.className = 'pop-model-opt' + (m.id === cur ? ' active' : '')
      b.dataset.id = m.id
      b.textContent = m.id
      b.title = m.id
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        ws.model = m.id
        persistWorkspaces()
        updateModelPill(ws)
        updateSendMode(ws)
        renderModelPop(ws)
        closeAllPops()
        toast('已切换模型：' + m.id, 'info', 1800)
      })
      wrap.appendChild(b)
    })
}

/* ===== 生成（走当前图片工作区配置，多任务并行） ===== */
generateBtn.addEventListener('click', () => {
  const ws = activeImageWs()
  if (!ws) return
  void doGenerate()
})

function updateGenerateBtn(t: { jobs: unknown[] }): void {
  const running = t.jobs.length > 0
  generateBtn.classList.toggle('loading', running)
  generateBtn.classList.remove('stoppable')
  generateBtn.title = '生成 (Ctrl+Enter)'
}

promptEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const ws = activeImageWs()
    if (!ws) return
    void doGenerate()
  }
})

const PHASE_LABEL: Record<string, string> = {
  queued: '准备中',
  uploading: '上传参考图',
  requesting: '正在提交请求',
  receiving: '模型绘制中',
  processing: '模型绘制中',
  saving: '保存到本地',
  downloading: '下载图片',
  done: '完成',
  error: '生成失败'
}

async function doGenerate(retry?: { ws: ImageWorkspace; prompt: string; refs: ReturnType<typeof wsTransient>['refImages'] }): Promise<void> {
  const ws = retry ? store.workspaces.find((item) => item.id === retry.ws.id && item.type === 'image') as ImageWorkspace | undefined : activeImageWs()
  if (!ws) return
  const t = wsTransient(ws)
  const prompt = retry?.prompt ?? promptEl.value.trim()
  const refs = (retry?.refs ?? t.refImages).map((ref) => ({ ...ref }))
  if (!prompt) {
    toast('请输入提示词', 'error')
    return
  }
  if (!ws.apiKey || !ws.apiKey.trim()) {
    toast('请先在工作区设置中配置 API Key', 'error')
    openWsSettings(ws)
    return
  }

  const grid = $('#canvasGrid')
  $('#discover').style.display = 'none'
  $('#resultHead').style.display = 'block'

  const size = ws.size || '1:1'
  const count = ws.count || 1
  const shapeClass = sizeToShape(size)
  const jobId = 'job-' + crypto.randomUUID()
  const startAt = Date.now()

  const cards: ProgressCardHandle[] = []
  for (let i = 0; i < count; i++) {
    const card = buildProgressCard(shapeClass, i)
    grid.prepend(card.el)
    cards.push(card)
  }

  const job = { id: jobId, cards, startAt }
  t.jobs.push(job)
  t.progressCards = t.progressCards.concat(cards)
  updateGenerateBtn(t)

  const timer = setInterval(() => {
    const secs = ((Date.now() - startAt) / 1000).toFixed(1)
    cards.forEach((c) => {
      if (!c.done) c.setTime(secs + 's')
    })
  }, 100)

  const setAll = (fn: (c: ProgressCardHandle) => void): void => cards.forEach((c) => {
    if (!c.done) fn(c)
  })

  let unsub = (): void => {}
  let res: any
  const useEdit = refs.length > 0
  try {
    unsub = img.onProgress((data) => {
      if (data.jobId !== jobId) return
      const label = PHASE_LABEL[data.phase] || data.phase
      if (data.phase === 'uploading') {
        const txt = data.count ? `${label} ${data.index || 0}/${data.count}` : label
        setAll((c) => {
          c.setPhase(String(txt))
          c.setIndeterminate()
        })
      } else if (data.phase === 'processing') {
        setAll((c) => {
          c.setPhase(label)
          if (typeof data.percent === 'number' && !isNaN(data.percent)) c.setPercent(Math.min(99, Math.max(1, data.percent)))
          else c.setIndeterminate()
        })
      } else if (data.phase === 'receiving' || data.phase === 'downloading') {
        const total = Number(data.total)
        const pct = total ? Math.min(99, Math.round((Number(data.received) / total) * 100)) : null
        const apply = (c: ProgressCardHandle): void => {
          if (c.done) return
          c.setPhase(label)
          if (pct != null) c.setPercent(pct)
          else c.setIndeterminate()
        }
        const idx = data.index
        const targets = typeof idx === 'number' && cards[idx] ? [cards[idx]] : cards
        targets.forEach(apply)
      } else if (data.phase === 'requesting' || data.phase === 'saving') {
        setAll((c) => {
          c.setPhase(label)
          c.setIndeterminate()
        })
      } else if (data.phase === 'error') {
        setAll((c) => c.setPhase(label))
      }
    })

    const payload: any = {
      jobId,
      prompt,
      wsId: ws.id,
      engine: ws.engine || 'gpt',
      model: (ws.model || '').trim() || (ws.engine === 'banana' ? 'nano-banana' : 'gpt-image-2'),
      size,
      n: count,
      resolution: ws.resolution || '2k',
      transparentBackground: ws.transparentBackground === true,
      provider: await wsProvider(ws),
      baseUrl: (ws.baseUrl || '').trim(),
      apiKey: (ws.apiKey || '').trim(),
      saveDir: ws.saveDir || ''
    }
    payload.provider.allowPublicUpload = payload.provider.allowPublicUpload === true
    if (useEdit) payload.images = refs

    res = ((useEdit ? await img.edit(payload) : await img.generate(payload)) as any) || {}
  } catch (error) {
    res = { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearInterval(timer)
    try { unsub() } catch { toast('进度监听清理失败', 'error') }
    // 从瞬态移除该任务（其余进行中的任务不受影响）
    t.jobs = t.jobs.filter((j) => j !== job)
    t.progressCards = t.progressCards.filter((c) => !cards.includes(c))
    // 仅当仍停留在该工作区时才动发送键与结果区
    if (activeImageWs() === ws) updateGenerateBtn(t)
  }

  if (!res.ok) {
    cards.forEach((c) => c.el.remove())
    if (activeImageWs() === ws && !grid.children.length) {
      $('#resultHead').style.display = 'none'
      $('#discover').style.display = 'block'
    }
    if ((res as any).cancelled) {
      toast('已取消生成（若请求已提交，服务端可能仍会计费）', 'info', 4000)
    } else {
      toast(`「${ws.name}」生成失败：` + (res.error || '未知错误'), 'error', 5000)
      if (activeImageWs() === ws) {
        const failure = document.createElement('div')
        failure.className = 'image-retry-card'
        const message = document.createElement('p')
        message.textContent = String(res.error || '生成失败')
        const button = document.createElement('button')
        button.className = 'ghost-btn small'
        button.textContent = '重试生成'
        button.type = 'button'
        const hint = document.createElement('span')
        hint.textContent = '保留原提示词与参考图，使用当前工作区配置；重试可能再次计费。'
        button.addEventListener('click', () => {
          button.disabled = true
          failure.remove()
          void doGenerate({ ws, prompt, refs })
        }, { once: true })
        failure.append(message, hint, button)
        grid.prepend(failure)
        $('#resultHead').style.display = 'block'
        $('#discover').style.display = 'none'
      }
    }
    return
  }

  // 移除进度卡片，把新结果插入历史列表顶部
  cards.forEach((c) => c.el.remove())
  try {
    state.gallery = await library.get()
  } catch {
    toast('图片已生成，但作品集刷新失败，请稍后重新打开作品集', 'error')
  }
  if (activeImageWs() === ws) {
    const frag = document.createDocumentFragment()
    ;(res.images || []).forEach((entry: any, i: number) => {
      frag.appendChild(buildCard(entry, shapeClass, i, { fromResult: true, onQuote: sendToComposer }))
    })
    grid.prepend(frag)
  }
  const saved = res.images.filter((e: any) => e.filePath).length
  const unsaved = res.images.length - saved
  const doneMsg = unsaved > 0
    ? `「${ws.name}」成功${useEdit ? '编辑' : '生成'} ${res.images.length} 张图片（${saved} 张已保存本地，${unsaved} 张下载失败、仅保留远程链接）`
    : `「${ws.name}」成功${useEdit ? '编辑' : '生成'} ${res.images.length} 张图片，已保存到本地`
  toast(doneMsg, unsaved > 0 ? 'info' : 'success', 4000)
}

/* ===== 一键引用提示词 ===== */
export function sendToComposer(text: unknown): void {
  const t = String(text || '').trim()
  if (!t) return
  // 目标：当前图片工作区，否则第一个图片工作区
  let ws = activeImageWs()
  if (!ws) ws = store.workspaces.find((w): w is ImageWorkspace => w.type === 'image') || null
  if (!ws) {
    toast('请先创建一个图片工作区', 'error')
    return
  }
  promptEl.value = t
  autoGrow()
  switchWorkspace(ws.id)
  toast('已填入创作提示词', 'info')
  promptEl.focus()
}

/** 由 sidebar 提供的切换入口（注入以避免循环依赖）。 */
let _switchWorkspace: ((id: string) => Promise<void>) | null = null
export function setSwitchWorkspace(fn: (id: string) => Promise<void>): void {
  _switchWorkspace = fn
}
function switchWorkspace(id: string): void {
  if (_switchWorkspace) void _switchWorkspace(id)
}

/** 工作区设置弹窗入口（由 modals 注入，避免循环依赖）。 */
let _openWsSettings: ((ws: ImageWorkspace) => void) | null = null
export function setOpenWsSettings(fn: (ws: ImageWorkspace) => void): void {
  _openWsSettings = fn
}
function openWsSettings(ws: ImageWorkspace): void {
  if (_openWsSettings) _openWsSettings(ws)
}

/* ===== 结果历史（按工作区隔离） ===== */
export async function renderResultHistory(): Promise<void> {
  state.gallery = await library.get()
  const ws = activeImageWs()
  const grid = $('#canvasGrid')
  const token = ++resultRenderToken
  // 结果区按工作区隔离：只显示本工作区生成的图；无 wsId 的旧条目在所有工作区显示
  const list = ws
    ? state.gallery.filter((e) => !e.wsId || e.wsId === ws.id)
    : state.gallery.slice()
  // 进行中的进度卡片重新附着到顶部（切走再切回不失联）
  const running = ws ? wsTransient(ws).progressCards || [] : []
  grid.innerHTML = ''
  if (!list.length && !running.length) {
    $('#resultHead').style.display = 'none'
    $('#discover').style.display = 'block'
    return
  }
  $('#discover').style.display = 'none'
  $('#resultHead').style.display = 'block'
  running.forEach((c) => grid.appendChild(c.el))
  // 历史很多时分帧挂载，避免一次创建几百个卡片阻塞交互
  appendInChunks(
    grid,
    list.slice(),
    (entry, i) => buildCard(entry, sizeToShape(entry.size || '1024x1024'), i, { fromResult: true, onQuote: sendToComposer }),
    { isCancelled: () => token !== resultRenderToken }
  )
}

export function resultListCount(): number {
  const ws = activeImageWs()
  const list = ws ? state.gallery.filter((e) => !e.wsId || e.wsId === ws.id) : state.gallery
  return list.length
}

export { escapeHtml as _escapeHtml }
