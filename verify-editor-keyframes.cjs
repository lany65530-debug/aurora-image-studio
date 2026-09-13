/**
 * 剪辑工作区 · P1 关键帧动画 自检
 * ---------------------------------------------------------------------------
 * 前置：npm run build
 * 运行：npx electron verify-editor-keyframes.cjs（自动查找可用 ffmpeg）
 *
 * 覆盖：
 *  A. 关键帧创建 / 删除（◆ 按钮、滑杆自动打帧、关键帧 chip 删除）。
 *  B. 属性插值与预览联动（亮度 / 音量按时间变化）。
 *  C. 时间线关键帧菱形标记。
 *  D. FFmpeg 表达式导出：亮度随时间变化的 MP4，抽帧灰度递增。
 * 副作用：临时 userData 与临时媒体，不触碰真实数据。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function pickFfmpeg() {
  const candidates = [
    process.env.AURORA_FFMPEG_PATH,
    'E:\\XIAZAI\\AIB\\bin\\ffmpeg.exe',
    'C:\\Program Files\\File Converter\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && /ffmpeg version/i.test(execFileSync(c, ['-hide_banner', '-version'], { encoding: 'utf8' }))) return c
    } catch {
      /* 下一个 */
    }
  }
  return ''
}
const FFMPEG = pickFfmpeg()
if (FFMPEG) process.env.AURORA_FFMPEG_PATH = FFMPEG
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : ''
const HAS_PROBE = FFPROBE && fs.existsSync(FFPROBE)

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-kf-e2e-'))
const TMP_MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-kf-media-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()
function cleanup() {
  for (const dir of [TMP_USER_DATA, TMP_MEDIA]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 交给系统回收 */ }
  }
}
const videoPath = path.join(TMP_MEDIA, 'clip.webm')
const mp4Path = path.join(TMP_MEDIA, 'kf.mp4')

require('./out/main/index.js')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name) => console.log(`step: ${name}`)
async function until(label, fn, { timeout = 30000, tick = 150 } = {}) {
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
const js = (win, code) => win.webContents.executeJavaScript(code, true)
const guard = setTimeout(() => {
  console.error('FAIL: 自检超时（180s）')
  app.exit(1)
}, 180000)

;(async () => {
  await app.whenReady()
  const win = await until('主窗口就绪', () => BrowserWindow.getAllWindows()[0])
  await until('主窗口页面加载', async () => (await js(win, 'document.readyState')) === 'complete')
  await until('侧边栏渲染', async () => (await js(win, "document.querySelectorAll('#wsList .ws-item').length")) >= 4)
  await js(win, `[...document.querySelectorAll('#wsList .ws-item')].find((el) => el.textContent.includes('剪辑')).click()`)
  await until('剪辑视图激活', async () => (await js(win, "!!document.querySelector('.view-edit.active #editorRoot .editor-shell')")) === true)
  step(`ffmpeg = ${FFMPEG || '（未找到，将跳过导出校验）'}`)

  // 2s 画布视频（偏暗，方便亮度关键帧对比）
  const recorded = await js(
    win,
    `(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 240
      const ctx = canvas.getContext('2d')
      const stream = canvas.captureStream(25)
      let ac = null
      try {
        ac = new AudioContext()
        const osc = ac.createOscillator(); osc.frequency.value = 300
        const dest = ac.createMediaStreamDestination()
        osc.connect(dest); osc.start()
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
      } catch {}
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'
      const rec = new MediaRecorder(stream, { mimeType: mime })
      const chunks = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      const stopped = new Promise((r) => { rec.onstop = r })
      rec.start()
      const t0 = performance.now()
      await new Promise((resolve) => {
        const draw = () => {
          const el = performance.now() - t0
          ctx.fillStyle = 'rgb(40,60,90)'
          ctx.fillRect(0, 0, 320, 240)
          if (el > 2000) { resolve(); return }
          requestAnimationFrame(draw)
        }
        requestAnimationFrame(draw)
      })
      rec.stop(); await stopped
      if (ac) { try { await ac.close() } catch {} }
      const blob = new Blob(chunks, { type: mime })
      const data = new Uint8Array(await blob.arrayBuffer())
      const res = await window.aurora.editor.writeFile({ path: ${JSON.stringify(videoPath.split(path.sep).join('/'))}, data })
      return { ok: res.ok, size: data.length }
    })()`
  )
  assert.ok(recorded.ok && recorded.size > 1000, '测试视频应生成')
  await js(win, `window.__auroraEditor.addPaths(${JSON.stringify([videoPath.split(path.sep).join('/')])})`)
  const mediaState = await until('媒体就绪', async () => {
    const s = await js(win, 'window.__auroraEditor.getState()')
    return s.media.length === 1 && s.media[0].duration > 1.5 ? s : 0
  }, { timeout: 25000 })
  const media = mediaState.media[0]
  await js(win, 'window.__auroraEditor.setPlayhead(0)')
  const clip = await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(media.id)}, 0)`)
  await js(win, `window.__auroraEditor.select([${JSON.stringify(clip.id)}])`)

  /* ---------- A. 创建关键帧 ---------- */
  await js(win, `window.__auroraEditor.setKeyframe('brightness', 0, 100)`)
  await js(win, `window.__auroraEditor.setKeyframe('brightness', 1.5, 180)`)
  await js(win, `window.__auroraEditor.setKeyframe('volume', 0, 1)`)
  await js(win, `window.__auroraEditor.setKeyframe('volume', 1.5, 0.2)`)
  let kfs = await js(win, 'window.__auroraEditor.getKeyframes()')
  assert.ok(kfs.brightness && kfs.brightness.length === 2, '亮度应有 2 个关键帧')
  assert.ok(kfs.volume && kfs.volume.length === 2, '音量应有 2 个关键帧')
  assert.ok((await js(win, 'document.querySelectorAll(".ed-kf-dot").length')) >= 2, '时间线应显示关键帧标记')
  await until('关键帧列表渲染', async () => (await js(win, 'document.querySelectorAll(".ed-kf-chip").length')) >= 4)
  step('关键帧创建 OK：亮度 / 音量各 2 帧，时间线与列表可见')

  /* ---------- B. 插值与预览联动 ---------- */
  await js(win, 'window.__auroraEditor.setPlayhead(0.75)')
  const midBright = await js(win, "window.__auroraEditor.kfValueAt('brightness')")
  const midVolume = await js(win, "window.__auroraEditor.kfValueAt('volume')")
  assert.ok(midBright > 135 && midBright < 145, `0.75s 亮度应约 140，实际 ${midBright}`)
  assert.ok(Math.abs(midVolume - 0.6) < 0.03, `0.75s 音量应约 0.6，实际 ${midVolume}`)
  const previewFilter = await js(win, "document.getElementById('edVideo').style.filter")
  assert.ok(previewFilter.includes('brightness(140'), `预览滤镜应使用插值亮度，实际 ${previewFilter}`)
  step(`插值 OK：0.75s 亮度 ${midBright.toFixed(1)}、音量 ${midVolume.toFixed(2)}，预览滤镜联动`)

  /* ---------- A2. ◆ 按钮 / 滑杆自动打帧 / chip 删除 ---------- */
  const clipStart = (await js(win, 'window.__auroraEditor.getState()')).clips.find((c) => c.id === clip.id).start
  await js(win, `window.__auroraEditor.setPlayhead(${clipStart + 0.5})`)
  await js(win, `document.querySelector('[data-act="kf-toggle"][data-kf-prop="rotation"]').click()`)
  kfs = await js(win, 'window.__auroraEditor.getKeyframes()')
  assert.ok(kfs.rotation && kfs.rotation.length === 1, '◆ 应添加旋转关键帧')
  await js(win, `document.querySelector('[data-act="kf-toggle"][data-kf-prop="rotation"]').click()`)
  kfs = await js(win, 'window.__auroraEditor.getKeyframes()')
  assert.ok(!kfs.rotation || kfs.rotation.length === 0, '再次点击应删除旋转关键帧')
  // 滑杆自动打帧：亮度已有动画 → 在 0.5s 处插入关键帧
  await js(win, `window.__auroraEditor.setPlayhead(${clipStart + 0.5})`)
  await js(
    win,
    `(() => {
      const input = document.querySelector('#edInspector [data-kf-prop="brightness"]')
      input.value = '150'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  kfs = await js(win, 'window.__auroraEditor.getKeyframes()')
  assert.equal(kfs.brightness.length, 3, '滑杆应在 0.5s 自动插入亮度关键帧')
  assert.ok(Math.abs(kfs.brightness.find((k) => Math.abs(k.t - 0.5) < 0.07).v - 150) < 1, '自动关键帧值应为 150')
  // 删除第一个亮度关键帧
  await js(win, `document.querySelector('.ed-kf-chip i[data-act="kf-del"][data-kf-prop="brightness"]').click()`)
  kfs = await js(win, 'window.__auroraEditor.getKeyframes()')
  assert.equal(kfs.brightness.length, 2, 'chip 删除应减少一个关键帧')
  step('关键帧编辑 OK：◆ 增删、滑杆自动打帧、chip 删除')

  /* ---------- D. 表达式导出（亮度随时间升高） ---------- */
  if (FFMPEG && HAS_PROBE) {
    const live = await js(win, 'window.__auroraEditor.getState()')
    const start = Math.min(...live.clips.filter((c) => c.id === clip.id).map((c) => c.start))
    const exported = await js(
      win,
      `window.aurora.editor.exportTimeline({
        project: window.__auroraEditor.getState(),
        outputPath: ${JSON.stringify(mp4Path.split(path.sep).join('/'))},
        width: 1280, height: 720, fps: 25, quality: 'fast'
      })`
    )
    assert.equal(exported.ok, true, `关键帧 MP4 导出应成功：${exported.error || ''}`)
    const sample = (t) => {
      const raw = execFileSync(
        FFMPEG,
        ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', mp4Path, '-frames:v', '1', '-vf', 'scale=320:180,format=gray', '-f', 'rawvideo', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }
      )
      let sum = 0
      for (const byte of raw) sum += byte
      return raw.length ? sum / raw.length : 0
    }
    const early = sample(start + 0.2)
    const late = sample(start + 1.4)
    assert.ok(late > early + 4, `亮度关键帧应使画面变亮：早=${early.toFixed(1)} 晚=${late.toFixed(1)}`)
    step(`表达式导出 OK：画面灰度 ${early.toFixed(1)} → ${late.toFixed(1)}，亮度动画已烧录`)
  } else {
    step('未找到 ffmpeg/ffprobe，跳过关键帧导出校验')
  }

  console.log('PASS: 关键帧 —— 创建/删除/插值/预览联动/时间线标记。')
  if (FFMPEG && HAS_PROBE) console.log('PASS: 关键帧导出 —— eq 表达式随帧求值，画面亮度随时间变化。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  cleanup()
  app.exit(1)
})
