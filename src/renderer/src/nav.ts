/**
 * 渲染层 · 导航 / 侧边栏 / 视图切换
 * ------------------------------------------------------------
 * 侧边栏工作区列表渲染、视图切换（工作区 / 作品集）、工作区删除，
 * 以及 workspace 切换（含 create / chat 视图绑定）。
 * 注：工作区设置弹窗入口由 main.ts 注入，避免与 modals 形成循环依赖。
 */
import { store, findWs, persistWorkspaces, transient, $, $$ } from './state/store'
import { chat as chatApi, img } from './state/aurora'
import { bindCreateWorkspace, setSwitchWorkspace } from './workspaces/image'
import { bindChatWorkspace, wsChatPrefix } from './workspaces/chat'
import { bindNovelWorkspace } from './workspaces/novel'
import { bindEditorWorkspace } from './workspaces/editor'
import { renderGallery } from './gallery'
import { confirmDialog } from './components/confirm'
import { toast } from './components/toast'
import { bindWorkspaceReorder } from './components/workspaceReorder'
import { WS_TYPE_LABEL, WS_TYPE_SHORT, filterWorkspaces, workspaceColor, workspaceColorIndex, type WsType } from './state/workspaceVisual'

let disposeReorder: (() => void) | undefined
/** 侧边栏搜索关键字（仅展开态可见，收起 / 重建列表时保留）。 */
let sidebarQuery = ''
let sidebarSearchTimer: ReturnType<typeof setTimeout> | null = null

/** 搜索输入做轻量防抖：工作区很多时避免每个按键都整表重建。 */
function scheduleSidebarRender(): void {
  if (sidebarSearchTimer) clearTimeout(sidebarSearchTimer)
  sidebarSearchTimer = setTimeout(() => {
    sidebarSearchTimer = null
    renderSidebar()
  }, 80)
}

const SIDEBAR_EXPANDED_KEY = 'aurora_sidebar_expanded_v1'

/** 头像右下角的类型角标图标。 */
const TYPE_BADGE: Record<WsType, string> = {
  image:
    '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M21 15.5 16 11l-8 9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat:
    '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" stroke-linejoin="round"/></svg>',
  novel:
    '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 4v13a3 3 0 0 0 3 3"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M20 4 8.4 15.6M8.4 8.4 20 20" stroke-linecap="round"/></svg>'
}

/** 切换活动视图（create / chat / gallery）。 */
export function showView(name: string): void {
  $$('.view').forEach((v) => v.classList.toggle('active', (v as HTMLElement).dataset.view === name))
}

/* ===== 切换工作区 ===== */
export async function switchWorkspace(id: string): Promise<void> {
  const ws = findWs(id)
  if (!ws) return
  store.activeId = id
  store.view = 'workspace'
  persistWorkspaces()
  renderSidebar()
  if (ws.type === 'chat') {
    showView('chat')
    await bindChatWorkspace(ws)
  } else if (ws.type === 'novel') {
    showView('novel')
    bindNovelWorkspace(ws)
  } else if (ws.type === 'edit') {
    showView('edit')
    bindEditorWorkspace(ws)
  } else {
    showView('create')
    bindCreateWorkspace(ws)
  }
}

export function showGallery(): void {
  store.view = 'gallery'
  renderSidebar()
  showView('gallery')
  void renderGallery()
}

/* ===== 侧边栏 ===== */
export function renderSidebar(): void {
  disposeReorder?.()
  disposeReorder = undefined
  const wrap = $('#wsList')
  wrap.innerHTML = ''
  const visible = filterWorkspaces(store.workspaces, sidebarQuery)
  const filtering = sidebarQuery.trim().length > 0

  visible.forEach((ws) => {
    const type = ws.type as WsType
    const isActive = store.view === 'workspace' && ws.id === store.activeId
    const color = workspaceColor(ws)
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'ws-item nav-item' + (isActive ? ' active' : '')
    el.dataset.tip = `${ws.name} · ${WS_TYPE_SHORT[type]}`
    el.dataset.workspaceId = ws.id
    el.dataset.wsType = type
    el.dataset.wsColor = String(workspaceColorIndex(ws))
    el.setAttribute('aria-label', el.dataset.tip)
    if (isActive) el.setAttribute('aria-current', 'page')

    // 头像：专属配色 + 名称首字母 / 自定义图标，右下角叠加类型角标
    // 四种类型各有独立外形：图片=圆角方块，聊天=圆形，小说=书脊，剪辑=胶片齿孔
    const av = document.createElement('span')
    av.className =
      'ws-avatar' + (type === 'chat' ? ' chat' : type === 'novel' ? ' novel' : type === 'edit' ? ' edit' : '')
    av.dataset.type = type
    av.style.setProperty('--ws-bg', color.bg)
    av.style.setProperty('--ws-fg', color.fg)
    av.style.setProperty('--ws-line', color.line)
    if (ws.icon) {
      av.innerHTML = `<img src="${ws.icon}" alt="" />`
    } else {
      av.textContent = (String(ws.name).trim()[0] || '?').toUpperCase()
    }

    const badge = document.createElement('i')
    badge.className = 'ws-type-badge'
    badge.setAttribute('aria-hidden', 'true')
    badge.innerHTML = TYPE_BADGE[type]
    av.appendChild(badge)

    const txt = document.createElement('span')
    txt.className = 'ws-text'
    const nm = document.createElement('span')
    nm.className = 'ws-name'
    nm.textContent = ws.name
    const ty = document.createElement('span')
    ty.className = 'ws-type'
    ty.textContent = WS_TYPE_SHORT[type]
    // 展开态副标题悬停显示类型全称；收起态副标题隐藏，不会与 data-tip 提示重复
    ty.title = WS_TYPE_LABEL[type]
    txt.appendChild(nm)
    txt.appendChild(ty)

    const del = document.createElement('span')
    del.className = 'ws-del'
    del.title = '删除工作区'
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      void deleteWorkspace(ws.id)
    })

    el.appendChild(av)
    el.appendChild(txt)
    el.appendChild(del)
    el.addEventListener('click', () => void switchWorkspace(ws.id))
    // 折叠态删除按钮不可见，提供右键删除作为兜底入口
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      void deleteWorkspace(ws.id)
    })
    wrap.appendChild(el)
  })

  if (!visible.length) {
    const empty = document.createElement('div')
    empty.className = 'ws-empty'
    empty.textContent = store.workspaces.length ? `没有匹配「${sidebarQuery.trim()}」的工作区` : '暂无工作区'
    wrap.appendChild(empty)
  }

  $('#galleryNav').classList.toggle('active', store.view === 'gallery')

  // 过滤态下列表不完整，禁用拖拽排序，避免把过滤结果误写回完整顺序
  if (!filtering) {
    disposeReorder = bindWorkspaceReorder(wrap, ids => {
      const byId = new Map(store.workspaces.map(ws => [ws.id, ws]))
      if (ids.length !== byId.size || ids.some(id => !byId.has(id))) return
      store.workspaces = ids.map(id => byId.get(id)!)
      persistWorkspaces()
    })
  }
}

/* ===== 删除工作区 ===== */
async function deleteWorkspace(id: string): Promise<void> {
  const ws = findWs(id)
  if (!ws) return
  if (store.workspaces.length <= 1) {
    toast('至少保留一个工作区', 'info')
    return
  }
  const msg =
    ws.type === 'chat'
      ? `删除工作区「${ws.name}」？\n其下的全部对话记录也会一并删除。\n删除后无法恢复。`
      : `删除工作区「${ws.name}」？\n已生成的图片仍会保留在作品集。\n删除后无法恢复。`
  const ok = await confirmDialog('删除工作区', msg, '删除')
  if (!ok) return

  if (ws.type === 'chat') {
    // 一并删除该工作区前缀下的全部会话
    try {
      const all = await chatApi.sessionsList()
      const prefix = wsChatPrefix(ws)
      for (const s of all) {
        if (String(s.id || '').startsWith(prefix)) {
          await chatApi.sessionsDelete(String(s.id))
        }
      }
    } catch {
      /* 会话清理失败不阻塞删除 */
    }
  }

  // 取消该工作区仍在进行中的生成任务
  const t = transient.get(id)
  if (t && t.jobs && t.jobs.length) {
    t.jobs.forEach((j) => {
      try {
        img.stop(j.id)
      } catch {
        /* 忽略 */
      }
    })
  }
  transient.delete(id)
  store.workspaces = store.workspaces.filter((w) => w.id !== id)
  persistWorkspaces()

  if (store.activeId === id) {
    if (store.workspaces.length) {
      renderSidebar()
      await switchWorkspace(store.workspaces[0].id)
    } else {
      store.activeId = ''
      persistWorkspaces()
      renderSidebar()
      showGallery()
    }
  } else {
    renderSidebar()
  }
  toast('已删除工作区', 'success')
}

/* ===== 侧边栏展开 / 收起 + 搜索 ===== */
function readSidebarExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function persistSidebarExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_EXPANDED_KEY, expanded ? '1' : '0')
  } catch {
    /* 忽略持久化失败 */
  }
}

function applySidebarExpanded(expanded: boolean): void {
  $('#sidebar').classList.toggle('collapsed', !expanded)
  const btn = $('#sidebarToggle')
  if (!btn) return
  const label = expanded ? '收起侧边栏' : '展开侧边栏'
  btn.setAttribute('title', label)
  btn.setAttribute('aria-label', label)
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false')
}

function clearSidebarQuery(): void {
  if (sidebarSearchTimer) {
    clearTimeout(sidebarSearchTimer)
    sidebarSearchTimer = null
  }
  if (!sidebarQuery) return
  sidebarQuery = ''
  const input = $('#wsSearch') as HTMLInputElement | null
  if (input) input.value = ''
  renderSidebar()
}

/** 装配导航（作品集入口、侧边栏展开/搜索）；切换入口方面仅注入 workspace 切换（设置弹窗由 main 注入）。 */
export function initNav(): void {
  $('#galleryNav').addEventListener('click', () => showGallery())
  applySidebarExpanded(readSidebarExpanded())

  $('#sidebarToggle').addEventListener('click', () => {
    const willExpand = $('#sidebar').classList.contains('collapsed')
    applySidebarExpanded(willExpand)
    persistSidebarExpanded(willExpand)
    // 收起时清空搜索，避免列表被隐藏的过滤条件影响
    if (!willExpand) clearSidebarQuery()
  })

  const search = $('#wsSearch') as HTMLInputElement | null
  if (search) {
    search.addEventListener('input', () => {
      sidebarQuery = search.value
      scheduleSidebarRender()
    })
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        clearSidebarQuery()
      }
    })
  }

  setSwitchWorkspace((id) => switchWorkspace(id))
}
