import { nativeImage, type NativeImage } from 'electron'
import fs from 'fs'

/**
 * 主进程 · 图片缩略图服务
 * ------------------------------------------------------------
 * 图片工作区 / 作品集网格里的卡片只需要 ~几百像素的展示图，
 * 直接让渲染进程解码 2K/4K 原图是卡顿的主要来源。
 * 这里在主进程按需生成缩略图（JPEG dataURL），并做「文件修改时间」维度缓存。
 */

const DEFAULT_SIZE = 360
const MIN_SIZE = 96
const MAX_SIZE = 1024
const JPEG_QUALITY = 78
const CACHE_LIMIT = 400
const MAX_CONCURRENCY = 4

interface CacheEntry {
  stamp: string
  dataUrl: string
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string | null>>()

let active = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  active++
}

function release(): void {
  active--
  const next = waiters.shift()
  if (next) next()
}

function clampSize(size: unknown): number {
  const n = Number(size)
  if (!Number.isFinite(n)) return DEFAULT_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))
}

function fileStamp(filePath: string): string {
  try {
    const st = fs.statSync(filePath)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

function toDataUrl(img: NativeImage): string | null {
  try {
    if (img.isEmpty()) return null
    const buf = img.toJPEG(JPEG_QUALITY)
    if (!buf || !buf.length) return null
    return 'data:image/jpeg;base64,' + buf.toString('base64')
  } catch {
    return null
  }
}

/** 用系统缩略图 API 生成（Windows/macOS 上又快又省内存）。 */
async function createViaSystem(filePath: string, size: number): Promise<string | null> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null
  try {
    const img = await nativeImage.createThumbnailFromPath(filePath, { width: size, height: size })
    return toDataUrl(img)
  } catch {
    return null
  }
}

/** 兜底：按比例缩放原图（其他平台 / 系统缩略图失败时）。 */
function createViaResize(filePath: string, size: number): string | null {
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const base = Math.max(1, Math.max(width, height))
    if (base <= size) return toDataUrl(img)
    const scale = size / base
    const resized = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good'
    })
    return toDataUrl(resized)
  } catch {
    return null
  }
}

/** 取缩略图 dataURL；失败返回 null（渲染层会退回原图）。 */
export async function getThumbnail(filePath: string, size?: number): Promise<string | null> {
  const target = clampSize(size)
  if (typeof filePath !== 'string' || !filePath) return null
  if (!fs.existsSync(filePath)) return null

  const stamp = fileStamp(filePath)
  const key = `${target}::${filePath}`

  const cached = cache.get(key)
  if (cached && cached.stamp === stamp) {
    // LRU：命中后移动到队尾
    cache.delete(key)
    cache.set(key, cached)
    return cached.dataUrl
  }

  const running = inflight.get(key)
  if (running) return running

  const task = (async (): Promise<string | null> => {
    await acquire()
    try {
      const dataUrl = (await createViaSystem(filePath, target)) || createViaResize(filePath, target)
      if (dataUrl) {
        cache.set(key, { stamp, dataUrl })
        while (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
      }
      return dataUrl
    } finally {
      release()
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

/** 供自检 / 统计使用。 */
export function thumbnailCacheSize(): number {
  return cache.size
}
