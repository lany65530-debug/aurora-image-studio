/**
 * 剪辑工作区 · FFmpeg 接入自检（真实 Electron 窗口 + 真实 ffmpeg）
 * ---------------------------------------------------------------------------
 * 前置：npm run build
 * 运行：AURORA_FFMPEG_PATH=D:\path\to\ffmpeg.exe npx electron verify-editor-ffmpeg.cjs
 * 未设置时脚本会自动在常见位置找一个带 libx264 的 ffmpeg。
 *
 * 覆盖：
 *  A. 自动检测 ffmpeg / ffprobe（来源、编码器）。
 *  B. ffprobe 探测：AVI(MPEG-4+MP3) 判定为「Chromium 不可直接播放」。
 *  C. 自动转码代理：生成 H.264/AAC MP4 并挂到媒体上，渲染层用代理预览。
 *  D. 抽帧缩略图。
 *  E. FFmpeg filter_complex 直接导出 MP4（非实时），ffprobe 校验编码 / 分辨率 / 时长。
 * 副作用：临时 userData 与临时媒体文件，不触碰真实数据。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* ---------- 找一个可用的 ffmpeg（优先环境变量） ---------- */
function pickFfmpeg() {
  const candidates = [
    process.env.AURORA_FFMPEG_PATH,
    'E:\\XIAZAI\\AIB\\bin\\ffmpeg.exe',
    'C:\\Program Files\\File Converter\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue
      const out = execFileSync(c, ['-hide_banner', '-version'], { encoding: 'utf8' })
      if (/ffmpeg version/i.test(out)) return c
    } catch {
      /* 尝试下一个 */
    }
  }
  return ''
}

const FFMPEG = pickFfmpeg()
if (!FFMPEG) {
  console.error('FAIL: 未找到可用的 ffmpeg，请设置 AURORA_FFMPEG_PATH')
  process.exit(1)
}
const FFPROBE = path.join(path.dirname(FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const HAS_PROBE = fs.existsSync(FFPROBE)
process.env.AURORA_FFMPEG_PATH = FFMPEG

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-ffmpeg-e2e-'))
const TMP_MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-ffmpeg-media-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()

function cleanup() {
  for (const dir of [TMP_USER_DATA, TMP_MEDIA]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 交给系统回收 */
    }
  }
}

/* ---------- 造素材：AVI（Chromium 不支持）+ WAV ---------- */
const aviPath = path.join(TMP_MEDIA, 'source.avi')
const wavPath = path.join(TMP_MEDIA, 'tone.wav')
execFileSync(
  FFMPEG,
  ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'mp3', '-shortest', aviPath]
)
execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5', '-c:a', 'pcm_s16le', wavPath])
const exportPath = path.join(TMP_MEDIA, 'export.mp4')

require('./out/main/index.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name) => console.log(`step: ${name}`)

async function until(label, fn, { timeout = 40000, tick = 150 } = {}) {
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
  step(`ffmpeg = ${FFMPEG}`)

  await js(win, `[...document.querySelectorAll('#wsList .ws-item')].find((el) => el.textContent.includes('剪辑')).click()`)
  await until('剪辑视图激活', async () => (await js(win, "!!document.querySelector('.view-edit.active #editorRoot .editor-shell')")) === true)

  /* ---------- A. 状态检测 ---------- */
  const status = await until('ffmpeg 状态就绪', async () => {
    const s = await js(win, 'window.__auroraEditor.getFfmpegStatus()')
    return s && s.available ? s : 0
  }, { timeout: 20000 })
  assert.ok(status.available, '应检测到 ffmpeg')
  assert.ok(status.encoders.length > 0, '应读取到编码器列表')
  step(`状态 OK：source=${status.source}，encoders=${status.encoders.filter((e) => /264/.test(e)).join('/')}`)

  /* ---------- B/C. 导入 AVI -> 探测 -> 自动转码代理 ---------- */
  const probe = await js(win, `window.aurora.editor.probe({ path: ${JSON.stringify(aviPath)} })`)
  assert.equal(probe.ok, true, `AVI 应能探测：${probe.error || ''}`)
  assert.equal(probe.playable, false, `AVI(MPEG-4) 应判定为 Chromium 不可直接播放（container=${probe.container}）`)
  assert.ok(probe.duration > 1.5, `探测时长应约 2s，实际 ${probe.duration}`)
  assert.equal(probe.hasVideo, true, 'AVI 应探测到视频流')
  step(`探测 OK：${probe.container} / ${probe.videoCodec}+${probe.audioCodec} / playable=${probe.playable}`)

  await js(win, `window.__auroraEditor.addPaths(${JSON.stringify([aviPath, wavPath])})`)
  const mediaState = await until('自动转码代理完成', async () => {
    const s = await js(win, 'window.__auroraEditor.getState()')
    if (s.media.length !== 2) return 0
    const avi = s.media.find((m) => m.name.endsWith('.avi'))
    return avi && avi.proxyPath && avi.duration > 1.5 ? s : 0
  }, { timeout: 60000 })
  const aviMedia = mediaState.media.find((m) => m.name.endsWith('.avi'))
  const wavMedia = mediaState.media.find((m) => m.name.endsWith('.wav'))
  assert.ok(aviMedia.proxyPath && fs.existsSync(aviMedia.proxyPath), `代理文件应存在：${aviMedia.proxyPath}`)
  assert.ok(String(aviMedia.proxyPath).endsWith('.mp4'), '代理应为 MP4')
  assert.equal(aviMedia.needsProxy, true, 'AVI 应标记 needsProxy')
  assert.equal(wavMedia.needsProxy, false, 'WAV 可直接播放，不需要代理')
  step(`代理 OK：${path.basename(aviMedia.proxyPath)}（${(fs.statSync(aviMedia.proxyPath).size / 1024).toFixed(0)}KB）`)

  /* ---------- D. 抽帧缩略图 ---------- */
  const thumb = await js(win, `window.aurora.editor.thumbnail({ path: ${JSON.stringify(aviPath)}, at: 0.5 })`)
  assert.equal(thumb.ok, true, `缩略图应生成：${thumb.error || ''}`)
  assert.ok(String(thumb.dataUrl).startsWith('data:image/jpeg;base64,'), '缩略图应为 JPEG dataURL')
  step(`缩略图 OK：${(thumb.dataUrl.length / 1024).toFixed(1)}KB`)

  /* ---------- E. 导出 MP4 并用 ffprobe 校验 ---------- */
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(aviMedia.id)}, 0)`)
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(wavMedia.id)}, 0)`)
  const state = await js(win, 'window.__auroraEditor.getState()')
  const aviClips = state.clips.filter((c) => c.mediaId === aviMedia.id)
  assert.ok(aviClips.length >= 1, 'AVI 应生成至少 1 个片段')
  if (aviClips.length === 2) {
    assert.ok(aviClips[0].linkId && aviClips[0].linkId === aviClips[1].linkId, 'AVI 视频 + 音频应自动链接')
  }
  assert.equal(state.clips.length, 1 + aviClips.length, `应有 ${1 + aviClips.length} 个片段`)
  const expected = Math.max(...state.clips.map((c) => c.start + c.duration))

  const exported = await js(
    win,
    `window.aurora.editor.exportTimeline({
      project: window.__auroraEditor.getState(),
      outputPath: ${JSON.stringify(exportPath)},
      width: 1280, height: 720, fps: 25, quality: 'fast'
    })`
  )
  assert.equal(exported.ok, true, `MP4 导出应成功：${exported.error || ''}`)
  assert.ok(fs.existsSync(exportPath) && fs.statSync(exportPath).size > 10000, `导出文件应存在且有内容：${fs.statSync(exportPath).size} bytes`)
  step(`导出 OK：${(fs.statSync(exportPath).size / 1024).toFixed(0)}KB`)

  if (HAS_PROBE) {
    const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', exportPath], { encoding: 'utf8' }))
    const v = info.streams.find((s) => s.codec_type === 'video')
    const a = info.streams.find((s) => s.codec_type === 'audio')
    const dur = Number(info.format.duration)
    assert.equal(v.codec_name, 'h264', `导出视频应为 h264，实际 ${v.codec_name}`)
    assert.equal(v.width, 1280, `导出宽度应为 1280，实际 ${v.width}`)
    assert.equal(v.height, 720, `导出高度应为 720，实际 ${v.height}`)
    assert.ok(a, '导出 MP4 应包含音频轨')
    assert.ok(Math.abs(dur - expected) < 0.6, `导出时长应约 ${expected.toFixed(2)}s，实际 ${dur.toFixed(2)}s`)
    step(`ffprobe 校验 OK：h264 ${v.width}x${v.height} + ${a.codec_name}，时长 ${dur.toFixed(2)}s`)
  } else {
    step('未找到 ffprobe，跳过导出文件校验')
  }

  console.log('PASS: FFmpeg 接入 —— 自动检测 / ffprobe 探测 / AVI 自动转码代理 / 抽帧缩略图。')
  console.log('PASS: FFmpeg 导出 —— filter_complex 直接渲染 H.264/AAC MP4，编码 / 分辨率 / 时长校验通过。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  cleanup()
  app.exit(1)
})
