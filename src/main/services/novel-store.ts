import fs from 'fs'
import path from 'path'
import { novelsDir } from '../config'
import type { NovelFileData, NovelSummary } from '../../shared/novel'

/**
 * 小说数据服务：磁盘 data/ JSON 落盘（每书一文件）。
 * 写入采用 tmp + rename 原子写，整库「读-改-写」串行化，避免并发覆盖。
 */

/** 文件名安全化（沿用 chat.ts 附件的做法）。 */
function sanitize(id: string): string {
  return String(id).replace(/[\\/:*?"<>|]/g, '_')
}

function fileFor(id: string): string {
  return path.join(novelsDir(), `${sanitize(id)}.json`)
}

export function saveNovelFile(data: NovelFileData): boolean {
  try {
    const dir = novelsDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const p = fileFor(data.id)
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
    return true
  } catch (e) {
    console.error('save novel file failed', e)
    return false
  }
}

export function loadNovelFile(id: string): NovelFileData | null {
  try {
    const p = fileFor(id)
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as NovelFileData
  } catch (e) {
    console.error('load novel file failed', e)
    return null
  }
}

export function deleteNovelFile(id: string): boolean {
  try {
    const p = fileFor(id)
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return true
  } catch (e) {
    console.error('delete novel file failed', e)
    return false
  }
}

/** 列出书库摘要（只读头字段，不读章节 body），按更新时间倒序。 */
export function listNovelSummaries(): NovelSummary[] {
  try {
    const dir = novelsDir()
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    const items: NovelSummary[] = []
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as NovelFileData
        if (!data || !data.id) continue
        items.push({
          id: data.id,
          title: data.title || '',
          author: data.author || '',
          summary: data.summary || '',
          cover: data.cover || '#334155',
          chapterCount: Array.isArray(data.chapters) ? data.chapters.length : 0,
          currentChapter: data.currentChapter || 0,
          updatedAt: data.updatedAt || 0
        })
      } catch (e) {
        /* 单文件损坏跳过 */
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items
  } catch (e) {
    console.error('list novel summaries failed', e)
    return []
  }
}

// 串行化所有「读 / 写」操作，避免并发相互覆盖
let novelQueue: Promise<unknown> = Promise.resolve()

export function enqueueNovel(task: () => Promise<void>): Promise<void> {
  const run = novelQueue.then(async () => { await task() })
  novelQueue = run.catch(() => {})
  return run
}