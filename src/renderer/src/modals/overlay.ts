/**
 * 渲染层 · 弹窗（Overlay）通用
 * ------------------------------------------------------------
 * 统一弹窗开关、遮罩点击外关闭，以及全局 Escape 关闭弹窗。
 * 各 modal 模块通过 registerOverlay 登记其遮罩元素。
 */
import { closeConfirmEsc } from '../components/confirm'
import { closeLightbox } from '../components/lightbox'

const registered: HTMLElement[] = []
const openStack: HTMLElement[] = []
const previousFocus = new WeakMap<HTMLElement, HTMLElement>()

function focusable(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, a[href], [tabindex]'))
    .filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length > 0)
}

/** 登记一个遮罩弹窗（添加点击遮罩关闭）。 */
export function registerOverlay(el: HTMLElement): void {
  if (registered.includes(el)) return
  registered.push(el)
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) closeOverlay(el)
  })
}

export function openOverlay(el: HTMLElement): void {
  if (el.classList.contains('open')) return
  if (document.activeElement instanceof HTMLElement) previousFocus.set(el, document.activeElement)
  openStack.push(el)
  el.classList.add('open')
  const target = el.querySelector<HTMLElement>('.ws-name-field input') || focusable(el)[0] || el
  target.focus()
}

export function closeOverlay(el: HTMLElement): void {
  if (!el.classList.contains('open')) return
  const wasTop = openStack[openStack.length - 1] === el
  const index = openStack.indexOf(el)
  if (index >= 0) openStack.splice(index, 1)
  el.classList.remove('open')
  if (wasTop) {
    const previous = previousFocus.get(el)
    const top = openStack[openStack.length - 1]
    if (previous?.isConnected && previous.getClientRects().length && (!top || top.contains(previous))) previous.focus()
    else if (top) (focusable(top)[0] || top).focus()
    else document.querySelector<HTMLElement>('#createWsSettingsBtn')?.focus()
  }
  previousFocus.delete(el)
}

let _hooked = false

/** 绑定全局 Escape（关闭所有已登记的 open 弹窗 + 确认框 + 大图）。 */
export function initOverlayGlobals(): void {
  if (_hooked) return
  _hooked = true
  document.addEventListener('keydown', (e) => {
    const top = openStack[openStack.length - 1]
    if (top && e.key === 'Tab') {
      const items = focusable(top)
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (!items.length || index < 0 || (e.shiftKey ? index === 0 : index === items.length - 1)) {
        e.preventDefault()
        ;(e.shiftKey ? items[items.length - 1] || top : items[0] || top).focus()
      }
      return
    }
    if (e.key !== 'Escape') return
    if (top) {
      e.preventDefault()
      closeOverlay(top)
      return
    }
    closeLightbox()
    closeConfirmEsc()
  })
}
