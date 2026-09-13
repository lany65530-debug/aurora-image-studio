import fs from 'fs'
import { uiSettingsFile } from '../config'
import { defaultUiSettings, normalizeUiSettings, type UiSettings } from '../../shared/types'

/**
 * 界面设置服务（主题 / 字号 / 密度 / 动效）。
 * ------------------------------------------------------------
 * 单独存 ui-settings.json，与接口配置（settings.json）解耦：
 * 用户清空接口配置时不会连带把主题一起重置。
 * 归一化规则与渲染层共用 shared/types 中的 normalizeUiSettings，
 * 避免两处白名单不一致。
 */

/** 读取界面设置（文件缺失 / 损坏时回退默认）。 */
export function loadUiSettings(): UiSettings {
  try {
    const p = uiSettingsFile()
    if (fs.existsSync(p)) {
      return normalizeUiSettings(JSON.parse(fs.readFileSync(p, 'utf-8')))
    }
  } catch (e) {
    console.error('load ui settings failed', e)
  }
  return defaultUiSettings()
}

/** 保存界面设置（先归一化再落盘）。 */
export function saveUiSettings(settings: UiSettings): boolean {
  try {
    fs.writeFileSync(uiSettingsFile(), JSON.stringify(normalizeUiSettings(settings), null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('save ui settings failed', e)
    return false
  }
}

/** 合并增量并保存（IPC ui:save 使用）。 */
export function mergeAndSaveUiSettings(patch: Partial<UiSettings>): boolean {
  const merged = normalizeUiSettings(Object.assign({}, loadUiSettings(), patch || {}))
  return saveUiSettings(merged)
}
