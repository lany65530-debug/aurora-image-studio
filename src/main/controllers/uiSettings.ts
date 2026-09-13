import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { UiSettings } from '../../shared/types'
import { loadUiSettings, mergeAndSaveUiSettings } from '../services/uiSettings'
import { applyAutoCheckSetting } from '../services/updater'

/** 界面设置 IPC：ui:get / ui:save。 */
export function registerUiSettingsIpc(): void {
  ipcMain.handle(IPC.Ui.get, (): UiSettings => loadUiSettings())
  ipcMain.handle(IPC.Ui.save, (_e, patch) => {
    const ok = mergeAndSaveUiSettings((patch || {}) as Partial<UiSettings>)
    if (ok) {
      // 「自动检查更新」开关需要即时生效，不用重启应用
      applyAutoCheckSetting(loadUiSettings().autoCheckUpdate)
    }
    return { ok }
  })
}
