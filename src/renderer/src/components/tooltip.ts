/**
 * 渲染层 · 全局自绘 tooltip（统一黑底白字气泡风格，接管所有原生 title）
 * 模块加载时通过事件委托接管 [title] 元素的提示展示。
 */

let _tipEl: HTMLDivElement | null = null
let _tipOwner: HTMLElement | null = null

function ensureTipEl(): HTMLDivElement {
  if (!_tipEl) {
    _tipEl = document.createElement('div')
    _tipEl.className = 'global-tip'
    _tipEl.setAttribute('aria-hidden', 'true')
    document.body.appendChild(_tipEl)
  }
  return _tipEl
}

function positionTip(ownerRect: DOMRect, textRect: DOMRect): void {
  const tip = ensureTipEl()
  const r = ownerRect
  const pad = 8
  // 优先显示在元素下方；空间不足则在上方
  let top = r.bottom + pad
  if (top + textRect.height + pad > window.innerHeight) top = r.top - textRect.height - pad
  let left = r.left + (r.width - textRect.width) / 2
  left = Math.max(pad, Math.min(left, window.innerWidth - textRect.width - pad))
  tip.style.left = Math.round(left) + 'px'
  tip.style.top = Math.round(top) + 'px'
}

function restoreTipTitle(): void {
  if (_tipOwner) {
    const owner = _tipOwner as HTMLElement & { _tipText?: string }
    if (owner._tipText !== undefined) {
      owner.title = owner._tipText
      delete owner._tipText
    }
  }
  _tipOwner = null
}

function hideGlobalTip(): void {
  if (_tipEl) _tipEl.classList.remove('show')
}

// 事件绑定（单例，模块加载时执行一次）
document.addEventListener('mouseover', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement & { _tipText?: string }>('[title]')
  if (!t || !t.getAttribute('title')) return
  if (t === _tipOwner) return
  restoreTipTitle()
  hideGlobalTip()
  _tipOwner = t
  t._tipText = t.title
  t.removeAttribute('title')
  const tip = ensureTipEl()
  tip.textContent = t._tipText
  positionTip(t.getBoundingClientRect(), tip.getBoundingClientRect())
  tip.classList.add('show')
})

document.addEventListener('mouseout', (e) => {
  if (!_tipOwner) return
  const rt = e.relatedTarget as HTMLElement | null
  if (rt && _tipOwner.contains(rt)) return // 仍在该元素内部（悬停空白/子元素）
  restoreTipTitle()
  hideGlobalTip()
})