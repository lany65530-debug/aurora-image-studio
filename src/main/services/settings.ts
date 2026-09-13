import fs from 'fs'
import { settingsFile, defaultSaveDir } from '../config'
import { defaultSettings, type AppSettings } from '../config/defaults'

/** 全局设置服务：读写 settings.json，并在保存时做默认值归一。 */

export function loadSettings(): AppSettings {
  try {
    const p = settingsFile()
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf-8')) as AppSettings
      if (!s.saveDir) s.saveDir = defaultSaveDir()
      if (!s.provider) s.provider = null
      if (!s.chat || typeof s.chat !== 'object') s.chat = {}
      // 接口地址一律默认留空，由用户自行填写
      return s
    }
  } catch (e) {
    console.error('load settings failed', e)
  }
  return defaultSettings()
}

export function saveSettings(settings: AppSettings): boolean {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('save settings failed', e)
    return false
  }
}

/** 读取当前设置并合并传入的增量（IPC settings:save 使用）。返回是否保存成功。 */
export function mergeAndSaveSettings(patch: Partial<AppSettings>): boolean {
  const prev = loadSettings()
  const merged = Object.assign({}, prev, patch)
  if (!merged.saveDir) merged.saveDir = prev.saveDir || defaultSaveDir()
  if (!merged.chat || typeof merged.chat !== 'object') merged.chat = prev.chat || {}
  return saveSettings(merged)
}