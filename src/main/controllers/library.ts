import { dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import { IPC } from '../../shared/ipc'
import { loadSettings, saveSettings } from '../services/settings'
import { enqueueLibrary, loadLibrary } from '../services/library'
import { getThumbnail } from '../services/thumbnails'
import { ensureDir } from '../common/utils'
import { defaultSaveDir } from '../config'
import { getMainWindow } from '../window-store'

/** 图片库 IPC：library:get / library:delete / library:clear，及目录选择打开、图片另存、shell 打开。 */
export function registerLibraryIpc(): void {
  ipcMain.handle(IPC.Library.get, () => loadLibrary())
  ipcMain.handle(IPC.Library.fileInfo, (_e, id: string) => {
    if (typeof id !== 'string' || !id) return { ok: false }
    const entry = loadLibrary().find((item) => item.id === id)
    if (typeof entry?.filePath !== 'string' || !entry.filePath) return { ok: false }
    try {
      const stat = fs.statSync(entry.filePath)
      return stat.isFile() ? { ok: true, bytes: stat.size } : { ok: false }
    } catch {
      return { ok: false }
    }
  })
  ipcMain.handle(IPC.Library.delete, async (_e, args: { id?: string; deleteFile?: boolean }) => {
    let targetPath = ''
    await enqueueLibrary((lib) => {
      const t = lib.find((x) => x.id === args?.id)
      if (t) targetPath = (t.filePath as string) || ''
      lib.splice(0, lib.length, ...lib.filter((x) => x.id !== args?.id))
    })
    if (args?.deleteFile && targetPath) {
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
      } catch (e) {
        /* ignore */
      }
    }
    return { ok: true }
  })
  ipcMain.handle(IPC.Library.clear, async () => {
    await enqueueLibrary((lib) => {
      lib.length = 0
    })
    return { ok: true }
  })
  // 网格卡片缩略图：避免渲染进程解码 2K/4K 原图导致卡顿
  ipcMain.handle(IPC.Library.thumb, async (_e, args: { path?: string; size?: number } = {}) => {
    const p = typeof args?.path === 'string' ? args.path : ''
    if (!p) return { ok: false, error: 'missing path' }
    try {
      const dataUrl = await getThumbnail(p, args?.size)
      return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'thumbnail unavailable' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---- Save directory management ----
  ipcMain.handle(IPC.Dir.choose, async () => {
    const win = getMainWindow()
    const opts: { title: string; properties: Array<'openDirectory' | 'createDirectory'> } = {
      title: '选择图片保存文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const { canceled, filePaths } = res
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true }
    const dir = filePaths[0]
    const settings = loadSettings()
    settings.saveDir = dir
    saveSettings(settings)
    return { ok: true, dir }
  })
  ipcMain.handle(IPC.Dir.open, (_e, dir?: string) => {
    const target = dir || loadSettings().saveDir || defaultSaveDir()
    ensureDir(target)
    void shell.openPath(target)
    return { ok: true }
  })

  ipcMain.handle(IPC.Shell.openPath, (_e, p?: string) => {
    if (p) shell.showItemInFolder(p)
    return true
  })
}