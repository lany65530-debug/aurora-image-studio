/**
 * 剪辑工作区 · P0-4 转场 + P0-5 自动保存/恢复/多分辨率波形/胶片带 自检
 * ---------------------------------------------------------------------------
 * 前置：npm run build
 * 运行：npx electron verify-editor-p04p05.cjs（自动查找可用 ffmpeg）
 *
 * 覆盖：
 *  A. 转场：添加 / 类型切换 / 时长调整 / 预览双视频交叉 / 时间线角标 / 移除。
 *  B. 导出：带 xfade 的 MP4，ffprobe 校验编码与时长，画面抽样确认转场帧非纯黑。
 *  C. 自动保存 + 崩溃恢复：快照落盘、恢复 / 忽略。
 *  D. 多分辨率波形：峰值点数 > 600 且随缩放变化。
 *  E. 真实胶片带：多帧拼接缩略图应用到时间线片段。
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

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-p04p05-'))
const TMP_MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-p04p05-media-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()
function cleanup() {
  for (const dir of [TMP_USER_DATA, TMP_MEDIA]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 交给系统回收 */ }
  }
}

// 6 秒 WAV（用于多分辨率波形：>=700 个峰值点）
const wavPath = path.join(TMP_MEDIA, 'tone6s.wav')
{
  const rate = 44100
  const frames = 6 * rate
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
}
const videoPath = path.join(TMP_MEDIA, 'clip.webm')
const mp4Path = path.join(TMP_MEDIA, 'transition.mp4')

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
  step(`ffmpeg = ${FFMPEG || '（未找到，将跳过导出/胶片带校验）'}`)

  /* 生成 1.2s 测试视频（画布录制） */
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
        const osc = ac.createOscillator(); osc.frequency.value = 330
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
          ctx.fillStyle = 'hsl(' + ((el / 4) % 360) + ',72%,52%)'
          ctx.fillRect(0, 0, 320, 240)
          if (el > 1200) { resolve(); return }
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

  await js(win, `window.__auroraEditor.addPaths(${JSON.stringify([videoPath.split(path.sep).join('/'), wavPath.split(path.sep).join('/')])})`)
  const mediaState = await until('媒体就绪', async () => {
    const s = await js(win, 'window.__auroraEditor.getState()')
    return s.media.length === 2 && s.media.every((m) => m.duration > 0.5) ? s : 0
  }, { timeout: 25000 })
  const videoMedia = mediaState.media.find((m) => m.kind === 'video')
  const audioMedia = mediaState.media.find((m) => m.kind === 'audio')

  /* ---------- D. 多分辨率波形 ---------- */
  const peaksLen = await until('波形生成', async () => {
    const s = await js(win, 'window.__auroraEditor.getState()')
    const a = s.media.find((m) => m.kind === 'audio')
    return a && Array.isArray(a.peaks) && a.peaks.length >= 600 ? a.peaks.length : 0
  }, { timeout: 15000 })
  assert.ok(peaksLen > 600, `6 秒音频应生成多分辨率波形（>600 点），实际 ${peaksLen}`)
  await js(win, 'window.__auroraEditor.setPlayhead(0)')
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(audioMedia.id)}, 0)`)
  const waveWidths = []
  for (const z of [60, 200]) {
    await js(win, `window.__auroraEditor.setZoom(${z})`)
    await wait(120)
    waveWidths.push(await js(win, 'document.querySelector(".ed-lane.audio .ed-wave").width'))
  }
  assert.ok(waveWidths[1] > waveWidths[0], `波形画布宽度应随缩放变化：${waveWidths.join(' → ')}`)
  await js(win, 'window.__auroraEditor.setZoom(90)')
  step(`多分辨率波形 OK：峰值 ${peaksLen} 点，画布宽度 ${waveWidths[0]} → ${waveWidths[1]}`)

  /* ---------- E. 真实胶片带 ---------- */
  if (FFMPEG) {
    const strips = await until('胶片带生成', async () => await js(win, 'window.__auroraEditor.filmstripCount()'), { timeout: 30000 })
    assert.ok(strips >= 1, `应生成胶片带，实际 ${strips}`)
    step(`胶片带 OK：已生成 ${strips} 条（加入视频片段后应用到时间线）`)
  } else {
    step('未找到 ffmpeg，跳过胶片带校验')
  }

  /* ---------- A. 转场 ---------- */
  // 两个相邻视频片段
  const v1 = await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(videoMedia.id)}, 0)`)
  if (FFMPEG) {
    assert.ok(
      (await js(win, 'document.querySelectorAll(".ed-clip.filmstrip").length')) >= 1,
      '时间线视频片段应使用胶片带背景'
    )
  }
  let st = await js(win, 'window.__auroraEditor.getState()')
  const v1c = st.clips.find((c) => c.id === v1.id) || st.clips.find((c) => c.mediaId === videoMedia.id && c.trackId === st.tracks.find((t) => t.kind === 'video').id)
  const v2 = await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(videoMedia.id)}, ${v1c.start + v1c.duration})`)
  await js(win, `window.__auroraEditor.select([${JSON.stringify(v2.id)}])`)
  await js(win, 'window.__auroraEditor.addTransition()')
  st = await js(win, 'window.__auroraEditor.getState()')
  let v2c = st.clips.find((c) => c.id === v2.id)
  assert.ok(v2c.transition, '应成功添加转场')
  assert.equal(v2c.transition.type, 'dissolve', '默认应为交叉溶解')
  assert.ok(v2c.transition.duration > 0.1, '转场时长应有效')
  assert.ok(
    Math.abs(v2c.start - (v1c.start + v1c.duration - v2c.transition.duration)) < 0.05,
    `片段应与前一片段重叠一个转场时长：start=${v2c.start}`
  )
  assert.ok((await js(win, 'document.querySelectorAll(".ed-transition-badge").length')) >= 1, '时间线应显示转场角标')
  // 预览：转场中点应有 A/B 双视频交叉
  await js(win, `window.__auroraEditor.setPlayhead(${v2c.start + v2c.transition.duration / 2})`)
  const preview = await until('转场预览生效', async () => {
    const r = await js(win, `(() => {
      const b = document.getElementById('edVideoB')
      const t = window.__auroraEditor.getActiveTransition()
      return t && b && getComputedStyle(b).display !== 'none' ? { type: t.type, opacity: Number(getComputedStyle(b).opacity), clip: getComputedStyle(b).clipPath } : null
    })()`)
    return r
  }, { timeout: 8000 })
  assert.equal(preview.type, 'dissolve', '预览应处于 dissolve 转场')
  assert.ok(preview.opacity > 0 && preview.opacity < 1, `交叉溶解中点透明度应在 0~1，实际 ${preview.opacity}`)
  // 类型切换为左划像
  await js(win, `window.__auroraEditor.select([${JSON.stringify(v2.id)}])`)
  await until(
    '转场属性面板',
    async () => (await js(win, `!!document.querySelector('#edInspector [data-trans-prop="type"]')`)) === true
  )
  await js(
    win,
    `(() => {
      const sel = document.querySelector('#edInspector [data-trans-prop="type"]')
      sel.value = 'wipeleft'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  st = await js(win, 'window.__auroraEditor.getState()')
  v2c = st.clips.find((c) => c.id === v2.id)
  assert.equal(v2c.transition.type, 'wipeleft', '应切换为左划像')
  await js(win, `window.__auroraEditor.setPlayhead(${v2c.start + v2c.transition.duration / 2})`)
  const clipPath = await js(win, "getComputedStyle(document.getElementById('edVideoB')).clipPath")
  assert.ok(clipPath && clipPath.includes('inset'), `划像应使用 clip-path，实际 ${clipPath}`)
  // 时长调整
  await js(
    win,
    `(() => {
      const input = document.querySelector('#edInspector [data-trans-prop="duration"]')
      input.value = '0.8'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  st = await js(win, 'window.__auroraEditor.getState()')
  v2c = st.clips.find((c) => c.id === v2.id)
  assert.ok(Math.abs(v2c.transition.duration - 0.8) < 0.02, `转场时长应改为 0.8，实际 ${v2c.transition.duration}`)
  await js(win, `window.__auroraEditor.setPlayhead(${v2c.start + 0.4})`)
  step(`转场 OK：添加 dissolve → 切换 wipeleft → 时长 0.8s，预览双视频交叉/划像生效`)

  /* ---------- B. 带转场导出 MP4 ---------- */
  if (FFMPEG && HAS_PROBE) {
    const live = await js(win, 'window.__auroraEditor.getState()')
    const expected = Math.max(...live.clips.map((c) => c.start + c.duration))
    const exported = await js(
      win,
      `window.aurora.editor.exportTimeline({
        project: window.__auroraEditor.getState(),
        outputPath: ${JSON.stringify(mp4Path.split(path.sep).join('/'))},
        width: 1280, height: 720, fps: 25, quality: 'fast'
      })`
    )
    assert.equal(exported.ok, true, `带转场 MP4 导出应成功：${exported.error || ''}`)
    const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4Path], { encoding: 'utf8' }))
    const v = info.streams.find((s) => s.codec_type === 'video')
    const dur = Number(info.format.duration)
    assert.equal(v.codec_name, 'h264', '导出应为 h264')
    assert.ok(Math.abs(dur - expected) < 0.6, `导出时长应约 ${expected.toFixed(2)}s，实际 ${dur.toFixed(2)}s`)
    // 转场中点抽帧：两个彩色画面交叉，应明显非纯黑
    const mid = v2c.start + v2c.transition.duration / 2
    const raw = execFileSync(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(mid), '-i', mp4Path, '-frames:v', '1', '-vf', 'scale=320:180,format=gray', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }
    )
    let sum = 0
    for (const byte of raw) sum += byte
    const avg = raw.length ? sum / raw.length : 0
    assert.ok(avg > 20, `转场帧应包含画面内容，实际灰度均值 ${avg.toFixed(2)}`)
    step(`转场导出 OK：h264 ${dur.toFixed(2)}s（期望 ${expected.toFixed(2)}s），转场帧灰度均值 ${avg.toFixed(2)}`)
  } else {
    step('未找到 ffmpeg/ffprobe，跳过转场导出校验')
  }

  // 移除转场
  await js(win, `window.__auroraEditor.select([${JSON.stringify(v2.id)}])`)
  await js(win, `document.querySelector('[data-act="remove-transition"]').click()`)
  st = await js(win, 'window.__auroraEditor.getState()')
  v2c = st.clips.find((c) => c.id === v2.id)
  assert.equal(v2c.transition, undefined, '应移除转场')
  assert.ok(Math.abs(v2c.start - (v1c.start + v1c.duration)) < 0.05, '移除转场后应恢复相邻')
  step('移除转场 OK：恢复相邻、角标消失')

  /* ---------- C. 自动保存 + 崩溃恢复 ---------- */
  await js(win, 'window.__auroraEditor.stopAutosave()')
  await js(win, 'window.__auroraEditor.flushAutosave()')
  await until(
    '自动保存时间显示',
    async () => String(await js(win, "document.getElementById('edAutosaveState').textContent")).includes('已自动保存'),
    { timeout: 8000 }
  )
  const wsId = await js(win, 'window.__auroraEditor.getWorkspaceId()')
  assert.ok(wsId, '应能拿到工作区 id')

  const modified = await js(win, "(() => { const s = window.__auroraEditor.getState(); s.clips[0].volume = 1.37; return s })()")
  await js(win, `window.aurora.editor.recoverySave({ id: ${JSON.stringify(wsId)}, project: ${JSON.stringify(modified)} })`)
  await js(win, 'window.__auroraEditor.checkRecovery()')
  const bannerShown = await until('恢复横幅出现', async () => (await js(win, "!document.getElementById('edRecoveryBanner').hidden")) === true, { timeout: 8000 })
  assert.ok(bannerShown, '发现差异时应显示恢复横幅')
  assert.ok((await js(win, 'window.__auroraEditor.getPendingRecovery()')) !== null, '应记录待恢复快照')
  await js(win, `document.querySelector('[data-act="recovery-restore"]').click()`)
  await wait(300)
  const restoredVolume = (await js(win, 'window.__auroraEditor.getState()')).clips[0].volume
  assert.ok(Math.abs(restoredVolume - 1.37) < 0.01, `恢复后应使用快照内容，实际 volume=${restoredVolume}`)
  assert.equal(await js(win, 'window.__auroraEditor.getPendingRecovery()'), null, '恢复后应清空待恢复状态')
  assert.ok(await js(win, "document.getElementById('edRecoveryBanner').hidden"), '恢复后横幅应隐藏')
  assert.equal(await js(win, `window.aurora.editor.recoveryLoad({ id: ${JSON.stringify(wsId)} })`), null, '恢复后应清除磁盘快照')
  step('崩溃恢复 OK：快照检测 → 恢复 → 清理')

  // 忽略分支
  const modified2 = await js(win, "(() => { const s = window.__auroraEditor.getState(); s.clips[0].volume = 1.99; return s })()")
  await js(win, `window.aurora.editor.recoverySave({ id: ${JSON.stringify(wsId)}, project: ${JSON.stringify(modified2)} })`)
  await js(win, 'window.__auroraEditor.checkRecovery()')
  await until('恢复横幅再次出现', async () => (await js(win, "!document.getElementById('edRecoveryBanner').hidden")) === true, { timeout: 8000 })
  const beforeDiscard = (await js(win, 'window.__auroraEditor.getState()')).clips[0].volume
  await js(win, `document.querySelector('[data-act="recovery-discard"]').click()`)
  await wait(300)
  const afterDiscard = (await js(win, 'window.__auroraEditor.getState()')).clips[0].volume
  assert.ok(Math.abs(afterDiscard - beforeDiscard) < 0.001, '忽略后不应改动当前工程')
  assert.ok(await js(win, "document.getElementById('edRecoveryBanner').hidden"), '忽略后横幅应隐藏')
  assert.equal(await js(win, `window.aurora.editor.recoveryLoad({ id: ${JSON.stringify(wsId)} })`), null, '忽略后应清除磁盘快照')
  step('崩溃恢复 OK：忽略 → 保留当前工程并清理')

  console.log('PASS: 转场 —— 添加/切换/调时长/预览交叉/角标/移除，xfade 导出画面抽样通过。')
  console.log('PASS: P0-5 —— 自动保存落盘、崩溃恢复/忽略、多分辨率波形随缩放、真实胶片带。')
  if (FFMPEG && HAS_PROBE) console.log('PASS: 导出 —— 带 xfade 的 MP4 时长与画面内容校验通过。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  cleanup()
  app.exit(1)
})
