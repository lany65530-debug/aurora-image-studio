import { app, BrowserWindow } from 'electron'
import { registerAppIpc } from './controllers/app'
import { registerWindowIpc } from './controllers/window-ipc'
import { createWindow } from './controllers/window'
import { registerSettingsIpc } from './controllers/settings'
import { registerLibraryIpc } from './controllers/library'
import { registerImageIpc, registerProviderIpc } from './controllers/image'
import { registerChatIpc } from './controllers/chat'
import { registerNovelIpc } from './controllers/novel'
import { registerDetectorIpc } from './controllers/detector'
import { registerEditorIpc } from './controllers/editor'
import { registerUpdaterIpc } from './controllers/updater'
import { registerUiSettingsIpc } from './controllers/uiSettings'
import { initUpdater } from './services/updater'
import { setupGpuAcceleration } from './config/gpu'

/**
 * 主进程引导入口：
 * 装配 services → 注册 controllers（IPC）→ 启动窗口。
 */

// 必须在 app ready 之前：显式开启 GPU 硬件加速（图片解码 / 合成 / 滚动走显卡）
setupGpuAcceleration()

// 单实例锁：避免重复启动
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.whenReady().then(() => {
  // 注册控制器（每个控制器内部自管理其 ipcMain.handle / ipcMain.on）
  registerAppIpc()
  registerWindowIpc()
  registerSettingsIpc()
  registerChatIpc()
  registerImageIpc()
  registerProviderIpc()
  registerLibraryIpc()
  registerNovelIpc()
  registerDetectorIpc()
  registerEditorIpc()
  registerUpdaterIpc()
  registerUiSettingsIpc()

  createWindow()

  // 窗口就绪后再启动更新服务：状态事件能推给渲染层（渲染层挂载时也会主动查询一次）
  initUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})