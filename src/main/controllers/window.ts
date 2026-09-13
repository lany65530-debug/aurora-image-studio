import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { setMainWindow } from '../window-store'

/**
 * 窗口控制器：负责创建与生命周期管理主窗口。
 * 仅承载「窗口创建 + 外链跳转」职责，不混入业务逻辑。
 */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    setMainWindow(null)
  })
  setMainWindow(win)

  // 外部链接一律交给系统默认浏览器，禁止在应用内新开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}