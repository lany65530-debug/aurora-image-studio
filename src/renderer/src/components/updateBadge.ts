/**
 * 渲染层 · 标题栏自动更新入口
 * ------------------------------------------------------------
 * 订阅主进程推送的 UpdaterStatus，把状态映射成按钮文案 / 颜色：
 *   idle / not-available → 检查更新
 *   checking             → 检查中…
 *   available            → 发现 vX.Y.Z（点击 → 确认后下载）
 *   downloading          → 下载中 N%（底部进度条）
 *   downloaded           → 重启以更新（点击 → 确认后重启安装）
 *   error                → 更新失败（点击 → 提示原因并重试）
 */
import { updater } from '../state/aurora'
import { toast } from './toast'
import { confirmDialog } from './confirm'
import type { UpdaterStatus } from '../../../shared/types'

/** 开发模式下主进程会返回这句提示，UI 上不当作红色故障处理。 */
const DEV_NOTICE = '开发模式'

function isDevNotice(s: UpdaterStatus): boolean {
  return s.state === 'error' && String(s.error || '').includes(DEV_NOTICE)
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

export function initUpdateBadge(): void {
  const badge = document.getElementById('updateBadge') as HTMLButtonElement | null
  const textEl = document.getElementById('updateBadgeText')
  const progressEl = document.getElementById('updateBadgeProgress')
  if (!badge || !textEl || !progressEl) return

  let current: UpdaterStatus = { state: 'idle', currentVersion: '' }
  let notifiedVersion = ''
  let notifiedLatest = false
  let busy = false

  const render = (s: UpdaterStatus): void => {
    current = s
    // 开发模式提示、以及后台自动检查的失败，都不在标题栏显示为红色故障（保持中性文案）
    const dev = isDevNotice(s)
    const silentError = s.state === 'error' && !s.manual
    const state = dev || silentError ? 'idle' : s.state
    badge.dataset.state = state

    let text = '检查更新'
    let title = silentError ? String(s.error || '') : '检查更新'
    switch (state) {
      case 'checking':
        text = '检查中…'
        title = '正在检查新版本'
        break
      case 'available':
        text = `发现 v${s.version}`
        title = s.notes ? `发现新版本 v${s.version}\n\n${s.notes}` : `发现新版本 v${s.version}`
        break
      case 'downloading': {
        const percent = Math.min(100, Math.max(0, Math.round(s.percent ?? 0)))
        const size = formatSize(s.total)
        text = `下载中 ${percent}%`
        title = `正在下载 v${s.version}${size ? `（${size}）` : ''}`
        break
      }
      case 'downloaded':
        text = '重启以更新'
        title = `v${s.version} 已下载，点击重启并安装`
        break
      case 'error':
        text = '更新失败'
        title = s.error || '更新失败，点击重试'
        break
      default:
        break
    }

    textEl.textContent = text
    badge.title = title
    badge.disabled = state === 'checking' || state === 'downloading'

    const ratio = state === 'downloading' ? Math.min(100, Math.max(0, s.percent ?? 0)) / 100 : state === 'downloaded' ? 1 : 0
    progressEl.style.transform = `scaleX(${ratio})`

    // 发现新版本时提示一次
    if (state === 'available' && s.version && s.version !== notifiedVersion) {
      notifiedVersion = s.version
      toast(`发现新版本 v${s.version}，点击右上角「发现 v${s.version}」即可更新`, 'info', 6000)
    }
    // 用户手动检查、但已经是最新版：必须给个反馈，否则像没反应
    if (state === 'checking') notifiedLatest = false
    if (state === 'not-available' && s.manual && !notifiedLatest) {
      notifiedLatest = true
      toast(`已经是最新版本 v${s.currentVersion}`, 'success')
    }
    // 开发模式下手动点击：给出明确解释
    if (dev && s.manual) {
      toast('当前是开发模式，打包安装后才会检查更新。', 'info', 4000)
    }
  }

  const run = async (fn: () => Promise<UpdaterStatus>): Promise<void> => {
    if (busy) return
    busy = true
    try {
      render(await fn())
    } catch {
      toast('更新操作失败，请稍后重试', 'error')
    } finally {
      busy = false
    }
  }

  badge.addEventListener('click', () => {
    const s = current

    if (s.state === 'available') {
      const lines = [
        `当前版本：v${s.currentVersion}`,
        `最新版本：v${s.version}`,
        s.notes ? `\n更新内容：\n${s.notes}` : ''
      ].filter(Boolean)
      void confirmDialog('发现新版本', lines.join('\n'), '立即下载').then((ok) => {
        if (ok) void run(() => updater.download())
      })
      return
    }

    if (s.state === 'downloaded') {
      void confirmDialog('更新已就绪', `v${s.version} 已下载完成，现在重启并安装吗？`, '重启更新').then((ok) => {
        if (ok) updater.install()
      })
      return
    }

    if (s.state === 'error' && s.error && !isDevNotice(s)) {
      toast(s.error, 'error', 6000)
    }
    void run(() => updater.check())
  })

  updater.onStatus(render)
  void updater
    .getStatus()
    .then(render)
    .catch(() => {
      /* 状态查询失败时保持默认文案 */
    })
}
