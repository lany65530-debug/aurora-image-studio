import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { AuroraApi, Unsubscribe } from '../shared/aurora-api'
import type {
  ChatChunkEvent,
  ChatReasoningEvent,
  ImageProgressEvent,
  UpdaterStatus
} from '../shared/types'
import type {
  NovelFileData
} from '../shared/novel'
import type { EditorProgressEvent } from '../shared/editor'
import type { DetectorApplyArgs, DetectorOpenPayload, DetectorTarget } from '../shared/ai-detect'

/** 订阅主进程事件推送，返回取消订阅函数（白名单收口到具体通道）。 */
function onChannel<TPayload>(channel: string, cb: (payload: TPayload) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: TPayload): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * 预加载层 API 面：渲染进程通过 window.aurora 调用。
 * 迁移阶段 2 已将主进程全部 IPC 通道收敛至此，事件推送统一以 on 订阅转发。
 */
export const api: AuroraApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.App.info),
    gpuStatus: () => ipcRenderer.invoke(IPC.App.gpuStatus)
  },
  ui: {
    get: () => ipcRenderer.invoke(IPC.Ui.get),
    save: (patch) => ipcRenderer.invoke(IPC.Ui.save, patch)
  },
  updater: {
    getStatus: () => ipcRenderer.invoke(IPC.Updater.status),
    check: () => ipcRenderer.invoke(IPC.Updater.check),
    download: () => ipcRenderer.invoke(IPC.Updater.download),
    install: () => ipcRenderer.send(IPC.Updater.install),
    onStatus: (cb) => onChannel<UpdaterStatus>(IPC.Events.updaterStatus, cb)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.Window.minimize),
    maximize: () => ipcRenderer.send(IPC.Window.maximize),
    close: () => ipcRenderer.send(IPC.Window.close)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.Settings.get),
    save: (settings) => ipcRenderer.invoke(IPC.Settings.save, settings)
  },
  chat: {
    send: (params) => ipcRenderer.invoke(IPC.Chat.send, params),
    stop: (sessionId) => ipcRenderer.send(IPC.Chat.stop, sessionId),
    search: (args) => ipcRenderer.invoke(IPC.Chat.search, args),
    attachmentSave: (args) => ipcRenderer.invoke(IPC.Chat.attachmentSave, args),
    attachmentReadText: (args) => ipcRenderer.invoke(IPC.Chat.attachmentReadText, args),
    attachmentReadImage: (args) => ipcRenderer.invoke(IPC.Chat.attachmentReadImage, args),
    sessionsList: () => ipcRenderer.invoke(IPC.Chat.sessionsList),
    sessionsSave: (session) => ipcRenderer.invoke(IPC.Chat.sessionsSave, session),
    sessionsDelete: (args) => ipcRenderer.invoke(IPC.Chat.sessionsDelete, args),
    modelsList: (params) => ipcRenderer.invoke(IPC.Chat.modelsList, params),
    export: (args) => ipcRenderer.invoke(IPC.Chat.export, args),
    onChunk: (cb) => onChannel<ChatChunkEvent>(IPC.Events.chatChunk, cb),
    onReasoning: (cb) => onChannel<ChatReasoningEvent>(IPC.Events.chatReasoning, cb)
  },
  provider: {
    presets: () => ipcRenderer.invoke(IPC.Provider.presets),
    test: (params) => ipcRenderer.invoke(IPC.Provider.test, params)
  },
  image: {
    generate: (params) => ipcRenderer.invoke(IPC.Image.generate, params),
    edit: (params) => ipcRenderer.invoke(IPC.Image.edit, params),
    stop: (jobId) => ipcRenderer.send(IPC.Image.stop, jobId),
    modelsList: (params) => ipcRenderer.invoke(IPC.Image.modelsList, params),
    groupsList: (params) => ipcRenderer.invoke(IPC.Image.groupsList, params),
    onProgress: (cb) => onChannel<ImageProgressEvent>(IPC.Events.imageProgress, cb)
  },
  library: {
    get: () => ipcRenderer.invoke(IPC.Library.get),
    delete: (args) => ipcRenderer.invoke(IPC.Library.delete, args),
    clear: () => ipcRenderer.invoke(IPC.Library.clear),
    thumb: (args) => ipcRenderer.invoke(IPC.Library.thumb, args)
  },
  editor: {
    import: () => ipcRenderer.invoke(IPC.Editor.import),
    resolve: (args) => ipcRenderer.invoke(IPC.Editor.resolve, args),
    read: (args) => ipcRenderer.invoke(IPC.Editor.read, args),
    save: (args) => ipcRenderer.invoke(IPC.Editor.save, args),
    writeFile: (args) => ipcRenderer.invoke(IPC.Editor.writeFile, args),
    ffmpegStatus: () => ipcRenderer.invoke(IPC.Editor.ffmpegStatus),
    ffmpegChoose: () => ipcRenderer.invoke(IPC.Editor.ffmpegChoose),
    ffmpegRecheck: () => ipcRenderer.invoke(IPC.Editor.ffmpegRecheck),
    probe: (args) => ipcRenderer.invoke(IPC.Editor.probe, args),
    transcode: (args) => ipcRenderer.invoke(IPC.Editor.transcode, args),
    thumbnail: (args) => ipcRenderer.invoke(IPC.Editor.thumbnail, args),
    exportTimeline: (args) => ipcRenderer.invoke(IPC.Editor.exportTimeline, args),
    cancelExport: () => ipcRenderer.invoke(IPC.Editor.cancelExport),
    pickSubtitle: () => ipcRenderer.invoke(IPC.Editor.pickSubtitle),
    tempFile: (args) => ipcRenderer.invoke(IPC.Editor.tempFile, args),
    recoverySave: (args) => ipcRenderer.invoke(IPC.Editor.recoverySave, args),
    recoveryLoad: (args) => ipcRenderer.invoke(IPC.Editor.recoveryLoad, args),
    recoveryClear: (args) => ipcRenderer.invoke(IPC.Editor.recoveryClear, args),
    onProgress: (cb) => onChannel<EditorProgressEvent>(IPC.Events.editorProgress, cb)
  },
  novel: {
    list: () => ipcRenderer.invoke(IPC.Novel.list),
    get: (id) => ipcRenderer.invoke(IPC.Novel.get, id),
    save: (data: NovelFileData) => ipcRenderer.invoke(IPC.Novel.save, data),
    delete: (id) => ipcRenderer.invoke(IPC.Novel.delete, id)
  },
  detector: {
    open: (payload) => ipcRenderer.invoke(IPC.Detector.open, payload),
    pickFile: () => ipcRenderer.invoke(IPC.Detector.pickFile),
    readDocument: (args) => ipcRenderer.invoke(IPC.Detector.readDocument, args),
    export: (args) => ipcRenderer.invoke(IPC.Detector.export, args),
    applyToNovel: (args) => ipcRenderer.invoke(IPC.Detector.applyToNovel, args),
    requestConfig: (target) => ipcRenderer.invoke(IPC.Detector.requestConfig, target),
    status: () => ipcRenderer.invoke(IPC.Detector.status),
    copyText: (text) => ipcRenderer.invoke(IPC.Detector.copyText, text),
    onLoad: (cb) => onChannel<DetectorOpenPayload>(IPC.Events.detectorLoad, cb),
    onApply: (cb) => onChannel<DetectorApplyArgs>(IPC.Events.detectorApply, cb),
    onRequestConfig: (cb) => onChannel<DetectorTarget | undefined>(IPC.Events.detectorConfig, cb)
  },
  dir: {
    choose: () => ipcRenderer.invoke(IPC.Dir.choose),
    open: (dir) => ipcRenderer.invoke(IPC.Dir.open, dir)
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke(IPC.Shell.openPath, p)
  }
}