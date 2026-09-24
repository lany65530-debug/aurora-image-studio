/**
 * 渲染层 · 应用设置弹窗
 * ------------------------------------------------------------
 * 承载「主应用级」的可配置项（与「工作区设置」wsSettings 区分：
 * 那边是单个工作区的接口/模型/目录，这边是整个应用的界面与更新行为）。
 *
 * 内容：
 *   · 主题     —— 六套设计语言，点击即时生效（无需确认）
 *   · 界面     —— 字号 / 密度 / 减少动效
 *   · 更新     —— 自动检查开关 + 版本信息 + 手动检查
 * 复用 overlay 模块统一处理遮罩点击与 Escape 关闭。
 */
import { $ } from '../state/store'
import { patchUiSettings, resetUiSettings, uiState } from '../state/ui'
import { app as appApi, updater } from '../state/aurora'
import { registerOverlay, openOverlay, closeOverlay } from './overlay'
import { toast } from '../components/toast'
import {
  FONT_SCALE_PX,
  THEME_META,
  UI_DENSITIES,
  UI_FONT_SCALES,
  type UiDensity,
  type UiFontScale,
  type UiSettings
} from '../../../shared/types'

const FONT_LABELS: Record<UiFontScale, string> = { sm: '小', md: '标准', lg: '大', xl: '特大' }
const DENSITY_LABELS: Record<UiDensity, string> = { compact: '紧凑', cozy: '舒适', roomy: '宽松' }

let initialised = false

/* ---------- 片段渲染 ---------- */

/** 主题卡片：用四个代表色拼一张「该主题长什么样」的缩略图。 */
function themeCard(meta: (typeof THEME_META)[number], active: boolean): string {
  const [bg, surface, accent, extra] = meta.swatch
  return `
    <button class="theme-card${active ? ' active' : ''}" type="button" data-theme-id="${meta.id}">
      <span class="theme-preview" style="background:${bg}">
        <i class="tp-dot" style="background:${accent}"></i>
        <i class="tp-bar" style="background:${surface};flex:0 0 34%"></i>
        <i class="tp-bar" style="background:${accent};flex:0 0 16%"></i>
        <i class="tp-bar" style="background:${extra};flex:1"></i>
      </span>
      <span class="theme-card-name">${meta.name}</span>
      <span class="theme-card-desc">${meta.desc}</span>
    </button>`
}

/** 分段选择器一行。 */
function segRow(
  id: string,
  label: string,
  hint: string,
  options: ReadonlyArray<{ value: string; text: string }>,
  current: string
): string {
  const btns = options
    .map(
      (o) =>
        `<button type="button" data-seg="${id}" data-value="${o.value}"${
          o.value === current ? ' class="active"' : ''
        }>${o.text}</button>`
    )
    .join('')
  return `
    <div class="seg-row">
      <div class="seg-row-main">
        <div class="seg-label">${label}</div>
        <div class="seg-hint">${hint}</div>
      </div>
      <div class="seg-control" role="group" aria-label="${label}">${btns}</div>
    </div>`
}

/** 开关一行。 */
function switchRow(id: string, label: string, hint: string, on: boolean): string {
  return `
    <div class="seg-row">
      <div class="seg-row-main">
        <div class="seg-label">${label}</div>
        <div class="seg-hint">${hint}</div>
      </div>
      <button class="switch${on ? ' on' : ''}" type="button" role="switch" aria-checked="${on}" data-switch="${id}" aria-label="${label}"></button>
    </div>`
}

function renderBody(): void {
  const s = uiState.settings
  const body = $('#appSettingsBody')
  if (!body) return

  body.innerHTML = `
    <section class="settings-section">
      <div class="settings-section-title">主题 <small>六套主题 · 点击即时生效</small></div>
      <div class="theme-grid">${THEME_META.map((m) => themeCard(m, m.id === s.theme)).join('')}</div>
    </section>

    <section class="settings-section">
      <div class="settings-section-title">界面</div>
      ${segRow(
        'fontScale',
        '界面字号',
        `整体缩放正文与控件文字（当前基准 ${FONT_SCALE_PX[s.fontScale]}）`,
        UI_FONT_SCALES.map((v) => ({ value: v, text: FONT_LABELS[v] })),
        s.fontScale
      )}
      ${segRow(
        'density',
        '界面密度',
        '紧凑省空间 / 宽松更透气，影响主区与侧栏留白',
        UI_DENSITIES.map((v) => ({ value: v, text: DENSITY_LABELS[v] })),
        s.density
      )}
      ${switchRow('reduceMotion', '减少动画', '关闭过渡与入场动画，界面响应更干脆', s.reduceMotion)}
    </section>

    <section class="settings-section">
      <div class="settings-section-title">更新</div>
      ${switchRow('autoCheckUpdate', '自动检查更新', '启动后静默检查一次，之后每 6 小时一次', s.autoCheckUpdate)}
      <div class="about-row">
        <div class="about-meta">
          <div class="about-version" id="aboutVersion">极光工作室</div>
          <div class="about-env" id="aboutEnv">正在读取运行环境…</div>
        </div>
        <div class="about-actions">
          <button class="ghost-btn small" id="appSettingsReset" type="button">恢复默认</button>
          <button class="ghost-btn small" id="appSettingsCheckUpdate" type="button">检查更新</button>
        </div>
      </div>
    </section>`

  void fillAbout()
}

async function fillAbout(): Promise<void> {
  try {
    const info = await appApi.getInfo()
    const v = document.getElementById('aboutVersion')
    const e = document.getElementById('aboutEnv')
    if (v) v.textContent = `极光工作室 v${info.version}`
    if (e) e.textContent = `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`
  } catch {
    /* 拿不到就保持占位文案 */
  }
}

/* ---------- 交互 ---------- */

async function onBodyClick(e: MouseEvent): Promise<void> {
  const el = e.target as HTMLElement

  const themeBtn = el.closest<HTMLElement>('[data-theme-id]')
  if (themeBtn) {
    const theme = themeBtn.dataset.themeId as UiSettings['theme']
    if (theme !== uiState.settings.theme) {
      await patchUiSettings({ theme })
      const meta = THEME_META.find((m) => m.id === theme)
      toast(`已切换到「${meta?.name ?? theme}」主题`, 'success')
    }
    $('#appSettingsBody')
      ?.querySelectorAll('.theme-card')
      .forEach((c) => c.classList.toggle('active', (c as HTMLElement).dataset.themeId === theme))
    return
  }

  const segBtn = el.closest<HTMLElement>('[data-seg]')
  if (segBtn) {
    const key = segBtn.dataset.seg as 'fontScale' | 'density'
    const value = segBtn.dataset.value as UiFontScale & UiDensity
    if (value !== uiState.settings[key]) {
      await patchUiSettings({ [key]: value } as Partial<UiSettings>)
      renderBody()
    }
    return
  }

  const sw = el.closest<HTMLElement>('[data-switch]')
  if (sw) {
    const key = sw.dataset.switch as 'reduceMotion' | 'autoCheckUpdate'
    await patchUiSettings({ [key]: !uiState.settings[key] })
    renderBody()
    return
  }

  if (el.closest('#appSettingsReset')) {
    await resetUiSettings()
    renderBody()
    toast('已恢复默认界面设置', 'success')
    return
  }

  if (el.closest('#appSettingsCheckUpdate')) {
    const btn = el.closest<HTMLButtonElement>('#appSettingsCheckUpdate')
    if (btn) {
      btn.disabled = true
      btn.textContent = '检查中…'
    }
    try {
      const status = await updater.check()
      // 有新版本 / 已是最新的提示由标题栏更新徽标统一给出，这里只处理失败
      if (status.state === 'error' && status.error) toast(status.error, 'error', 6000)
    } catch {
      toast('检查更新失败，请稍后重试', 'error')
    } finally {
      const b = document.getElementById('appSettingsCheckUpdate') as HTMLButtonElement | null
      if (b) {
        b.disabled = false
        b.textContent = '检查更新'
      }
    }
  }
}

/* ---------- 对外 ---------- */

/** 打开应用设置弹窗。 */
export function openAppSettings(): void {
  const el = $('#appSettingsModal')
  if (!el) return
  renderBody()
  openOverlay(el)
}

/** 装配设置弹窗（幂等）。 */
export function initAppSettings(): void {
  if (initialised) return
  initialised = true

  const modal = $('#appSettingsModal')
  const entry = $('#settingsEntryBtn')
  if (modal) {
    registerOverlay(modal)
    $('#appSettingsBody')?.addEventListener('click', (e) => void onBodyClick(e as MouseEvent))
    $('#appSettingsClose')?.addEventListener('click', () => closeOverlay(modal))
  }
  entry?.addEventListener('click', () => openAppSettings())
}
