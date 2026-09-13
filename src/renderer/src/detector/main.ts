/**
 * AI 率检测 · 独立窗口渲染层
 * ---------------------------------------------------------------------------
 * 设计要点：
 * 1. 检测以大模型为主：默认完全由大模型判定 AI 率与痕迹位置（quote 精确定位），
 *    离线算法不参与判定；只有显式勾选「只依赖算法检测」时才单独跑算法，
 *    且该模式不作零容忍认定。
 * 2. 接口复用：不另开接口配置，直接用小说工作区「AI 设置」里配置好的对话接口
 *    （主进程在打开窗口时通过载荷下发；未配置时引导回工作区配置）。
 * 3. 一键降低 AI 率：按大模型指认的句子精准改写（或整篇润色）→ 自动复检 → 展示前后对比，
 *    支持撤销、复制，并可写回小说章节。
 */
import {
  DEFAULT_THRESHOLD,
  LLM_DETECT_CHUNK,
  REWRITE_BATCH,
  ZERO_TOLERANCE_SCORE,
  analyzeText,
  applyRewrites,
  buildLlmDetectPrompt,
  buildLlmFailureReport,
  buildLlmRepairPrompt,
  buildLlmReport,
  buildPolishPrompt,
  buildReportMarkdown,
  buildSentenceRewritePrompt,
  chunkTextForRewrite,
  chunkTextWithOffsets,
  contentChars,
  detectLevel,
  mergeLlmChunkResults,
  parseLlmDetectReplyDetailed,
  parsePolishReply,
  parseRewriteReply,
  splitSentences,
  withStrictRule,
  ZERO_TOLERANCE_MARK_LIMIT,
  type DetectReport,
  type DetectorCfg,
  type DetectorOpenPayload,
  type DetectorTarget,
  type LlmDetectResult,
  type LlmSuspiciousItem,
  type RewriteItem
} from '../../../shared/ai-detect'
import { chat, detector as detectorApi, win } from '../state/aurora'

const MIN_CHARS = 30
/** 检测输出是长 JSON，必须显式给 max_tokens（否则中转接口的默认值可能很小，导致输出被截断、JSON 不完整）。 */
const DETECT_MAX_TOKENS = 3000
const REWRITE_MAX_TOKENS = 3000
const POLISH_MAX_TOKENS = 8000

/** 示例文本：典型 AI 生成腔调（用于快速体验大模型检测与改写）。 */
const SAMPLE_TEXT = `在这个快节奏的时代，我们总是在忙碌中迷失方向。林夏站在渡口的栏杆边，看着远处的城市慢慢醒来。她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。

不是所有的告别都需要仪式，而是有些离开本身就足够沉重。她想起那封信，想起信纸上熟悉又陌生的字迹，嘴角不由得勾起一抹苦笑。风从河面上吹过来，带着水汽，也带着一种说不出的凉意。

或许，这就是成长的意义吧。我们在一次次失去中学会珍惜，在一次次相逢中确认彼此。无论未来如何，那些温暖的瞬间都会成为我们前行的力量。

值得注意的是，记忆从来不会真正消失，它只是沉淀在时光的深处。曾经的承诺，如今看来既是负担，也是礼物。让我们带着这份温柔，继续走向下一个清晨。`

interface ScoreSnapshot {
  score: number
  strict: number
  marks: number
  pass: boolean
  llmScore: number | null
}

interface UiState {
  report: DetectReport | null
  /** 上一次检测所依据的文本（用于判断结果是否过期） */
  analyzedText: string
  text: string
  title: string
  source: string
  target: DetectorTarget | null
  cfg: DetectorCfg
  threshold: number
  tab: 'mark' | 'list' | 'metric' | 'reduce'
  selected: number
  /** 是否只用离线算法（默认关闭：检测必须走大模型） */
  algorithmOnly: boolean
  /** 最严格判定：任意指认句即不通过（默认关闭，用标准零容忍规则） */
  strictAnyMark: boolean
  /** 大模型检测进行中 */
  llmBusy: boolean
  /** 分块检测进度文案 */
  chunkProgress: string
  /** 降 AI 味进行中 */
  reduceBusy: boolean
  reduceLog: Array<{ text: string; kind: 'info' | 'ok' | 'warn' }>
  reduceProgress: string
  /** 目标 AI 率（改写到该值以下才算完成） */
  reduceTarget: number
  /** 最大改写轮次 */
  reduceRounds: number
  /** 本轮检测中失败的分块数（提示用） */
  partialFailures: number
  before: ScoreSnapshot | null
  after: ScoreSnapshot | null
  /** 撤销改写用：改写前的正文 */
  undoText: string | null
  lastRewriteApplied: number
}

const state: UiState = {
  report: null,
  analyzedText: '',
  text: '',
  title: 'AI 率检测',
  source: '手动粘贴 / 输入',
  target: null,
  cfg: {},
  threshold: DEFAULT_THRESHOLD,
  tab: 'mark',
  selected: -1,
  algorithmOnly: false,
  strictAnyMark: false,
  llmBusy: false,
  chunkProgress: '',
  reduceBusy: false,
  reduceLog: [],
  reduceProgress: '',
  reduceTarget: 10,
  reduceRounds: 4,
  partialFailures: 0,
  before: null,
  after: null,
  undoText: null,
  lastRewriteApplied: 0
}

const el = <T extends Element = HTMLElement>(id: string): T =>
  document.getElementById(id) as unknown as T

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))

const LEVEL_COLOR: Record<string, string> = {
  human: '#0a7d43',
  light: '#b7791f',
  mid: '#d66a13',
  high: '#c62a20'
}

/* ═══════════════════════════════════════════
   Toast
═══════════════════════════════════════════ */
function toast(msg: string, type: 'info' | 'success' | 'error' = 'info', ms = 3200): void {
  const wrap = el('dtToasts')
  const node = document.createElement('div')
  node.className = `dt-toast ${type}`
  node.innerHTML = `<span class="dt-toast-dot"></span><span>${esc(msg)}</span>`
  wrap.appendChild(node)
  setTimeout(() => {
    node.classList.add('out')
    setTimeout(() => node.remove(), 260)
  }, ms)
}

/* ═══════════════════════════════════════════
   接口（复用小说工作区配置，不单独设置）
═══════════════════════════════════════════ */
function cfgReady(): boolean {
  return !!(state.cfg.baseUrl && state.cfg.apiKey && state.cfg.model)
}

function cfgLabel(): string {
  const { model, baseUrl } = state.cfg
  if (!cfgReady()) return '未配置（需在小说工作区「AI 设置」里填写）'
  let host = baseUrl || ''
  try {
    host = new URL(baseUrl as string).host
  } catch {
    /* 地址不合法时直接展示原文 */
  }
  return `${model} · ${host}`
}

function requestConfig(): void {
  const api = detectorApi
  if (!api?.requestConfig) return
  void api.requestConfig(state.target || undefined)
  toast('已切到小说工作区的「AI 设置」，保存后会自动同步到本窗口', 'info', 4200)
}

/* ═══════════════════════════════════════════
   骨架渲染
═══════════════════════════════════════════ */
function renderShell(): void {
  el('dtApp').innerHTML = `
    <section class="dt-pane dt-pane-input">
      <div class="dt-pane-head">
        <div class="dt-pane-title">
          <h2>待检测文本</h2>
          <p class="dt-sub" id="dtSource">手动粘贴 / 输入</p>
        </div>
        <div class="dt-input-tools">
          <button class="dt-btn" id="dtPick" title="选择本地文档（txt / md / docx）">上传文档</button>
          <button class="dt-btn ghost" id="dtSample" title="填入一段示例文本">示例</button>
          <button class="dt-btn ghost" id="dtClear">清空</button>
        </div>
      </div>
      <div class="dt-editor-wrap">
        <textarea id="dtText" class="dt-editor" spellcheck="false" placeholder="在此粘贴要检测的文字；也可以把 .txt / .md / .docx 文件拖进来…"></textarea>
        <div class="dt-drop-mask" id="dtDrop">松开鼠标即可导入文档</div>
      </div>
      <div class="dt-input-foot">
        <span class="dt-count" id="dtCount">0 字 · 0 句</span>
        <span class="dt-spacer"></span>
        <label class="dt-switch" id="dtAlgoLbl" title="默认由大模型检测。只有在不想调用大模型时，才勾选此项改用离线算法，结果不参与零容忍认定。">
          <input type="checkbox" id="dtAlgoOnly" />只依赖算法检测
        </label>
        <span class="dt-cfg" id="dtCfg"></span>
        <button class="dt-btn primary" id="dtRun">大模型检测</button>
      </div>
    </section>

    <section class="dt-pane dt-pane-result">
      <div class="dt-score-card">
        <div class="dt-ring">
          <svg width="116" height="116" viewBox="0 0 116 116">
            <circle class="dt-ring-bg" cx="58" cy="58" r="50" fill="none" stroke-width="9"></circle>
            <circle class="dt-ring-fg" id="dtRingFg" cx="58" cy="58" r="50" fill="none" stroke-width="9"
              stroke-dasharray="314.16" stroke-dashoffset="314.16"></circle>
          </svg>
          <div class="dt-ring-center">
            <div class="dt-score-num"><b id="dtScore">--</b><small>%</small></div>
            <div class="dt-score-cap">综合 AI 率</div>
          </div>
        </div>
        <div class="dt-score-info">
          <span class="dt-verdict" id="dtVerdict"><span class="dt-dot"></span>等待检测</span>
          <p class="dt-summary" id="dtSummary">粘贴或导入文本后点击「大模型检测」：由小说工作区配置的模型判定 AI 率，并逐句标出 AI 痕迹。需要离线算法时，可勾选左下角「只依赖算法检测」。</p>
          <div class="dt-chips" id="dtChips"></div>
        </div>
        <div class="dt-score-ops">
          <button class="dt-btn ghost" id="dtCopy">复制报告</button>
          <button class="dt-btn ghost" id="dtExport">导出报告</button>
        </div>
      </div>

      <div class="dt-banner" id="dtBanner"></div>
      <div class="dt-actionbar" id="dtActionBar"></div>

      <div class="dt-tabs" role="tablist">
        <button class="dt-tab on" data-tab="mark" role="tab">原文标注</button>
        <button class="dt-tab" data-tab="list" role="tab">疑似清单<span class="dt-tab-badge" id="dtListBadge"></span></button>
        <button class="dt-tab" data-tab="metric" role="tab" id="dtMetricTab">大模型判定</button>
        <button class="dt-tab" data-tab="reduce" role="tab">降 AI 味</button>
      </div>
      <div class="dt-toolbar" id="dtToolbar"></div>
      <div class="dt-body" id="dtBody"></div>
    </section>`

  el<HTMLTextAreaElement>('dtText').value = ''
  bindShell()
  renderScore()
  renderBanner()
  renderActions()
  renderToolbar()
  renderBody()
}

/* ═══════════════════════════════════════════
   事件绑定
═══════════════════════════════════════════ */
let dropDepth = 0

function bindShell(): void {
  const editor = el<HTMLTextAreaElement>('dtText')

  editor.addEventListener('input', () => {
    state.text = editor.value
    renderCount()
    renderScore()
  })

  el('dtRun').addEventListener('click', () => void runDetect())
  el('dtPick').addEventListener('click', () => void pickFile())
  el('dtSample').addEventListener('click', () => {
    editor.value = SAMPLE_TEXT
    state.text = SAMPLE_TEXT
    state.source = '内置示例（AI 腔调）'
    state.target = null
    state.undoText = null
    renderSource()
    renderCount()
    void runDetect()
  })
  el('dtClear').addEventListener('click', () => {
    editor.value = ''
    state.text = ''
    state.report = null
    state.analyzedText = ''
    state.source = '手动粘贴 / 输入'
    state.selected = -1
    state.before = null
    state.after = null
    state.undoText = null
    state.target = null
    state.reduceLog = []
    renderSource()
    renderCount()
    renderScore()
    renderBanner()
    renderActions()
    renderToolbar()
    renderBody()
    editor.focus()
  })
  el('dtCopy').addEventListener('click', () => void copyReport())
  el('dtExport').addEventListener('click', () => void exportReport())

  const algoBox = el<HTMLInputElement>('dtAlgoOnly')
  algoBox.addEventListener('change', () => {
    state.algorithmOnly = algoBox.checked
    el('dtAlgoLbl').classList.toggle('on', state.algorithmOnly)
    renderCfgSlot()
    renderScore()
    renderBanner()
    renderActions()
    renderToolbar()
    renderBody()
    toast(
      state.algorithmOnly
        ? '已切换为「只依赖算法检测」：离线运行、不调用大模型，结果不作零容忍认定'
        : '已切换为大模型检测：检测由小说工作区配置的模型完成',
      'info',
      4200
    )
  })

  document.querySelectorAll<HTMLElement>('.dt-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.tab = (tab.dataset.tab as UiState['tab']) || 'mark'
      document.querySelectorAll('.dt-tab').forEach((t) => t.classList.toggle('on', t === tab))
      renderToolbar()
      renderBody()
    })
  )

  const mask = el('dtDrop')
  window.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dropDepth++
    mask.classList.add('on')
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('dragleave', (e) => {
    e.preventDefault()
    dropDepth = Math.max(0, dropDepth - 1)
    if (!dropDepth) mask.classList.remove('on')
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dropDepth = 0
    mask.classList.remove('on')
    const files = e.dataTransfer?.files
    if (files && files.length) void importFiles([files[0]])
  })

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void runDetect()
    }
  })

  window.addEventListener('scroll', hideMarkTip, true)
}

/* ═══════════════════════════════════════════
   文本来源
═══════════════════════════════════════════ */
function renderCount(): void {
  const text = el<HTMLTextAreaElement>('dtText').value
  const chars = contentChars(text)
  el('dtCount').textContent = `${chars.toLocaleString('zh-CN')} 字 · ${splitSentences(text).length} 句`
}

function renderSource(): void {
  el('dtSource').textContent = state.source
  el('dtTitleHint').textContent = state.title || '文本 AI 痕迹扫描'
}

function setText(text: string, source: string, title?: string): void {
  const editor = el<HTMLTextAreaElement>('dtText')
  editor.value = text
  state.text = text
  state.source = source
  if (title) state.title = title
  state.report = null
  state.selected = -1
  state.before = null
  state.after = null
  state.undoText = null
  renderSource()
  renderCount()
  renderScore()
  renderBanner()
  renderActions()
  renderToolbar()
  renderBody()
}

async function pickFile(): Promise<void> {
  const api = detectorApi
  if (!api?.pickFile) {
    toast('当前环境不支持文件读取，请直接拖拽或粘贴文本', 'error')
    return
  }
  const res = await api.pickFile()
  if (!res.ok) {
    if (!res.canceled) toast(res.error || '导入失败', 'error')
    return
  }
  applyImport(res.name || '文档', res.text || '', res.warning)
}

async function importFiles(files: File[]): Promise<void> {
  const file = files[0]
  if (!file) return
  const api = detectorApi
  if (!api?.readDocument) {
    toast('当前环境不支持文件读取', 'error')
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    toast('文件过大（上限 20MB）', 'error')
    return
  }
  try {
    const data = await file.arrayBuffer()
    const res = await api.readDocument({ name: file.name, data })
    if (!res.ok) {
      toast(res.error || '导入失败', 'error')
      return
    }
    applyImport(res.name || file.name, res.text || '', res.warning)
  } catch (err) {
    toast((err as Error).message || '读取文件失败', 'error')
  }
}

function applyImport(name: string, text: string, warning?: string): void {
  setText(text, `文件：${name}`, name.replace(/\.[^.]+$/, ''))
  state.target = null
  toast(`已导入《${name}》，共 ${contentChars(text).toLocaleString('zh-CN')} 字`, 'success')
  if (warning) toast(warning, 'info', 5200)
  void runDetect()
}

/* ═══════════════════════════════════════════
   双引擎检测
═══════════════════════════════════════════ */
function setScanning(busy: boolean): void {
  state.llmBusy = busy
  const btn = el<HTMLButtonElement>('dtRun')
  btn.disabled = busy || state.reduceBusy
  btn.classList.toggle('busy', busy)
  btn.textContent = busy ? '检测中' : state.algorithmOnly ? '仅算法检测' : '大模型检测'
}

function llmCfg(): DetectorCfg {
  return {
    baseUrl: state.cfg.baseUrl,
    apiKey: state.cfg.apiKey,
    model: state.cfg.model,
    temperature: state.cfg.temperature ?? 0.2
  }
}

async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number
): Promise<{ ok: boolean; content: string; error?: string; finishReason?: string }> {
  try {
    const res = await chat.send({
      cfg: { ...llmCfg(), temperature },
      maxTokens,
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
    if (!res.ok) return { ok: false, content: '', error: res.error }
    if ('aborted' in res && res.aborted) return { ok: false, content: '', error: '请求已取消' }
    const ok = res as { content: string; finishReason?: string }
    return { ok: true, content: ok.content || '', finishReason: ok.finishReason }
  } catch (err) {
    return { ok: false, content: '', error: (err as Error).message || '请求失败' }
  }
}

/** 统一入口：默认走大模型检测；勾选「只依赖算法检测」时走离线算法。 */
async function runDetect(): Promise<void> {
  if (state.llmBusy || state.reduceBusy) return
  const editor = el<HTMLTextAreaElement>('dtText')
  state.text = editor.value
  if (contentChars(state.text) < MIN_CHARS) {
    toast(`文本太短：至少需要 ${MIN_CHARS} 个正文汉字才能给出可靠判断`, 'error')
    return
  }
  hideMarkTip()
  if (state.algorithmOnly) return runAlgorithmDetect()
  return runLlmDetect()
}

/** 仅算法模式（用户显式勾选）：离线统计，不作零容忍认定。 */
async function runAlgorithmDetect(): Promise<void> {
  setScanning(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  let report: DetectReport
  try {
    report = analyzeText(state.text, { threshold: state.threshold })
  } catch (err) {
    setScanning(false)
    toast(`算法检测失败：${(err as Error).message}`, 'error')
    return
  }
  state.report = report
  state.analyzedText = state.text
  state.selected = -1
  setScanning(false)
  renderScore()
  renderBanner()
  renderActions()
  renderToolbar()
  renderBody()
  toast(`仅算法模式：AI 倾向 ${report.rawScore}%，标出 ${markedSegments().length} 处（未调用大模型，不作零容忍认定）`, 'info', 4600)
}

/** 大模型检测（无 UI 副作用，供主流程与改写复检复用）。 */
async function detectLlmReport(
  source: string,
  onProgress?: (text: string) => void
): Promise<DetectReport> {
  const chunks = chunkTextWithOffsets(source, LLM_DETECT_CHUNK)
  const results: LlmDetectResult[] = []
  const weights: number[] = []
  const failures: string[] = []
  let lastRaw = ''
  let lastFinishReason = ''
  let lastParseError = ''
  let repairs = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    onProgress?.(chunks.length > 1 ? `大模型检测中 ${i + 1} / ${chunks.length}` : '大模型检测中…')
    const parts = buildLlmDetectPrompt(chunk.text, {
      title: state.title,
      part: chunks.length > 1 ? { index: i + 1, total: chunks.length } : undefined
    })
    const res = await callLlm(parts.system, parts.user, 0.2, DETECT_MAX_TOKENS)
    if (!res.ok) {
      failures.push(res.error || '请求失败')
      continue
    }
    lastFinishReason = res.finishReason || ''
    lastRaw = res.content
    let outcome = parseLlmDetectReplyDetailed(res.content)
    // 解析失败先尝试让模型把输出整理成严格 JSON（最多 3 次，避免刷请求）
    if (!outcome.result && repairs < 3) {
      repairs++
      lastParseError = outcome.error || ''
      onProgress?.(`模型输出格式有误，正在整理（${repairs}/3）…`)
      const repair = buildLlmRepairPrompt(res.content)
      const fixed = await callLlm(repair.system, repair.user, 0.1, 1500)
      if (fixed.ok) {
        const repaired = parseLlmDetectReplyDetailed(fixed.content)
        if (repaired.result) outcome = repaired
        else lastRaw = `${res.content}\n\n[整理后的输出]\n${fixed.content}`
      } else {
        failures.push(fixed.error || '整理输出失败')
      }
    }
    if (!outcome.result) {
      lastParseError = outcome.error || '模型返回无法解析为 JSON'
      failures.push(lastParseError)
      continue
    }
    results.push(outcome.result)
    weights.push(contentChars(chunk.text))
  }
  onProgress?.('')

  if (!results.length) {
    const truncated = lastFinishReason === 'length'
    const reason = truncated
      ? `模型输出被 max_tokens 截断（finish_reason=length）${lastParseError ? `：${lastParseError}` : ''}`
      : failures[0] || '大模型未返回可用结果'
    return buildLlmFailureReport(source, reason, {
      threshold: state.threshold,
      model: state.cfg.model,
      rawReply: lastRaw,
      finishReason: lastFinishReason,
      parseError: lastParseError,
      strictAnyMark: state.strictAnyMark
    })
  }

  const merged = results.length === 1 ? results[0] : mergeLlmChunkResults(results, weights)
  const suspicious: LlmSuspiciousItem[] =
    chunks.length === 1
      ? merged.suspicious
      : // 分块时句子序号只在块内有效，统一去掉序号，仅按片段定位
        merged.suspicious.map((item) => ({ ...item, sentence: undefined }))
  const report = buildLlmReport(source, { ...merged, suspicious }, {
    threshold: state.threshold,
    model: state.cfg.model,
    chunks: chunks.length,
    chunkScores: results.map((r) => r.score),
    finishReason: lastFinishReason,
    strictAnyMark: state.strictAnyMark
  })
  if (failures.length) state.partialFailures = failures.length
  return report
}

/** 大模型检测（UI 入口）：跑检测 → 提交状态 → 渲染 + 提示。 */
async function runLlmDetect(): Promise<void> {
  if (state.llmBusy) return
  if (!cfgReady()) {
    const report = buildLlmFailureReport(state.text, '尚未配置大模型接口', { threshold: state.threshold })
    state.report = report
    state.analyzedText = state.text
    renderScore()
    renderBanner()
    renderActions()
    renderToolbar()
    renderBody()
    toast('检测需要大模型：请在小说工作区「AI 设置」中填写接口地址、密钥与模型', 'error', 5200)
    state.tab = 'metric'
    syncTabs()
    renderBody()
    return
  }

  setScanning(true)
  state.chunkProgress = ''
  state.partialFailures = 0
  renderBanner()
  renderActions()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const source = state.text
  const report = await detectLlmReport(source, (text) => {
    state.chunkProgress = text
    renderScore()
  })

  state.report = report
  state.analyzedText = source
  state.selected = -1
  setScanning(false)
  renderScore()
  renderBanner()
  renderActions()
  renderToolbar()
  renderBody()

  if (!report.llm.ok) {
    toast(
      report.llm.truncated
        ? '模型输出被截断，检测未完成（可在「大模型判定」页查看原始返回）'
        : `大模型检测失败：${report.llm.error || '未知原因'}`,
      'error',
      5600
    )
    state.tab = 'metric'
    syncTabs()
    renderBody()
    return
  }
  if (state.partialFailures) toast(`有 ${state.partialFailures} 个分块检测失败，已按其余分块结果汇总`, 'info', 5200)

  const tolerance = report.tolerance
  toast(
    tolerance.pass
      ? `大模型检测通过：AI 率 ${report.score}%，未检出 AI 痕迹`
      : `大模型检测不通过：AI 率 ${report.score}%，标出 ${markedSegments().length} 处痕迹`,
    tolerance.pass ? 'success' : 'error',
    4600
  )
}

/** 重新检测（大模型判定页的「重新检测」按钮）。 */
async function rerunDetection(): Promise<void> {
  await runDetect()
}

/* ═══════════════════════════════════════════
   一键降低 AI 率（目标驱动 + 回退保护）
═══════════════════════════════════════════ */
function logReduce(text: string, kind: 'info' | 'ok' | 'warn' = 'info'): void {
  state.reduceLog.push({ text, kind })
  renderBody()
}

function snapshot(report: DetectReport): ScoreSnapshot {
  return {
    score: report.score,
    strict: report.tolerance.strictScore,
    marks: report.sentences.filter((s) => s.score >= report.threshold).length,
    pass: report.tolerance.pass,
    llmScore: report.llm.ok && typeof report.llm.score === 'number' ? Math.round(report.llm.score) : null
  }
}

function rewriteTargets(report: DetectReport): RewriteItem[] {
  return report.sentences
    .filter((s) => s.score >= report.threshold)
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      index: s.index,
      text: s.text,
      reasons: s.flags.map((f) => (f.detail ? `${f.label}（${f.detail}）` : f.label))
    }))
}

type RewriteStrategy = 'sentences' | 'paragraphs' | 'polish'

const STRATEGY_LABEL: Record<RewriteStrategy, string> = {
  sentences: '逐句改写指认句',
  paragraphs: '重写含痕迹的整段',
  polish: '整篇润色'
}

/** 逐句改写：把指认句分批发给大模型，就地替换。 */
async function rewriteSentences(text: string, report: DetectReport, round: number): Promise<string> {
  const targets = rewriteTargets(report)
  if (!targets.length) return text
  logReduce(`逐句改写：${targets.length} 句，分 ${Math.ceil(targets.length / REWRITE_BATCH)} 批。`)
  const rewrites: Array<{ index: number; text: string }> = []
  for (let i = 0; i < targets.length; i += REWRITE_BATCH) {
    const batch = targets.slice(i, i + REWRITE_BATCH)
    state.reduceProgress = `逐句改写 ${i + 1}-${i + batch.length} / ${targets.length}`
    renderBody()
    const segments = report.sentences
    const before = segments[batch[0].index - 1]?.text.slice(0, 140)
    const after = segments[batch[batch.length - 1].index + 1]?.text.slice(0, 140)
    const parts = buildSentenceRewritePrompt(batch, { before, after, strength: round > 1 ? 'strong' : 'normal' })
    const res = await callLlm(parts.system, parts.user, round > 1 ? 0.95 : 0.85, REWRITE_MAX_TOKENS)
    if (!res.ok) {
      logReduce(`第 ${Math.floor(i / REWRITE_BATCH) + 1} 批改写失败：${res.error || '未知错误'}`, 'warn')
      continue
    }
    if (res.finishReason === 'length') logReduce(`第 ${Math.floor(i / REWRITE_BATCH) + 1} 批输出被截断，可能存在漏改`, 'warn')
    const parsed = parseRewriteReply(res.content, batch)
    if (!parsed.length) {
      logReduce(`第 ${Math.floor(i / REWRITE_BATCH) + 1} 批未返回可用改写，已跳过`, 'warn')
      continue
    }
    rewrites.push(...parsed)
  }
  if (!rewrites.length) return text
  const applied = applyRewrites(
    text,
    report.sentences.map((s) => ({ index: s.index, start: s.start, end: s.end })),
    rewrites
  )
  state.lastRewriteApplied = applied.applied
  logReduce(`就地替换 ${applied.applied} 句（其余句子保持原样）。`)
  return applied.text
}

/** 段落级重写：只重写「含痕迹」的段落，保留其余段落。 */
async function rewriteParagraphs(text: string, report: DetectReport, round: number): Promise<string> {
  const targets = rewriteTargets(report)
  if (!targets.length) return text
  const hitParagraphs = report.paragraphs.filter((p) =>
    targets.some((t) => {
      const seg = report.sentences.find((s) => s.index === t.index)
      return seg && seg.start >= p.start && seg.end <= p.end
    })
  )
  if (!hitParagraphs.length) return text
  logReduce(`段落重写：${hitParagraphs.length} 段含痕迹，逐段改写。`)
  const edits: Array<{ start: number; end: number; text: string }> = []
  for (let i = 0; i < hitParagraphs.length; i++) {
    const para = hitParagraphs[i]
    state.reduceProgress = `段落重写 ${i + 1} / ${hitParagraphs.length}`
    renderBody()
    const parts = buildPolishPrompt(para.text, { title: state.title, strength: round > 1 ? 'strong' : 'normal' })
    const res = await callLlm(parts.system, parts.user, 0.9, POLISH_MAX_TOKENS)
    if (!res.ok) {
      logReduce(`第 ${i + 1} 段改写失败，保留原文`, 'warn')
      continue
    }
    const polished = parsePolishReply(res.content)
    if (!polished) {
      logReduce(`第 ${i + 1} 段未返回可用文本，保留原文`, 'warn')
      continue
    }
    edits.push({ start: para.start, end: para.end, text: polished })
  }
  if (!edits.length) return text
  edits.sort((a, b) => b.start - a.start)
  let out = text
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  state.lastRewriteApplied = -1
  logReduce(`已替换 ${edits.length} 个段落。`)
  return out
}

/** 整篇润色：按段落分批改写全文。 */
async function rewriteWhole(text: string, round: number): Promise<string> {
  const chunks = chunkTextForRewrite(text, 3000)
  logReduce(`整篇润色：${chunks.length} 个批次。`)
  const out: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    state.reduceProgress = `整篇润色 ${i + 1} / ${chunks.length}`
    renderBody()
    const parts = buildPolishPrompt(chunks[i], { title: state.title, strength: round > 1 ? 'strong' : 'normal' })
    const res = await callLlm(parts.system, parts.user, 0.9, POLISH_MAX_TOKENS)
    if (!res.ok) {
      logReduce(`第 ${i + 1} 批失败，保留该批原文：${res.error || '未知错误'}`, 'warn')
      out.push(chunks[i])
      continue
    }
    const polished = parsePolishReply(res.content)
    if (!polished) {
      logReduce(`第 ${i + 1} 批未返回可用文本，保留该批原文`, 'warn')
      out.push(chunks[i])
      continue
    }
    out.push(polished)
    logReduce(`第 ${i + 1} 批完成（${contentChars(polished)} 字）`)
  }
  state.lastRewriteApplied = -1
  return out.join('\n\n')
}

/**
 * 一键降低 AI 率：以「目标 AI 率」为终点循环改写 + 复检。
 * 每一轮都真实复检，只有确实变好才采纳，变差则回退换策略 —— 绝不会越改越高。
 */
async function reduceAiRate(mode: 'sentences' | 'polish' = 'sentences'): Promise<void> {
  if (state.reduceBusy || state.llmBusy) return
  const report = state.report
  if (!report) {
    toast('请先完成一次检测', 'error')
    return
  }
  if (!cfgReady()) {
    toast('改写需要大模型：请在小说工作区「AI 设置」中配置接口', 'error', 5200)
    requestConfig()
    return
  }
  if (report.mode !== 'llm') {
    toast('请先关闭「只依赖算法检测」，用大模型检测后再改写', 'error', 5200)
    return
  }
  if (!report.llm.ok) {
    toast('检测未完成，无法改写：请先重新检测', 'error', 4600)
    return
  }

  const original = el<HTMLTextAreaElement>('dtText').value
  const target = state.reduceTarget
  const maxRounds = state.reduceRounds

  state.reduceBusy = true
  state.tab = 'reduce'
  syncTabs()
  state.before = snapshot(report)
  state.after = null
  state.reduceLog = []
  state.lastRewriteApplied = 0
  setScanning(false)
  renderActions()
  renderBanner()
  renderToolbar()
  renderBody()

  let best = { text: original, report, score: report.score, marks: snapshot(report).marks }
  state.undoText = original
  const editor = el<HTMLTextAreaElement>('dtText')

  try {
    logReduce(`目标：AI 率 ≤ ${target}%（最多 ${maxRounds} 轮，每轮改写后都会真实复检，变差自动回退）。`)
    if (best.score <= target && best.marks === 0) {
      logReduce(`当前 AI 率 ${best.score}% 已达目标且无指认句，无需改写。`, 'ok')
    }
    for (let round = 1; round <= maxRounds; round++) {
      if (best.score <= target && best.marks === 0) break
      const strategy: RewriteStrategy =
        mode === 'polish' ? 'polish' : round <= 2 ? 'sentences' : round === 3 ? 'paragraphs' : 'polish'
      logReduce(`第 ${round} 轮 · ${STRATEGY_LABEL[strategy]}（当前 AI 率 ${best.score}%，痕迹 ${best.marks} 处）`)

      const candidate =
        strategy === 'sentences'
          ? await rewriteSentences(best.text, best.report, round)
          : strategy === 'paragraphs'
            ? await rewriteParagraphs(best.text, best.report, round)
            : await rewriteWhole(best.text, round)

      if (!candidate.trim() || candidate.trim() === best.text.trim()) {
        logReduce(`第 ${round} 轮没有产生有效改写，换下一种策略`, 'warn')
        continue
      }

      state.reduceProgress = '第 ' + round + ' 轮复检中…'
      renderBody()
      const fresh = await detectLlmReport(candidate, (text) => {
        state.reduceProgress = text || `第 ${round} 轮复检中…`
        renderBody()
      })
      const freshMarks = fresh.sentences.filter((s) => s.score >= fresh.threshold).length

      if (!fresh.llm.ok) {
        logReduce(`第 ${round} 轮复检未取得结论（${fresh.llm.error || '未知原因'}），已回退该轮`, 'warn')
        continue
      }
      const better = fresh.score < best.score || (fresh.score === best.score && freshMarks < best.marks)
      if (better) {
        logReduce(
          `第 ${round} 轮采纳：AI 率 ${best.score}% → ${fresh.score}%，痕迹 ${best.marks} → ${freshMarks} 处。`,
          fresh.score <= target ? 'ok' : 'info'
        )
        best = { text: candidate, report: fresh, score: fresh.score, marks: freshMarks }
        editor.value = best.text
        state.text = best.text
        state.report = fresh
        state.analyzedText = best.text
        renderCount()
        renderScore()
        renderBanner()
        renderActions()
      } else {
        logReduce(
          `第 ${round} 轮未改善（${best.score}% → ${fresh.score}%），已回退并换更彻底的策略`,
          'warn'
        )
      }
      state.after = null
      renderBody()
    }

    // 提交最终结果
    editor.value = best.text
    state.text = best.text
    state.report = best.report
    state.analyzedText = best.text
    state.after = snapshot(best.report)
    state.undoText = original
    renderCount()
    renderScore()
    renderBanner()
    renderActions()
    renderToolbar()
    renderBody()

    const startScore = state.before?.score ?? best.score
    if (best.score <= target) {
      logReduce(`完成：AI 率 ${startScore}% → ${best.score}%，已达目标 ${target}%。`, 'ok')
      toast(`已降到 ${best.score}%（目标 ${target}%）：${startScore}% → ${best.score}%`, 'success', 5600)
    } else if (best.score < startScore) {
      logReduce(`完成：AI 率 ${startScore}% → ${best.score}%，仍未达到 ${target}%，可再次点击继续降低。`, 'warn')
      toast(`已降到 ${best.score}%（目标 ${target}%），可再次点击继续降低`, 'info', 5600)
    } else {
      logReduce(
        `未能降低 AI 率（${startScore}%），已完整回退到原文，绝不保留更差的结果。可尝试换模型或手动润色。`,
        'warn'
      )
      toast('这轮改写没有降低 AI 率，已恢复原文', 'error', 5600)
    }
  } catch (err) {
    logReduce(`改写中断：${(err as Error).message || '未知错误'}`, 'warn')
  } finally {
    state.reduceBusy = false
    state.reduceProgress = ''
    setScanning(false)
    renderActions()
    renderBanner()
    renderScore()
    renderToolbar()
    renderBody()
  }
}

async function undoRewrite(): Promise<void> {
  if (state.undoText === null) return
  const editor = el<HTMLTextAreaElement>('dtText')
  editor.value = state.undoText
  state.text = state.undoText
  state.undoText = null
  state.before = null
  state.after = null
  state.reduceLog.push({ text: '已撤销改写，恢复改写前的正文。', kind: 'info' })
  renderCount()
  await runDetect()
}

async function writeBack(): Promise<void> {
  const api = detectorApi
  const target = state.target
  if (!api?.applyToNovel) {
    toast('当前环境不支持写回', 'error')
    return
  }
  if (!target?.novelId) {
    toast('当前文本不是从小说章节打开的，无法写回；可先复制正文再粘贴回编辑器', 'error', 4600)
    return
  }
  const text = el<HTMLTextAreaElement>('dtText').value
  const res = await api.applyToNovel({ text, target })
  if (res.ok) toast(`已写回《${target.novelTitle || '作品'}》${target.chapterTitle ? ` · ${target.chapterTitle}` : ''}`, 'success', 4600)
  else toast(res.error || '写回失败', 'error')
}

async function copyText(): Promise<void> {
  const text = el<HTMLTextAreaElement>('dtText').value
  if (!text.trim()) {
    toast('正文为空', 'info')
    return
  }
  await copyPlain(text, '正文已复制到剪贴板')
}

/* ═══════════════════════════════════════════
   结果渲染
═══════════════════════════════════════════ */
function markedSegments() {
  const report = state.report
  if (!report) return []
  return report.sentences.filter((s) => s.score >= state.threshold)
}

function syncTabs(): void {
  document.querySelectorAll<HTMLElement>('.dt-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === state.tab))
}

function renderScore(): void {
  const report = state.report
  const scoreEl = el('dtScore')
  const verdictEl = el('dtVerdict')
  const summaryEl = el('dtSummary')
  const chipsEl = el('dtChips')
  const ring = el<SVGCircleElement>('dtRingFg')

  if (!report) {
    scoreEl.textContent = '--'
    verdictEl.className = 'dt-verdict'
    verdictEl.innerHTML = '<span class="dt-dot"></span>等待检测'
    summaryEl.textContent = state.algorithmOnly
      ? '已勾选「只依赖算法检测」：点击右侧按钮将只运行离线统计，结果不作零容忍认定。'
      : '粘贴或导入文本后点击「大模型检测」：由小说工作区配置的模型判定 AI 率，并逐句标出 AI 痕迹。'
    chipsEl.innerHTML = state.chunkProgress ? `<span class="dt-chip">${esc(state.chunkProgress)}</span>` : ''
    ring.style.stroke = '#8f8f8f'
    ring.setAttribute('stroke-dashoffset', '314.16')
    renderCfgSlot()
    renderModeUi()
    return
  }

  const level = report.level
  scoreEl.textContent = report.score ? String(report.score) : '--'
  verdictEl.className = `dt-verdict lv-${level}`
  verdictEl.innerHTML = `<span class="dt-dot"></span>${esc(report.verdict)}`
  summaryEl.textContent = report.summary
  ring.style.stroke = LEVEL_COLOR[level] || '#8f8f8f'
  ring.setAttribute('stroke-dashoffset', String(314.16 * (1 - report.score / 100)))

  const chips: string[] = []
  if (state.chunkProgress) chips.push(`<span class="dt-chip">${esc(state.chunkProgress)}</span>`)
  if (report.mode === 'llm') {
    if (state.llmBusy) chips.push('<span class="dt-chip">大模型检测中…</span>')
    else if (report.llm.ok && typeof report.llm.score === 'number') {
      chips.push(`<span class="dt-chip">大模型 <b>${Math.round(report.llm.score)}%</b></span>`)
    } else chips.push('<span class="dt-chip warn">大模型检测未完成</span>')
    if (report.llm.model) chips.push(`<span class="dt-chip">${esc(report.llm.model)}</span>`)
    if (report.llm.chunks && report.llm.chunks > 1) chips.push(`<span class="dt-chip">分 ${report.llm.chunks} 块检测</span>`)
  } else {
    chips.push(`<span class="dt-chip">算法 <b>${report.rawScore}%</b></span>`)
    chips.push(`<span class="dt-chip">置信度 <b>${Math.round(report.confidence * 100)}%</b></span>`)
    if (report.flagsTop[0]) chips.push(`<span class="dt-chip">${esc(report.flagsTop[0].label)} ×${report.flagsTop[0].count}</span>`)
  }
  chips.push(`<span class="dt-chip">疑似痕迹 <b>${markedSegments().length}</b> 处</span>`)
  if (report.llm.missing?.length) chips.push(`<span class="dt-chip warn">${report.llm.missing.length} 处无法定位</span>`)
  if (state.analyzedText !== el<HTMLTextAreaElement>('dtText').value) {
    chips.push('<span class="dt-chip warn">文本已修改，请重新检测</span>')
  }
  if (report.mode !== (state.algorithmOnly ? 'algorithm' : 'llm')) {
    chips.push('<span class="dt-chip warn">检测方式已切换，请重新检测</span>')
  }
  chipsEl.innerHTML = chips.join('')
  renderCfgSlot()
  renderModeUi()
}

/** 模式相关的界面文案（按钮、页签、接口提示）。 */
function renderModeUi(): void {
  const btn = el<HTMLButtonElement>('dtRun')
  if (!state.llmBusy) btn.textContent = state.algorithmOnly ? '仅算法检测' : '大模型检测'
  const tab = document.getElementById('dtMetricTab')
  if (tab) tab.textContent = state.algorithmOnly ? '检测维度' : '大模型判定'
}

function renderCfgSlot(): void {
  const slot = document.getElementById('dtCfg')
  if (!slot) return
  const ready = cfgReady()
  slot.className = `dt-cfg${ready ? '' : ' warn'}`
  slot.innerHTML = `<span title="${esc(state.cfg.baseUrl || '')}">${
    ready ? '接口（来自小说工作区）' : '未配置大模型接口'
  }：${esc(cfgLabel())}</span>${
    ready ? '' : '<button class="dt-link" id="dtCfgGo">去小说工作区配置</button>'
  }`
  document.getElementById('dtCfgGo')?.addEventListener('click', () => requestConfig())
}

function renderBanner(): void {
  const banner = el('dtBanner')
  const report = state.report
  if (!report) {
    banner.className = 'dt-banner'
    banner.innerHTML = `<div class="dt-banner-main"><b>${
      state.algorithmOnly ? '仅算法模式（已勾选）' : '大模型检测 · 零容忍'
    }</b><span>${
      state.algorithmOnly
        ? '将只运行离线算法：速度快、完全本地，但不调用大模型，结果不作零容忍认定。'
        : `检测由小说工作区配置的大模型完成：AI 率 ≥ ${ZERO_TOLERANCE_SCORE}% 或存在指认句即判为不通过，检测未完成同样不通过。`
    }</span></div>`
    return
  }
  const tolerance = report.tolerance
  const algorithmMode = report.mode === 'algorithm'
  const running = state.llmBusy
  const cls = algorithmMode ? 'pending' : running ? 'pending' : tolerance.pass ? 'pass' : 'fail'
  const title = algorithmMode
    ? '仅算法模式 · 未作零容忍认定'
    : running
      ? '大模型检测中…'
      : report.llm.ok
        ? tolerance.label
        : '大模型检测未完成 · 视为不通过'
  const reasons = running
    ? ['正在调用小说工作区配置的模型，请稍候']
    : tolerance.reasons
  const conditions = running
    ? []
    : tolerance.conditions.map(
        (c) =>
          `<li class="${c.pass ? 'ok' : 'bad'}"><i>${c.pass ? '✓' : '✗'}</i><span>${esc(c.label)}</span><b>${esc(
            c.value
          )}</b></li>`
      )
  banner.className = `dt-banner ${cls}`
  banner.innerHTML = `
    <div class="dt-banner-main">
      <b>${esc(title)}</b>
      <span>${esc(running ? '' : tolerance.advice)}</span>
      ${conditions.length ? `<ul class="dt-conditions">${conditions.join('')}</ul>` : ''}
      <div class="dt-banner-tags">
        <i>判定线 ${ZERO_TOLERANCE_SCORE}%</i>
        ${algorithmMode ? '<i>离线算法 · 未使用大模型</i>' : `<i>大模型判定 ${tolerance.strictScore}%</i>`}
        ${
          !algorithmMode && report.llm.chunks && report.llm.chunks > 1 && report.llm.chunkScores?.length
            ? `<i>最严格分块 ${Math.round(Math.max(...report.llm.chunkScores))}%</i>`
            : ''
        }
        ${report.llm.model ? `<i>模型 ${esc(report.llm.model)}</i>` : ''}
      </div>
      ${reasons.length ? `<ul class="dt-banner-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="dt-banner-ops">
      ${
        !running && !tolerance.pass && !algorithmMode
          ? `<button class="dt-btn primary small" id="dtReduceQuick" ${cfgReady() ? '' : 'disabled'}>一键降低 AI 率</button>`
          : ''
      }
      ${
        !running && !algorithmMode && cfgReady()
          ? '<button class="dt-btn small" id="dtRetryQuick">重新检测</button>'
          : !running && !algorithmMode
            ? '<button class="dt-btn small" id="dtCfgQuick">去小说工作区配置接口</button>'
            : ''
      }
      ${
        !running && !algorithmMode
          ? `<button class="dt-btn small ghost" id="dtStrictToggle" title="切换判定规则：标准规则允许少量偶发指认，最严格规则只要存在任意指认句就不通过">${
              state.strictAnyMark ? '改用标准判定规则' : '改用最严格判定规则'
            }</button>`
          : ''
      }
      ${algorithmMode ? '<button class="dt-btn small" id="dtSwitchLlm">改用大模型检测</button>' : ''}
    </div>`
  document.getElementById('dtReduceQuick')?.addEventListener('click', () => void reduceAiRate('sentences'))
  document.getElementById('dtRetryQuick')?.addEventListener('click', () => void rerunDetection())
  document.getElementById('dtCfgQuick')?.addEventListener('click', () => requestConfig())
  document.getElementById('dtStrictToggle')?.addEventListener('click', () => {
    state.strictAnyMark = !state.strictAnyMark
    const current = state.report
    if (current) state.report = withStrictRule(current, state.strictAnyMark)
    renderBanner()
    toast(
      state.strictAnyMark
        ? '已切换为最严格判定规则：只要存在任意指认句即判不通过'
        : `已切换为标准判定规则：AI 率 < ${ZERO_TOLERANCE_SCORE}% 且无「高」等级指认、指认句少于 ${ZERO_TOLERANCE_MARK_LIMIT} 处即通过`,
      'info',
      4200
    )
  })
  document.getElementById('dtSwitchLlm')?.addEventListener('click', () => {
    state.algorithmOnly = false
    el<HTMLInputElement>('dtAlgoOnly').checked = false
    el('dtAlgoLbl').classList.remove('on')
    renderScore()
    renderBanner()
    renderActions()
    void runDetect()
  })
}

function renderActions(): void {
  const bar = el('dtActionBar')
  const report = state.report
  const canReduce = !!report && !state.reduceBusy && !state.llmBusy
  const stale = !!report && state.analyzedText !== el<HTMLTextAreaElement>('dtText').value
  bar.innerHTML = `
    <button class="dt-btn primary" id="dtReduce" ${canReduce && !stale ? '' : 'disabled'} title="用大模型逐句改写被指认的疑似 AI 句子，然后自动复检">
      一键降低 AI 率${state.lastRewriteApplied > 0 ? `（已改 ${state.lastRewriteApplied} 句）` : ''}
    </button>
    <button class="dt-btn" id="dtPolish" ${canReduce ? '' : 'disabled'} title="用大模型整篇润色，打破 AI 腔调后自动复检">整篇润色</button>
    <button class="dt-btn ghost" id="dtUndo" ${state.undoText !== null ? '' : 'disabled'}>撤销改写</button>
    <span class="dt-spacer"></span>
    ${state.reduceProgress || state.chunkProgress ? `<span class="dt-progress">${esc(state.reduceProgress || state.chunkProgress)}</span>` : ''}
    <button class="dt-btn ghost" id="dtCopyText">复制正文</button>
    <button class="dt-btn" id="dtWriteBack" ${state.target?.novelId ? '' : 'disabled'} title="${
      state.target?.novelId ? '把当前正文写回小说章节' : '当前文本不是从小说章节打开的'
    }">写回章节</button>`
  el('dtReduce').addEventListener('click', () => void reduceAiRate('sentences'))
  el('dtPolish').addEventListener('click', () => void reduceAiRate('polish'))
  el('dtUndo').addEventListener('click', () => void undoRewrite())
  el('dtCopyText').addEventListener('click', () => void copyText())
  el('dtWriteBack').addEventListener('click', () => void writeBack())
}

function renderToolbar(): void {
  const bar = el('dtToolbar')
  if (!state.report || state.tab === 'metric' || state.tab === 'reduce') {
    bar.hidden = true
    bar.innerHTML = ''
    return
  }
  bar.hidden = false
  if (state.tab === 'list') {
    bar.innerHTML = `<span>共 <b>${markedSegments().length}</b> 处达到阈值（得分 ≥ ${state.threshold}）</span>
      <span class="dt-spacer"></span>${rangeHtml()}`
    bindRange()
    return
  }
  bar.innerHTML = `<span class="dt-legend">
      <i><span class="sw high"></span>高度疑似</i>
      <i><span class="sw mid"></span>中度</i>
      <i><span class="sw light"></span>轻微</i>
    </span>
    <span class="dt-spacer"></span>${rangeHtml()}
    <span>点击高亮处可查看命中原因</span>`
  bindRange()
}

function rangeHtml(): string {
  return `<label class="dt-range">标记阈值 <input type="range" id="dtThreshold" min="20" max="80" step="5" value="${state.threshold}" /><b id="dtThresholdVal">${state.threshold}</b></label>`
}

function bindRange(): void {
  const input = document.getElementById('dtThreshold') as HTMLInputElement | null
  if (!input) return
  input.addEventListener('input', () => {
    state.threshold = Number(input.value)
    const label = document.getElementById('dtThresholdVal')
    if (label) label.textContent = String(state.threshold)
    renderScore()
    renderBanner()
    renderToolbar()
    renderBody()
  })
}

function renderBody(): void {
  const body = el('dtBody')
  el('dtListBadge').textContent = state.report ? String(markedSegments().length) : ''
  const report = state.report
  if (!report && state.tab !== 'reduce') {
    body.innerHTML = `
      <div class="dt-empty">
        <div class="dt-empty-mark">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M17 4h1.5A1.5 1.5 0 0 1 20 5.5V7M20 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17M7 20H5.5A1.5 1.5 0 0 1 4 18.5V17"/>
            <path d="M8 12h8"/>
          </svg>
        </div>
        <h3>还没有检测结果</h3>
        <p>左侧粘贴文本（或上传 .txt / .md / .docx），点击「大模型检测」：由小说工作区配置的模型给出 AI 率并逐句标出 AI 痕迹；不通过时可一键改写降 AI 味。需要离线运行时，可勾选「只依赖算法检测」。</p>
        <div class="dt-empty-steps"><span>1 · 粘贴或导入文本</span><span>2 · 大模型检测</span><span>3 · 一键降低 AI 率</span></div>
      </div>`
    return
  }
  if (state.tab === 'reduce') {
    body.innerHTML = renderReduce()
    bindDynamicBlocks()
    return
  }
  if (state.tab === 'list') {
    body.innerHTML = renderList()
    bindList()
    return
  }
  if (state.tab === 'metric') {
    body.innerHTML = renderMetrics()
    bindDynamicBlocks()
    return
  }
  body.innerHTML = renderMarked()
  bindMarked()
}

function renderMarked(): string {
  const report = state.report
  if (!report) return ''
  const text = state.analyzedText
  if (!text) return '<div class="dt-empty"><h3>文本为空</h3></div>'
  let html = ''
  let cursor = 0
  for (const seg of markedSegments()) {
    if (seg.start < cursor || seg.end > text.length) continue
    html += esc(text.slice(cursor, seg.start))
    html += `<mark class="lv-${seg.level}${state.selected === seg.index ? ' sel' : ''}" data-seg="${seg.index}">${esc(
      text.slice(seg.start, seg.end)
    )}</mark>`
    cursor = seg.end
  }
  html += esc(text.slice(cursor))
  const staleNote =
    state.analyzedText !== el<HTMLTextAreaElement>('dtText').value
      ? '<p class="dt-stale">提示：文本已被修改，当前标注对应的是上一次检测的内容。</p>'
      : ''
  return `${staleNote}<div class="dt-marked" id="dtMarked">${html}</div>`
}

function bindMarked(): void {
  document.querySelectorAll<HTMLElement>('#dtMarked mark').forEach((mark) => {
    const index = Number(mark.dataset.seg)
    mark.addEventListener('mouseenter', () => showMarkTip(mark, index))
    mark.addEventListener('mouseleave', hideMarkTip)
    mark.addEventListener('click', () => {
      state.selected = state.selected === index ? -1 : index
      renderBody()
      if (state.selected >= 0) {
        document.querySelector<HTMLElement>(`#dtMarked mark[data-seg="${index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    })
  })
}

function showMarkTip(anchor: HTMLElement, index: number): void {
  const seg = state.report?.sentences.find((s) => s.index === index)
  if (!seg) return
  const tip = el('dtMarkTip')
  const reasons = seg.flags.length
    ? `<ul>${seg.flags.map((f) => `<li>${esc(f.label)}${f.detail ? `：${esc(f.detail)}` : ''}</li>`).join('')}</ul>`
    : '<ul><li>整句节奏与全文风格高度一致</li></ul>'
  tip.innerHTML = `<div><span class="dt-tip-score">疑似度 ${seg.score}</span> · ${esc(
    seg.level === 'high' ? '高度疑似' : seg.level === 'mid' ? '中度疑似' : seg.level === 'light' ? '轻微痕迹' : '正常'
  )}</div>${reasons}`
  tip.classList.add('on')
  const rect = anchor.getBoundingClientRect()
  const width = tip.offsetWidth
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12)
  const top = rect.top > tip.offsetHeight + 16 ? rect.top - tip.offsetHeight - 10 : rect.bottom + 10
  tip.style.left = `${left}px`
  tip.style.top = `${Math.max(8, top)}px`
}

function hideMarkTip(): void {
  el('dtMarkTip').classList.remove('on')
}

function renderList(): string {
  const marked = markedSegments()
  if (!marked.length) {
    return `<div class="dt-empty"><h3>没有句子达到标记阈值</h3><p>可以把上方阈值调低，查看可疑度较低的句子。</p></div>`
  }
  return `<div class="dt-seg-list">${marked
    .slice()
    .sort((a, b) => b.score - a.score)
    .map(
      (seg) => `<button class="dt-seg${state.selected === seg.index ? ' on' : ''}" data-seg="${seg.index}">
        <span class="dt-seg-score lv-${seg.level}">${seg.score}</span>
        <span>
          <span class="dt-seg-text">${esc(seg.text.trim().slice(0, 220))}</span>
          <span class="dt-seg-flags">${
            seg.flags.length
              ? seg.flags
                  .slice(0, 4)
                  .map((f) => `<i class="${f.id === 'llm' ? 'llm' : ''}" title="${esc(f.detail)}">${esc(f.label)}</i>`)
                  .join('')
              : '<i>节奏一致</i>'
          }</span>
        </span>
      </button>`
    )
    .join('')}</div>`
}

function bindList(): void {
  document.querySelectorAll<HTMLElement>('.dt-seg').forEach((row) =>
    row.addEventListener('click', () => {
      const index = Number(row.dataset.seg)
      state.selected = index
      state.tab = 'mark'
      syncTabs()
      renderToolbar()
      renderBody()
      document.querySelector<HTMLElement>(`#dtMarked mark[data-seg="${index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  )
}

/** 「大模型判定」页：模型结论与依据；算法模式下展示九个离线维度。 */
function renderMetrics(): string {
  const report = state.report
  if (!report) return ''
  if (report.mode === 'algorithm') {
    const metrics = report.metrics
      .map(
        (m) => `<div class="dt-metric">
        <div class="dt-metric-head"><b>${esc(m.label)}</b><span class="dt-metric-val">得分 ${m.score} · ${
          m.skipped ? '本项不参与加权' : `权重 ${Math.round(m.weight * 100)}%`
        }</span></div>
        <div class="dt-bar"><i class="lv-${detectLevel(m.score)}" style="width:${m.skipped ? 0 : Math.max(2, m.score)}%"></i></div>
        <p>${esc(m.value)}</p>
        <p class="dt-hint">${esc(m.hint)}</p>
      </div>`
      )
      .join('')
    return `<div class="dt-llm warn-note"><div class="dt-llm-head"><b>仅算法模式</b><span>未使用大模型</span></div>
      <p>以下维度由离线统计得出，只作参考：零容忍认定必须由大模型完成。取消勾选「只依赖算法检测」即可用大模型重新检测。</p>
      <button class="dt-btn small" id="dtSwitchLlm2">改用大模型检测</button></div>
      <div>${metrics}</div>`
  }
  return `${renderLlmBlock()}<div>${renderLlmJudgement()}</div>`
}

/** 大模型判定依据 + 逐句判定。 */
function renderLlmJudgement(): string {
  const report = state.report
  if (!report || report.mode !== 'llm') return ''
  const reasons = report.llm.reasons
  const marked = markedSegments()
  const missing = report.llm.missing ?? []
  if (!report.llm.ok) {
    return `<div class="dt-llm"><div class="dt-llm-head"><b>判定依据</b><span>无</span></div>
      <p class="err">本次检测未取得大模型结论，请检查小说工作区「AI 设置」中的接口后重新检测。</p></div>`
  }
  return `
    <div class="dt-metric">
      <div class="dt-metric-head"><b>判定依据</b><span class="dt-metric-val">${esc(report.llm.model || '')}</span></div>
      ${reasons.length ? `<ul class="dt-reason-list">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="dt-hint">模型未给出文字依据</p>'}
      ${report.llm.summary ? `<p class="dt-hint">${esc(report.llm.summary)}</p>` : ''}
    </div>
    <div class="dt-metric">
      <div class="dt-metric-head"><b>逐句判定</b><span class="dt-metric-val">${marked.length} 处</span></div>
      ${
        marked.length
          ? `<ul class="dt-reason-list">${marked
              .slice(0, 40)
              .map(
                (s) =>
                  `<li><button class="dt-link" data-jump="${s.index}">${esc(s.text.trim().slice(0, 60))}</button> — ${esc(
                    s.flags[0]?.detail || ''
                  )}</li>`
              )
              .join('')}</ul>`
          : '<p class="dt-hint">模型未指认任何句子</p>'
      }
    </div>
    ${
      missing.length
        ? `<div class="dt-metric"><div class="dt-metric-head"><b>无法定位的指认</b><span class="dt-metric-val">${missing.length} 处</span></div>
            <ul class="dt-reason-list">${missing.map((m) => `<li>${esc(m.quote || '(未提供原文片段)')} — ${esc(m.reason)}</li>`).join('')}</ul>
            <p class="dt-hint">模型回引的原文与当前文本不一致（文本可能已被改动），这些指认未参与标注。</p></div>`
        : ''
    }`
}

function renderLlmBlock(): string {
  const report = state.report
  if (!report) return ''
  const llm = report.llm
  if (state.llmBusy || state.chunkProgress) {
    return `<div class="dt-llm"><div class="dt-llm-head"><b>大模型检测</b><span>进行中…</span></div>
      <p>${esc(state.chunkProgress || '正在把文本送给小说工作区配置的模型判定。')}</p></div>`
  }
  if (!llm.ok) {
    const truncated = llm.finishReason === 'length' || llm.truncated
    return `<div class="dt-llm"><div class="dt-llm-head"><b>大模型检测</b><span>未完成</span></div>
      <p class="err">${esc(llm.error || '未知原因')}</p>
      ${
        truncated
          ? '<p class="dt-hint">模型输出被 max_tokens 截断（finish_reason=length）。可在小说工作区「AI 设置」换用输出上限更大的模型，或缩短待检文本。</p>'
          : ''
      }
      ${llm.parseError ? `<p class="dt-hint">解析失败原因：${esc(llm.parseError)}</p>` : ''}
      ${
        llm.rawReply
          ? `<details class="dt-raw"><summary>查看模型原始返回（前 1200 字）</summary><pre>${esc(
              llm.rawReply.slice(0, 1200)
            )}</pre></details>`
          : ''
      }
      <div class="dt-llm-ops">
        <button class="dt-btn small" id="dtRetryLlm">重新检测</button>
        <button class="dt-btn small" id="dtCfgGo2">去小说工作区配置</button>
      </div></div>`
  }
  return `<div class="dt-llm">
    <div class="dt-llm-head"><b>大模型检测</b><span>${esc(llm.model || '')}${
      llm.chunks && llm.chunks > 1 ? ` · 分 ${llm.chunks} 块` : ''
    }</span></div>
    <p><span class="dt-llm-score">${Math.round(llm.score || 0)}%</span> · ${esc(llm.verdict || '')}</p>
    <button class="dt-btn small" id="dtRetryLlm">重新检测</button>
  </div>`
}

function renderReduce(): string {
  const report = state.report
  const before = state.before
  const after = state.after
  const reached = !!after && after.score <= state.reduceTarget
  const compare =
    before && after
      ? `<div class="dt-compare">
          <div class="dt-compare-col">
            <span class="dt-compare-label">改写前</span>
            <b class="dt-compare-score lv-${before.pass ? 'human' : 'high'}">${before.score}%</b>
            <span class="dt-compare-sub">算法 ${before.strict}%${before.llmScore !== null ? ` · 大模型 ${before.llmScore}%` : ''} · 痕迹 ${before.marks} 处</span>
          </div>
          <div class="dt-compare-arrow">→</div>
          <div class="dt-compare-col">
            <span class="dt-compare-label">改写后</span>
            <b class="dt-compare-score lv-${reached ? 'human' : 'high'}">${after.score}%</b>
            <span class="dt-compare-sub">算法 ${after.strict}%${after.llmScore !== null ? ` · 大模型 ${after.llmScore}%` : ''} · 痕迹 ${after.marks} 处</span>
          </div>
          <div class="dt-compare-verdict">${
            reached ? `已达目标（≤ ${state.reduceTarget}%）` : `未达目标（≤ ${state.reduceTarget}%），可再来一轮`
          }</div>
        </div>`
      : ''
  const log = state.reduceLog.length
    ? `<ul class="dt-reduce-log">${state.reduceLog
        .map((item) => `<li class="${item.kind}">${esc(item.text)}</li>`)
        .join('')}</ul>`
    : ''
  const busy = state.reduceBusy || state.llmBusy
  return `
    <div class="dt-reduce">
      <div class="dt-reduce-head">
        <div>
          <b>一键降低 AI 率</b>
          <p>每一轮改写后都会真实复检：<b>只有 AI 率确实下降才采纳，变差会自动回退并换更彻底的策略</b>，所以不会出现越改越高。改写会循环到达到目标 AI 率或轮次用尽。</p>
        </div>
        <div class="dt-reduce-ops">
          <button class="dt-btn primary" id="dtReduce2" ${report && !busy ? '' : 'disabled'}>一键降低 AI 率</button>
          <button class="dt-btn" id="dtPolish2" ${report && !busy ? '' : 'disabled'}>从整篇润色开始</button>
        </div>
      </div>
      <div class="dt-reduce-settings">
        <span class="dt-set-label">目标 AI 率</span>
        <div class="dt-segbtns" id="dtTargetBtns">
          ${[10, 20, 30].map((v) => `<button data-target="${v}" class="${state.reduceTarget === v ? 'on' : ''}">≤ ${v}%</button>`).join('')}
        </div>
        <span class="dt-set-label">最多轮次</span>
        <div class="dt-segbtns" id="dtRoundBtns">
          ${[2, 4, 6].map((v) => `<button data-rounds="${v}" class="${state.reduceRounds === v ? 'on' : ''}">${v} 轮</button>`).join('')}
        </div>
      </div>
      ${compare}
      ${state.reduceProgress ? `<p class="dt-progress-line">${esc(state.reduceProgress)}</p>` : ''}
      ${log}
      ${
        log || compare
          ? ''
          : `<p class="dt-hint">还没有改写记录。检测不通过时点上面的按钮即可：它会按「逐句改写 → 重写含痕迹段落 → 整篇润色」逐步加力，直到达到目标 AI 率。</p>`
      }
      ${state.undoText !== null ? `<p class="dt-hint">改写前的正文已保留，可随时「撤销改写」恢复。</p>` : ''}
    </div>`
}

/* ═══════════════════════════════════════════
   报告输出
═══════════════════════════════════════════ */
function reportMarkdown(): string {
  const report = state.report
  if (!report) return ''
  return buildReportMarkdown(report, {
    title: `AI 率检测报告 · ${state.title}`,
    source: state.source,
    llmModel: state.cfg.model
  })
}

async function copyPlain(text: string, okMessage: string): Promise<void> {
  // 优先走主进程剪贴板：窗口未聚焦时浏览器 Clipboard API 会被拒绝
  try {
    const api = detectorApi
    if (api?.copyText) {
      const res = await api.copyText(text)
      if (res?.ok) {
        toast(okMessage, 'success')
        return
      }
    }
  } catch {
    /* 落到浏览器 API */
  }
  try {
    await navigator.clipboard.writeText(text)
    toast(okMessage, 'success')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    toast(ok ? okMessage : '复制失败，请改用导出', ok ? 'success' : 'error')
  }
}

async function copyReport(): Promise<void> {
  const md = reportMarkdown()
  if (!md) {
    toast('还没有检测结果', 'error')
    return
  }
  await copyPlain(md, '检测报告已复制到剪贴板')
}

async function exportReport(): Promise<void> {
  const md = reportMarkdown()
  if (!md) {
    toast('还没有检测结果', 'error')
    return
  }
  const api = detectorApi
  if (!api?.export) {
    toast('当前环境不支持导出', 'error')
    return
  }
  const name = `${state.title || 'AI率检测'}-报告-${new Date().toISOString().slice(0, 10)}`
  const res = await api.export({ name, content: md })
  if (res.ok) toast(`报告已导出：${res.path}`, 'success', 5200)
  else if (!res.canceled) toast(res.error || '导出失败', 'error')
}

/* ═══════════════════════════════════════════
   启动
═══════════════════════════════════════════ */
/** 绑定随重渲染刷新的动态按钮（重新检测 / 降 AI 味入口 / 判定句跳转）。 */
function bindDynamicBlocks(): void {
  document.getElementById('dtRetryLlm')?.addEventListener('click', () => void rerunDetection())
  document.getElementById('dtCfgGo2')?.addEventListener('click', () => requestConfig())
  document.getElementById('dtSwitchLlm2')?.addEventListener('click', () => {
    state.algorithmOnly = false
    el<HTMLInputElement>('dtAlgoOnly').checked = false
    el('dtAlgoLbl').classList.remove('on')
    renderScore()
    renderBanner()
    renderActions()
    void runDetect()
  })
  document.getElementById('dtReduce2')?.addEventListener('click', () => void reduceAiRate('sentences'))
  document.getElementById('dtPolish2')?.addEventListener('click', () => void reduceAiRate('polish'))
  document.querySelectorAll<HTMLElement>('#dtTargetBtns [data-target]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.reduceTarget = Number(btn.dataset.target) || 10
      renderBody()
    })
  )
  document.querySelectorAll<HTMLElement>('#dtRoundBtns [data-rounds]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.reduceRounds = Number(btn.dataset.rounds) || 4
      renderBody()
    })
  )
  document.querySelectorAll<HTMLElement>('[data-jump]').forEach((node) =>
    node.addEventListener('click', () => {
      const index = Number(node.dataset.jump)
      state.tab = 'mark'
      state.selected = index
      syncTabs()
      renderToolbar()
      renderBody()
      document.querySelector<HTMLElement>(`#dtMarked mark[data-seg="${index}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  )
}

async function applyPayload(payload: DetectorOpenPayload | null | undefined): Promise<void> {
  if (!payload) return
  if (payload.cfg) {
    state.cfg = { ...state.cfg, ...payload.cfg, temperature: payload.cfg.temperature ?? 0.2 }
  }
  if (payload.target) state.target = payload.target
  const text = typeof payload.text === 'string' ? payload.text : ''
  const title = payload.title || ''
  if (text.trim()) {
    setText(text, payload.source || '来自小说工作区', title || '小说章节')
    if (payload.autoRun !== false) await runDetect()
  } else if (title) {
    state.title = title
    renderSource()
  }
  // 接口配置后到（用户刚在小说工作区补填）：自动补做一次大模型检测
  const report = state.report
  if (payload.cfg && report && report.mode === 'llm' && !report.llm.ok && !state.llmBusy && cfgReady()) {
    toast('已同步小说工作区的接口配置，正在重新做大模型检测', 'info', 4200)
    await runLlmDetect()
  }
  renderCfgSlot()
  renderBanner()
  renderActions()
}

/** 骨架是否已渲染完成（主进程可能在异步初始化期间就推送载荷）。 */
let shellReady = false
let queuedPayload: DetectorOpenPayload | null = null

detectorApi?.onLoad?.((payload) => {
  if (!shellReady) {
    queuedPayload = payload
    return
  }
  void applyPayload(payload)
})

async function bootstrap(): Promise<void> {
  el('btnMin').addEventListener('click', () => win.minimize())
  el('btnMax').addEventListener('click', () => win.maximize())
  el('btnClose').addEventListener('click', () => win.close())

  renderShell()
  renderCount()

  shellReady = true
  const payload = queuedPayload
  queuedPayload = null
  if (payload) await applyPayload(payload)
  else {
    renderCfgSlot()
    renderBanner()
    renderActions()
  }
  el<HTMLTextAreaElement>('dtText').focus()
}

void bootstrap()
