import { app } from 'electron'
import { join } from 'path'

/** 极光工作室：应用内所有文件路径的集中定义（config 层，纯函数，无副作用）。 */

/** 应用数据根目录（userData），随 Electron 自动创建。 */
export const userDataPath = (): string => app.getPath('userData')

/** 全局设置文件。 */
export const settingsFile = (): string => join(userDataPath(), 'settings.json')

/** 图片库条目文件。 */
export const libraryFile = (): string => join(userDataPath(), 'library.json')

/** 聊天会话文件（文件名与旧版一致，沿用既有用户数据）。 */
export const chatSessionsFile = (): string => join(userDataPath(), 'chat_sessions.json')

/** 小说数据目录（内置每书一文件）。 */
export const novelsDir = (): string => join(userDataPath(), 'novels')

/** 默认图片保存目录（图片工作区未指定时的回退；目录名与旧版一致，沿用既有用户数据）。 */
export const defaultSaveDir = (): string => join(app.getPath('pictures'), 'Aurora Image Studio')

/** 打包后的静态资源目录（build/icon.ico 等）。 */
export const bundledResources = (): string =>
  app.isPackaged ? join(process.resourcesPath) : join(app.getAppPath(), 'resources')