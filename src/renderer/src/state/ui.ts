/**
 * 渲染层 · 界面设置（主题 / 字号 / 密度 / 动效）
 * ------------------------------------------------------------
 * 唯一职责：把 UiSettings 落到 <html> 的 data-* 与 CSS 变量上。
 * 所有主题差异都写在 styles/base/themes.css 里，这里不出现任何颜色/字体常量，
 * 因此「新增一套主题」= 加一个 CSS 块 + 在 THEME_META 里登记，不用改逻辑。
 *
 * 持久化：
 *   - 主进程 ui-settings.json 为准（跨清缓存可用）
 *   - 同时镜像一份到 localStorage，用于「首帧就应用主题」，避免启动白闪
 */
import { ui as uiApi } from './aurora'
import {
  DENSITY_SCALE,
  FONT_SCALE_PX,
  defaultUiSettings,
  normalizeUiSettings,
  type UiSettings
} from '../../../shared/types'

const CACHE_KEY = 'aurora_ui_v1'

/** 当前界面设置（单一数据源，视图层只读）。 */
export const uiState: { settings: UiSettings } = { settings: defaultUiSettings() }

/** 把设置写到文档根节点：主题切换的唯一入口。 */
export function applyUiSettings(settings: UiSettings): void {
  uiState.settings = settings
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.dataset.density = settings.density
  root.dataset.motion = settings.reduceMotion ? 'off' : 'on'
  root.style.setProperty('--font-size-base', FONT_SCALE_PX[settings.fontScale])
  root.style.setProperty('--space-scale', DENSITY_SCALE[settings.density])
}

function writeCache(settings: UiSettings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings))
  } catch {
    /* 缓存失败不影响本次会话 */
  }
}

/** 启动首帧：先用缓存把主题贴上，避免闪一下默认样式。 */
export function applyCachedUi(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    applyUiSettings(raw ? normalizeUiSettings(JSON.parse(raw)) : defaultUiSettings())
  } catch {
    applyUiSettings(defaultUiSettings())
  }
}

/** 从主进程读取权威设置并应用（应在首帧后尽早调用）。 */
export async function initUiSettings(): Promise<void> {
  try {
    const settings = normalizeUiSettings(await uiApi.get())
    applyUiSettings(settings)
    writeCache(settings)
  } catch {
    /* 读不到就沿用缓存值 */
  }
}

/** 增量修改：立即生效 → 写缓存 → 落盘。 */
export async function patchUiSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
  const next = normalizeUiSettings({ ...uiState.settings, ...patch })
  applyUiSettings(next)
  writeCache(next)
  try {
    await uiApi.save(patch)
  } catch {
    /* 落盘失败不回滚：至少本次会话已生效 */
  }
  return next
}

/** 恢复默认界面设置。 */
export function resetUiSettings(): Promise<UiSettings> {
  return patchUiSettings(defaultUiSettings())
}
