import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/ipc'
import type {
  DetectorApplyArgs,
  DetectorExportArgs,
  DetectorExportResult,
  DetectorFileResult,
  DetectorOpenPayload,
  DetectorTarget
} from '../../shared/ai-detect'
import { TEXT_EXTENSIONS, extractDocumentText } from '../services/doc-text'
import { loadSettings } from '../services/settings'
import { getMainWindow, notify } from '../window-store'

/**
 * AI 率检测：独立窗口控制器
 * ---------------------------------------------------------------------------
 * - 单例窗口：再次调用 detector:open 只聚焦已有窗口并推送新文本
 * - 文本导入：系统文件对话框（主进程读取）或渲染层拖拽/选择后回传字节
 * - 报告导出：Markdown 落盘
 * 检测算法本身在渲染层运行（shared/ai-detect 为纯函数），主进程只负责窗口与文件。
 */

let detectorWindow: BrowserWindow | null = null
/** 窗口尚未加载完成时暂存待推送载荷。 */
let pendingPayload: DetectorOpenPayload | null = null

const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** 载荷消毒：只接受已知字段与字符串/数字类型，避免任意对象穿过 IPC。 */
function sanitizePayload(payload: unknown): DetectorOpenPayload {
  const src = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>
  const out: DetectorOpenPayload = {}
  if (typeof src.text === 'string') out.text = src.text.slice(0, 2_000_000)
  if (typeof src.title === 'string' && src.title.trim()) out.title = src.title.trim().slice(0, 160)
  if (typeof src.source === 'string' && src.source.trim()) out.source = src.source.trim().slice(0, 200)
  if (src.autoRun === true) out.autoRun = true
  const cfg = src.cfg
  if (cfg && typeof cfg === 'object') {
    out.cfg = {
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim().slice(0, 500) : undefined,
      apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey.trim().slice(0, 500) : undefined,
      model: typeof cfg.model === 'string' ? cfg.model.trim().slice(0, 200) : undefined,
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined
    }
  }
  if (src.target && typeof src.target === 'object') out.target = sanitizeTarget(src.target)
  return out
}

/** 写回目标消毒。 */
function sanitizeTarget(target: unknown): DetectorTarget | undefined {
  const src = (target && typeof target === 'object' ? target : {}) as Record<string, any>
  const out: DetectorTarget = {}
  if (typeof src.novelId === 'string' && src.novelId) out.novelId = src.novelId.slice(0, 120)
  if (typeof src.novelTitle === 'string' && src.novelTitle) out.novelTitle = src.novelTitle.slice(0, 160)
  if (typeof src.chapterId === 'string' && src.chapterId) out.chapterId = src.chapterId.slice(0, 120)
  if (typeof src.chapterTitle === 'string' && src.chapterTitle) out.chapterTitle = src.chapterTitle.slice(0, 200)
  if (typeof src.chapterIndex === 'number' && Number.isInteger(src.chapterIndex) && src.chapterIndex >= 0) {
    out.chapterIndex = src.chapterIndex
  }
  return Object.keys(out).length ? out : undefined
}

function createDetectorWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    title: 'AI 率检测',
    backgroundColor: '#f6f6f7',
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
    detectorWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', () => {
    if (pendingPayload) {
      win.webContents.send(IPC.Events.detectorLoad, pendingPayload)
      pendingPayload = null
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}/ai-detector.html`)
  else void win.loadFile(join(__dirname, '../renderer/ai-detector.html'))

  return win
}

/** 打开（或聚焦）AI 率检测窗口，可携带待检测文本与小说工作区的接口配置。 */
export function openDetectorWindow(payload?: unknown): { ok: boolean } {
  const data = sanitizePayload(payload)
  pendingPayload = data
  const existing = detectorWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (!existing.webContents.isLoading()) {
      existing.webContents.send(IPC.Events.detectorLoad, data)
      pendingPayload = null
    }
    return { ok: true }
  }
  detectorWindow = createDetectorWindow()
  return { ok: true }
}

function fileFilters(): Electron.FileFilter[] {
  return [
    { name: '文本与 Word 文档', extensions: TEXT_EXTENSIONS },
    { name: '纯文本', extensions: ['txt', 'md', 'markdown', 'log', 'csv', 'json', 'srt'] },
    { name: 'Word 文档', extensions: ['docx'] },
    { name: '所有文件', extensions: ['*'] }
  ]
}

export function registerDetectorIpc(): void {
  ipcMain.handle(IPC.Detector.open, (_e, payload: unknown) => openDetectorWindow(payload))

  // 系统文件对话框导入：主进程直接读取并抽取文本
  ipcMain.handle(IPC.Detector.pickFile, async (e): Promise<DetectorFileResult> => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? detectorWindow
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: '选择待检测文档', filters: fileFilters(), properties: ['openFile'] })
      : await dialog.showOpenDialog({ title: '选择待检测文档', filters: fileFilters(), properties: ['openFile'] })
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    const filePath = result.filePaths[0]
    const name = filePath.split(/[\\/]/).pop() || '未命名文件'
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > MAX_IMPORT_BYTES) {
        return { ok: false, error: `文件过大（${Math.round(stat.size / 1024 / 1024)}MB），上限 20MB。` }
      }
      const extracted = extractDocumentText(name, fs.readFileSync(filePath))
      if (!extracted.text.trim()) {
        return { ok: false, name, error: extracted.warning || '未能从文件中提取到文本。' }
      }
      return { ok: true, name, text: extracted.text, warning: extracted.warning }
    } catch (err) {
      return { ok: false, name, error: (err as Error).message || '读取文件失败。' }
    }
  })

  // 渲染层拖拽 / 文件选择后回传的字节流
  ipcMain.handle(
    IPC.Detector.readDocument,
    (_e, args: { name?: string; data?: ArrayBuffer | Uint8Array }): DetectorFileResult => {
      const data = args?.data
      if (!data) return { ok: false, error: '未收到文件内容。' }
      const name = String(args?.name || '未命名文件')
      const size = (data as ArrayBuffer).byteLength ?? (data as Uint8Array).length ?? 0
      if (size > MAX_IMPORT_BYTES) return { ok: false, name, error: '文件过大（上限 20MB）。' }
      try {
        const extracted = extractDocumentText(name, data)
        if (!extracted.text.trim()) {
          return { ok: false, name, error: extracted.warning || '未能从文件中提取到文本。' }
        }
        return { ok: true, name, text: extracted.text, warning: extracted.warning }
      } catch (err) {
        return { ok: false, name, error: (err as Error).message || '解析文件失败。' }
      }
    }
  )

  // 导出 Markdown 报告
  ipcMain.handle(IPC.Detector.export, async (_e, args: DetectorExportArgs): Promise<DetectorExportResult> => {
    const content = String(args?.content || '')
    if (!content.trim()) return { ok: false, error: '报告内容为空。' }
    const settings = loadSettings()
    const safeName = String(args?.name || 'AI率检测报告').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'AI率检测报告'
    const baseDir = settings.saveDir && fs.existsSync(settings.saveDir) ? settings.saveDir : app.getPath('documents')
    const result = await dialog.showSaveDialog({
      title: '导出 AI 率检测报告',
      defaultPath: join(baseDir, `${safeName}.md`),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '纯文本', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(result.filePath, content, 'utf-8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message || '写入文件失败。' }
    }
  })

  // 把改写后的正文写回小说章节：转发给主窗口，由小说工作区落地并保存
  ipcMain.handle(IPC.Detector.applyToNovel, (_e, args: DetectorApplyArgs) => {
    const text = String(args?.text || '')
    if (!text.trim()) return { ok: false, error: '改写结果为空，无法写回。' }
    const target = sanitizeTarget(args?.target)
    if (!target?.novelId) return { ok: false, error: '当前文本不是从小说章节打开的，无法写回。' }
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: '主窗口已关闭，无法写回章节。' }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC.Events.detectorApply, { text, target })
    return { ok: true }
  })

  // 查询检测窗口状态（小说工作区保存 AI 设置后据此决定是否推送新配置）
  ipcMain.handle(IPC.Detector.status, () => ({ open: !!detectorWindow && !detectorWindow.isDestroyed() }))

  // 写系统剪贴板：窗口未聚焦时渲染层 Clipboard API 会被拒绝，这里兜底
  ipcMain.handle(IPC.Detector.copyText, (_e, text: unknown) => {
    const value = String(text ?? '')
    if (!value) return { ok: false }
    clipboard.writeText(value.slice(0, 5_000_000))
    return { ok: true }
  })

  // 请求在主窗口打开小说工作区的 AI 接口设置（检测窗口不单独维护接口配置）
  ipcMain.handle(IPC.Detector.requestConfig, (_e, target?: DetectorTarget) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { ok: false }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    notify(IPC.Events.detectorConfig, sanitizeTarget(target))
    return { ok: true }
  })
}
