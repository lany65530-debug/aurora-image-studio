import fs from 'fs'
import { libraryFile } from '../config'

/** 图片库服务：loadLibrary / saveLibrary（原子写） / enqueueLibrary（串行化“读-改-写”）。 */

export interface LibraryItem {
  [key: string]: unknown
}

export function loadLibrary(): LibraryItem[] {
  const p = libraryFile()
  try {
    if (fs.existsSync(p)) {
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf-8'))
        return Array.isArray(arr) ? (arr as LibraryItem[]) : []
      } catch (e) {
        // 主文件损坏（半写入/崩溃残留）：尝试从备份恢复，避免整库被判空
        console.error('parse library failed, trying backup:', (e as Error).message)
        try {
          const arr = JSON.parse(fs.readFileSync(p + '.bak', 'utf-8'))
          if (Array.isArray(arr)) {
            fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf-8') // 用备份回填主文件
            return arr as LibraryItem[]
          }
        } catch (e2) {
          console.error('restore library from backup failed', (e2 as Error).message)
        }
      }
    }
  } catch (e) {
    console.error('load library failed', e)
  }
  return []
}

// 原子写：先写临时文件再 rename 覆盖，避免写入中途崩溃破坏 library.json
export function saveLibrary(items: LibraryItem[]): boolean {
  try {
    const data = JSON.stringify(items, null, 2)
    const p = libraryFile()
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, data, 'utf-8')
    fs.renameSync(tmp, p)
    try {
      fs.copyFileSync(p, p + '.bak')
    } catch (e) {
      /* 备份尽力而为 */
    }
    return true
  } catch (e) {
    console.error('save library failed', e)
    return false
  }
}

// 串行化所有“读-改-写”库操作，避免并发生成入库相互覆盖（根因1）
let libraryQueue: Promise<unknown> = Promise.resolve()

export function enqueueLibrary(mutate: (lib: LibraryItem[]) => void): Promise<LibraryItem[]> {
  const run = libraryQueue.then(() => {
    const lib = loadLibrary()
    mutate(lib)
    saveLibrary(lib)
    return lib
  })
  libraryQueue = run.catch(() => {})
  return run
}