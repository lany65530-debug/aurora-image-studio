import fs from 'fs'
import path from 'path'
import { downloadBuffer } from '../common/http'
import { ensureDir, sanitizeName } from '../common/utils'
import { enqueueLibrary } from './library'

/** 下载与落盘服务：把生成的原始图片（URL/base64）持久化到磁盘并入库。 */

export interface RawImage {
  type?: 'url' | 'b64'
  value: string
}

export interface PersistMeta {
  saveDir: string
  baseUrl?: string
  prompt?: unknown
  model?: unknown
  size?: unknown
  resolution?: string
  mode?: string
  wsId?: string
}

export type PersistEmit = (phase: string, data?: Record<string, unknown>) => void

/**
 * 持久化一组原始图片到磁盘 + 图片库，返回入库条目。
 */
export function persistImages(rawImages: RawImage[], meta: PersistMeta, emit?: PersistEmit): Promise<Record<string, any>[]> {
  ensureDir(meta.saveDir)
  const savedImages: Record<string, any>[] = []
  const stamp = Date.now()
  return (async () => {
    const collected: Record<string, any>[] = [] // 本批待入库条目，入库前统一走队列
    for (let i = 0; i < rawImages.length; i++) {
      const img = rawImages[i]
      // 部分中转站会把图片以 base64 data: URL 的形式塞进 "url" 字段。
      // 这类值必须直接按 base64 解码，而不是当作远程 URL 去下载（downloadBuffer 只支持 http/https）。
      const isDataUrl = typeof img.value === 'string' && /^data:/i.test(img.value)
      const type = isDataUrl ? 'b64' : (img.type || 'url')
      console.log(`[persistImages] Processing image ${i + 1}/${rawImages.length}:`, { type, url: type === 'url' ? img.value : '<base64>' })
      let buf: Buffer | null = null
      try {
        if (type === 'b64') {
          // tolerate data URI with prefix, or raw base64 without prefix
          const data = String(img.value)
          const b64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data
          buf = Buffer.from(b64, 'base64')
          console.log(`[persistImages] Decoded base64 buffer, size: ${buf.length} bytes`)
        } else {
          console.log(`[persistImages] Attempting download from URL: ${img.value}`)
          const onDL = ({ received, total }: { received: number; total: number }) => {
            if (emit) emit('downloading', { index: i, received, total })
          }
          try {
            buf = await downloadBuffer(img.value, onDL)
            console.log(`[persistImages] First download attempt succeeded, buffer size: ${buf.length} bytes`)
          } catch (firstErr) {
            console.log(`[persistImages] First download attempt failed:`, (firstErr as Error).message)
            // retry once with a Referer header (some CDNs reject headerless requests)
            const referer = meta.baseUrl && meta.baseUrl.trim() ? meta.baseUrl.trim() : ''
            console.log(`[persistImages] Retrying with Referer: ${referer || '(empty)'}`)
            buf = referer
              ? await downloadBuffer(img.value, onDL, { headers: { Referer: referer } })
              : null
            if (buf) {
              console.log(`[persistImages] Retry succeeded, buffer size: ${buf.length} bytes`)
            } else {
              console.log(`[persistImages] Retry skipped (no referer)`)
            }
          }
        }
      } catch (e) {
        console.error(`[persistImages] Error processing image ${i + 1}:`, e)
        buf = null
      }

      console.log(`[persistImages] Final buffer status for image ${i + 1}: ${buf ? `${buf.length} bytes` : 'NULL'}`)

      // 时间戳只能到毫秒，并发批次的 i 可能重合；追加随机后缀保证文件名与 id 全局唯一
      const uniq = Math.random().toString(36).slice(2, 8)
      const fileName = `${new Date(stamp).toISOString().slice(0, 10)}_${sanitizeName(meta.prompt)}_${stamp}_${i + 1}_${uniq}.png`
      const filePath = path.join(meta.saveDir, fileName)
      let savedPath = ''
      // 空 / 损坏 buffer（0 字节）不入库也不落盘，避免生成打不开的空文件
      if (buf && buf.length > 0) {
        try {
          fs.writeFileSync(filePath, buf)
          savedPath = filePath
        } catch (e) {
          savedPath = ''
        }
      }

      const entry = {
        id: `${stamp}-${i}-${uniq}`,
        prompt: meta.prompt,
        model: meta.model,
        size: meta.size,
        resolution: meta.resolution || '',
        mode: meta.mode || 'generate',
        wsId: meta.wsId || '',
        filePath: savedPath,
        fileUrl: savedPath ? 'file:///' + savedPath.replace(/\\/g, '/') : img.value,
        remoteUrl: type === 'url' ? img.value : '',
        ts: stamp
      }
      collected.push(entry)
      savedImages.push(entry)
    }
    // 入库统一走队列：每次重新读取最新库再前置插入，避免并发批次相互覆盖（根因1）
    await enqueueLibrary((lib) => {
      lib.unshift(...collected)
    })
    return savedImages
  })()
}