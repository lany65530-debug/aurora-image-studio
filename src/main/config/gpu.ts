import { app } from 'electron'

/**
 * 主进程 · GPU 硬件加速开关
 * ------------------------------------------------------------
 * Electron 默认就会使用 GPU，但部分机器会因驱动被 Chromium 列入黑名单而降级为软件渲染。
 * 这里在 app ready 之前显式开启光栅化 / 零拷贝，并忽略 GPU 黑名单，
 * 让图片解码、合成与滚动走硬件加速。
 *
 * 如需排查显卡兼容问题，设置环境变量 AURORA_DISABLE_GPU=1 即可恢复默认策略。
 */

export const FORCED_GPU_FLAGS = [
  'enable-gpu-rasterization',
  'enable-zero-copy',
  'ignore-gpu-blocklist'
] as const

let forced = false

/** 必须在 app ready 之前调用。返回是否成功注入开关。 */
export function setupGpuAcceleration(): boolean {
  if (process.env.AURORA_DISABLE_GPU === '1') {
    forced = false
    return false
  }
  for (const flag of FORCED_GPU_FLAGS) {
    app.commandLine.appendSwitch(flag)
  }
  forced = true
  return true
}

export function gpuFlagsForced(): boolean {
  return forced
}
