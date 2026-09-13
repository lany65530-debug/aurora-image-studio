/** Long-press sorting changes DOM order first and commits only on release. */
export function bindWorkspaceReorder(list: HTMLElement, commit: (ids: string[]) => void): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  let item: HTMLElement | null = null
  let original: HTMLElement[] = []
  let pointer = -1
  let startX = 0
  let startY = 0
  let y = 0
  let dragging = false
  let suppressClick = false
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const options = { signal: controller.signal }
  const children = () => Array.from(list.querySelectorAll<HTMLElement>('.ws-item'))
  const place = () => {
    if (!item) return
    const before = children().find(node => {
      if (node === item) return false
      const rect = node.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })
    if (before) list.insertBefore(item, before)
    else list.appendChild(item)
  }
  const scroll = () => {
    if (!dragging) return
    const rect = list.getBoundingClientRect()
    const distance = y < rect.top + 30 ? y - rect.top - 30 : y > rect.bottom - 30 ? y - rect.bottom + 30 : 0
    if (distance) { list.scrollTop += Math.max(-9, Math.min(9, distance / 4)); place() }
    frame = requestAnimationFrame(scroll)
  }
  const finish = (save: boolean) => {
    clearTimeout(pending)
    cancelAnimationFrame(frame)
    pending = undefined
    if (dragging) {
      if (!save) original.forEach(node => list.appendChild(node))
      item?.classList.remove('ws-dragging')
      list.classList.remove('ws-reordering')
      document.body.classList.remove('ws-reorder-active')
      suppressClick = true
      clearTimeout(clickTimer)
      clickTimer = setTimeout(() => { suppressClick = false }, 0)
      if (save) {
        const ids = children().map(node => node.dataset.workspaceId!)
        if (ids.some((id, index) => id !== original[index]?.dataset.workspaceId)) commit(ids)
      }
    }
    dragging = false
    if (list.hasPointerCapture(pointer)) list.releasePointerCapture(pointer)
    item = null
    pointer = -1
  }
  list.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || item) return
    const target = event.target as HTMLElement
    if (target.closest('.ws-del')) return
    item = target.closest<HTMLElement>('.ws-item')
    if (!item) return
    pointer = event.pointerId
    startX = event.clientX
    startY = y = event.clientY
    pending = setTimeout(() => {
      if (!item?.isConnected) { finish(false); return }
      dragging = true
      original = children()
      item.classList.add('ws-dragging')
      list.classList.add('ws-reordering')
      document.body.classList.add('ws-reorder-active')
      list.setPointerCapture(pointer)
      frame = requestAnimationFrame(scroll)
    }, 320)
  }, options)
  window.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return
    y = event.clientY
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, y - startY) > 7) finish(false)
      return
    }
    event.preventDefault()
    place()
  }, { ...options, passive: false })
  window.addEventListener('pointerup', event => { if (event.pointerId === pointer) finish(true) }, options)
  window.addEventListener('pointercancel', event => { if (event.pointerId === pointer) finish(false) }, options)
  list.addEventListener('lostpointercapture', () => { if (dragging) finish(false) }, options)
  window.addEventListener('blur', () => finish(false), options)
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && item) { event.preventDefault(); finish(false) }
  }, options)
  list.addEventListener('click', event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation() }
  }, { ...options, capture: true })
  list.addEventListener('contextmenu', event => {
    if (dragging) { event.preventDefault(); event.stopImmediatePropagation(); finish(false) }
  }, { ...options, capture: true })
  list.addEventListener('dragstart', event => event.preventDefault(), options)
  return () => { finish(false); clearTimeout(clickTimer); controller.abort() }
}
