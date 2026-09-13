/**
 * 渲染层 · 新建工作区弹窗
 * ------------------------------------------------------------
 * 侧边栏「+」下拉选择类型（图片 / 聊天），弹窗内命名 + 图标 + 生图引擎，
 * 创建后写入 store 持久化并切到新工作区。
 */
import { $, store, persistWorkspaces, makeImageWorkspace, makeChatWorkspace, makeNovelWorkspace, makeEditWorkspace } from '../state/store'
import { assignWorkspaceColors } from '../state/workspaceVisual'
import { toast } from '../components/toast'
import { readIconFile, renderIconPreview } from '../components/icon'
import { registerOverlay, openOverlay, closeOverlay } from './overlay'
import { renderSidebar, switchWorkspace } from '../nav'

const newWsState: { type: 'image' | 'chat' | 'novel' | 'edit'; icon: string | null; engine: 'gpt' | 'banana' } = {
  type: 'image',
  icon: null,
  engine: 'gpt'
}

function setNewWsEngine(engine: 'gpt' | 'banana'): void {
  newWsState.engine = engine
  $('#newWsEngineGpt').classList.toggle('selected', engine === 'gpt')
  $('#newWsEngineBanana').classList.toggle('selected', engine === 'banana')
}

function openNewWsModal(type: 'image' | 'chat' | 'novel' | 'edit'): void {
  newWsState.type = type
  newWsState.icon = null
  $('#newWsTitle').textContent =
    type === 'chat' ? '新建聊天工作区'
      : type === 'novel' ? '新建小说工作区'
        : type === 'edit' ? '新建剪辑工作区'
          : '新建图片工作区'
  ;($('#newWsName') as HTMLInputElement).value = ''
  // 图片工作区显示引擎选择，聊天工作区隐藏
  ;($('#newWsEngineField') as HTMLElement).style.display = type === 'image' ? 'block' : 'none'
  setNewWsEngine('gpt')
  renderIconPreview($('#newWsIconPreview'), '', null)
  openOverlay($('#newWsModal'))
  setTimeout(() => ($('#newWsName') as HTMLInputElement).focus(), 60)
}

function createWorkspace(): void {
  const name = ($('#newWsName') as HTMLInputElement).value.trim()
  if (!name) {
    toast('请填写工作区名称', 'error')
    return
  }
  const ws =
    newWsState.type === 'novel' ? makeNovelWorkspace(name, newWsState.icon)
      : newWsState.type === 'edit' ? makeEditWorkspace(name, newWsState.icon)
        : newWsState.type === 'chat' ? makeChatWorkspace(name, newWsState.icon)
          : makeImageWorkspace(name, newWsState.icon, {
              engine: newWsState.engine || 'gpt',
              model: newWsState.engine === 'banana' ? 'nano-banana' : ''
            })
  store.workspaces.push(ws)
  // 新建工作区优先分配当前使用次数最少的配色，避免与相邻工作区撞色
  assignWorkspaceColors(store.workspaces)
  persistWorkspaces()
  closeOverlay($('#newWsModal'))
  renderSidebar()
  void switchWorkspace(ws.id)
  toast(`已创建工作区「${ws.name}」，点击右上角齿轮完成接口配置`, 'success', 4200)
}

/** 装配（模块加载时执行一次）。 */
export function initNewWorkspace(): void {
  registerOverlay($('#newWsModal'))
  $('#newWsModalClose').addEventListener('click', () => closeOverlay($('#newWsModal')))
  $('#newWsCancelBtn').addEventListener('click', () => closeOverlay($('#newWsModal')))

  // 侧栏「+」一体按钮 + 下拉（图片 / 聊天）
  const wrap = $('#wsAddWrap')
  const btn = $('#wsAddBtn')
  const menu = $('#wsAddMenu')
  if (wrap && btn && menu) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const show = menu.hidden
      menu.hidden = !show
      wrap.classList.toggle('open', show)
    })
    menu.querySelectorAll('.ws-add-item').forEach((it) => {
      it.addEventListener('click', () => {
        menu.hidden = true
        wrap.classList.remove('open')
        openNewWsModal(((it as HTMLElement).dataset.type || 'image') as 'image' | 'chat' | 'novel' | 'edit')
      })
    })
    document.addEventListener('click', (e) => {
      if (menu.hidden) return
      if (!wrap.contains(e.target as Node)) {
        menu.hidden = true
        wrap.classList.remove('open')
      }
    })
  }

  $('#newWsEngineGpt').addEventListener('click', () => setNewWsEngine('gpt'))
  $('#newWsEngineBanana').addEventListener('click', () => setNewWsEngine('banana'))

  // 图标上传 / 重置
  $('#newWsIconUploadBtn').addEventListener('click', () => ($('#newWsIconInput') as HTMLInputElement).click())
  ;($('#newWsIconInput') as HTMLInputElement).addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files && (e.target as HTMLInputElement).files![0]
    if (f) {
      readIconFile(f, (dataUrl) => {
        newWsState.icon = dataUrl
        renderIconPreview($('#newWsIconPreview'), ($('#newWsName') as HTMLInputElement).value, dataUrl)
      })
    }
    ;(e.target as HTMLInputElement).value = ''
  })
  $('#newWsIconResetBtn').addEventListener('click', () => {
    newWsState.icon = null
    renderIconPreview($('#newWsIconPreview'), ($('#newWsName') as HTMLInputElement).value, null)
  })
  ;($('#newWsName') as HTMLInputElement).addEventListener('input', () => {
    if (!newWsState.icon) renderIconPreview($('#newWsIconPreview'), ($('#newWsName') as HTMLInputElement).value, null)
  })

  $('#newWsCreateBtn').addEventListener('click', () => createWorkspace())
}
