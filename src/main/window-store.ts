import type { BrowserWindow } from 'electron'

/** 主窗口引用存储：供各控制器向渲染进程推送 progress/chunk 事件。 */

let current: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  current = win
}

export function getMainWindow(): BrowserWindow | null {
  return current
}

/** 向主窗口 webContents 发送事件（窗口已销毁时安全跳过）。 */
export function notify(channel: string, payload: unknown): void {
  const win = current
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}