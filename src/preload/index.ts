import { contextBridge } from 'electron'
import { api } from './api'

/** 通过 contextBridge 向渲染进程暴露类型化的 window.aurora 面。 */
contextBridge.exposeInMainWorld('aurora', api)