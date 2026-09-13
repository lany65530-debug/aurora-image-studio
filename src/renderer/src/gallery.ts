/**
 * 渲染层 · 作品集视图
 * ------------------------------------------------------------
 * 渲染全局图片库（支持删除），以及「打开文件夹 / 清空记录」操作。
 * 由 nav 视图切换调用 renderGallery；initGallery 负责绑定交互按钮。
 */
import { state, store, activeWorkspace } from './state/store'
import { $ } from './state/store'
import { library, dir } from './state/aurora'
import { toast } from './components/toast'
import { buildCard, sizeToShape } from './components/imageCard'
import { appendInChunks } from './components/chunkedRender'
import type { Workspace } from './state/store'

/** 渲染代次：作品集重复打开时让上一批未挂载的卡片立即作废。 */
let galleryRenderToken = 0

/** 作品集「打开文件夹」：优先当前图片工作区的保存目录。 */
function currentImageSaveDir(): string {
  const act = activeWorkspace()
  if (act && act.type === 'image') return act.saveDir || ''
  const img = store.workspaces.find((w): w is Extract<Workspace, { type: 'image' }> => w.type === 'image')
  return (img && img.saveDir) || ''
}

export async function renderGallery(): Promise<void> {
  const token = ++galleryRenderToken
  state.gallery = await library.get()
  if (token !== galleryRenderToken) return
  const grid = $('#galleryGrid')
  const empty = $('#galleryEmpty')
  grid.innerHTML = ''
  if (!state.gallery.length) {
    empty.style.display = 'block'
    return
  }
  empty.style.display = 'none'
  const items = state.gallery.slice()
  appendInChunks(
    grid,
    items,
    (entry, i) => buildCard(entry, sizeToShape(entry.size || '1024x1024'), i, { deletable: true }),
    { isCancelled: () => token !== galleryRenderToken }
  )
}

/** 绑定作品集工具按钮（模块装配时调用一次）。 */
export function initGallery(): void {
  $('#openDirBtn').addEventListener('click', () => {
    void dir.open(currentImageSaveDir())
  })
  $('#clearLibBtn').addEventListener('click', async () => {
    if (!state.gallery.length) return toast('作品集已经是空的', 'info')
    await library.clear()
    state.gallery = []
    await renderGallery()
    toast('已清空作品记录（本地文件仍保留）', 'success')
  })
}