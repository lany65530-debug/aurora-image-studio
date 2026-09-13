/**
 * 剪辑工作区 · 端到端自检（真实 Electron 窗口）
 * ---------------------------------------------------------------------------
 * 前置：npm run build，然后运行：npx electron verify-editor.cjs
 *
 * 覆盖：
 *  A. 工作区接入：侧边栏「剪辑」工作区、视图、媒体库 / 时间线 / 属性面板渲染。
 *  B. 媒体导入：WAV 音频 + 画布录制生成的 WebM 视频，读取时长、视频分辨率、音频波形。
 *  C. 时间线编辑：添加到轨道、分割、撤销 / 重做、删除、轨道增删、片段属性修改。
 *  D. 播放：播放头随播放前进。
 *  E. 导出：音频离线渲染为 WAV、视频实时录制为 WebM，校验文件头与体积。
 * 副作用：临时 userData 目录与临时媒体文件，不触碰真实数据。
 */
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-editor-e2e-'))
const TMP_MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-editor-media-'))
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

/** 生成 2 秒双声道正弦 WAV。 */
function makeWav(seconds = 2, rate = 44100) {
  const frames = Math.floor(seconds * rate)
  const channels = 2
  const dataLength = frames * channels * 2
  const buf = Buffer.alloc(44 + dataLength)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLength, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * channels * 2, 28)
  buf.writeUInt16LE(channels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLength, 40)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000)
    buf.writeInt16LE(v, 44 + i * 4)
    buf.writeInt16LE(v, 44 + i * 4 + 2)
  }
  return buf
}

const wavPath = path.join(TMP_MEDIA, 'tone.wav')
fs.writeFileSync(wavPath, makeWav(2))
const videoPath = path.join(TMP_MEDIA, 'clip.webm')
const exportWavPath = path.join(TMP_MEDIA, 'export-audio.wav')
const exportVideoPath = path.join(TMP_MEDIA, 'export-video.webm')

require('./out/main/index.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name) => console.log(`step: ${name}`)

async function until(label, fn, { timeout = 25000, tick = 120 } = {}) {
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
  step('主窗口就绪')

  /* ---------- A. 工作区接入 ---------- */
  const editorWs = await js(
    win,
    `(() => {
      const item = [...document.querySelectorAll('#wsList .ws-item')].find((el) => el.textContent.includes('剪辑'))
      if (!item) return null
      return { tip: item.dataset.tip, type: item.dataset.wsType, shape: item.querySelector('.ws-avatar').className }
    })()`
  )
  assert.ok(editorWs, '默认应存在剪辑工作区')
  assert.equal(editorWs.type, 'edit', '剪辑工作区 type 应为 edit')
  assert.ok(editorWs.shape.includes('edit'), `剪辑头像应有独立形状：${editorWs.shape}`)
  assert.ok(String(editorWs.tip).includes('剪辑'), `tooltip 应包含类型：${editorWs.tip}`)
  await js(win, `[...document.querySelectorAll('#wsList .ws-item')].find((el) => el.textContent.includes('剪辑')).click()`)
  await until('剪辑视图激活', async () => (await js(win, "document.querySelector('.view-edit.active') !== null")) === true)
  await until('编辑器壳层渲染', async () => (await js(win, "!!document.querySelector('#editorRoot .editor-shell')")) === true)
  const skeleton = await js(
    win,
    `(() => ({
      tracks: document.querySelectorAll('.ed-tl-row').length,
      mediaEmpty: !!document.querySelector('#edMediaList .ed-empty'),
      hasImport: !!document.querySelector('[data-act="import"]'),
      hasExportVideo: !!document.querySelector('[data-act="export-video"]'),
      hasInspector: !!document.querySelector('#edInspector')
    }))()`
  )
  assert.equal(skeleton.tracks, 2, `默认应有视频 / 音频两条轨道，实际 ${skeleton.tracks}`)
  assert.ok(skeleton.mediaEmpty, '新工作区媒体库应为空状态')
  assert.ok(skeleton.hasImport && skeleton.hasExportVideo && skeleton.hasInspector, '编辑器核心区域应齐全')
  step('工作区接入 OK：剪辑视图 + 双轨时间线 + 媒体库 / 属性面板')

  /* ---------- B. 媒体导入 ---------- */
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
          ctx.fillStyle = 'hsl(' + ((el / 5) % 360) + ',70%,50%)'
          ctx.fillRect(0, 0, 320, 240)
          if (el > 1200) { resolve(); return }
          requestAnimationFrame(draw)
        }
        requestAnimationFrame(draw)
      })
      rec.stop()
      await stopped
      if (ac) { try { await ac.close() } catch {} }
      const blob = new Blob(chunks, { type: mime })
      const data = new Uint8Array(await blob.arrayBuffer())
      const res = await window.aurora.editor.writeFile({ path: ${JSON.stringify(videoPath)}, data })
      return { ok: res.ok, size: data.length, mime }
    })()`
  )
  assert.ok(recorded.ok && recorded.size > 1000, `应能录出测试视频：${JSON.stringify(recorded)}`)
  step(`测试视频生成 OK：${(recorded.size / 1024).toFixed(0)}KB ${recorded.mime}`)

  await js(win, `window.__auroraEditor.addPaths(${JSON.stringify([wavPath, videoPath])})`)
  const mediaState = await until(
    '媒体元数据就绪',
    async () => {
      const s = await js(win, 'window.__auroraEditor.getState()')
      const ok = s.media.length === 2 && s.media.every((m) => m.duration > 0.5)
      return ok ? s : 0
    },
    { timeout: 15000 }
  )
  const audioMedia = mediaState.media.find((m) => m.kind === 'audio')
  const videoMedia = mediaState.media.find((m) => m.kind === 'video')
  assert.ok(audioMedia && videoMedia, `应导入一个音频 + 一个视频：${JSON.stringify(mediaState.media.map((m) => m.kind))}`)
  assert.ok(videoMedia.width >= 300 && videoMedia.height >= 200, `应读取到视频分辨率：${videoMedia.width}×${videoMedia.height}`)
  await until('音频波形生成', async () => {
    const s = await js(win, 'window.__auroraEditor.getState()')
    const a = s.media.find((m) => m.kind === 'audio')
    return a && Array.isArray(a.peaks) && a.peaks.length > 100
  }, { timeout: 10000 })
  assert.ok(
    (await js(win, 'document.querySelectorAll("#edMediaList .ed-media-item").length')) === 2,
    '媒体库应渲染两条媒体'
  )
  step(`媒体导入 OK：WAV ${audioMedia.duration.toFixed(2)}s + WebM ${videoMedia.duration.toFixed(2)}s，波形已生成`)

  /* ---------- C. 时间线编辑 ---------- */
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(audioMedia.id)}, 0)`)
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(videoMedia.id)}, 0)`)
  let state = await js(win, 'window.__auroraEditor.getState()')
  const avClips = state.clips.filter((c) => c.mediaId === videoMedia.id)
  const baseline = 1 + avClips.length
  assert.ok(avClips.length >= 1, '视频应生成至少 1 个片段（可能带 A/V 链接音频片段）')
  if (avClips.length === 2) {
    assert.ok(avClips[0].linkId && avClips[0].linkId === avClips[1].linkId, '视频 + 音频应自动成组链接')
  }
  assert.equal(state.clips.length, baseline, `应添加 ${baseline} 个片段，实际 ${state.clips.length}`)
  assert.equal(
    await js(win, 'document.querySelectorAll("#edTlRows .ed-clip").length'),
    baseline,
    `时间线应渲染 ${baseline} 个片段`
  )
  assert.ok(
    (await js(win, 'document.querySelectorAll("#edTlRows .ed-lane.audio .ed-clip canvas").length')) >= 1,
    '音频片段应绘制波形'
  )
  step(`添加到时间线 OK：${avClips.length === 2 ? '视频 + 自动链接音频' : '视频'}，音频带波形`)

  // 分割：播放头 1.0s 位于音频（2s）内
  await js(win, 'window.__auroraEditor.setPlayhead(1.0)')
  await js(win, 'window.__auroraEditor.split()')
  state = await js(win, 'window.__auroraEditor.getState()')
  const afterSplit = state.clips.length
  assert.ok(afterSplit > baseline, `分割后片段应增加，实际 ${afterSplit}`)
  await js(win, 'window.__auroraEditor.undo()')
  assert.equal((await js(win, 'window.__auroraEditor.getState()')).clips.length, baseline, '撤销应恢复分割前')
  await js(win, 'window.__auroraEditor.redo()')
  assert.equal((await js(win, 'window.__auroraEditor.getState()')).clips.length, afterSplit, '重做应恢复分割')

  // 轨道增删
  await js(win, `document.querySelector('[data-act="add-audio-track"]').click()`)
  assert.equal((await js(win, 'window.__auroraEditor.getState()')).tracks.length, 3, '应新增一条音频轨')
  await js(win, `document.querySelector('.ed-tl-row:last-child [data-act="track-remove"]').click()`)
  assert.equal((await js(win, 'window.__auroraEditor.getState()')).tracks.length, 2, '应删除新增轨道')
  step('分割 / 撤销 / 重做 / 轨道增删 OK')

  // 通过属性面板修改片段时长（真实 UI 路径）
  const selectedBefore = await js(win, 'window.__auroraEditor.getState().clips[0].id')
  await js(
    win,
    `(() => {
      const el = document.querySelector('.ed-clip[data-clip-id="${selectedBefore}"]')
      const r = el.getBoundingClientRect()
      const opts = { bubbles: true, clientX: r.left + 6, clientY: r.top + 6, pointerId: 1, isPrimary: true, button: 0 }
      el.dispatchEvent(new PointerEvent('pointerdown', opts))
      window.dispatchEvent(new PointerEvent('pointerup', opts))
      return true
    })()`
  )
  await until(
    '属性面板显示',
    async () => (await js(win, `!!document.querySelector('#edInspector [data-clip-prop="duration"]')`)) === true
  )
  await js(
    win,
    `(() => {
      const input = document.querySelector('#edInspector [data-clip-prop="duration"]')
      input.value = '1.20'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  const clipped = (await js(win, 'window.__auroraEditor.getState()')).clips.find((c) => c.id === selectedBefore)
  assert.ok(Math.abs(clipped.duration - 1.2) < 0.01, `属性面板应能修改片段时长，实际 ${clipped.duration}`)
  step('属性面板修改片段时长 OK')

  /* ---------- D. 播放 ---------- */
  await js(win, 'window.__auroraEditor.setPlayhead(0)')
  await js(win, 'window.__auroraEditor.play()')
  await wait(700)
  await js(win, 'window.__auroraEditor.pause()')
  const playhead = (await js(win, 'window.__auroraEditor.getState()')).playhead
  assert.ok(playhead > 0.3, `播放头应随播放前进，实际 ${playhead}`)
  step(`播放 OK：0.7s 内播放头前进到 ${playhead.toFixed(2)}s`)

  /* ---------- E. 导出 ---------- */
  const wavOut = await js(
    win,
    `(async () => {
      const data = await window.__auroraEditor.renderAudioWav()
      if (!data) return { ok: false }
      const res = await window.aurora.editor.writeFile({ path: ${JSON.stringify(exportWavPath)}, data })
      return { ok: res.ok, size: data.length }
    })()`
  )
  assert.ok(wavOut.ok, '音频离线渲染应成功')
  const wavFile = fs.readFileSync(exportWavPath)
  assert.equal(wavFile.subarray(0, 4).toString('ascii'), 'RIFF', '导出的音频应为合法 WAV')
  assert.equal(wavFile.subarray(8, 12).toString('ascii'), 'WAVE', 'WAV 应包含 WAVE 标记')
  assert.ok(wavFile.length > 44 + 44100, `WAV 数据量应合理，实际 ${wavFile.length}`)
  step(`音频导出 OK：${(wavFile.length / 1024).toFixed(0)}KB WAV`)

  const videoOut = await js(
    win,
    `(async () => {
      const data = await window.__auroraEditor.renderVideoWebm()
      if (!data) return { ok: false }
      const res = await window.aurora.editor.writeFile({ path: ${JSON.stringify(exportVideoPath)}, data })
      return { ok: res.ok, size: data.length }
    })()`
  )
  assert.ok(videoOut.ok, '视频录制导出应成功')
  const webmFile = fs.readFileSync(exportVideoPath)
  assert.equal(webmFile[0], 0x1a, 'WebM 应以 EBML 头开始')
  assert.equal(webmFile[1], 0x45, 'WebM 应以 EBML 头开始')
  assert.ok(webmFile.length > 2000, `WebM 体积应合理，实际 ${webmFile.length}`)
  step(`视频导出 OK：${(webmFile.length / 1024).toFixed(0)}KB WebM`)

  /* ---------- F. 多选 / 链接 / 复制粘贴 / 涟漪删除 ---------- */
  // 多选
  await js(win, 'window.__auroraEditor.selectAll()')
  state = await js(win, 'window.__auroraEditor.getState()')
  const allCount = state.clips.length
  assert.equal((await js(win, 'window.__auroraEditor.getSelection()')).length, allCount, '全选应覆盖全部片段')
  assert.equal(
    await js(win, 'document.querySelectorAll("#edTlRows .ed-clip.selected").length'),
    allCount,
    '全选后所有片段应有选中样式'
  )
  await js(win, 'window.__auroraEditor.clearSelection()')
  assert.equal((await js(win, 'window.__auroraEditor.getSelection()')).length, 0, '清空选择')
  step('多选 OK：全选 / 清空选择与选中样式')

  // A/V 链接：选中视频片段应自动带上链接的音频片段
  if (avClips.length === 2) {
    const videoClipId = avClips.find((c) => c.trackId && state.tracks.find((t) => t.id === c.trackId)?.kind === 'video')?.id
    await js(win, `window.__auroraEditor.select([${JSON.stringify(videoClipId)}])`)
    let sel = await js(win, 'window.__auroraEditor.getSelection()')
    assert.equal(sel.length, 2, '点击 A/V 片段应联动选中音频轨片段')
    await js(win, 'window.__auroraEditor.unlink()')
    state = await js(win, 'window.__auroraEditor.getState()')
    assert.equal(state.clips.filter((c) => c.id === videoClipId)[0].linkId, undefined, '取消链接后应无 linkId')
    await js(win, 'window.__auroraEditor.selectAll()')
    await js(win, 'window.__auroraEditor.clearSelection()')
    await js(win, `window.__auroraEditor.select([${JSON.stringify(videoClipId)}])`)
    const linkedAudioId = state.clips.find((c) => c.mediaId === videoMedia.id && c.id !== videoClipId)?.id
    await js(win, `window.__auroraEditor.select([${JSON.stringify(linkedAudioId)}], true)`)
    await js(win, 'window.__auroraEditor.link()')
    state = await js(win, 'window.__auroraEditor.getState()')
    const relinked = state.clips.filter((c) => c.id === videoClipId || c.id === linkedAudioId).map((c) => c.linkId)
    assert.ok(relinked[0] && relinked[0] === relinked[1], '手动链接后两个片段应共享 linkId')
    step('A/V 链接 OK：自动联动选择、取消链接、手动重新链接')
  } else {
    step('A/V 链接：测试视频无音频轨，跳过链接断言')
  }

  // 复制 / 粘贴
  await js(win, 'window.__auroraEditor.selectAll()')
  const beforeCopy = (await js(win, 'window.__auroraEditor.getState()')).clips.length
  await js(win, 'window.__auroraEditor.copy()')
  await js(win, 'window.__auroraEditor.setPlayhead(0)')
  await js(win, 'window.__auroraEditor.paste()')
  const afterPaste = (await js(win, 'window.__auroraEditor.getState()')).clips.length
  assert.equal(afterPaste, beforeCopy * 2, `粘贴后应翻倍，实际 ${beforeCopy} → ${afterPaste}`)
  step(`复制 / 粘贴 OK：${beforeCopy} → ${afterPaste} 个片段`)

  // 涟漪删除：两个同轨片段，删除第一个后第二个应左移
  await js(win, 'window.__auroraEditor.selectAll()')
  await js(win, 'window.__auroraEditor.rippleDelete()')
  assert.equal((await js(win, 'window.__auroraEditor.getState()')).clips.length, 0, '涟漪删除应清空时间线')
  await js(win, `window.__auroraEditor.setPlayhead(0)`)
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(audioMedia.id)})`)
  await js(win, `window.__auroraEditor.setPlayhead(2)`)
  await js(win, `window.__auroraEditor.addToTimeline(${JSON.stringify(audioMedia.id)})`)
  state = await js(win, 'window.__auroraEditor.getState()')
  assert.equal(state.clips.length, 2, '应有两个同轨音频片段')
  const first = state.clips[0]
  const second = state.clips[1]
  const secondStartBefore = second.start
  await js(win, `window.__auroraEditor.select([${JSON.stringify(first.id)}])`)
  await js(win, 'window.__auroraEditor.rippleDelete()')
  const afterRipple = await js(win, 'window.__auroraEditor.getState()')
  assert.equal(afterRipple.clips.length, 1, '涟漪删除应只删掉选中片段')
  assert.ok(
    afterRipple.clips[0].start < Math.max(0.01, secondStartBefore - first.duration + 0.05),
    `后续片段应左移：${secondStartBefore} → ${afterRipple.clips[0].start}`
  )
  step(`涟漪删除 OK：后续片段 ${secondStartBefore.toFixed(2)}s → ${afterRipple.clips[0].start.toFixed(2)}s`)

  /* ---------- G. 通过「+」新建剪辑工作区 ---------- */
  await js(win, `document.getElementById('wsAddBtn').click()`)
  await js(win, `document.querySelector('.ws-add-item[data-type="edit"]').click()`)
  await until('新建弹窗出现', async () => (await js(win, "!document.getElementById('newWsModal').hidden")) === true)
  await js(
    win,
    `(() => {
      const input = document.getElementById('newWsName')
      input.value = '自检剪辑工作区'
      document.getElementById('newWsCreateBtn').click()
      return true
    })()`
  )
  const created = await until(
    '新建剪辑工作区激活',
    async () => {
      const s = await js(
        win,
        `(() => {
          const items = [...document.querySelectorAll('#wsList .ws-item')].filter((el) => el.textContent.includes('剪辑'))
          const active = document.querySelector('#wsList .ws-item.active')
          return { count: items.length, activeName: active ? active.querySelector('.ws-name').textContent : '' }
        })()`
      )
      return s.count >= 2 && s.activeName.includes('自检') ? s : 0
    },
    { timeout: 8000 }
  )
  assert.ok(created.count >= 2, `应有 2 个剪辑工作区，实际 ${created.count}`)
  step('新建剪辑工作区 OK：类型出现在「+」菜单且创建后自动激活')

  console.log('PASS: 剪辑工作区 —— 媒体导入（视频/音频/波形）、多轨时间线、分割/撤销/重做/属性编辑。')
  console.log('PASS: 播放与导出 —— 播放头推进、音频离线渲染 WAV、视频实时录制 WebM。')
  console.log('PASS: 工作区接入 —— 侧边栏独立类型与形状、新建菜单、默认种子工作区。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  cleanup()
  app.exit(1)
})
