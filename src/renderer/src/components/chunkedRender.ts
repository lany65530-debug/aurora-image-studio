/**
 * 渲染层 · 分批挂载长列表
 * ------------------------------------------------------------
 * 作品集 / 结果区可能一次渲染几百张卡片。一次性同步创建全部 DOM
 * 会阻塞渲染主线程，表现为「打开作品集就卡一下」。
 * 这里首屏同步挂载一批，其余按帧追加；小数据量保持原有同步语义。
 */
export interface ChunkedRenderOptions {
  /** 每批卡片数量，默认 24。 */
  batch?: number
  /** 不超过该数量时一次性同步挂载，默认 48。 */
  syncLimit?: number
  /** 返回 true 表示本次渲染已过期（列表被重建），应立即停止。 */
  isCancelled?: () => boolean
  onDone?: () => void
}

export function appendInChunks<T>(
  container: HTMLElement,
  items: readonly T[],
  make: (item: T, index: number) => Node,
  opts: ChunkedRenderOptions = {}
): () => void {
  const batch = Math.max(1, opts.batch ?? 24)
  const syncLimit = Math.max(batch, opts.syncLimit ?? 48)
  let start = 0
  let cancelled = false

  const isCancelled = (): boolean => cancelled || (opts.isCancelled ? opts.isCancelled() : false)

  const appendRange = (end: number): void => {
    const frag = document.createDocumentFragment()
    for (; start < end; start++) {
      frag.appendChild(make(items[start], start))
    }
    container.appendChild(frag)
  }

  if (items.length <= syncLimit) {
    appendRange(items.length)
    opts.onDone?.()
    return () => {
      cancelled = true
    }
  }

  appendRange(Math.min(batch, items.length))
  const schedule = (fn: () => void): void => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn())
    else setTimeout(fn, 16)
  }
  const step = (): void => {
    if (isCancelled()) return
    appendRange(Math.min(start + batch, items.length))
    if (start < items.length) schedule(step)
    else opts.onDone?.()
  }
  schedule(step)

  return () => {
    cancelled = true
  }
}
