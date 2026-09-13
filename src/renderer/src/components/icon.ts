/**
 * 渲染层 · 工作区图标工具（压缩到 64px，避免撑爆 localStorage）
 */
import { toast } from './toast'

/** 读取并压缩图片文件为 64px 内的 dataURL。 */
export function readIconFile(file: File, cb: (dataUrl: string) => void): void {
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件', 'error')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        const s = Math.min(64 / img.width, 64 / img.height, 1)
        c.width = Math.max(1, Math.round(img.width * s))
        c.height = Math.max(1, Math.round(img.height * s))
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        cb(c.toDataURL('image/png'))
      } catch {
        cb(reader.result as string) // 兜底：原始 dataUrl
      }
    }
    img.onerror = () => cb(reader.result as string)
    img.src = reader.result as string
  }
  reader.readAsDataURL(file)
}

/** 用名称首字母 / 图标渲染头像元素。 */
export function renderIconPreview(el: HTMLElement | null, name: string, icon: string | null): void {
  if (!el) return
  if (icon) {
    el.innerHTML = `<img src="${icon}" alt="" />`
  } else {
    el.textContent = (String(name || '').trim()[0] || '?').toUpperCase()
  }
}