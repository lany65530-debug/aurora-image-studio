import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { loadSettings, mergeAndSaveSettings } from '../services/settings'

/** 设置 IPC：settings:get / settings:save。 */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.Settings.get, () => loadSettings())
  ipcMain.handle(IPC.Settings.save, (_e, settings) => {
    const ok = mergeAndSaveSettings(settings || {})
    return { ok }
  })
}