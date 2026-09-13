/**
 * 图片性能 · 网格缩略图 / 分批挂载 / GPU 加速 自检（真实 Electron 窗口）
 * ---------------------------------------------------------------------------
 * 前置：npm run build，然后运行：npx electron verify-image-performance.cjs
 *
 * 覆盖：
 *  A. 缩略图链路：library:thumb 返回小尺寸 JPEG dataURL，而不是让渲染进程解码 2K 原图。
 *  B. 长列表：60 张图片入库后打开作品集，卡片能全部渲染且首屏不长时间阻塞。
 *  C. 渲染策略：卡片启用 content-visibility:auto；可见卡片最终换成缩略图。
 *  D. GPU：启动时已注入 enable-gpu-rasterization / enable-zero-copy / ignore-gpu-blocklist。
 * 副作用：临时 userData 目录与临时图片，不触碰真实数据。
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-image-perf-'))
const TMP_IMAGES = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-image-src-'))
app.setPath('userData', TMP_USER_DATA)
app.disableHardwareAcceleration()

function cleanup() {
  for (const dir of [TMP_USER_DATA, TMP_IMAGES]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 交给系统回收 */ }
  }
}

/* ---------- 造一张有噪声的大图（贴近真实照片体积）+ 60 条 library 记录 ---------- */
const N = 60
const W = 1600
const H = 1200
const { randomFillSync } = require('node:crypto')
const bitmap = Buffer.alloc(W * H * 4)
randomFillSync(bitmap)
for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255 // 不透明，保证缩略图是照片质感
const bigPng = nativeImage.createFromBitmap(bitmap, { width: W, height: H }).toPNG()
const samplePath = path.join(TMP_IMAGES, 'perf-big.png')
fs.writeFileSync(samplePath, bigPng)
const sampleBytes = fs.statSync(samplePath).size

const library = []
for (let i = 0; i < N; i++) {
  library.push({
    id: `perf-${i}`,
    prompt: `performance test ${i}`,
    model: 'perf-model',
    size: '4:3',
    resolution: '4k',
    filePath: samplePath,
    fileUrl: 'file:///' + samplePath.replace(/\\/g, '/'),
    remoteUrl: '',
    ts: Date.now() - i * 1000
  })
}
fs.writeFileSync(path.join(TMP_USER_DATA, 'library.json'), JSON.stringify(library, null, 2), 'utf-8')

require('./out/main/index.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name) => console.log(`step: ${name}`)

async function until(label, fn, { timeout = 20000, tick = 120 } = {}) {
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
  console.error('FAIL: 自检超时（90s）')
  app.exit(1)
}, 90000)

;(async () => {
  await app.whenReady()
  const win = await until('主窗口就绪', () => BrowserWindow.getAllWindows()[0])
  await until('主窗口页面加载', async () => (await js(win, 'document.readyState')) === 'complete')
  await until('侧边栏渲染', async () => (await js(win, "document.querySelectorAll('#wsList .ws-item').length")) >= 1)
  step('主窗口就绪')

  /* ---------- A. 缩略图 IPC ---------- */
  const thumb = await js(
    win,
    `window.aurora.library.thumb({ path: ${JSON.stringify(samplePath)}, size: 420 })`
  )
  assert.equal(thumb.ok, true, `缩略图应生成成功：${thumb.error || ''}`)
  assert.ok(String(thumb.dataUrl).startsWith('data:image/jpeg;base64,'), '缩略图应为 JPEG dataURL')
  const thumbImg = nativeImage.createFromDataURL(thumb.dataUrl)
  const thumbSize = thumbImg.getSize()
  assert.ok(Math.max(thumbSize.width, thumbSize.height) <= 420, `缩略图最长边应 <=420，实际 ${JSON.stringify(thumbSize)}`)
  assert.ok(
    thumb.dataUrl.length < sampleBytes,
    `缩略图应明显小于原图（dataURL ${thumb.dataUrl.length} vs 原图 ${sampleBytes}）`
  )
  step(`缩略图 OK：${thumbSize.width}×${thumbSize.height}，dataURL ${(thumb.dataUrl.length / 1024).toFixed(1)}KB / 原图 ${(sampleBytes / 1024).toFixed(1)}KB`)

  /* ---------- B/C. 打开作品集：分批挂载 + 缩略图 + content-visibility ---------- */
  const startedAt = Date.now()
  await js(win, "document.getElementById('galleryNav').click()")
  await until('首屏卡片出现', async () => (await js(win, "document.querySelectorAll('#galleryGrid .img-card').length")) > 0, { tick: 30 })
  const firstCount = await js(win, "document.querySelectorAll('#galleryGrid .img-card').length")
  const totalCount = await until(
    '全部卡片渲染完成',
    async () => {
      const n = await js(win, "document.querySelectorAll('#galleryGrid .img-card').length")
      return n >= N ? n : 0
    },
    { timeout: 15000 }
  )
  const elapsed = Date.now() - startedAt
  assert.equal(totalCount, N, `应渲染全部 ${N} 张卡片，实际 ${totalCount}`)
  assert.ok(elapsed < 8000, `长列表渲染耗时过长：${elapsed}ms`)
  console.log(`step: 分批挂载 OK：首批 ${firstCount} 张 → 全部 ${totalCount} 张，用时 ${elapsed}ms`)

  const strategy = await js(
    win,
    `(() => {
      const card = document.querySelector('#galleryGrid .img-card')
      const img = card.querySelector('img')
      return {
        contentVisibility: getComputedStyle(card).contentVisibility,
        containIntrinsic: getComputedStyle(card).containIntrinsicSize,
        imgSrc: (img && img.src || '').slice(0, 30),
        imgDecoding: img && img.decoding,
        imgLoading: img && img.loading
      }
    })()`
  )
  assert.equal(strategy.contentVisibility, 'auto', `卡片应启用 content-visibility:auto，实际 ${strategy.contentVisibility}`)
  assert.ok(strategy.containIntrinsic && strategy.containIntrinsic !== 'none', '应设置 contain-intrinsic-size，避免滚动条跳动')
  assert.equal(strategy.imgDecoding, 'async', '图片应异步解码')
  assert.equal(strategy.imgLoading, 'lazy', '图片应懒加载')
  assert.ok(
    strategy.imgSrc.includes('data:image/jpeg'),
    `可见卡片最终应加载缩略图，实际 ${strategy.imgSrc}`
  )
  step('渲染策略 OK：content-visibility:auto + decoding:async + 可见卡片使用 JPEG 缩略图')

  /* ---------- D. GPU 加速开关 ---------- */
  const gpu = await js(win, 'window.aurora.app.gpuStatus()')
  assert.ok(Array.isArray(gpu.forcedFlags), 'GPU 状态应返回 forcedFlags')
  for (const flag of ['enable-gpu-rasterization', 'enable-zero-copy', 'ignore-gpu-blocklist']) {
    assert.ok(gpu.forcedFlags.includes(flag), `启动时应注入 GPU 开关 ${flag}`)
  }
  assert.ok(gpu.featureStatus && typeof gpu.featureStatus === 'object', '应返回 Chromium GPU 特性状态')
  step(`GPU OK：已注入 ${gpu.forcedFlags.join(', ')}；gpu_compositing=${gpu.featureStatus.gpu_compositing || 'n/a'}`)

  /* ---------- 交互仍然正常：点击第一张能打开灯箱 ---------- */
  await js(win, "document.querySelector('#galleryGrid .img-card img').click()")
  await until('灯箱打开', async () => (await js(win, "document.querySelectorAll('.lightbox.open, .lightbox.show, #lightbox.open').length")) > 0, { timeout: 5000 })
  step('交互 OK：点击缩略图可正常打开灯箱（原图预览）')

  console.log('PASS: 图片性能 —— 缩略图替代原图解码、长列表分批挂载、content-visibility 跳绘。')
  console.log('PASS: GPU —— 启动时已强制开启 GPU 光栅化 / 零拷贝 / 忽略黑名单。')

  clearTimeout(guard)
  cleanup()
  app.exit(0)
})().catch((err) => {
  clearTimeout(guard)
  console.error('FAIL:', err && err.stack ? err.stack : err)
  cleanup()
  app.exit(1)
})
