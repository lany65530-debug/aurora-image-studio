/**
 * 渲染层 · Toast 轻提示
 */
import { $ } from '../state/store'

type ToastType = 'info' | 'success' | 'error' | 'warning'

export function toast(msg: string, type: ToastType = 'info', ms = 3200): void {
  const wrap = $('#toastWrap')
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `<span class="t-dot"></span><span>${msg}</span>`
  wrap.appendChild(el)
  setTimeout(() => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 320)
  }, ms)
}