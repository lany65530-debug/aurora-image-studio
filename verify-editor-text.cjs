/**
 * 剪辑工作区 · 文字 / 字幕 自检（真实 Electron 窗口，可选真实 ffmpeg）
 * ---------------------------------------------------------------------------
 * 前置：npm run build
 * 运行：npx electron verify-editor-text.cjs（设置 AURORA_FFMPEG_PATH 可同时验证 MP4 导出）
 *
 * 覆盖：
 *  A. 添加文字片段 + 预览叠加层渲染（内容 / 字号 / 位置）。
 *  B. 属性面板改文字内容实时生效。
 *  C. SRT 解析导入（多条字幕时间点正确）与 SRT 反向生成。
 *  D. 文字转透明 PNG：像素级校验确实画出了不透明文字。
 *  E. FFmpeg 导出带文字 MP4：ffprobe 校验编码/时长，并抽样画面区域确认文字被烧录。
 * 副作用：临时 userData 与临时文件，不触碰真实数据。
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

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-text-e2e-'))
const TMP_MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-text-media-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()
function cleanup() {
  for (const dir of [TMP_USER_DATA, TMP_MEDIA]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 交给系统回收 */ }
  }
}

const srtPath = path.join(TMP_MEDIA, 'export.srt')
const mp4Path = path.join(TMP_MEDIA, 'text.mp4')

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
  console.error('FAIL: 自检超时（120s）')
  app.exit(1)
}, 120000)

;(async () => {
  await app.whenReady()
  const win = await until('主窗口就绪', () => BrowserWindow.getAllWindows()[0])
  await until('主窗口页面加载', async () => (await js(win, 'document.readyState')) === 'complete')
  await until('侧边栏渲染', async () => (await js(win, "document.querySelectorAll('#wsList .ws-item').length")) >= 4)
  await js(win, `[...document.querySelectorAll('#wsList .ws-item')].find((el) => el.textContent.includes('剪辑')).click()`)
  await until('剪辑视图激活', async () => (await js(win, "!!document.querySelector('.view-edit.active #editorRoot .editor-shell')")) === true)
  step(`ffmpeg = ${FFMPEG || '（未找到，将跳过导出校验）'}`)

  /* ---------- A. 添加文字 + 预览叠加 ---------- */
  await js(win, 'window.__auroraEditor.setPlayhead(0)')
  const clip = await js(win, "window.__auroraEditor.addText('测试标题 A')")
  assert.ok(clip && clip.id, '应创建文字片段')
  assert.equal(clip.text.content, '测试标题 A', '文字内容应正确')
  assert.equal(await js(win, 'document.querySelectorAll(".ed-clip.text").length'), 1, '时间线应渲染文字片段')
  assert.equal(await js(win, 'window.__auroraEditor.textOverlayCount()'), 1, '预览区应渲染文字叠加层')
  const overlay = await js(win, "(() => { const el = document.querySelector('#edTextLayer .ed-overlay-text'); return el ? { text: el.textContent, font: getComputedStyle(el).fontSize, color: getComputedStyle(el).color } : null })()")
  assert.equal(overlay.text, '测试标题 A', '叠加层文字应一致')
  assert.ok(parseFloat(overlay.font) > 0, '叠加层字号应有效')
  step(`添加文字 OK：时间线片段 + 预览叠加「${overlay.text}」（${overlay.font}）`)

  /* ---------- B. 属性面板改内容实时生效 ---------- */
  await js(win, `window.__auroraEditor.select([${JSON.stringify(clip.id)}])`)
  await until('属性面板出现文字输入', async () => (await js(win, "!!document.querySelector('#edInspector [data-text-prop=\"content\"]')")) === true)
  await js(
    win,
    `(() => {
      const ta = document.querySelector('#edInspector [data-text-prop="content"]')
      ta.value = '改过的标题 B'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  const state = await js(win, 'window.__auroraEditor.getState()')
  const edited = state.clips.find((c) => c.id === clip.id)
  assert.equal(edited.text.content, '改过的标题 B', '属性面板应能修改文字内容')
  assert.equal(await js(win, "document.querySelector('#edTextLayer .ed-overlay-text').textContent"), '改过的标题 B', '预览叠加层应实时更新')
  step('属性面板 OK：文字内容修改实时生效')

  /* ---------- C. SRT 解析 / 生成 ---------- */
  const srtSample = [
    '1',
    '00:00:00,500 --> 00:00:02,000',
    '第一条字幕',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,000',
    '第二条字幕',
    ''
  ].join('\n')
  const imported = await js(win, `window.__auroraEditor.importSrtText(${JSON.stringify(srtSample)})`)
  assert.equal(imported, 2, '应解析出 2 条字幕')
  const afterImport = await js(win, 'window.__auroraEditor.getState()')
  const sub1 = afterImport.clips.find((c) => c.text && c.text.content === '第一条字幕')
  const sub2 = afterImport.clips.find((c) => c.text && c.text.content === '第二条字幕')
  assert.ok(sub1 && Math.abs(sub1.start - 0.5) < 0.01 && Math.abs(sub1.duration - 1.5) < 0.02, `第一条字幕时间错误：${sub1 && sub1.start}/${sub1 && sub1.duration}`)
  assert.ok(sub2 && Math.abs(sub2.start - 2.5) < 0.01 && Math.abs(sub2.duration - 1.5) < 0.02, '第二条字幕时间错误')
  const srtOut = await js(win, 'window.__auroraEditor.buildSrtText()')
  assert.ok(srtOut.includes('00:00:00,500 --> 00:00:02,000'), `SRT 应包含正确时间码：\n${srtOut}`)
  assert.ok(srtOut.includes('第一条字幕') && srtOut.includes('第二条字幕'), 'SRT 应包含字幕内容')
  await js(win, `window.aurora.editor.writeFile({ path: ${JSON.stringify(srtPath)}, data: new TextEncoder().encode(window.__auroraEditor.buildSrtText()) })`)
  assert.ok(fs.readFileSync(srtPath, 'utf-8').includes('-->'), 'SRT 文件应成功写盘')
  step('SRT OK：解析导入 2 条字幕、反向生成时间码正确并可写盘')

  /* ---------- D. 文字转 PNG 像素校验 ---------- */
  const dataUrl = await js(win, `window.__auroraEditor.textPngDataUrl(${JSON.stringify(clip.id)}, 1280, 720)`)
  assert.ok(String(dataUrl).startsWith('data:image/png;base64,'), '应能生成透明 PNG')
  const alphaInfo = await js(
    win,
    `(async () => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(dataUrl)} })
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 32) opaque++
      return { w: img.width, h: img.height, opaque }
    })()`
  )
  assert.equal(alphaInfo.w, 1280, 'PNG 宽度应为 1280')
  assert.equal(alphaInfo.h, 720, 'PNG 高度应为 720')
  assert.ok(alphaInfo.opaque > 200, `PNG 应绘制出不透明文字像素，实际 ${alphaInfo.opaque}`)
  step(`文字 PNG OK：1280×720，不透明像素 ${alphaInfo.opaque}`)

  /* ---------- E. 导出「媒体 + 文字」混合 MP4 ---------- */
  if (FFMPEG && HAS_PROBE) {
    // 造一段 2s 音频并加入时间线（音频 + 文字混合）
    const wavPath = path.join(TMP_MEDIA, 'tone.wav')
    const rate = 44100
    const frames = 2 * rate
    const dl = frames * 4
    const wav = Buffer.alloc(44 + dl)
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + dl, 4); wav.write('WAVE', 8); wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24)
    wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dl, 40)
    for (let i = 0; i < frames; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000)
      wav.writeInt16LE(v, 44 + i * 4)
      wav.writeInt16LE(v, 44 + i * 4 + 2)
    }
    fs.writeFileSync(wavPath, wav)
    await js(win, `window.__auroraEditor.addPaths(${JSON.stringify([wavPath])})`)
    const withMedia = await until('音频媒体就绪', async () => {
      const s = await js(win, 'window.__auroraEditor.getState()')
      return s.media.length === 1 && s.media[0].duration > 1 ? s : 0
    }, { timeout: 15000 })
    await js(win, 'window.__auroraEditor.setPlayhead(0)')
    await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(withMedia.media[0].id)}, 0)`)
    await js(win, "window.__auroraEditor.addText('EXPORT')")
    const textImages = await js(win, 'window.__auroraEditor.prepareTextImages(1280, 720)')
    assert.ok(textImages && Object.keys(textImages).length >= 1, '应生成文字 PNG 路径')
    const exported = await js(
      win,
      `window.aurora.editor.exportTimeline({
        project: window.__auroraEditor.getState(),
        outputPath: ${JSON.stringify(mp4Path)},
        width: 1280, height: 720, fps: 25, quality: 'fast', textImages: ${JSON.stringify(textImages)}
      })`
    )
    assert.equal(exported.ok, true, `带文字 MP4 导出应成功：${exported.error || ''}`)
    const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4Path], { encoding: 'utf8' }))
    const v = info.streams.find((s) => s.codec_type === 'video')
    const a = info.streams.find((s) => s.codec_type === 'audio')
    const dur = Number(info.format.duration)
    assert.equal(v.codec_name, 'h264', '导出应为 h264')
    assert.ok(a, '音频 + 文字混合导出应包含音轨')
    assert.ok(dur > 1.8, `导出时长应覆盖音频与文字，实际 ${dur}`)
    // 抽样画面：文字默认在 82% 高度附近，取一块区域算灰度均值，白字应明显 > 0
    const raw = execFileSync(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', mp4Path, '-frames:v', '1', '-vf', 'crop=640:140:320:540,format=gray', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }
    )
    let sum = 0
    for (const byte of raw) sum += byte
    const avg = raw.length ? sum / raw.length : 0
    assert.ok(avg > 2, `画面文字区域应检测到亮像素，实际灰度均值 ${avg.toFixed(2)}`)
    step(`MP4 导出 OK：h264 + ${a.codec_name} 时长 ${dur.toFixed(2)}s，文字区域灰度均值 ${avg.toFixed(2)}`)
  } else {
    step('未找到 ffmpeg/ffprobe，跳过 MP4 导出校验')
  }

  console.log('PASS: 文字 —— 片段 / 叠加层 / 属性面板实时编辑 / 文字 PNG 像素校验。')
  console.log('PASS: 字幕 —— SRT 解析导入、时间点正确、反向生成 SRT 并可写盘。')
  if (FFMPEG && HAS_PROBE) console.log('PASS: 导出 —— FFmpeg 把文字 PNG 烧录进 MP4，画面抽样确认。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  cleanup()
  app.exit(1)
})
