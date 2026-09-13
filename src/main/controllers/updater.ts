import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { UpdaterStatus } from '../../shared/types'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdaterStatus,
  quitAndInstall
} from '../services/updater'

/** 应用级 IPC：自动更新（检查 / 下载 / 重启安装）。 */
export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC.Updater.status, (): UpdaterStatus => getUpdaterStatus())
  ipcMain.handle(IPC.Updater.check, (): Promise<UpdaterStatus> => checkForUpdates(true))
  ipcMain.handle(IPC.Updater.download, (): Promise<UpdaterStatus> => downloadUpdate())
  ipcMain.on(IPC.Updater.install, () => quitAndInstall())
}
