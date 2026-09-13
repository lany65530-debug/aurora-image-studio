import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppInfo, GpuStatus } from '../../shared/types'
import { FORCED_GPU_FLAGS, gpuFlagsForced } from '../config/gpu'

/** 应用级 IPC：运行环境信息 + GPU 硬件加速状态。 */
export function registerAppIpc(): void {
  ipcMain.handle(IPC.App.info, (): AppInfo => ({
    version: String(app.getVersion()),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform
  }))
  ipcMain.handle(IPC.App.gpuStatus, (): GpuStatus => {
    const featureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>
    const compositing = String(featureStatus?.gpu_compositing || '')
    return {
      hardwareAcceleration: compositing.includes('enabled'),
      featureStatus,
      forcedFlags: gpuFlagsForced() ? [...FORCED_GPU_FLAGS] : []
    }
  })
}