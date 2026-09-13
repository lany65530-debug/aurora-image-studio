import type {
  AppInfo,
  AppSettings,
  GpuStatus,
  LibraryThumbArgs,
  LibraryThumbResult,
  ChatResult,
  ChatSendParams,
  ChatSession,
  ChatSearchArgs,
  AttachmentSaveArgs,
  AttachmentReadArgs,
  SessionDeleteArgs,
  ChatModelsParams,
  ChatChunkEvent,
  ChatReasoningEvent,
  DeleteLibraryArgs,
  EditImageParams,
  GenerateImageParams,
  GroupsResult,
  ImageProgressEvent,
  LibraryItem,
  ModelItem,
  ChooseDirResult,
  ProviderTestParams,
  UpdaterStatus
} from './types'
import type {
  NovelDeleteResult,
  NovelFileData,
  NovelGetResult,
  NovelSaveResult,
  NovelSummary
} from './novel'
import type {
  EditorImportResult,
  EditorProgressEvent,
  EditorProbeResult,
  EditorReadArgs,
  EditorReadResult,
  EditorResolveArgs,
  EditorSaveArgs,
  EditorPickSubtitleResult,
  EditorRecoveryData,
  EditorRecoverySaveArgs,
  EditorRecoverySaveResult,
  EditorSaveResult,
  EditorTempFileArgs,
  EditorTempFileResult,
  EditorThumbArgs,
  EditorThumbResult,
  EditorTranscodeArgs,
  EditorTranscodeResult,
  EditorWriteArgs,
  EditFileInfo,
  ExportTimelineArgs,
  ExportTimelineResult,
  FfmpegStatus
} from './editor'
import type {
  DetectorApplyArgs,
  DetectorExportArgs,
  DetectorExportResult,
  DetectorFileResult,
  DetectorOpenPayload,
  DetectorTarget
} from './ai-detect'

/** 事件订阅取消函数。 */
export type Unsubscribe = () => void

/**
 * 预加载层暴露给渲染进程的 API 面类型（全局契约）。
 * 仅放纯类型，不 import electron，供 preload 实现与渲染层消费共同引用。
 */
export interface AuroraApi {
  app: {
    getInfo: () => Promise<AppInfo>
    gpuStatus: () => Promise<GpuStatus>
  }
  /** 自动更新：检查 / 下载 / 安装（GitHub Releases）。 */
  updater: {
    /** 查询当前更新状态快照。 */
    getStatus: () => Promise<UpdaterStatus>
    /** 主动检查新版本，返回检查后的状态。 */
    check: () => Promise<UpdaterStatus>
    /** 下载已发现的新版本，返回操作后的状态。 */
    download: () => Promise<UpdaterStatus>
    /** 退出应用并安装已下载的更新（无返回值，进程会退出）。 */
    install: () => void
    /** 订阅更新状态变化。 */
    onStatus: (cb: (status: UpdaterStatus) => void) => Unsubscribe
  }
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
  }
  settings: {
    get: () => Promise<AppSettings>
    save: (settings: Partial<AppSettings>) => Promise<{ ok: boolean }>
  }
  chat: {
    send: (params: ChatSendParams) => Promise<ChatResult>
    stop: (sessionId: string) => void
    search: (args: ChatSearchArgs) => Promise<{ ok: boolean; result?: unknown; error?: string }>
    attachmentSave: (args: AttachmentSaveArgs) => Promise<{ ok: boolean; path?: string; fileUrl?: string; error?: string }>
    attachmentReadText: (args: AttachmentReadArgs) => Promise<{ ok: boolean; text?: string; error?: string }>
    attachmentReadImage: (args: AttachmentReadArgs) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
    sessionsList: () => Promise<ChatSession[]>
    sessionsSave: (session: ChatSession) => Promise<{ ok: boolean; error?: string }>
    sessionsDelete: (args: SessionDeleteArgs) => Promise<{ ok: boolean }>
    modelsList: (params: ChatModelsParams) => Promise<{ ok: boolean; models?: string[]; error?: string }>
    export: (args: { name?: string; content: string }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
    onChunk: (cb: (e: ChatChunkEvent) => void) => Unsubscribe
    onReasoning: (cb: (e: ChatReasoningEvent) => void) => Unsubscribe
  }
  provider: {
    presets: () => Promise<{ ok: boolean; presets?: Record<string, any>; error?: string }>
    test: (params: ProviderTestParams) => Promise<{ ok: boolean; count?: number; error?: string }>
  }
  image: {
    generate: (params: GenerateImageParams) => Promise<{ ok: boolean; images?: Array<Record<string, any>>; error?: string }>
    edit: (params: EditImageParams) => Promise<{ ok: boolean; images?: Array<Record<string, any>>; error?: string }>
    stop: (jobId: string) => void
    modelsList: (params: GenerateImageParams) => Promise<{ ok: boolean; models?: ModelItem[]; error?: string; status?: number; raw?: string }>
    groupsList: (params: GenerateImageParams) => Promise<GroupsResult>
    onProgress: (cb: (e: ImageProgressEvent) => void) => Unsubscribe
  }
  library: {
    get: () => Promise<LibraryItem[]>
    delete: (args: DeleteLibraryArgs) => Promise<{ ok: boolean }>
    clear: () => Promise<{ ok: boolean }>
    thumb: (args: LibraryThumbArgs) => Promise<LibraryThumbResult>
  }
  novel: {
    list: () => Promise<NovelSummary[]>
    get: (id: string) => Promise<NovelGetResult>
    save: (data: NovelFileData) => Promise<NovelSaveResult>
    delete: (id: string) => Promise<NovelDeleteResult>
  }
  /** 剪辑工作区：媒体导入 / 探测 / 转码代理 / ffmpeg 导出。 */
  editor: {
    import: () => Promise<EditorImportResult>
    resolve: (args: EditorResolveArgs) => Promise<{ ok: boolean; files: EditFileInfo[] }>
    read: (args: EditorReadArgs) => Promise<EditorReadResult>
    save: (args: EditorSaveArgs) => Promise<EditorSaveResult>
    writeFile: (args: EditorWriteArgs) => Promise<{ ok: boolean; path?: string; error?: string }>
    ffmpegStatus: () => Promise<FfmpegStatus>
    ffmpegChoose: () => Promise<{ ok: boolean; canceled?: boolean; status?: FfmpegStatus }>
    ffmpegRecheck: () => Promise<FfmpegStatus>
    probe: (args: { path: string }) => Promise<EditorProbeResult>
    transcode: (args: EditorTranscodeArgs) => Promise<EditorTranscodeResult>
    thumbnail: (args: EditorThumbArgs) => Promise<EditorThumbResult>
    exportTimeline: (args: ExportTimelineArgs) => Promise<ExportTimelineResult>
    cancelExport: () => Promise<{ ok: boolean }>
    pickSubtitle: () => Promise<EditorPickSubtitleResult>
    tempFile: (args: EditorTempFileArgs) => Promise<EditorTempFileResult>
    recoverySave: (args: EditorRecoverySaveArgs) => Promise<EditorRecoverySaveResult>
    recoveryLoad: (args: { id: string }) => Promise<EditorRecoveryData | null>
    recoveryClear: (args: { id: string }) => Promise<{ ok: boolean }>
    onProgress: (cb: (e: EditorProgressEvent) => void) => Unsubscribe
  }
  /** AI 率检测：独立窗口 + 文档导入 + 报告导出 + 降 AI 味写回。 */
  detector: {
    open: (payload?: DetectorOpenPayload) => Promise<{ ok: boolean }>
    pickFile: () => Promise<DetectorFileResult>
    readDocument: (args: { name: string; data: ArrayBuffer | Uint8Array }) => Promise<DetectorFileResult>
    export: (args: DetectorExportArgs) => Promise<DetectorExportResult>
    /** 把改写后的正文写回小说章节（主窗口执行）。 */
    applyToNovel: (args: DetectorApplyArgs) => Promise<{ ok: boolean; error?: string }>
    /** 请求在主窗口打开小说工作区的 AI 接口设置。 */
    requestConfig: (target?: DetectorTarget) => Promise<{ ok: boolean }>
    /** 检测窗口是否已打开（用于决定是否推送新配置/文本）。 */
    status: () => Promise<{ open: boolean }>
    /** 写入系统剪贴板（主进程执行，窗口未聚焦时也可靠）。 */
    copyText: (text: string) => Promise<{ ok: boolean }>
    /** 检测窗口：主进程推入待检测文本 / 接口配置。 */
    onLoad: (cb: (payload: DetectorOpenPayload) => void) => Unsubscribe
    /** 主窗口：接收「写回章节」请求。 */
    onApply: (cb: (payload: DetectorApplyArgs) => void) => Unsubscribe
    /** 主窗口：接收「打开接口设置」请求。 */
    onRequestConfig: (cb: (target?: DetectorTarget) => void) => Unsubscribe
  }
  dir: {
    choose: () => Promise<ChooseDirResult>
    open: (dir?: string) => Promise<{ ok: boolean }>
  }
  shell: {
    openPath: (p?: string) => Promise<boolean>
  }
}