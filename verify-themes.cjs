/**
 * 六套主题 · 真实窗口视觉自检 + 设置链路端到端自检
 * ---------------------------------------------------------------------------
 * 前置：npm run build，然后运行：npx electron verify-themes.cjs
 *
 * 覆盖：
 *  A. 六套主题都能真实渲染（逐套截图，用于人工/视觉核对）
 *  B. 点设置弹窗里的主题卡片 → <html data-theme> 立即变化
 *  C. 该变更真的落盘到主进程 ui-settings.json（重启后能保持）
 *  D. 字号 / 密度 / 减少动效 开关均生效
 * 副作用：临时 userData 目录，不触碰真实数据。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-theme-e2e-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()

require('./out/main/index.js')

const THEMES = ['aurora', 'nocturne', 'botanical', 'frosted', 'ios', 'comic']
const SHOT_DIR = path.join(__dirname, 'shots-theme')
const UI_SETTINGS_FILE = path.join(TMP_USER_DATA, 'ui-settings.json')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const js = (win, code) => win.webContents.executeJavaScript(code, true)

async function until(label, fn, { timeout = 25000, step = 150 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > deadline) throw new Error(`超时: ${label}${last ? ' / ' + last.message : ''}`)
    await wait(step)
  }
}

async function shot(win, file) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(SHOT_DIR, file), img.toPNG())
  console.log(`  截图 ${file}`)
}

/** 在设置弹窗里点某个主题卡片（走真实 UI 链路，而不是直接改 DOM 属性）。 */
async function clickThemeCard(win, theme) {
  await until('设置弹窗打开', () => js(win, `!!document.querySelector('#appSettingsModal.open')`))
  await js(win, `document.querySelector('[data-theme-id="${theme}"]').click(); true`)
  await until(`主题切到 ${theme}`, () => js(win, `document.documentElement.dataset.theme === '${theme}'`))
}

async function main() {
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const win = await until('主窗口就绪', () => BrowserWindow.getAllWindows()[0])
  await until('渲染层就绪', () => js(win, `!!document.querySelector('#settingsEntryBtn') && !!window.aurora`))
  await until('工作区渲染完成', () => js(win, `!!document.querySelector('.ws-list')`))
  await wait(1200)

  console.log('step: 默认主题应为 aurora')
  assert.equal(await js(win, `document.documentElement.dataset.theme`), 'aurora')

  console.log('step: 打开应用设置')
  await js(win, `document.querySelector('#settingsEntryBtn').click(); true`)
  await until('设置弹窗打开', () => js(win, `!!document.querySelector('#appSettingsModal.open')`))
  assert.equal(await js(win, `document.querySelectorAll('.theme-card').length`), THEMES.length, '应有 6 张主题卡')
  await wait(400)
  await shot(win, 'settings-aurora.png')

  console.log('step: 逐套切换主题并截图（走真实卡片点击）')
  for (const theme of THEMES) {
    await clickThemeCard(win, theme)
    await wait(420)
    await shot(win, `settings-${theme}.png`)
    // 关掉弹窗，截一张纯主界面
    await js(win, `document.querySelector('#appSettingsClose').click(); true`)
    await until('设置弹窗关闭', () => js(win, `!document.querySelector('#appSettingsModal.open')`))
    await wait(700)
    assert.equal(
      await js(win, `document.querySelector('#appSettingsModal').classList.contains('open')`),
      false,
      '主界面截图前弹窗必须已关闭'
    )
    await shot(win, `main-${theme}.png`)
    await js(win, `document.querySelector('#settingsEntryBtn').click(); true`)
    await until('设置弹窗打开', () => js(win, `!!document.querySelector('#appSettingsModal.open')`))
  }

  console.log('step: 字号 / 密度 / 减少动效 应真实生效')
  await js(win, `document.querySelector('[data-seg="fontScale"][data-value="xl"]').click(); true`)
  await until('字号变大', () => js(win, `document.documentElement.style.getPropertyValue('--font-size-base') === '17px'`))
  await js(win, `document.querySelector('[data-seg="density"][data-value="compact"]').click(); true`)
  await until('密度生效', () => js(win, `document.documentElement.dataset.density === 'compact'`))
  await js(win, `document.querySelector('[data-switch="reduceMotion"]').click(); true`)
  await until('动效关闭', () => js(win, `document.documentElement.dataset.motion === 'off'`))
  await shot(win, 'settings-accessibility.png')

  console.log('step: 变更应落盘到主进程 ui-settings.json')
  const persisted = await until('ui-settings.json 落盘', () => {
    if (!fs.existsSync(UI_SETTINGS_FILE)) return null
    const j = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, 'utf-8'))
    return j.theme === 'comic' && j.fontScale === 'xl' ? j : null
  })
  assert.equal(persisted.density, 'compact')
  assert.equal(persisted.reduceMotion, true)
  console.log('  已落盘:', JSON.stringify(persisted))

  console.log('step: 关掉动效后过渡时长应被强制归零')
  const dur = await js(
    win,
    `getComputedStyle(document.querySelector('.theme-card')).transitionDuration`
  )
  console.log('  .theme-card transitionDuration =', dur)
  // 浏览器把 0.001ms 换算成秒后是 1e-06s
  assert.ok(dur === '1e-06s' || dur.startsWith('0.001ms'), 'reduceMotion 应把过渡压到接近 0')

  console.log('step: 恢复默认')
  await js(win, `document.querySelector('#appSettingsReset').click(); true`)
  await until('已恢复 aurora', () => js(win, `document.documentElement.dataset.theme === 'aurora'`))
  await wait(300)
  await shot(win, 'settings-reset.png')

  console.log('\n全部通过 ✅  截图目录: shots-theme/')
  app.exit(0)
}

main().catch((e) => {
  console.error('\n失败 ❌', e)
  app.exit(1)
})
