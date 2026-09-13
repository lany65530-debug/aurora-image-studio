import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { IPC } from '../../shared/ipc'
import type { UpdaterState, UpdaterStatus } from '../../shared/types'
import { loadUiSettings } from './uiSettings'

/**
 * 自动更新服务（electron-updater + GitHub Releases）。
 * ------------------------------------------------------------
 * 更新信息来自构建时由 electron-builder 生成的 `app-update.yml`（appId / provider：
 * GitHub owner+repo）。运行时 electron-updater 会去拉取该仓库最新 Release 里的
 * `latest.yml`，从而得知新版本号、安装包地址与 **blockmap**（用于增量下载）。
 *
 * 增量说明：NSIS 目标会同时产出 `AuroraStudio-Setup-x.y.z.exe.blockmap`。
 * 只要用户本地缓存过上一版安装包，electron-updater 就会走块级差分（非全量）；
 * 首次更新或缓存被清理时自动回退为整包下载，无需额外处理。
 *
 * 开发模式（未打包）下没有 `app-update.yml`，因此直接跳过检查。
 */

/** 自动检查的启动延迟：避免和窗口首屏抢带宽。 */
const AUTO_CHECK_DELAY_MS = 8_000
/** 自动检查的轮询间隔：6 小时。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let status: UpdaterStatus = { state: 'idle', currentVersion: '0.0.0' }
let delayedTimer: NodeJS.Timeout | null = null
let intervalTimer: NodeJS.Timeout | null = null
let started = false

/** 是否处于可更新的运行环境（只有安装版才具备 app-update.yml）。 */
function isEnabled(): boolean {
  return app.isPackaged
}

/** 读取打包时写入的更新源（app-update.yml），把错误提示说得更具体。 */
function describeUpdateSource(): string {
  try {
    const text = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const owner = /^owner:\s*(.+)$/m.exec(text)?.[1]?.trim()
    const repo = /^repo:\s*(.+)$/m.exec(text)?.[1]?.trim()
    if (owner && repo) return `（当前更新仓库：${owner}/${repo}）`
  } catch {
    /* 读不到就忽略 */
  }
  return ''
}

/** 把 electron-updater 抛出的英文错误转成用户能看懂的中文提示。 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/404|not found|cannot find|ENOENT/i.test(raw)) {
    return `未找到发布信息：请确认该仓库已发布 Release（tag 需形如 v1.0.0）${describeUpdateSource()}`
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|getaddrinfo|network|socket hang up/i.test(raw)) {
    return '网络连接失败：请检查网络（含代理/VPN）后重试。'
  }
  if (/403|rate limit|forbidden/i.test(raw)) {
    return '访问 GitHub 被拒绝（可能触发限流），请稍后再试。'
  }
  if (/sha512|checksum|integrity|blockmap/i.test(raw)) {
    return '安装包校验失败：文件可能已损坏，请重试。'
  }
  return `更新失败：${raw}`
}

/** 去掉更新说明里的 HTML 标签，避免在纯文本 UI 中出现裸标签。 */
function plainNotes(notes: UpdateInfo['releaseNotes']): string {
  if (!notes) return ''
  const text = Array.isArray(notes)
    ? notes.map((n) => `${n.version ? `v${n.version} ` : ''}${n.note ?? ''}`).join('\n')
    : notes
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000)
}

/** 更新状态并广播给所有窗口。 */
function push(patch: Partial<UpdaterStatus> & { state?: UpdaterState }): UpdaterStatus {
  status = { ...status, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(IPC.Events.updaterStatus, status)
      } catch {
        /* 窗口正在销毁，忽略 */
      }
    }
  }
  return status
}

/** 注册 electron-updater 事件（只做一次）。 */
function bindEvents(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  // 显式保留差分下载能力（默认即开启，这里写出来表明是有意为之）。
  autoUpdater.disableDifferentialDownload = false
  // 只走正式版 Release，不把 prerelease 当最新版。
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    push({ state: 'checking', error: undefined })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    push({
      state: 'available',
      version: info.version,
      notes: plainNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      error: undefined,
      percent: undefined
    })
  })

  autoUpdater.on('update-not-available', () => {
    push({ state: 'not-available', version: undefined, notes: undefined, percent: undefined, error: undefined })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    push({
      state: 'downloading',
      percent: Math.round(p.percent),
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    push({ state: 'downloaded', version: info.version, percent: 100, error: undefined })
  })

  autoUpdater.on('error', (err: Error) => {
    push({ state: 'error', error: friendlyError(err), percent: undefined })
  })
}

/** 清掉自动检查的定时器。 */
function clearTimers(): void {
  if (delayedTimer) clearTimeout(delayedTimer)
  if (intervalTimer) clearInterval(intervalTimer)
  delayedTimer = null
  intervalTimer = null
}

/**
 * 按设置开关启停「自动检查更新」。
 * 关闭时只停定时器，用户仍可在界面上手动点「检查更新」。
 */
export function applyAutoCheckSetting(enabled: boolean): void {
  clearTimers()
  if (!started || !enabled || !isEnabled()) return

  delayedTimer = setTimeout(() => {
    void checkForUpdates(false)
  }, AUTO_CHECK_DELAY_MS)
  delayedTimer.unref?.()

  intervalTimer = setInterval(() => {
    void checkForUpdates(false)
  }, AUTO_CHECK_INTERVAL_MS)
  intervalTimer.unref?.()
}

/** 初始化更新服务：注册事件 + 按界面设置安排自动检查。 */
export function initUpdater(): void {
  if (started) return
  started = true

  status.currentVersion = app.getVersion()
  bindEvents()

  applyAutoCheckSetting(loadUiSettings().autoCheckUpdate)
}

/** 停止定时器（退出前调用，非必须）。 */
export function disposeUpdater(): void {
  clearTimers()
}

/** 读取当前更新状态。 */
export function getUpdaterStatus(): UpdaterStatus {
  return status
}

/** 检查更新；manual=true 表示用户手动点击（用于错误提示的措辞）。 */
export async function checkForUpdates(manual = false): Promise<UpdaterStatus> {
  if (!isEnabled()) {
    return push({
      state: 'error',
      manual,
      error: '当前为开发模式，自动更新仅在安装版可用。'
    })
  }
  if (status.state === 'checking' || status.state === 'downloading') {
    return status
  }

  push({ state: 'checking', manual, error: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    push({ state: 'error', manual, error: friendlyError(err) })
  }
  return status
}

/** 下载已发现的新版本。 */
export async function downloadUpdate(): Promise<UpdaterStatus> {
  if (!isEnabled()) {
    return push({ state: 'error', error: '当前为开发模式，自动更新仅在安装版可用。' })
  }
  if (status.state === 'downloading' || status.state === 'downloaded') {
    return status
  }
  if (status.state !== 'available') {
    // 还没发现新版本：先查一次
    const checked = await checkForUpdates(false)
    if (checked.state !== 'available') return checked
  }

  try {
    push({ state: 'downloading', percent: 0, error: undefined })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    push({ state: 'error', error: friendlyError(err), percent: undefined })
  }
  return status
}

/** 退出应用并安装已下载的更新（安装完成后自动重启）。 */
export function quitAndInstall(): void {
  if (status.state !== 'downloaded') return
  // isSilent=false 显示安装界面；isForceRunAfter=true 安装后自动拉起应用。
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      push({ state: 'error', error: friendlyError(err) })
    }
  })
}
