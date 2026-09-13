import { app, dialog, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { IPC } from '../../shared/ipc'
import type {
  EditFileInfo,
  EditorReadArgs,
  EditorReadResult,
  EditorSaveArgs,
  EditorSaveResult,
  EditorTranscodeArgs,
  EditorThumbArgs,
  EditorWriteArgs,
  ExportTimelineArgs
} from '../../shared/editor'
import { getMainWindow, notify } from '../window-store'
import { clearRecovery, loadRecovery, saveRecovery } from '../services/editor-recovery'
import {
  cancelCurrent,
  exportTimeline,
  getFfmpegStatus,
  makeThumbnail,
  probeMedia,
  setFfmpegPath,
  transcodeToProxy
} from '../services/ffmpeg'

/**
 * 剪辑工作区 IPC：媒体导入 / 路径解析 / 文件读写 +
 * FFmpeg 探测 / 转码代理 / 抽帧缩略图 / 时间线导出 MP4。
 * 编解码统一走主进程 ffmpeg（缺失时渲染层回退到 WebM 录制）。
 */

const WIN = process.platform === 'win32'

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', '3gp']
const AUDIO_EXT = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'ape']

function kindOf(ext: string): EditFileInfo['kind'] {
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  return ''
}

function resolveFile(p: string): EditFileInfo {
  const ext = path.extname(p).slice(1).toLowerCase()
  let size = 0
  try {
    size = fs.statSync(p).size
  } catch {
    /* 文件可能已移动，交给渲染层报错 */
  }
  return { name: path.basename(p), path: p, url: pathToFileURL(p).href, kind: kindOf(ext), ext, size }
}

const READ_LIMIT = 64 * 1024 * 1024

export function registerEditorIpc(): void {
  /** 打开文件选择器导入视频 / 音频。 */
  ipcMain.handle(IPC.Editor.import, async () => {
    const win = getMainWindow()
    const opts = {
      title: '导入视频 / 音频',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        { name: '媒体文件', extensions: [...VIDEO_EXT, ...AUDIO_EXT] },
        { name: '视频', extensions: VIDEO_EXT },
        { name: '音频', extensions: AUDIO_EXT }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true, files: [] }
    return { ok: true, files: res.filePaths.map(resolveFile) }
  })

  /** 按路径解析媒体信息（拖拽导入 / 自检用）。 */
  ipcMain.handle(IPC.Editor.resolve, (_e, args: { paths?: string[] } = {}) => {
    const paths = Array.isArray(args?.paths) ? args.paths.filter((p): p is string => typeof p === 'string' && !!p) : []
    return { ok: true, files: paths.map(resolveFile) }
  })

  /** 读取本地文件（音频波形解码用），带大小上限避免一次性读入超大视频。 */
  ipcMain.handle(IPC.Editor.read, (_e, args: EditorReadArgs = { path: '' }): EditorReadResult => {
    const p = typeof args?.path === 'string' ? args.path : ''
    if (!p) return { ok: false, error: 'missing path' }
    const max = Math.min(READ_LIMIT, Math.max(1024, Number(args?.maxBytes) || READ_LIMIT))
    try {
      const st = fs.statSync(p)
      if (st.size > max) return { ok: false, error: `文件超过读取上限（${Math.round(max / 1024 / 1024)}MB）` }
      return { ok: true, data: new Uint8Array(fs.readFileSync(p)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /** 导出：另存为对话框 + 写文件。 */
  ipcMain.handle(IPC.Editor.save, async (_e, args: EditorSaveArgs): Promise<EditorSaveResult> => {
    const name = typeof args?.name === 'string' && args.name ? args.name : '导出文件'
    if (!args?.data) return { ok: false, error: 'missing data' }
    const win = getMainWindow()
    const opts = {
      title: '导出',
      defaultPath: name,
      filters: args?.filters && args.filters.length ? args.filters : [{ name: '全部文件', extensions: ['*'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(res.filePath, Buffer.from(args.data))
      return { ok: true, path: res.filePath }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /** 写入指定路径（自检 / 自动化导出用）。 */
  ipcMain.handle(IPC.Editor.writeFile, (_e, args: EditorWriteArgs) => {
    const p = typeof args?.path === 'string' ? args.path : ''
    if (!p || !args?.data) return { ok: false, error: 'missing args' }
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.from(args.data))
      return { ok: true, path: p }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /* ---------- FFmpeg：探测 / 指定路径 / 转码 / 抽帧 / 导出 ---------- */
  ipcMain.handle(IPC.Editor.ffmpegStatus, () => getFfmpegStatus())
  ipcMain.handle(IPC.Editor.ffmpegRecheck, () => getFfmpegStatus(true))
  ipcMain.handle(IPC.Editor.ffmpegChoose, async () => {
    const win = getMainWindow()
    const opts = {
      title: '选择 ffmpeg 可执行文件',
      properties: ['openFile'] as Array<'openFile'>,
      filters: WIN ? [{ name: 'FFmpeg', extensions: ['exe'] }] : [{ name: 'FFmpeg', extensions: ['*'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
    const status = await setFfmpegPath(res.filePaths[0])
    return { ok: status.available, status }
  })

  ipcMain.handle(IPC.Editor.probe, (_e, args: { path?: string } = {}) => {
    if (!args?.path) {
      return { ok: false, path: '', duration: 0, hasVideo: false, hasAudio: false, container: '', playable: false, error: 'missing path' }
    }
    return probeMedia(args.path)
  })

  ipcMain.handle(IPC.Editor.transcode, async (_e, args: EditorTranscodeArgs) => {
    if (!args?.path || !args?.mediaId) return { ok: false, error: 'missing args' }
    try {
      const result = await transcodeToProxy(args.path, args.mediaId, args.maxSize || 1920, (e) => notify(IPC.Events.editorProgress, e))
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.Editor.thumbnail, async (_e, args: EditorThumbArgs) => {
    if (!args?.path) return { ok: false, error: 'missing path' }
    const dataUrl = await makeThumbnail(args.path, args.at || 0)
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'thumbnail failed' }
  })

  ipcMain.handle(IPC.Editor.exportTimeline, async (_e, args: ExportTimelineArgs) => {
    if (!args?.project) return { ok: false, error: 'missing project' }
    let output = typeof args.outputPath === 'string' ? args.outputPath : ''
    if (!output) {
      const win = getMainWindow()
      const saveOpts = { title: '导出视频', defaultPath: '剪辑-视频.mp4', filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] }
      const res = win ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      output = res.filePath
    }
    try {
      return await exportTimeline(args, output, (e) => notify(IPC.Events.editorProgress, e))
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.Editor.cancelExport, () => {
    cancelCurrent()
    return { ok: true }
  })

  /* ---------- 字幕导入 / 临时文件 ---------- */
  ipcMain.handle(IPC.Editor.pickSubtitle, async () => {
    const win = getMainWindow()
    const opts = {
      title: '导入字幕',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [
        { name: '字幕文件', extensions: ['srt', 'vtt', 'txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
    const file = res.filePaths[0]
    try {
      return { ok: true, name: path.basename(file), content: fs.readFileSync(file, 'utf-8') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /* ---------- 自动保存 / 崩溃恢复 ---------- */
  ipcMain.handle(IPC.Editor.recoverySave, (_e, args: { id?: string; project?: unknown } = {}) => {
    if (!args?.id) return { ok: false, error: 'missing id' }
    return saveRecovery(args.id, args.project)
  })
  ipcMain.handle(IPC.Editor.recoveryLoad, (_e, args: { id?: string } = {}) => {
    if (!args?.id) return null
    return loadRecovery(args.id)
  })
  ipcMain.handle(IPC.Editor.recoveryClear, (_e, args: { id?: string } = {}) => {
    if (!args?.id) return { ok: false }
    return { ok: clearRecovery(args.id) }
  })

  ipcMain.handle(IPC.Editor.tempFile, (_e, args: { name?: string } = {}) => {
    const name = (typeof args?.name === 'string' && args.name ? args.name : 'tmp.bin').replace(/[\\/:*?"<>|]/g, '_')
    const dir = path.join(app.getPath('userData'), 'edits', 'tmp')
    try {
      fs.mkdirSync(dir, { recursive: true })
      return { ok: true, path: path.join(dir, name) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
