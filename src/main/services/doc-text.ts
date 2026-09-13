import { inflateRawSync } from 'node:zlib'
import { TextDecoder } from 'node:util'

/**
 * 文档文本提取服务（主进程）
 * ---------------------------------------------------------------------------
 * 供「AI 率检测」窗口导入待检测文本：支持
 * - 纯文本：.txt / .md / .markdown / .json / .csv / .log / .srt（UTF-8，自动回退 GBK）
 * - 网页文本：.html / .htm（剥离标签）
 * - Word：.docx（直接解 ZIP 读 word/document.xml，不依赖外部库）
 * 纯函数实现（输入 Buffer），便于单元测试；文件读取由控制器负责。
 */

export type ExtractFormat = 'text' | 'html' | 'docx'

export interface ExtractResult {
  text: string
  format: ExtractFormat
  warning?: string
}

export const TEXT_EXTENSIONS = [
  'txt',
  'text',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'srt',
  'html',
  'htm',
  'docx'
]

const ZIP_SIGNATURE = 0x04034b50

function extensionOf(name: string): string {
  const base = String(name || '').trim().toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1) : ''
}

function toBuffer(data: Uint8Array | ArrayBuffer | Buffer): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  return Buffer.from(data as Uint8Array)
}

/* ═══════════════════════════════════════════
   编码解码
═══════════════════════════════════════════ */

/** UTF-8 解码；出现大量替换字符时回退 GBK（中文小说常见编码）。 */
export function decodeTextBuffer(buf: Buffer): string {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const bad = (text.match(/\uFFFD/g) || []).length
  if (bad > 0 && bad / Math.max(1, text.length) > 0.002) {
    try {
      const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf)
      if (gbk && (gbk.match(/\uFFFD/g) || []).length < bad) text = gbk
    } catch {
      /* 运行环境无 GBK 解码表时保持 UTF-8 结果 */
    }
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/* ═══════════════════════════════════════════
   HTML
═══════════════════════════════════════════ */

export function htmlToText(html: string): string {
  return decodeXmlEntities(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ═══════════════════════════════════════════
   DOCX（ZIP + word/document.xml）
═══════════════════════════════════════════ */

interface ZipEntry {
  name: string
  method: number
  compSize: number
  localOffset: number
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP / DOCX 文件（未找到目录结束标记）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, compSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.localOffset + 30 > buf.length || buf.readUInt32LE(entry.localOffset) !== ZIP_SIGNATURE) {
    throw new Error(`DOCX 内部结构异常：${entry.name}`)
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26)
  const extraLen = buf.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`DOCX 使用了不支持的压缩方式（${entry.method}）`)
}

/** word/document.xml → 纯文本（保留段落换行与制表符）。 */
export function docxXmlToText(xml: string): string {
  return decodeXmlEntities(
    String(xml || '')
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\u000b/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractDocxText(buf: Buffer): string {
  const entries = readZipEntries(buf)
  const target =
    entries.find((e) => e.name === 'word/document.xml') ||
    entries.find((e) => /^word\/document\d*\.xml$/.test(e.name))
  if (!target) throw new Error('未在 DOCX 中找到正文（word/document.xml）')
  return docxXmlToText(readZipEntry(buf, target).toString('utf8'))
}

/* ═══════════════════════════════════════════
   统一入口
═══════════════════════════════════════════ */

/** 按文件名与内容特征提取纯文本。 */
export function extractDocumentText(name: string, data: Uint8Array | ArrayBuffer | Buffer): ExtractResult {
  const buf = toBuffer(data)
  const ext = extensionOf(name)

  if (ext === 'doc') {
    return {
      text: '',
      format: 'text',
      warning: '旧版 .doc 为二进制格式，暂不支持；请在 Word 中另存为 .docx 或 .txt 后重新导入。'
    }
  }

  const looksZip = buf.length > 4 && buf.readUInt32LE(0) === ZIP_SIGNATURE
  const otherZipFormat = ['zip', 'rar', '7z', 'xlsx', 'xls', 'pptx', 'epub', 'jar', 'apk'].includes(ext)
  if (ext === 'docx' || (looksZip && !otherZipFormat)) {
    try {
      return { text: extractDocxText(buf), format: 'docx' }
    } catch (err) {
      return { text: '', format: 'docx', warning: (err as Error).message || 'DOCX 解析失败' }
    }
  }
  if (looksZip && otherZipFormat) {
    return { text: '', format: 'docx', warning: `暂不支持导入 .${ext} 文件，请先导出为 .docx 或 .txt。` }
  }

  const decoded = decodeTextBuffer(buf)
  if (ext === 'html' || ext === 'htm' || /^\s*<(?:!doctype|html)\b/i.test(decoded)) {
    return { text: htmlToText(decoded), format: 'html' }
  }
  return { text: decoded, format: 'text' }
}
