import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'

/** 窗口控制 IPC：最小化 / 最大化 / 关闭（沿用原 main.js window:* 通道）。 */
export function registerWindowIpc(): void {
  ipcMain.on(IPC.Window.minimize, () => BrowserWindow.getFocusedWindow()?.minimize())
  ipcMain.on(IPC.Window.maximize, () => BrowserWindow.getFocusedWindow()?.maximize())
  ipcMain.on(IPC.Window.close, () => BrowserWindow.getFocusedWindow()?.close())
}