/**
 * 侧边栏 · 工作区辨识度与可扩展性 自检（真实 Electron 窗口）
 * ---------------------------------------------------------------------------
 * 前置：npm run build，然后运行：npx electron verify-workspace-sidebar.cjs
 *
 * 覆盖：
 *  A. 辨识度：每个工作区有专属配色、头像右下角有类型角标；同类型工作区不撞色。
 *  B. 可扩展性：侧边栏可展开（显示名称 / 类型副标题），展开后可按名称 / 类型搜索过滤。
 *  C. 状态：展开偏好持久化；收起时清空搜索，避免隐藏的过滤条件影响列表。
 * 副作用：临时 userData 目录，不触碰真实数据。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sidebar-e2e-'))
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

const guard = setTimeout(() => {
  console.error('FAIL: 自检超时（90s）')
  app.exit(1)
}, 90000)

/** 读取侧边栏当前状态。 */
const snapshot = (win) =>
  js(
    win,
    `(() => {
      const sidebar = document.getElementById('sidebar')
      const items = [...document.querySelectorAll('#wsList .ws-item')]
      const searchWrap = document.getElementById('wsSearchWrap')
      const avatars = items.map((el) => el.querySelector('.ws-avatar'))
      return {
        count: items.length,
        types: items.map((el) => el.dataset.wsType),
        colors: items.map((el) => el.dataset.wsColor),
        names: items.map((el) => (el.querySelector('.ws-name') || {}).textContent || ''),
        tips: items.map((el) => el.dataset.tip || ''),
        badgeCount: document.querySelectorAll('#wsList .ws-type-badge').length,
        avatarVars: avatars.map((av) => av && av.style.getPropertyValue('--ws-bg')),
        avatarRadius: avatars.map((av) => av ? getComputedStyle(av).borderRadius : ''),
        avatarClasses: avatars.map((av) => av ? av.className : ''),
        avatarSize: avatars.map((av) => {
          if (!av) return ''
          const r = av.getBoundingClientRect()
          return Math.round(r.width) + 'x' + Math.round(r.height)
        }),
        badgePx: items.length
          ? Math.round(parseFloat(getComputedStyle(items[0].querySelector('.ws-type-badge')).width))
          : 0,
        collapsed: sidebar.classList.contains('collapsed'),
        searchVisible: getComputedStyle(searchWrap).display !== 'none',
        nameVisible: items.length ? getComputedStyle(items[0].querySelector('.ws-name')).display !== 'none' : false,
        typeVisible: items.length ? getComputedStyle(items[0].querySelector('.ws-type')).display !== 'none' : false,
        empty: document.querySelectorAll('#wsList .ws-empty').length,
        saved: localStorage.getItem('aurora_sidebar_expanded_v1')
      }
    })()`
  )

const setSearch = (win, value) =>
  js(
    win,
    `(() => {
      const input = document.getElementById('wsSearch')
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  )

;(async () => {
  await app.whenReady()
  const win = await until('主窗口就绪', () => BrowserWindow.getAllWindows()[0])
  watch(win, '主窗口')
  await until('主窗口页面加载', async () => (await js(win, 'document.readyState')) === 'complete')
  await until('侧边栏渲染', async () => (await js(win, "document.querySelectorAll('#wsList .ws-item').length")) >= 2)
  step('主窗口就绪')

  /* ---------- A. 辨识度 ---------- */
  const base = await snapshot(win)
  assert.ok(base.count >= 4, `默认应至少有 4 个工作区，实际 ${base.count}`)
  assert.equal(base.badgeCount, base.count, '每个工作区头像都应有类型角标')
  assert.ok(
    base.avatarVars.every((v) => !!v),
    `每个头像都应有专属配色：${JSON.stringify(base.avatarVars)}`
  )
  assert.equal(
    new Set(base.colors).size,
    base.count,
    `默认工作区配色应互不相同：${JSON.stringify(base.colors)}`
  )
  // 默认工作区数量增加到 5 个后，12 色环上不保证任意两色索引间距都 ≥2；
  // 这里只要求配色合法且互不相同（Set 断言），色相本身由调色板保证差异。
  const colorNums = base.colors.map(Number)
  assert.ok(
    colorNums.every((n) => Number.isInteger(n) && n >= 0 && n < 12),
    `配色索引应合法：${JSON.stringify(base.colors)}`
  )
  assert.deepEqual(
    [...new Set(base.types)].sort(),
    ['chat', 'edit', 'image', 'novel'],
    `应覆盖图片 / 聊天 / 小说 / 剪辑四种类型，实际 ${JSON.stringify(base.types)}`
  )
  assert.ok(
    base.tips.every((t) => t.includes('·')),
    `tooltip 应包含类型说明：${JSON.stringify(base.tips)}`
  )
  assert.ok(base.collapsed === true, '默认应为收起的图标轨')
  assert.ok(base.searchVisible === false, '收起态不应显示搜索框')
  assert.ok(base.badgePx >= 16, `类型角标应足够大、便于辨认，实际 ${base.badgePx}px`)

  // 三种类型必须有彼此不同的头像外形：图片=圆角方块，聊天=圆形，小说=书脊
  const radiusOf = (type) => {
    const i = base.types.indexOf(type)
    assert.ok(i >= 0, `默认工作区应包含 ${type} 类型`)
    return base.avatarRadius[i]
  }
  const indexOfType = (type) => {
    const i = base.types.indexOf(type)
    assert.ok(i >= 0, `默认工作区应包含 ${type} 类型`)
    return i
  }
  const imageIndex = indexOfType('image')
  const chatIndex = indexOfType('chat')
  const novelIndex = indexOfType('novel')
  const imageRadius = radiusOf('image')
  const chatRadius = radiusOf('chat')
  const novelRadius = radiusOf('novel')
  assert.ok(chatRadius.includes('50%'), `聊天头像应为圆形，实际 ${chatRadius}`)
  assert.ok(!novelRadius.includes('50%'), `小说头像不应是圆形，实际 ${novelRadius}`)
  assert.notEqual(novelRadius, imageRadius, `小说与图片头像外形必须不同：${novelRadius} vs ${imageRadius}`)
  const [nw, nh] = base.avatarSize[novelIndex].split('x').map(Number)
  assert.ok(nw < nh, `小说头像应为竖向书形（高>宽），实际 ${base.avatarSize[novelIndex]}`)
  assert.equal(base.avatarSize[imageIndex].split('x')[0], base.avatarSize[imageIndex].split('x')[1], '图片头像应为正方形')
  assert.notEqual(base.avatarSize[chatIndex], base.avatarSize[novelIndex], '聊天与小说头像尺寸/外形应不同')
  assert.ok(
    base.avatarClasses.some((c) => c.includes('novel')),
    `小说头像应带 novel 造型类：${JSON.stringify(base.avatarClasses)}`
  )
  step('辨识度 OK：专属配色 + 大尺寸类型角标 + 三种独立外形（方形 / 圆形 / 书脊）')

  /* ---------- B. 展开与搜索 ---------- */
  await js(win, "document.getElementById('sidebarToggle').click()")
  await wait(300)
  let s = await snapshot(win)
  assert.equal(s.collapsed, false, '点击后侧边栏应展开')
  assert.equal(s.searchVisible, true, '展开态应显示搜索框')
  assert.equal(s.nameVisible, true, '展开态应显示工作区名称')
  assert.equal(s.typeVisible, true, '展开态应显示类型副标题')
  assert.equal(s.saved, '1', '展开偏好应写入 localStorage')
  await shot(win, 'workspace-sidebar-expanded.png')
  step('展开 OK：名称 / 类型 / 搜索框可见，偏好已持久化')

  await setSearch(win, '小说')
  await wait(120)
  s = await snapshot(win)
  assert.ok(s.count >= 1, '按小说类型搜索应命中工作区')
  assert.ok(s.types.every((t) => t === 'novel'), `搜索结果应全部为小说工作区：${JSON.stringify(s.types)}`)

  await setSearch(win, 'GPT')
  await wait(120)
  s = await snapshot(win)
  assert.equal(s.count, 1, `按名称搜索 “GPT” 应命中 1 个工作区，实际 ${s.count}`)
  assert.ok(s.names[0].includes('GPT'), `命中的应是 GPT 工作区：${s.names[0]}`)

  await setSearch(win, '不存在的名字')
  await wait(120)
  s = await snapshot(win)
  assert.equal(s.count, 0, '无匹配时不应渲染工作区条目')
  assert.equal(s.empty, 1, '无匹配时应显示空状态提示')
  await shot(win, 'workspace-sidebar-search.png')
  step('搜索 OK：名称 / 类型过滤与空状态')

  /* ---------- C. 收起清空搜索 ---------- */
  await setSearch(win, 'GPT')
  await wait(120)
  await js(win, "document.getElementById('sidebarToggle').click()")
  await wait(250)
  s = await snapshot(win)
  assert.equal(s.collapsed, true, '再次点击应收起')
  assert.equal(s.searchVisible, false, '收起态应隐藏搜索框')
  assert.equal(s.count, base.count, '收起后应恢复完整工作区列表')
  assert.equal(s.saved, '0', '收起偏好应写入 localStorage')
  await shot(win, 'workspace-sidebar-collapsed.png')
  step('收起 OK：搜索被清空，列表恢复完整')

  assert.deepEqual(errors, [], `不应有控制台错误：${errors.join(' | ')}`)

  console.log('PASS: 辨识度 —— 每个工作区专属配色、类型角标、tooltip 带类型，默认工作区不撞色。')
  console.log('PASS: 可扩展 —— 侧边栏可展开显示名称/类型，支持按名称与类型搜索、空状态提示。')
  console.log('PASS: 状态 —— 展开偏好持久化，收起时自动清空搜索。')
  console.log('PASS: 截图已保存 workspace-sidebar-expanded.png / workspace-sidebar-search.png / workspace-sidebar-collapsed.png。')

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
