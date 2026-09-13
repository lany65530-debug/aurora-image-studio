import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/** 剪辑工作区 · 自动保存 / 崩溃恢复快照（落盘到 userData，不被 localStorage 配额影响）。 */

export interface RecoveryData {
  savedAt: number
  project: unknown
}

function dir(): string {
  return path.join(app.getPath('userData'), 'edits', 'recovery')
}
function fileOf(id: string): string {
  return path.join(dir(), id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
}

export function saveRecovery(id: string, project: unknown): { ok: boolean; savedAt?: number; error?: string } {
  if (!id) return { ok: false, error: 'missing id' }
  try {
    fs.mkdirSync(dir(), { recursive: true })
    const savedAt = Date.now()
    const file = fileOf(id)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ savedAt, project }), 'utf-8')
    fs.renameSync(tmp, file)
    return { ok: true, savedAt }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function loadRecovery(id: string): RecoveryData | null {
  try {
    const file = fileOf(id)
    if (!fs.existsSync(file)) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as RecoveryData
    return data && data.project ? data : null
  } catch {
    return null
  }
}

export function clearRecovery(id: string): boolean {
  try {
    const file = fileOf(id)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}
