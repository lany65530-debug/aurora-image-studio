/**
 * 小说写作台 · 新版界面结构自检（参考作家助手布局）
 * 前置：npm run build，然后 npx electron verify-novel-desk-ui.cjs
 * 覆盖：顶栏 / 工具栏 / 左目录树 / 中间正文 / 右工具轨 / 底部状态栏，
 *       以及插入、输入、背景、一键排版、全屏、窄屏不溢出。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-desk-ui-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()
function cleanup() {
  try { fs.rmSync(TMP_USER_DATA, { recursive: true, force: true }) } catch { /* ignore */ }
}

require('./out/main/index.js')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (n) => console.log(`step: ${n}`)
const js = (w, c) => w.webContents.executeJavaScript(c, true)
async function until(label, fn, timeout = 20000) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    } catch (e) {
      last = e
    }
    if (Date.now() > end) throw new Error(`等待超时：${label}（${String(last)}）`)
    await wait(150)
  }
}

const errors = []
const guard = setTimeout(() => { console.error('FAIL: 超时'); app.exit(1) }, 120000)

;(async () => {
  await app.whenReady()
  const win = await until('主窗口', () => BrowserWindow.getAllWindows()[0])
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg) })
  await until('页面加载', async () => (await js(win, 'document.readyState')) === 'complete')
  await until('侧边栏', async () => (await js(win, "document.querySelectorAll('#wsList .ws-item').length")) >= 1)
  await js(win, `[...document.querySelectorAll('#wsList .ws-item')].find(e => e.textContent.includes('小说')).click()`)
  await until('作品库', async () => await js(win, "!!document.querySelector('.folio')"))
  await js(win, "document.getElementById('novelCreate').click()")
  await until('新建弹窗', async () => await js(win, "!!document.getElementById('qc-title')"))
  await js(win, "(() => { document.getElementById('qc-title').value='界面结构自检'; document.getElementById('qc-ok').click(); return true })()")
  await until('空作品', async () => await js(win, "!!document.querySelector('.novel-empty-book')"))
  await js(win, "document.querySelector('[data-act=\"first\"]').click()")
  await until('写作台', async () => await js(win, "!!document.getElementById('novelChapterContent')"))
  step('写作台已渲染')

  /* A. 结构 */
  const structure = await js(win, `(() => {
    const q = (s) => !!document.querySelector(s)
    return {
      header: q('.desk-header'), toolbar: q('.desk-toolbar'),
      toolbarText: document.querySelector('.desk-toolbar')?.textContent || '',
      sidebarTabs: document.querySelectorAll('.desk-sidebar-tab').length,
      groups: [...document.querySelectorAll('.desk-group')].map((e) => e.textContent),
      railItems: [...document.querySelectorAll('.desk-rail-item')].map((e) => e.textContent.trim()),
      status: q('.desk-status'),
      word: document.getElementById('deskWordCount')?.textContent || '',
      plan: document.querySelector('.desk-status-center')?.textContent || '',
      manuscriptWidth: getComputedStyle(document.querySelector('.desk-manuscript')).width
    }
  })()`)
  assert.ok(structure.header && structure.toolbar && structure.sidebarTabs === 2 && structure.status, '顶栏/工具栏/目录 tabs/状态栏应齐全')
  const TOOLS = ['字体', '背景', '一键排版', '插入', '输入', '全屏', '闭关', '查找替换', '取名', '画师', '历史', 'AI 创作', '发布投稿至阅文', '发布至其他平台']
  TOOLS.forEach((t) => assert.ok(structure.toolbarText.includes(t), `工具栏应包含「${t}」`))
  assert.deepEqual(structure.railItems, ['校对', '拆书', '大纲', '角色', '设定', '关系', '双栏', '对比'], '右侧工具轨应与参考一致')
  assert.ok(structure.groups.some((g) => g.includes('第一卷')), '目录应显示分卷分组')
  assert.ok(/字$/.test(structure.word), `状态栏字数应以「字」结尾（实际 ${structure.word}）`)
  assert.ok(structure.plan.includes('计划'), '状态栏应显示计划字数')
  assert.equal(structure.manuscriptWidth, '768px', '正文内容栏应保持 768px')
  step('结构 OK：工具栏 / 目录树 / 右工具轨 / 状态栏与参考一致')

  /* B. 插入菜单 */
  await js(win, "document.querySelector('[data-act=\"insert-menu\"]').click()")
  const menuCount = await until('插入菜单', async () => await js(win, "document.querySelectorAll('.desk-menu button').length"))
  assert.equal(menuCount, 4, '插入菜单应有 4 项')
  await js(win, "(() => { const item=[...document.querySelectorAll('.desk-menu button')].find((b) => b.textContent.includes('省略号')); item.click(); return true })()")
  await wait(300)
  assert.ok(String(await js(win, "document.getElementById('novelChapterContent').value")).includes('……'), '插入菜单应能写入省略号')
  step('插入菜单 OK')

  /* C. 输入菜单：自动首行缩进开关 */
  await js(win, "document.querySelector('[data-act=\"input-menu\"]').click()")
  const label1 = await until('输入菜单', async () => await js(win, "document.querySelector('.desk-menu button')?.textContent"))
  await js(win, "document.querySelector('.desk-menu button').click()")
  await wait(300)
  await js(win, "document.querySelector('[data-act=\"input-menu\"]').click()")
  const label2 = await until('输入菜单2', async () => await js(win, "document.querySelector('.desk-menu button')?.textContent"))
  assert.notEqual(label1, label2, `自动缩进开关应切换文案：${label1} → ${label2}`)
  await js(win, "document.querySelector('.desk-menu button').click()")
  await wait(200)
  step('输入菜单 OK：自动首行缩进可开关')

  /* D. 背景主题 / 一键排版 */
  const beforeTheme = await js(win, "document.querySelector('.desk').className")
  await js(win, "document.querySelector('[data-act=\"theme-cycle\"]').click()")
  await wait(400)
  assert.notEqual(await js(win, "document.querySelector('.desk').className"), beforeTheme, '背景按钮应切换主题')
  await js(win, "document.querySelector('[data-act=\"theme-cycle\"]').click()")
  await wait(300)
  await js(win, `(() => { const ta=document.getElementById('novelChapterContent'); ta.value='第一段。\\n\\n\\n第二段。   '; ta.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  await wait(300)
  await js(win, "document.querySelector('[data-act=\"normalize\"]').click()")
  await wait(600)
  const normalized = String(await js(win, "document.getElementById('novelChapterContent').value"))
  assert.ok(normalized.split('\n').filter((l) => l.trim()).every((l) => l.startsWith('\u3000')), `一键排版应统一全角缩进（实际 ${JSON.stringify(normalized)}）`)
  step('背景 / 一键排版 OK')

  /* E. 全屏专注 */
  await js(win, "document.querySelector('[data-act=\"desk-focus\"]').click()")
  await wait(300)
  const focused = await js(win, `(() => ({
    focused: document.querySelector('.desk').classList.contains('is-focused'),
    toolbar: getComputedStyle(document.querySelector('.desk-toolbar')).display,
    rail: getComputedStyle(document.querySelector('.desk-rail')).display,
    exit: getComputedStyle(document.getElementById('deskFocusExit')).display
  }))()`)
  assert.ok(focused.focused, '全屏应进入专注模式')
  assert.equal(focused.toolbar, 'none', '专注模式应隐藏工具栏')
  assert.equal(focused.rail, 'none', '专注模式应隐藏右工具轨')
  assert.notEqual(focused.exit, 'none', '专注模式应提供退出入口')
  await js(win, "document.getElementById('deskFocusExit').click()")
  await wait(300)
  assert.equal(await js(win, "document.querySelector('.desk').classList.contains('is-focused')"), false, '应能退出专注')
  step('全屏 / 专注 OK')

  /* F. 最小窗口宽度不溢出（主窗口 minWidth=1080） */
  win.setSize(1080, 720)
  await wait(500)
  const narrow = await js(win, `(() => ({
    overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    toolbarScroll: getComputedStyle(document.querySelector('.desk-toolbar')).overflowX,
    rail: getComputedStyle(document.querySelector('.desk-rail')).display,
    manuscript: getComputedStyle(document.querySelector('.desk-manuscript')).width
  }))()`)
  assert.equal(narrow.overflow, true, '最小宽度不应出现整页横向溢出')
  assert.equal(narrow.toolbarScroll, 'auto', '工具栏应在内部横向滚动')
  assert.equal(narrow.rail, 'none', '1080 宽度下应收起右工具轨')
  assert.ok(parseFloat(narrow.manuscript) <= 768, `正文栏不应超过 768px（实际 ${narrow.manuscript}）`)
  win.setSize(1440, 900)
  await wait(300)
  step('最小宽度 OK：整页不溢出，自动收起右工具轨')

  assert.deepEqual(errors, [], `不应有控制台错误：${errors.join(' | ')}`)
  console.log('PASS: 写作台新界面 —— 顶栏 / 工具栏 / 目录树 / 右工具轨 / 状态栏结构与交互正常。')
  console.log('PASS: 插入、输入、背景、一键排版、全屏专注、窄屏自适应均通过。')
  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((e) => {
  clearTimeout(guard)
  console.error('FAIL:', e && e.stack ? e.stack : e)
  console.error('console errors =', errors.join(' | ') || '(none)')
  cleanup()
  app.exit(1)
})
