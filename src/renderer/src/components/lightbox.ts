import { library } from '../state/aurora'
import { $ } from '../state/store'

type PreviewInfo = {
  id?: string
  model?: unknown
  ts?: unknown
  prompt?: unknown
}

const box = $('#lightbox')
const stage = $('#lightboxStage')
const image = $('#lightboxImg') as HTMLImageElement
const details = $('#lightboxDetails')
const footer = box.querySelector<HTMLElement>('.lightbox-footer')!
const zoomValue = $('#lightboxZoomValue')
let zoom = 1
let x = 0
let y = 0
let pointerId: number | null = null
let pointerX = 0
let pointerY = 0
let openedFrom: HTMLElement | null = null
let requestId = 0

function clampPosition(): void {
  const maxX = Math.max(0, (image.clientWidth * zoom - stage.clientWidth) / 2)
  const maxY = Math.max(0, (image.clientHeight * zoom - stage.clientHeight) / 2)
  x = Math.max(-maxX, Math.min(maxX, x))
  y = Math.max(-maxY, Math.min(maxY, y))
}

function renderView(): void {
  clampPosition()
  image.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${zoom})`
  stage.classList.toggle('can-pan', zoom > 1 && (image.clientWidth * zoom > stage.clientWidth || image.clientHeight * zoom > stage.clientHeight))
  zoomValue.textContent = `${Math.round(zoom * 100)}%`
  ;($('#lightboxZoomOut') as HTMLButtonElement).disabled = zoom <= 1
  ;($('#lightboxZoomIn') as HTMLButtonElement).disabled = zoom >= 8
  footer.style.top = ''
  footer.style.bottom = ''
  if (zoom === 1 && image.complete && image.naturalWidth) {
    const imageBottom = image.getBoundingClientRect().bottom - box.getBoundingClientRect().top
    footer.style.top = `${Math.max(0, Math.min(imageBottom + 12, box.clientHeight - footer.offsetHeight - 16))}px`
    footer.style.bottom = 'auto'
  }
}

function setZoom(next: number, clientX?: number, clientY?: number): void {
  const target = Math.max(1, Math.min(8, next))
  if (target === zoom) return
  const rect = stage.getBoundingClientRect()
  const centerX = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2
  const centerY = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2
  const ratio = target / zoom
  x = centerX - (centerX - x) * ratio
  y = centerY - (centerY - y) * ratio
  zoom = target
  renderView()
}

function addDetail(label: string, value: string): HTMLElement {
  const item = document.createElement('span')
  item.className = 'lightbox-detail'
  const name = document.createElement('span')
  name.className = 'lightbox-detail-label'
  name.textContent = label
  const content = document.createElement('span')
  content.className = 'lightbox-detail-value'
  content.textContent = value
  item.append(name, content)
  details.appendChild(item)
  return content
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function openLightbox(src: string, transparent = false, info: PreviewInfo = {}): void {
  if (!src) return
  const currentRequest = ++requestId
  if (pointerId !== null && stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId)
  stage.classList.remove('panning')
  openedFrom = document.activeElement instanceof HTMLElement && !box.contains(document.activeElement) ? document.activeElement : openedFrom
  box.classList.toggle('transparent-image', transparent)
  box.classList.add('open')
  zoom = 1
  x = 0
  y = 0
  pointerId = null
  image.onload = () => {
    if (currentRequest !== requestId) return
    resolution.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`
    renderView()
  }
  image.onerror = () => {
    if (currentRequest !== requestId) return
    resolution.textContent = '无法读取图片'
  }
  details.replaceChildren()
  const resolution = addDetail('分辨率', '加载中…')
  const fileSize = addDetail('文件大小', info.id ? '读取中…' : '未记录')
  const date = typeof info.ts === 'number' && Number.isFinite(info.ts) ? new Date(info.ts) : null
  addDetail('生成时间', date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN') : '未记录')
  addDetail('模型', typeof info.model === 'string' && info.model.trim() ? info.model : '未记录')
  if (typeof info.prompt === 'string' && info.prompt.trim()) {
    const prompt = addDetail('提示词', info.prompt)
    prompt.classList.add('lightbox-prompt')
    prompt.title = info.prompt
  }
  image.src = src
  renderView()
  box.focus()
  if (info.id) {
    void library.fileInfo(info.id).then((result) => {
      if (currentRequest === requestId) fileSize.textContent = result.ok && typeof result.bytes === 'number' ? formatBytes(result.bytes) : '未记录'
    }).catch(() => {
      if (currentRequest === requestId) fileSize.textContent = '未记录'
    })
  }
}

export function closeLightbox(): void {
  if (!box.classList.contains('open')) return
  requestId++
  box.classList.remove('open', 'transparent-image')
  image.onload = null
  image.onerror = null
  image.removeAttribute('src')
  if (pointerId !== null) {
    if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId)
    pointerId = null
  }
  stage.classList.remove('panning', 'can-pan')
  if (openedFrom?.isConnected) openedFrom.focus()
  openedFrom = null
}

$('#lightboxClose').addEventListener('click', closeLightbox)
$('#lightboxZoomIn').addEventListener('click', () => setZoom(zoom * 1.25))
$('#lightboxZoomOut').addEventListener('click', () => setZoom(zoom / 1.25))
$('#lightboxReset').addEventListener('click', () => {
  zoom = 1
  x = 0
  y = 0
  renderView()
})
box.addEventListener('click', (event) => {
  if (event.target === box) closeLightbox()
})
stage.addEventListener('wheel', (event) => {
  event.preventDefault()
  setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY)
}, { passive: false })
stage.addEventListener('dblclick', (event) => {
  setZoom(zoom > 1 ? 1 : 2, event.clientX, event.clientY)
})
stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || zoom <= 1 || !stage.classList.contains('can-pan')) return
  pointerId = event.pointerId
  pointerX = event.clientX
  pointerY = event.clientY
  stage.setPointerCapture(event.pointerId)
  stage.classList.add('panning')
})
stage.addEventListener('pointermove', (event) => {
  if (pointerId !== event.pointerId) return
  x += event.clientX - pointerX
  y += event.clientY - pointerY
  pointerX = event.clientX
  pointerY = event.clientY
  renderView()
})
function endPan(event: PointerEvent): void {
  if (pointerId !== event.pointerId) return
  pointerId = null
  stage.classList.remove('panning')
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
}
stage.addEventListener('pointerup', endPan)
stage.addEventListener('pointercancel', endPan)
window.addEventListener('resize', () => {
  if (box.classList.contains('open')) renderView()
})
box.addEventListener('keydown', (event) => {
  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    setZoom(zoom * 1.25)
  } else if (event.key === '-') {
    event.preventDefault()
    setZoom(zoom / 1.25)
  } else if (event.key === '0') {
    event.preventDefault()
    zoom = 1
    x = 0
    y = 0
    renderView()
  } else if (event.key === 'Tab') {
    const controls = Array.from(box.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
})
