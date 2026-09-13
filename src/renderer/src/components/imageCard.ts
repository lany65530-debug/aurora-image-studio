/**
 * 渲染层 · 图片卡片（结果区 / 作品集共用）
 * 引用提示词与删除后处理通过回调解耦，避免与 workspaces 层形成循环依赖。
 */
import { library, shell } from '../state/aurora'
import { state } from '../state/store'
import { toast } from './toast'
import { openLightbox } from './lightbox'
import { iconBtn } from './iconBtn'

export interface CardOptions {
  deletable?: boolean
  fromResult?: boolean
  /** 点击“一键引用提示词”时的处理（默认提示未存储）。 */
  onQuote?: (prompt: unknown) => void
  /** 删除完成（DOM 已移除）后调用，供调用方处理空态 / 重渲染。 */
  onDeleted?: (entry: any) => void
}

/** 根据 size 字符串推断卡片形状 class。 */
export function sizeToShape(size: unknown): string {
  if (!size || size === 'auto') return ''
  const s = String(size).trim()
  const parts = s.includes(':') ? s.split(':') : s.split('x')
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!w || !h) return ''
  if (w > h) return 'landscape'
  if (h > w) return 'portrait'
  return ''
}

/* ===== 网格缩略图懒加载 =====
   卡片只需要几百像素的展示图，直接让渲染进程解码 2K/4K 原图会明显卡顿。
   这里只把「滚入视野附近」的卡片交给主进程生成缩略图，原图仅用于灯箱预览。 */
interface CardImageInfo {
  fallback: string
  filePath: string
}

const cardImageInfo = new WeakMap<HTMLImageElement, CardImageInfo>()
const loadedImages = new WeakSet<HTMLImageElement>()
let thumbObserver: IntersectionObserver | null = null

function getThumbObserver(): IntersectionObserver | null {
  if (thumbObserver || typeof IntersectionObserver === 'undefined') return thumbObserver
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        thumbObserver?.unobserve(entry.target)
        void loadCardImage(entry.target as HTMLImageElement)
      }
    },
    // 提前约一屏开始取缩略图，滚动到时通常已经就绪
    { rootMargin: '600px 0px' }
  )
  return thumbObserver
}

async function loadCardImage(image: HTMLImageElement): Promise<void> {
  if (loadedImages.has(image)) return
  loadedImages.add(image)
  const info = cardImageInfo.get(image)
  if (!info) return
  if (info.filePath) {
    try {
      const res = await library.thumb({ path: info.filePath, size: 420 })
      if (res && res.ok && res.dataUrl) {
        image.src = res.dataUrl
        return
      }
    } catch {
      /* 缩略图失败时回退原图 */
    }
  }
  if (info.fallback) image.src = info.fallback
}

function scheduleCardImage(image: HTMLImageElement): void {
  const observer = getThumbObserver()
  if (!observer) {
    void loadCardImage(image)
    return
  }
  observer.observe(image)
}

export function buildCard(entry: any, shapeClass: string, index: number, opts: CardOptions = {}): HTMLDivElement {
  const src = entry.fileUrl || entry.remoteUrl
  const card = document.createElement('div')
  card.className = 'img-card ' + shapeClass
  // 只给前几屏卡片做入场动画；后面的卡片延迟归零，避免大量动画同时排队
  card.style.animationDelay = index < 12 ? `${index * 0.025}s` : '0s'

  const image = document.createElement('img')
  image.alt = entry.prompt || ''
  image.loading = 'lazy'
  image.decoding = 'async'
  image.draggable = false
  cardImageInfo.set(image, { fallback: src || '', filePath: entry.filePath ? String(entry.filePath) : '' })
  image.addEventListener('click', () => openLightbox(src))

  const overlay = document.createElement('div')
  overlay.className = 'img-overlay'

  const meta = document.createElement('div')
  meta.className = 'img-meta'
  meta.textContent = entry.prompt || ''

  const actions = document.createElement('div')
  actions.className = 'img-actions'

  const zoom = iconBtn(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4M11 8v6M8 11h6" stroke-linecap="round"/></svg>',
    () => openLightbox(src)
  )
  // 一键引用提示词
  const quote = iconBtn(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 5H6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2c0 2-1 3-3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 5h-2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2c0 2-1 3-3 3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    () => {
      if (!entry.prompt) {
        toast('该图片没有存储提示词', 'error')
        return
      }
      if (opts.onQuote) opts.onQuote(entry.prompt)
    }
  )
  quote.title = '一键引用提示词'
  const folder = iconBtn(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke-linejoin="round"/></svg>',
    () => {
      if (entry.filePath) void shell.openPath(entry.filePath)
      else toast('该图片没有本地文件', 'error')
    }
  )
  actions.appendChild(zoom)
  actions.appendChild(quote)
  actions.appendChild(folder)

  if (opts.deletable || opts.fromResult) {
    const del = iconBtn(
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      async () => {
        await library.delete({ id: entry.id, deleteFile: true })
        // 局部移除当前卡片：避免删除后整列重建导致所有图片重载
        state.gallery = state.gallery.filter((x) => x.id !== entry.id)
        card.classList.add('img-card-removing')
        setTimeout(() => {
          card.remove()
          if (opts.onDeleted) opts.onDeleted(entry)
        }, 180)
        toast('已删除', 'success')
      }
    )
    del.classList.add('danger')
    actions.appendChild(del)
  }

  overlay.appendChild(meta)
  overlay.appendChild(actions)
  card.appendChild(image)
  card.appendChild(overlay)
  scheduleCardImage(image)
  // 下载失败仅保留远程链接的图片，加角标明确提示“未保存本地”
  if (!entry.filePath && (entry.remoteUrl || (entry.fileUrl && /^https?:\/\//.test(entry.fileUrl)))) {
    const badge = document.createElement('span')
    badge.className = 'remote-badge'
    badge.textContent = '未保存本地'
    card.appendChild(badge)
  }
  return card
}