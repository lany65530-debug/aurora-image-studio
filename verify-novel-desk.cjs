/**
 * 小说工作区 · 写作台与界面统一性 自检（真实 Electron 窗口）
 * ---------------------------------------------------------------------------
 * 前置：npm run build，然后运行：npx electron verify-novel-desk.cjs
 *
 * 检查两件事：
 *  A. 写作区体验（最高优先级）：768px 内容栏、字号/行距/字体生效、自动首行缩进、
 *     Tab 缩进、Ctrl+S 立即保存、专注模式（含 Esc 退出）、字数统计、一键整理排版。
 *  B. 界面统一：小说工作区不再有绿色/石板旧配色，头部高度与胶囊按钮与对话/图片工作区一致。
 * 副作用：临时 userData 目录，不触碰真实数据。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-desk-e2e-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()

function cleanup() {
  try {
    fs.rmSync(TMP_USER_DATA, { recursive: true, force: true })
  } catch {
    /* 临时目录交给系统回收 */
  }
}

require('./out/main/index.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name) => console.log(`step: ${name}`)

async function until(label, fn, { timeout = 20000, step: tick = 150 } = {}) {
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
    await wait(tick)
  }
}

const errors = []
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

const js = (win, code) => win.webContents.executeJavaScript(code, true)

async function shot(win, file) {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, file), image.toPNG())
}

/** 发送真实键盘事件（走浏览器默认行为与页面监听器）。 */
async function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await wait(150)
}

const guard = setTimeout(() => {
  console.error('FAIL: 自检超时（120s）')
  app.exit(1)
}, 120000)

;(async () => {
  await app.whenReady()
  const win = await until('主窗口就绪', () => BrowserWindow.getAllWindows()[0])
  watch(win, '主窗口')
  await until('主窗口页面加载', async () => (await js(win, 'document.readyState')) === 'complete')
  await until('侧边栏渲染', async () => (await js(win, "document.querySelectorAll('#wsList .ws-item').length")) >= 1)
  step('主窗口就绪')

  /* ---------- 进入小说工作区并建一部作品 ---------- */
  assert.ok(
    await js(
      win,
      `(() => { const el = [...document.querySelectorAll('#wsList .ws-item')].find((n) => n.textContent.includes('小说')); if (!el) return false; el.click(); return true })()`
    ),
    '应能切到小说工作区'
  )
  await until('作品库渲染', async () => await js(win, "!!document.querySelector('.folio')"))
  step('作品库已渲染')

  // B1. 头部高度与胶囊按钮：与对话工作区一致
  const tokens = await js(
    win,
    `(() => {
      const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null }
      const read = (sel, prop) => { const s = cs(sel); return s ? s[prop] : null }
      return {
        chatHead: read('.chat-head', 'minHeight'),
        folioHead: read('.folio-header', 'minHeight'),
        folioBtnRadius: read('.folio-button', 'borderTopLeftRadius'),
        folioBtnBorder: read('.folio-button', 'borderTopColor'),
        ghostRadius: read('.ghost-btn', 'borderTopLeftRadius'),
        ghostBorder: read('.ghost-btn', 'borderTopColor'),
        primaryBg: read('.folio-primary', 'backgroundColor'),
        inkPrimary: read('.primary-btn', 'backgroundColor')
      }
    })()`
  )
  assert.equal(tokens.folioHead, tokens.chatHead, `作品库头部高度应与对话工作区一致（${tokens.folioHead} vs ${tokens.chatHead}）`)
  assert.equal(tokens.folioBtnRadius, tokens.ghostRadius, `作品库按钮圆角应与全局胶囊按钮一致（${tokens.folioBtnRadius} vs ${tokens.ghostRadius}）`)
  assert.equal(tokens.folioBtnBorder, tokens.ghostBorder, `作品库按钮描边应与全局胶囊按钮一致（${tokens.folioBtnBorder} vs ${tokens.ghostBorder}）`)
  assert.equal(tokens.primaryBg, tokens.inkPrimary, `主按钮底色应使用全局 ink 黑（${tokens.primaryBg} vs ${tokens.inkPrimary}）`)
  step('统一性：头部与按钮 OK')

  await js(win, "document.getElementById('novelCreate').click()")
  await until('新建弹窗', async () => await js(win, "!!document.getElementById('qc-title')"))
  await js(win, "(() => { document.getElementById('qc-title').value = '写作手感自检'; document.getElementById('qc-ok').click(); return true })()")
  await until('空作品页', async () => await js(win, "!!document.querySelector('.novel-empty-book')"))
  await js(win, "document.querySelector('[data-act=\"first\"]').click()")
  await until('写作台渲染', async () => await js(win, "!!document.getElementById('novelChapterContent')"))
  step('写作台已渲染')

  /* ---------- A. 写作区排版与内容栏 ---------- */
  const deskBase = await js(
    win,
    `(() => {
      const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null }
      const content = cs('.desk-content')
      return {
        manuscriptWidth: cs('.desk-manuscript').width,
        fontSize: content.fontSize,
        lineHeight: content.lineHeight,
        chatHead: cs('.chat-head').minHeight,
        deskHeaderHeight: cs('.desk-header').minHeight
      }
    })()`
  )
  assert.equal(deskBase.manuscriptWidth, '768px', `正文内容栏应为 768px（与对话工作区同宽，实际 ${deskBase.manuscriptWidth}）`)
  assert.equal(deskBase.deskHeaderHeight, deskBase.chatHead, '写作台头部高度应与对话工作区一致')
  assert.equal(deskBase.fontSize, '25px', '默认字号 25px')
  assert.ok(parseFloat(deskBase.lineHeight) / 25 > 1.6, `默认行距应舒展（实际 ${deskBase.lineHeight}）`)

  await js(
    win,
    `(() => {
      const ta = document.getElementById('novelChapterContent')
      ta.value = '第一段正文，用来检查排版。\\n\\n第二段正文。'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  )
  await wait(800)
  const countText = await js(win, "document.getElementById('deskWordCount').textContent")
  assert.ok(/字$/.test(countText), `状态栏应显示字数（实际 ${countText}）`)
  assert.equal(await js(win, "document.getElementById('deskSaveState').textContent"), '已保存', '编辑后应自动保存')
  step('排版与统计 OK')

  // A1. 自动首行缩进
  await js(win, "(() => { const ta = document.getElementById('novelChapterContent'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return true })()")
  await key(win, 'Enter')
  const afterEnter = await js(win, "document.getElementById('novelChapterContent').value")
  assert.ok(afterEnter.endsWith('\n\u3000'), `回车后新段落应自动补全角缩进（实际结尾：${JSON.stringify(afterEnter.slice(-6))}）`)

  // A2. Tab 插入全角缩进
  const beforeTab = afterEnter.length
  await key(win, 'Tab')
  const afterTab = await js(win, "document.getElementById('novelChapterContent').value")
  assert.equal(afterTab.length, beforeTab + 1, 'Tab 应插入一个字符而不是切换焦点')
  assert.ok(afterTab.endsWith('\u3000\u3000'), 'Tab 插入的应是全角缩进')
  step('自动缩进 / Tab OK')

  // A2b. 空行上按回车不再凭空多出一行
  await js(win, "(() => { const ta = document.getElementById('novelChapterContent'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.setSelectionRange(0, 0); return true })()")
  await key(win, 'Enter')
  assert.equal(await js(win, "document.getElementById('novelChapterContent').value"), '', '空章节回车不应空出一行')
  await js(win, "(() => { const ta = document.getElementById('novelChapterContent'); ta.value = '正文'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.setSelectionRange(2, 2); return true })()")
  await key(win, 'Enter')
  let enterOnce = await js(win, "document.getElementById('novelChapterContent').value")
  assert.ok(enterOnce.endsWith('\n\u3000'), `正常段落回车应补全角缩进（实际 ${JSON.stringify(enterOnce)}）`)
  await key(win, 'Enter')
  enterOnce = await js(win, "document.getElementById('novelChapterContent').value")
  assert.equal(enterOnce, '正文\n\u3000', `空行上回车不应再叠一行（实际 ${JSON.stringify(enterOnce)}）`)
  step('空行回车不再多空一行 OK')

  // A3. Ctrl+S 立即保存并落盘
  await js(win, "document.getElementById('novelChapterContent').dispatchEvent(new Event('input', { bubbles: true }))")
  await key(win, 's', ['control'])
  await wait(700)
  const novelsDir = path.join(TMP_USER_DATA, 'novels')
  const saved = await until('落盘文件生成', () => (fs.existsSync(novelsDir) ? fs.readdirSync(novelsDir).filter((f) => f.endsWith('.json')) : null))
  const data = JSON.parse(fs.readFileSync(path.join(novelsDir, saved[0]), 'utf-8'))
  assert.ok(data.chapters[0].content.includes('\u3000'), 'Ctrl+S 后正文（含自动缩进）应已落盘')
  step('Ctrl+S 落盘 OK')

  // A4. 排版设置：字号 / 行距 / 字体
  await js(win, "document.querySelector('[data-act=\"settings\"]').click()")
  await until('排版设置弹窗', async () => await js(win, "!!document.getElementById('rs-size')"))
  assert.ok(await js(win, "!!document.getElementById('rs-indent')"), '设置里应提供「自动首行缩进」开关')
  assert.ok(await js(win, "!!document.getElementById('rs-normalize')"), '设置里应提供「整理排版」')
  await js(
    win,
    `(() => {
      const size = document.getElementById('rs-size'); size.value = '22'; size.dispatchEvent(new Event('input', { bubbles: true }))
      const sp = document.getElementById('rs-spacing'); sp.value = '2.2'; sp.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('#rs-fonts [data-f="song"]').click()
      document.getElementById('rs-ok').click()
      return true
    })()`
  )
  await wait(600)
  const styled = await js(
    win,
    `(() => { const cs = getComputedStyle(document.getElementById('novelChapterContent')); return { size: cs.fontSize, lh: cs.lineHeight, family: cs.fontFamily } })()`
  )
  assert.equal(styled.size, '22px', `字号设置应生效（实际 ${styled.size}）`)
  assert.equal(styled.lh, '48.4px', `行距设置应生效（2.2 × 22 = 48.4，实际 ${styled.lh}）`)
  assert.ok(/Songti|SimSun|serif/i.test(styled.family), `字体设置应生效（实际 ${styled.family}）`)
  step('排版设置生效 OK')

  // A5. 专注模式 + Esc 退出
  await js(win, "document.getElementById('deskFocus').click()")
  await wait(400)
  const focused = await js(
    win,
    `(() => ({
      sidebar: getComputedStyle(document.querySelector('.desk-sidebar')).display,
      header: getComputedStyle(document.querySelector('.desk-header')).display,
      exitVisible: getComputedStyle(document.getElementById('deskFocusExit')).display
    }))()`
  )
  assert.equal(focused.sidebar, 'none', '专注模式应隐藏章节目录')
  assert.equal(focused.header, 'none', '专注模式应隐藏顶栏')
  assert.notEqual(focused.exitVisible, 'none', '专注模式应提供退出入口')
  await key(win, 'Escape')
  assert.equal(
    await js(win, "getComputedStyle(document.querySelector('.desk-sidebar')).display !== 'none'"),
    true,
    'Esc 应退出专注模式'
  )
  step('专注模式 OK')

  // A6. 整理排版
  await js(
    win,
    `(() => {
      const ta = document.getElementById('novelChapterContent')
      ta.value = '没有缩进的第一段。\\n\\n\\n\\n第二段也没有缩进。   '
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  )
  await wait(500)
  await js(win, "document.querySelector('[data-act=\"settings\"]').click()")
  await until('排版设置弹窗2', async () => await js(win, "!!document.getElementById('rs-normalize')"))
  await js(win, "document.getElementById('rs-normalize').click()")
  await wait(700)
  const normalized = await js(win, "document.getElementById('novelChapterContent').value")
  const lines = normalized.split('\n')
  assert.ok(
    lines.filter((l) => l.trim()).every((l) => l.startsWith('\u3000')),
    `整理后每个正文段落都应有全角缩进（实际：${JSON.stringify(normalized)}）`
  )
  assert.ok(!/\n\n\n/.test(normalized), '整理后不应存在连续多个空行')
  assert.ok(!/[ \t]+$/.test(lines.find((l) => l.includes('第二段')) || ''), '整理后不应有行尾空格')
  step('整理排版 OK')

  /* ---------- B2. 旧绿色调已彻底移除 ---------- */
  const legacyColors = await js(
    win,
    `(() => {
      const OLD = ['rgb(39, 104, 88)', 'rgb(32, 88, 71)', 'rgb(59, 147, 118)', 'rgb(116, 167, 153)',
        'rgb(173, 198, 187)', 'rgb(140, 180, 167)', 'rgb(207, 232, 221)', 'rgb(240, 245, 239)', 'rgb(232, 239, 231)']
      const bad = []
      const root = document.getElementById('novelRoot')
      const check = (el) => {
        const cs = getComputedStyle(el)
        for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor']) {
          if (OLD.includes(cs[prop])) bad.push((el.className || el.tagName) + ' ' + prop + '=' + cs[prop])
        }
      }
      check(root)
      root.querySelectorAll('*').forEach(check)
      document.querySelectorAll('.novel-dialog, .novel-dialog *').forEach(check)
      return bad
    })()`
  )
  assert.deepEqual(legacyColors, [], `小说工作区不应残留旧绿色配色：${legacyColors.join(' | ')}`)
  step('颜色扫描 OK')

  await shot(win, 'novel-desk.png')

  /* ---------- B3. 窄窗口不溢出 ---------- */
  for (const size of [{ width: 1440, height: 900 }, { width: 1080, height: 720 }]) {
    win.setSize(size.width, size.height)
    await wait(500)
    assert.equal(
      await js(win, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
      true,
      `${size.width}×${size.height} 下不应出现横向溢出`
    )
  }
  win.setSize(1440, 900)
  await wait(300)

  assert.deepEqual(errors, [], `不应有控制台错误：${errors.join(' | ')}`)

  console.log('PASS: 界面统一 —— 作品库/写作台头部高度与对话工作区一致，按钮为全局胶囊样式、主按钮使用 ink 黑，旧绿色调 0 残留。')
  console.log('PASS: 写作区排版 —— 768px 内容栏、字号/行距/字体设置即时生效（22px / 48.4px / 宋体）。')
  console.log('PASS: 写作手感 —— 回车自动首行缩进、Tab 插入全角缩进、Ctrl+S 立即保存并落盘、专注模式与 Esc 退出、字数统计。')
  console.log('PASS: 一键整理排版 —— 统一首行缩进、清理多余空行与行尾空格；1440/1080 宽度下均无横向溢出。')
  console.log('PASS: 截图已保存 novel-desk.png。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  console.error('控制台错误 =', errors.length ? errors.join(' | ') : '（无）')
  cleanup()
  app.exit(1)
})
