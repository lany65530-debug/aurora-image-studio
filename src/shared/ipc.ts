/**
 * 全局共享：IPC 通道名常量。
 * 所有 ipcMain / ipcRenderer / preload 必须引用此处的常量，避免字符串漂移。
 */
export const IPC = {
  App: {
    info: 'app:info',
    gpuStatus: 'app:gpuStatus'
  },
  Window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close'
  },
  Settings: {
    get: 'settings:get',
    save: 'settings:save'
  },
  Chat: {
    send: 'chat:send',
    stop: 'chat:stop',
    search: 'chat:search',
    attachmentSave: 'chat:attach:save',
    attachmentReadText: 'chat:attach:readText',
    attachmentReadImage: 'chat:attach:readImage',
    sessionsList: 'chat:sessions:list',
    sessionsSave: 'chat:sessions:save',
    sessionsDelete: 'chat:sessions:delete',
    modelsList: 'chat:models:list',
    export: 'chat:export'
  },
  Provider: {
    presets: 'provider:presets',
    test: 'provider:test'
  },
  Image: {
    generate: 'image:generate',
    edit: 'image:edit',
    stop: 'image:stop',
    modelsList: 'models:list',
    groupsList: 'groups:list'
  },
  Library: {
    get: 'library:get',
    delete: 'library:delete',
    clear: 'library:clear',
    thumb: 'library:thumb',
    fileInfo: 'library:fileInfo'
  },
  Novel: {
    list: 'novel:list',
    get: 'novel:get',
    save: 'novel:save',
    delete: 'novel:delete'
  },
  Editor: {
    import: 'editor:import',
    resolve: 'editor:resolve',
    read: 'editor:read',
    save: 'editor:save',
    writeFile: 'editor:writeFile',
    ffmpegStatus: 'editor:ffmpegStatus',
    ffmpegChoose: 'editor:ffmpegChoose',
    ffmpegRecheck: 'editor:ffmpegRecheck',
    probe: 'editor:probe',
    transcode: 'editor:transcode',
    thumbnail: 'editor:thumbnail',
    exportTimeline: 'editor:exportTimeline',
    cancelExport: 'editor:cancelExport',
    pickSubtitle: 'editor:pickSubtitle',
    tempFile: 'editor:tempFile',
    recoverySave: 'editor:recoverySave',
    recoveryLoad: 'editor:recoveryLoad',
    recoveryClear: 'editor:recoveryClear'
  },
  Detector: {
    open: 'detector:open',
    pickFile: 'detector:pickFile',
    readDocument: 'detector:readDocument',
    export: 'detector:export',
    /** 把改写结果写回小说章节（经主窗口落地） */
    applyToNovel: 'detector:applyToNovel',
    /** 请求在主窗口打开小说工作区的 AI 接口设置 */
    requestConfig: 'detector:requestConfig',
    /** 查询检测窗口是否已打开 */
    status: 'detector:status',
    /** 写入系统剪贴板（窗口未聚焦时浏览器 Clipboard API 会失败） */
    copyText: 'detector:copyText'
  },
  Dir: {
    choose: 'dir:choose',
    open: 'dir:open'
  },
  Shell: {
    openPath: 'shell:openPath'
  },
  /** 界面设置（主题 / 字号 / 密度 / 动效）。 */
  Ui: {
    /** 读取界面设置。 */
    get: 'ui:get',
    /** 保存界面设置（增量合并）。 */
    save: 'ui:save'
  },
  /** 自动更新（GitHub Releases）。 */
  Updater: {
    /** 查询当前更新状态快照。 */
    status: 'updater:status',
    /** 主动检查是否有新版本。 */
    check: 'updater:check',
    /** 下载已发现的新版本。 */
    download: 'updater:download',
    /** 退出应用并安装已下载的新版本。 */
    install: 'updater:install'
  },
  /** 主进程 -> 渲染层事件推送通道（仅 notify 使用，由 preload 订阅转发）。 */
  Events: {
    /** 自动更新状态变化推送。 */
    updaterStatus: 'updater:status:event',
    imageProgress: 'image:progress',
    chatChunk: 'chat:chunk',
    chatReasoning: 'chat:reasoning',
    /** 检测窗口加载 / 更新载荷 */
    detectorLoad: 'detector:load',
    /** 主窗口：把改写结果写回指定章节 */
    detectorApply: 'detector:apply',
    /** 主窗口：打开小说工作区的 AI 接口设置 */
    detectorConfig: 'detector:config',
    /** 剪辑工作区：ffmpeg 探测 / 转码 / 导出进度 */
    editorProgress: 'editor:progress'
  }
} as const

export type IpcChannels = typeof IPC