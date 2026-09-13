import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { NovelFileData } from '../../shared/novel'
import { loadNovelFile, saveNovelFile, deleteNovelFile, listNovelSummaries } from '../services/novel-store'

/** 小说数据 IPC：novel:list / novel:get / novel:save / novel:delete（data/ JSON 落盘）。 */
export function registerNovelIpc(): void {
  ipcMain.handle(IPC.Novel.list, () => listNovelSummaries())

  ipcMain.handle(IPC.Novel.get, (_e, id: string) => {
    if (!id) return { ok: false, error: '无效的小说 id。' }
    const novel = loadNovelFile(id)
    if (!novel) return { ok: false, error: '小说不存在。' }
    return { ok: true, novel }
  })

  ipcMain.handle(IPC.Novel.save, (_e, data: NovelFileData) => {
    if (!data || !data.id) return { ok: false, error: '无效的小说数据。' }
    saveNovelFile(data)
    return { ok: true }
  })

  ipcMain.handle(IPC.Novel.delete, (_e, id: string) => {
    if (!id) return { ok: false, error: '无效的小说 id。' }
    deleteNovelFile(id)
    return { ok: true }
  })
}