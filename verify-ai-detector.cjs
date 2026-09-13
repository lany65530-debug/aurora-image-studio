/**
 * AI 率检测独立窗口 · 端到端自检（真实 Electron 窗口 + 本地模拟大模型接口）
 * ---------------------------------------------------------------------------
 * 前置：npm run build（生成 out/），然后运行：
 *   npx electron verify-ai-detector.cjs
 *
 * 覆盖链路：
 *   小说工作区 AI 设置（唯一接口来源）→ 阅读器/书库入口 → 独立窗口
 *   → 默认由大模型检测（quote 精确定位高亮、零容忍判定）
 *   → 未配置接口时阻断并判不通过 → 一键降低 AI 率 → 自动复检通过 → 写回章节 → 撤销
 *   → 整篇润色 / 复制正文 / 最小窗口布局
 *   → 勾选「只依赖算法检测」时完全不调用大模型（仅算法模式不作零容忍认定）
 * 副作用：使用临时 userData 目录与本地 mock 服务，不触碰真实用户数据与外部网络。
 */
const { app, BrowserWindow, clipboard } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-detector-e2e-'))
app.setPath('userData', TMP_USER_DATA)
// 无头式验证：关闭硬件加速，避免 GPU 缓存目录在退出时仍被占用
app.disableHardwareAcceleration()

/** 尽力清理临时 userData（Windows 下 GPU 缓存可能仍被占用，失败可忽略）。 */
function cleanup() {
  try {
    fs.rmSync(TMP_USER_DATA, { recursive: true, force: true })
  } catch {
    /* 临时目录交给系统回收 */
  }
}

// 启动被测应用（注册全部 IPC 并创建主窗口）
require('./out/main/index.js')

const CHAPTER_TEXT = `在这个快节奏的时代，我们总是在忙碌中迷失方向。林夏站在渡口的栏杆边，看着远处的城市慢慢醒来。她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。

不是所有的告别都需要仪式，而是有些离开本身就足够沉重。她想起那封信，想起信纸上熟悉又陌生的字迹，嘴角不由得勾起一抹苦笑。风从河面上吹过来，带着水汽，也带着一种说不出的凉意。

或许，这就是成长的意义吧。我们在一次次失去中学会珍惜，在一次次相逢中确认彼此。无论未来如何，那些温暖的瞬间都会成为我们前行的力量。

值得注意的是，记忆从来不会真正消失，它只是沉淀在时光的深处。曾经的承诺，如今看来既是负担，也是礼物。让我们带着这份温柔，继续走向下一个清晨。`

const REWRITE_POOL_A = [
  '老陈把碗放下。',
  '雨还在下，屋檐在滴水。',
  '她没说话，把信折好塞进兜里。',
  '三斤二两，他数了两遍。',
  '巷口的灯忽明忽暗。',
  '他站着，看了一会儿。',
  '桌上剩半碗冷粥。',
  '风从窗缝里钻进来。'
]
/** 第 2 轮的改写结果：与 A 完全不同，用于验证"变差的那一轮被回退" */
const REWRITE_POOL_B = [
  '他把秤砣搁在柜台上，咣当一声。',
  '檐水顺着瓦口往下滴，滴在青石板上。',
  '信折了两折，塞进外套内袋，扣子扣上。',
  '三百八十块，他数到第三遍才停手。',
  '巷口那盏灯坏了一半，亮着半边。',
  '他站着，手指敲了两下门框。',
  '桌上那半碗粥凉透了，结着一层皮。',
  '窗缝漏风，桌上的纸角一直动。'
]

/* ═══════════════════════════════════════════
   本地 mock：OpenAI 兼容 /v1/chat/completions（SSE 流式）
   —— 故意返回真实模型常见的「不合格 JSON」，验证客户端容错与自愈
═══════════════════════════════════════════ */
const mock = {
  requests: [],
  detectCount: 0,
  repairCount: 0,
  rewriteCount: 0,
  expectSuspicious: 0,
  /** detect 分支：dirty=脏 JSON（中文引号 + 说明文字 + 尾逗号 + 裸换行）/ clean / garbage / lowOneMark / reduceLoop */
  detectMode: 'dirty',
  /** repair 分支：clean=整理成合法 JSON / garbage=仍不可解析 */
  repairMode: 'clean',
  maxTokensSeen: []
}

/** 从送检提示词里取回逐句编号的原文，保证 hint 与原文逐字一致。 */
function promptSentences(userText) {
  const items = []
  for (const line of userText.split('\n')) {
    const m = /^\[(\d+)\]\s*(.+)$/.exec(line.trim())
    if (m) items.push({ n: Number(m[1]), text: m[2].trim() })
  }
  return items
}

const cleanDetectJson = (score, verdict) =>
  JSON.stringify({
    ai_score: score,
    verdict,
    summary: '句式参差、细节具体，未见模板化痕迹。',
    reasons: ['句长参差', '有具体器物与数字'],
    suspicious: []
  })

/** 脏输出：中文引号当定界符 + 前后说明文字 + 尾随逗号 + 字符串内裸换行 + 百分比分数 */
function dirtyDetectReply(userText) {
  const items = promptSentences(userText)
  const picks = [items[0], items[2], items[6], items[9]].filter(Boolean)
  mock.expectSuspicious = picks.length
  const list = picks
    .map((item, i) => {
      const hint = item.text.slice(0, 10)
      const reason = i === 0 ? '模板化开场与排比' : '抽象抒情套话'
      const severity = i === 0 ? 'high' : 'mid'
      const tail = i < picks.length - 1 ? '，' : ',' // 最后一处故意留尾随逗号
      return `{“sentence”: ${item.n}, “hint”: “${hint}”, “reason”: “${reason}（句长均匀）\n”, “severity”: “${severity}”}${tail}`
    })
    .join('\n')
  return [
    '好的，以下是检测结果：',
    '{“ai_score”: “82%”, “verdict”: “高度疑似 AI 生成”,',
    ' “reasons”: [“句式模板化”, “句长过于均匀”],',
    ` “suspicious”: [\n${list}\n ]}`,
    '希望对你有所帮助。'
  ].join('\n')
}

/**
 * 降低 AI 率的复检序列（模拟真实模型的抖动）：
 *  第 1 次检测 = 82%（脏 JSON）；第 1 轮改写后复检 = 95%（更差 → 必须被回退）；
 *  第 2 轮改写后复检 = 8%（达标 → 采纳并结束）。
 */
function detectReply(userText) {
  mock.detectCount++
  const first = mock.detectCount === 1
  if (mock.detectMode === 'garbage') {
    return { kind: 'detect', content: '这段文本句长比较均匀、套语较多，因此判定 AI 概率很高。（本应输出 JSON）' }
  }
  // 低 AI 率 + 单处「中」等级指认：用于验证"分数低但仍有指认"时的判定说明与规则切换
  if (mock.detectMode === 'lowOneMark') {
    const items = promptSentences(userText)
    const target = items[2] || items[0]
    return {
      kind: 'detect',
      content: JSON.stringify({
        ai_score: 12,
        verdict: '基本自然',
        summary: '整体自然，仅一处略有模板感。',
        reasons: ['整体句式参差'],
        suspicious: [{ sentence: target.n, hint: target.text.slice(0, 10), reason: '略有模板感', severity: 'mid' }]
      })
    }
  }
  if (mock.detectMode === 'clean' || !first) {
    const items = promptSentences(userText)
    // 降 AI 味循环：第 2 次检测故意给更高的分，验证"变差必须回退"
    if (mock.detectMode !== 'clean') {
      if (mock.detectCount === 2) {
        return {
          kind: 'detect',
          content: JSON.stringify({
            ai_score: 95,
            verdict: '改写后更像 AI 了',
            summary: '句长过于整齐。',
            reasons: ['句式过于工整'],
            suspicious: items.slice(0, 6).map((item) => ({
              sentence: item.n,
              hint: item.text.slice(0, 10),
              reason: '句式工整',
              severity: 'high'
            }))
          })
        }
      }
      // 撤销改写后的复检：给整篇润色路径留出可下降的空间
      if (mock.detectCount === 4) {
        return {
          kind: 'detect',
          content: JSON.stringify({
            ai_score: 70,
            verdict: '疑似 AI 生成',
            summary: '套语偏多。',
            reasons: ['套语密集'],
            suspicious: items.slice(0, 3).map((item) => ({
              sentence: item.n,
              hint: item.text.slice(0, 10),
              reason: '套语',
              severity: 'mid'
            }))
          })
        }
      }
      return { kind: 'detect', content: cleanDetectJson(8, '未检出 AI 痕迹') }
    }
    return { kind: 'detect', content: cleanDetectJson(82, '未检出明显 AI 痕迹') }
  }
  return { kind: 'detect', content: dirtyDetectReply(userText) }
}

function rewriteReply(userText) {
  mock.rewriteCount++
  const items = promptSentences(userText)
  const pool = mock.rewriteCount === 1 ? REWRITE_POOL_A : REWRITE_POOL_B
  return {
    kind: 'rewrite',
    content: JSON.stringify({
      sentences: items.map((item, i) => ({ index: item.n, text: pool[i % pool.length] }))
    })
  }
}

function stripAiTone(text) {
  return text
    .replace(/值得注意的是，?/g, '')
    .replace(/不是所有的([^，。]{1,10})都需要([^，。]{1,10})，而是/g, '$1用不着$2，')
    .replace(/仿佛被[^，。]{1,20}了，?/g, '')
    .replace(/心中涌起一股[^。]{0,20}。/g, '他站着没动。')
    .replace(/嘴角不由得勾起一抹苦笑/g, '他咧了下嘴')
    .replace(/(?:或许|也许)，这就是([^。]{1,12})的意义吧。/g, '他没想明白$1。')
    .replace(/在这个快节奏的时代，/g, '')
}

function routeMock(userText) {
  // 顺序重要：整理请求里也含有 ai_score 字样，必须先判定
  if (userText.includes('【待整理的输出】')) {
    mock.repairCount++
    return mock.repairMode === 'garbage'
      ? { kind: 'repair', content: '抱歉，我仍然只能给出上述文字说明。' }
      : { kind: 'repair', content: cleanDetectJson(12, '未检出明显 AI 痕迹') }
  }
  if (userText.includes('{"sentences":[{"index":1')) return rewriteReply(userText)
  if (userText.includes('{"text":"改写后的完整文本"}')) {
    const m = /【文本开始】([\s\S]*?)【文本结束】/.exec(userText)
    return { kind: 'polish', content: JSON.stringify({ text: stripAiTone(m ? m[1] : '') }) }
  }
  if (userText.includes('ai_score')) return detectReply(userText)
  return { kind: 'unknown', content: '{"error":"unexpected prompt"}' }
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":{"message":"not found"}}')
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* 忽略解析失败 */
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const userText = messages.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n')
    const reply = routeMock(userText)
    mock.requests.push({ kind: reply.kind, model: parsed.model, maxTokens: parsed.max_tokens })
    if (reply.kind === 'detect' || reply.kind === 'repair') mock.maxTokensSeen.push(parsed.max_tokens)
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    const content = String(reply.content)
    for (let i = 0; i < content.length; i += 48) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 48) } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(label, fn, { timeout = 25000, step = 150 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (err) {
      last = err
    }
    if (Date.now() > deadline) throw new Error(`等待超时：${label}（最后结果：${String(last)}）`)
    await wait(step)
  }
}

const errors = []
/** Chromium 对 ResizeObserver 的这条提示并无实际影响，不计入失败。 */
const IGNORED_CONSOLE = [/ResizeObserver loop/i]
function watch(target, name) {
  target.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 3) return
    if (IGNORED_CONSOLE.some((re) => re.test(message))) return
    errors.push(`[${name}] ${message} (${source}:${line})`)
  })
  target.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`[${name}] 加载失败 ${code} ${desc}`))
  target.webContents.on('render-process-gone', (_e, details) => errors.push(`[${name}] 渲染进程崩溃 ${details.reason}`))
}

const isDetector = (win) => win.webContents.getURL().includes('ai-detector')
const isMain = (win) => !isDetector(win)
const js = (win, code) => win.webContents.executeJavaScript(code, true)

async function shot(win, file) {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, file), image.toPNG())
}

async function dumpDetector(win) {
  if (!win || win.isDestroyed()) {
    console.error('诊断：检测窗口不存在或已销毁')
    return
  }
  try {
    const snap = await js(
      win,
      `(() => ({
        score: (document.getElementById('dtScore') || {}).textContent,
        chips: (document.getElementById('dtChips') || {}).textContent,
        banner: (document.getElementById('dtBanner') || {}).textContent,
        marks: document.querySelectorAll('#dtMarked mark').length,
        dims: document.querySelectorAll('.dt-metric').length,
        bars: document.querySelectorAll('.dt-bar').length,
        algoChecked: (document.getElementById('dtAlgoOnly') || {}).checked,
        runLabel: (document.getElementById('dtRun') || {}).textContent,
        log: [...document.querySelectorAll('.dt-reduce-log li')].map((el) => el.textContent)
      }))()`
    )
    console.error('诊断：检测窗口快照 =', JSON.stringify(snap, null, 2))
  } catch (err) {
    console.error('诊断：读取检测窗口失败 =', err && err.message)
  }
  console.error('诊断：控制台错误 =', errors.length ? errors.join(' | ') : '（无）')
  console.error('诊断：mock 请求 =', JSON.stringify(mock.requests))
}

const guard = setTimeout(() => {
  console.error('FAIL: 端到端自检超时（180s）')
  app.exit(1)
}, 180000)

;(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mockBase = `http://127.0.0.1:${server.address().port}`

  await app.whenReady()
  const mainWin = await until('主窗口就绪', () => BrowserWindow.getAllWindows().find(isMain))
  watch(mainWin, '主窗口')
  await until('主窗口页面加载', async () => (await js(mainWin, 'document.readyState')) === 'complete')
  await until('侧边栏工作区渲染', async () => (await js(mainWin, "document.querySelectorAll('#wsList .ws-item').length")) >= 1)

  /* ---- 1. 进入小说工作区 ---- */
  const switched = await js(
    mainWin,
    `(() => {
      const novel = [...document.querySelectorAll('#wsList .ws-item')].find((el) => el.textContent.includes('小说'))
      if (!novel) return false
      novel.click()
      return true
    })()`
  )
  assert.ok(switched, '侧边栏应存在小说工作区')
  await until('小说书库渲染', async () => await js(mainWin, "!!document.querySelector('.folio')"))

  /* ---- 2. 未配置接口：检测阻断、判不通过，且不产生任何模型请求 ---- */
  await js(mainWin, "document.getElementById('novelDetect').click()")
  const gateWin = await until('书库入口打开检测窗口', () => BrowserWindow.getAllWindows().find(isDetector))
  watch(gateWin, '检测窗口(未配置)')
  await until('未配置窗口加载', async () => (await js(gateWin, 'document.readyState')) === 'complete')
  const cfgWarn = await js(gateWin, "document.getElementById('dtCfg').textContent")
  assert.ok(cfgWarn.includes('未配置'), `未配置时应提示缺少接口（实际：${cfgWarn}）`)
  await js(
    gateWin,
    `(() => {
      const ta = document.getElementById('dtText')
      ta.value = ${JSON.stringify(CHAPTER_TEXT)}
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('dtRun').click()
      return true
    })()`
  )
  const gateBanner = await until('未配置时的判定', async () => {
    const text = await js(gateWin, "document.getElementById('dtBanner').textContent")
    return text.includes('大模型检测未完成') ? text : null
  })
  assert.ok(gateBanner.includes('视为不通过'), '未完成大模型检测应判为不通过')
  assert.ok(gateBanner.includes('尚未配置'), '应说明未配置接口')
  assert.ok(await js(gateWin, "!!document.getElementById('dtCfgQuick')"), '应提供「去小说工作区配置接口」入口')
  assert.equal(mock.detectCount, 0, '未配置接口时不应向模型发请求')
  gateWin.close()
  await until('关闭未配置窗口', () => BrowserWindow.getAllWindows().every((w) => !isDetector(w)))

  /* ---- 3. 在小说的「AI 设置」里配置接口（检测窗口的唯一接口来源） ---- */
  await js(mainWin, "document.getElementById('novelSettings').click()")
  await until('AI 设置弹窗', async () => await js(mainWin, "!!document.getElementById('ai-base')"))
  await js(
    mainWin,
    `(() => {
      document.getElementById('ai-base').value = ${JSON.stringify(mockBase)}
      document.getElementById('ai-key').value = 'test-key'
      document.getElementById('ai-model').value = 'mock-model'
      document.getElementById('ai-ok').click()
      return true
    })()`
  )
  await until('设置弹窗关闭', async () => !(await js(mainWin, "!!document.getElementById('ai-base')")))

  /* ---- 4. 新建作品 + 写入章节正文 ---- */
  await js(mainWin, "document.getElementById('novelCreate').click()")
  await until('新建作品弹窗', async () => await js(mainWin, "!!document.getElementById('qc-title')"))
  await js(
    mainWin,
    `(() => {
      document.getElementById('qc-title').value = '检测窗口测试稿'
      document.getElementById('qc-ok').click()
      return true
    })()`
  )
  await until('进入空作品页', async () => await js(mainWin, "!!document.querySelector('.novel-empty-book')"))
  await js(mainWin, "document.querySelector('[data-act=\"first\"]').click()")
  await until('写作视图', async () => await js(mainWin, "!!document.getElementById('novelChapterContent')"))
  await js(
    mainWin,
    `(() => {
      const ta = document.getElementById('novelChapterContent')
      ta.value = ${JSON.stringify(CHAPTER_TEXT)}
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  )
  await wait(600)
  await shot(mainWin, 'ai-detector-entry.png')

  /* ---- 5. 默认路径：大模型检测（正文与接口随窗口带入，自动检测） ---- */
  await js(mainWin, "document.querySelector('[data-act=\"detect\"]').click()")
  const det = await until('检测窗口创建', () => BrowserWindow.getAllWindows().find(isDetector))
  watch(det, '检测窗口')
  assert.notEqual(det.id, mainWin.id, '检测窗口应是独立窗口')
  await until('检测窗口加载', async () => (await js(det, 'document.readyState')) === 'complete')

  const carried = await until('正文带入并完成大模型检测', async () => {
    const value = await js(det, "document.getElementById('dtText').value")
    const banner = await js(det, "document.getElementById('dtBanner').textContent")
    const chips = await js(det, "document.getElementById('dtChips').textContent")
    return value.length > 200 && chips.includes('大模型') && !banner.includes('检测中') && !chips.includes('检测中') ? { value, banner, chips } : null
  })
  assert.ok(carried.value.includes('在这个快节奏的时代'), '章节正文应随窗口带入')
  assert.ok(carried.chips.includes('大模型 82%'), `脏 JSON 也应被容错解析出分数（实际：${carried.chips}）`)
  assert.ok(!carried.chips.includes('算法'), '默认路径不应展示算法分')
  assert.ok(carried.banner.includes('不通过'), '大模型判定 82% 应显示不通过')
  assert.ok(carried.banner.includes('大模型判定 82%'), '横幅应写明大模型判定分')
  assert.ok(mock.requests.every((r) => r.model === 'mock-model'), '必须使用小说工作区配置的模型')
  assert.ok(
    mock.maxTokensSeen.length > 0 && mock.maxTokensSeen.every((v) => typeof v === 'number' && v >= 1000),
    `检测请求必须显式携带 max_tokens（实际：${JSON.stringify(mock.maxTokensSeen)}）`
  )

  const first = await js(
    det,
    `(() => {
      const marks = [...document.querySelectorAll('#dtMarked mark')]
      return {
        score: Number(document.getElementById('dtScore').textContent),
        marks: marks.length,
        markTexts: marks.map((m) => m.textContent),
        text: document.getElementById('dtText').value,
        bars: document.querySelectorAll('.dt-bar').length
      }
    })()`
  )
  assert.equal(first.score, 82, 'AI 率应等于大模型判定分（脏输出里的 "82%" 也要识别）')
  assert.equal(first.marks, mock.expectSuspicious, `模型指认的 ${mock.expectSuspicious} 处都应被定位高亮（实际 ${first.marks}）`)
  assert.equal(first.bars, 0, '大模型模式不应出现算法维度条')
  for (const text of first.markTexts) {
    assert.ok(first.text.includes(text), `标注片段必须来自原文：${text.slice(0, 16)}`)
  }
  // 指认用的是短片段 hint，也应扩展到整句
  assert.ok(
    first.markTexts.some((t) => t.includes('她的心中涌起一股难以言喻的情绪')),
    'hint 短片段也应定位到完整句子'
  )

  await js(det, "document.querySelector('.dt-tab[data-tab=\"list\"]').click()")
  const listRows = await js(det, "document.querySelectorAll('.dt-seg').length")
  assert.equal(listRows, first.marks, '疑似清单条数应等于标注数量')

  await js(det, "document.querySelector('.dt-tab[data-tab=\"metric\"]').click()")
  const tabLabel = await js(det, "document.getElementById('dtMetricTab').textContent")
  assert.equal(tabLabel, '大模型判定', '大模型模式下页签应为「大模型判定」')
  const judgeText = await js(det, "document.getElementById('dtBody').textContent")
  assert.ok(judgeText.includes('句式模板化'), '应展示大模型判定依据')
  assert.ok(judgeText.includes('逐句判定'), '应展示逐句判定')
  await js(det, "document.querySelector('.dt-tab[data-tab=\"mark\"]').click()")
  await shot(det, 'ai-detector-window.png')

  /* ---- 6. 一键降低 AI 率：循环改写 + 真实复检 + 变差回退 ---- */
  assert.ok(await js(det, "!document.getElementById('dtReduce').disabled"), '不通过时应可点击一键降低 AI 率')
  await js(det, "document.querySelector('.dt-tab[data-tab=\"reduce\"]').click()")
  assert.equal(
    await js(det, "document.querySelector('#dtTargetBtns .on') ? document.querySelector('#dtTargetBtns .on').textContent.trim() : ''"),
    '≤ 10%',
    '默认目标 AI 率为 10%'
  )
  assert.equal(
    await js(det, "document.querySelector('#dtRoundBtns .on') ? document.querySelector('#dtRoundBtns .on').textContent.trim() : ''"),
    '4 轮',
    '默认最多 4 轮'
  )
  await js(det, "document.getElementById('dtReduce').click()")
  const reduced = await until('降 AI 率循环完成', async () => {
    const text = await js(det, "document.getElementById('dtText').value")
    const compare = await js(det, "document.querySelector('.dt-compare') ? document.querySelector('.dt-compare').textContent : ''")
    const banner = await js(det, "document.getElementById('dtBanner').textContent")
    const busy = await js(det, "document.getElementById('dtReduce').disabled")
    return compare && banner.includes('通过') && !busy ? { text, compare, banner } : null
  }, { timeout: 90000 })
  assert.ok(reduced.compare.includes('改写前') && reduced.compare.includes('改写后'), '应展示改写前后对比')
  assert.ok(reduced.compare.includes('82%') && reduced.compare.includes('8%'), `对比应显示 82% → 8%（实际：${reduced.compare.replace(/\s+/g, ' ')}）`)
  assert.ok(reduced.compare.includes('已达目标'), '应标明已达目标 AI 率')
  assert.ok(reduced.banner.includes('通过'), '降到达标后应判定通过')
  // 关键：第 1 轮把 AI 率改高到 95%，必须回退；最终文本来自第 2 轮
  const reduceLog = await js(det, "[...document.querySelectorAll('.dt-reduce-log li')].map((el) => el.textContent)")
  assert.ok(reduceLog.some((line) => line.includes('未改善')), '变差的那一轮应记录为未改善并回退')
  assert.ok(reduceLog.some((line) => line.includes('95%')), '日志应写明变差后的 AI 率')
  assert.ok(reduceLog.some((line) => line.includes('采纳')), '改善的那一轮应被采纳')
  assert.ok(reduceLog.some((line) => line.includes('已达目标')), '应记录达成目标')
  assert.ok(reduced.text.includes(REWRITE_POOL_B[0]), '最终正文应是"被采纳那一轮"的改写结果')
  assert.ok(!reduced.text.includes(REWRITE_POOL_A[0]), '变差的那一轮改写不得残留')
  assert.equal(mock.requests.filter((r) => r.kind === 'rewrite').length, 2, '两轮改写各调用一次')
  assert.equal(mock.detectCount, 3, '首次检测 + 两轮复检共 3 次大模型检测')
  await shot(det, 'ai-detector-reduced.png')

  /* ---- 7. 写回章节 + 撤销 ---- */
  const writtenText = await js(det, "document.getElementById('dtText').value")
  await js(det, "document.getElementById('dtWriteBack').click()")
  const chapterAfter = await until('章节内容被写回', async () => {
    const value = await js(mainWin, "document.getElementById('novelChapterContent').value")
    return value === writtenText ? value : null
  })
  assert.ok(chapterAfter.includes(REWRITE_POOL_B[0]), '写回后的章节正文应是改写后的内容')

  assert.ok(await js(det, "!document.getElementById('dtUndo').disabled"), '改写后应可撤销')
  await js(det, "document.getElementById('dtUndo').click()")
  const restored = await until('撤销后恢复原文并复检', async () => {
    const text = await js(det, "document.getElementById('dtText').value")
    const banner = await js(det, "document.getElementById('dtBanner').textContent")
    return text.includes('在这个快节奏的时代') && !banner.includes('检测中') ? text : null
  })
  assert.equal(restored.trim(), CHAPTER_TEXT.trim(), '撤销应恢复改写前的正文')

  /* ---- 8. 整篇润色 + 复制正文 ---- */
  const detectBeforePolish = mock.detectCount
  await js(det, "document.querySelector('.dt-tab[data-tab=\"reduce\"]').click()")
  await js(det, "document.getElementById('dtPolish2').click()")
  const polished = await until('整篇润色 + 复检完成', async () => {
    const log = await js(det, "[...document.querySelectorAll('.dt-reduce-log li')].map((el) => el.textContent)")
    const compare = await js(det, "document.querySelector('.dt-compare') ? document.querySelector('.dt-compare').textContent : ''")
    const busy = await js(det, "document.getElementById('dtReduce').disabled")
    return log.some((l) => l.includes('整篇润色')) && log.some((l) => l.includes('采纳')) && compare && !busy ? { log } : null
  }, { timeout: 90000 })
  assert.ok(polished.log.length > 0, '整篇润色应产生日志')
  assert.ok(polished.log.some((l) => l.includes('已达目标')), '整篇润色路径同样以达成目标 AI 率结束')
  assert.ok(mock.detectCount > detectBeforePolish, '整篇润色后必须重新做大模型检测')
  assert.ok(mock.requests.some((r) => r.kind === 'polish'), '应调用整篇润色提示词')

  const bodyText = await js(det, "document.getElementById('dtText').value")
  clipboard.writeText('__aurora_clipboard_probe__')
  det.focus()
  await js(det, "document.getElementById('dtCopyText').click()")
  await wait(400)
  assert.equal(clipboard.readText(), bodyText, '「复制正文」应把当前正文写入剪贴板')

  /* ---- 9. 勾选「只依赖算法检测」：完全不调用大模型 ---- */
  const detectBeforeAlgo = mock.detectCount
  await js(
    det,
    `(() => {
      const box = document.getElementById('dtAlgoOnly')
      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  assert.equal(await js(det, "document.getElementById('dtRun').textContent"), '仅算法检测', '按钮文案应切换为仅算法检测')
  await js(det, "document.getElementById('dtRun').click()")
  const algoBanner = await until('仅算法检测完成', async () => {
    const banner = await js(det, "document.getElementById('dtBanner').textContent")
    return banner.includes('仅算法模式') ? banner : null
  })
  assert.equal(mock.detectCount, detectBeforeAlgo, '仅算法模式不得调用大模型')
  assert.ok(algoBanner.includes('未作零容忍认定'), '仅算法模式不作零容忍认定')
  const algoTab = await js(det, "document.getElementById('dtMetricTab').textContent")
  assert.equal(algoTab, '检测维度', '算法模式下页签应为「检测维度」')
  await js(det, "document.querySelector('.dt-tab[data-tab=\"metric\"]').click()")
  assert.equal(await js(det, "document.querySelectorAll('.dt-metric').length"), 9, '算法模式应有 9 个离线维度')
  assert.equal(await js(det, "document.querySelectorAll('.dt-bar').length"), 9, '算法模式应展示维度进度条')
  assert.ok(
    (await js(det, "document.getElementById('dtBody').textContent")).includes('仅算法模式'),
    '维度页应提示未使用大模型'
  )

  /* ---- 10. 取消勾选后恢复大模型检测 + 输出不合格时的自愈与诊断 ---- */
  mock.detectMode = 'garbage'
  mock.repairMode = 'garbage'
  const detectBeforeBack = mock.detectCount
  const repairBefore = mock.repairCount
  await js(
    det,
    `(() => {
      const box = document.getElementById('dtAlgoOnly')
      box.checked = false
      box.dispatchEvent(new Event('change', { bubbles: true }))
      document.getElementById('dtRun').click()
      return true
    })()`
  )
  const failed = await until('模型输出无法解析时的失败卡片', async () => {
    const text = await js(det, "document.getElementById('dtBody').textContent")
    return text.includes('未完成') && text.includes('解析失败原因') ? text : null
  }, { timeout: 45000 })
  assert.ok(mock.detectCount > detectBeforeBack, '取消勾选后应重新调用大模型')
  assert.ok(mock.repairCount > repairBefore, '解析失败后应自动发起一次「整理成 JSON」请求')
  assert.ok(failed.includes('不是 JSON'), '应说明失败类型（不是 JSON）')
  const rawShown = await js(det, "document.querySelector('.dt-raw pre') ? document.querySelector('.dt-raw pre').textContent : ''")
  assert.ok(rawShown.includes('本应输出 JSON'), '应展示模型原始返回，便于排查')
  const bannerFail = await js(det, "document.getElementById('dtBanner').textContent")
  assert.ok(bannerFail.includes('视为不通过'), '解析失败应判为不通过')

  // 整理请求能救回来时，检测应自动成功
  mock.repairMode = 'clean'
  await js(det, "document.getElementById('dtRetryLlm').click()")
  const recovered = await until('整理后成功恢复检测', async () => {
    const chips = await js(det, "document.getElementById('dtChips').textContent")
    const banner = await js(det, "document.getElementById('dtBanner').textContent")
    return banner.includes('通过') && chips.includes('大模型 12%') ? chips : null
  }, { timeout: 45000 })
  assert.ok(recovered.includes('大模型 12%'), '整理后的 JSON 应被正常采用')

  /* ---- 11. 低 AI 率时的判定说明与规则切换（用户反馈的场景） ---- */
  mock.detectMode = 'lowOneMark'
  await js(det, "document.getElementById('dtRun').click()")
  const lowRate = await until('低 AI 率 + 单处指认的判定', async () => {
    const chips = await js(det, "document.getElementById('dtChips').textContent")
    const banner = await js(det, "document.getElementById('dtBanner').textContent")
    return chips.includes('大模型 12%') && banner.includes('通过') ? { chips, banner } : null
  }, { timeout: 45000 })
  assert.ok(lowRate.banner.includes('通过'), 'AI 率 12% + 单处「中」等级指认应通过（标准规则）')
  const conds = await js(
    det,
    "[...document.querySelectorAll('.dt-conditions li')].map((el) => ({ text: el.textContent.trim(), ok: el.classList.contains('ok'), bad: el.classList.contains('bad') }))"
  )
  assert.ok(conds.length >= 3, `应逐条展示判定条件（实际 ${conds.length} 条）`)
  assert.ok(conds.some((c) => c.text.includes('AI 率 < 30%') && c.ok), '应显示「AI 率 < 30% ✓」')
  assert.ok(conds.every((c) => c.ok), '通过时所有条件都应为 ✓')
  await js(det, "document.querySelector('.dt-tab[data-tab=\"mark\"]').click()")
  assert.equal(
    await js(det, "document.querySelectorAll('#dtMarked mark').length"),
    1,
    '此时仍有 1 处指认高亮，但标准规则下依然通过（说明"低 AI 率 + 单处偶发指认"不会被一票否决）'
  )

  // 切到最严格规则：同一份结果应立即变为不通过，并说明原因
  await js(det, "document.getElementById('dtStrictToggle').click()")
  const strictBanner = await js(det, "document.getElementById('dtBanner').textContent")
  assert.ok(strictBanner.includes('不通过'), '最严格规则下应判为不通过')
  assert.ok(strictBanner.includes('最严格规则下存在'), '应说明是最严格规则导致的')
  const strictConds = await js(det, "[...document.querySelectorAll('.dt-conditions li')].map((el) => el.className)")
  assert.ok(strictConds.some((c) => c.includes('bad')), '不满足的条件应标为 ✗')
  await js(det, "document.getElementById('dtStrictToggle').click()")
  assert.ok(
    (await js(det, "document.getElementById('dtBanner').textContent")).includes('通过'),
    '切回标准规则应恢复通过'
  )

  mock.detectMode = 'clean'
  mock.repairMode = 'clean'

  /* ---- 11. 窄窗口布局不溢出 ---- */
  det.setSize(960, 640)
  await wait(500)
  assert.equal(
    await js(det, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
    true,
    '检测窗口在最小尺寸下不应横向溢出'
  )
  assert.ok(
    await js(det, "getComputedStyle(document.querySelector('.dt-shell')).flexDirection === 'column'"),
    '窄窗口应切换为上下布局'
  )
  det.setSize(1240, 880)
  await wait(300)

  mainWin.setSize(1080, 720)
  await wait(400)
  assert.equal(
    await js(mainWin, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
    true,
    '小说工作区在主窗口最小尺寸下不应横向溢出'
  )

  assert.deepEqual(errors, [], `不应有控制台错误：${errors.join(' | ')}`)

  console.log('PASS: 默认检测完全由大模型完成 —— 请求显式携带 max_tokens，脏 JSON（中文引号/说明文字/尾逗号/裸换行/百分比分数）也能容错解析并按 hint 定位。')
  console.log(
    `PASS: 大模型判定 82% → 不通过，标出 ${first.marks} 处；一键降低 AI 率后复检通过；共 ${mock.requests.filter((r) => r.kind === 'detect').length} 次检测、${mock.requests.filter((r) => r.kind === 'rewrite').length} 次改写。`
  )
  console.log('PASS: 写回章节 / 撤销 / 整篇润色 / 复制正文均正常；结果区不出现算法维度条。')
  console.log('PASS: 勾选「只依赖算法检测」时零模型请求（9 个离线维度、不作零容忍认定），取消勾选后恢复大模型检测。')
  console.log('PASS: 输出无法解析时自动发起「整理成 JSON」请求，仍失败则展示原始返回与失败原因并判不通过；整理成功则自动恢复。')
  console.log('PASS: 判定条件逐条展示（✓/✗）：低 AI 率 + 单处「中」等级指认按标准规则通过；切换最严格规则后同一结果立即判不通过并可切回。')
  console.log('PASS: 截图已保存 ai-detector-entry.png / ai-detector-window.png / ai-detector-reduced.png。')

  clearTimeout(guard)
  server.close()
  cleanup()
  app.exit(0)
})().catch(async (err) => {
  clearTimeout(guard)
  const detector = BrowserWindow.getAllWindows().find(isDetector)
  if (detector) await dumpDetector(detector)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  try {
    server.close()
  } catch {
    /* 忽略 */
  }
  cleanup()
  app.exit(1)
})
