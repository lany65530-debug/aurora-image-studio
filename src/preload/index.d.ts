import type { AuroraApi } from '../shared/aurora-api'

declare global {
  interface Window {
    /** 极光工作室：预加载层暴露的类型化 API 面。 */
    aurora: AuroraApi
  }
}

export {}