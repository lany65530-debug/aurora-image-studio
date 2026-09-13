/**
 * 渲染层入口：装配全部模块并初始化。
 * ------------------------------------------------------------
 * 按 state / components / workspaces / modals / nav / gallery 分层装配：
 * - 读取持久化工作区（无则从旧全局设置迁移默认三工作区）
 * - 加载接口预设、渲染侧边栏
 * - 绑定窗口控制 / 弹窗全局 Escape
 * - 注入工作区设置弹窗入口 hooks（避免循环依赖）
 */
import './env.d'

import { $, store, state, persistWorkspaces, makeImageWorkspace, makeChatWorkspace, makeNovelWorkspace, makeEditWorkspace, readStoredState } from './state/store'
import { assignWorkspaceColors } from './state/workspaceVisual'
import { loadPresets, win, settings } from './state/aurora'
import { renderSidebar, switchWorkspace, showGallery, initNav } from './nav'
import { initGallery } from './gallery'
import { initOverlayGlobals } from './modals/overlay'
import { initWsSettings, openWsModal } from './modals/wsSettings'
import { initNewWorkspace } from './modals/newWorkspace'
import { initAppSettings } from './modals/appSettings'
import { initUpdateBadge } from './components/updateBadge'
import { applyCachedUi, initUiSettings } from './state/ui'
import { setOpenWsSettings as setImageOpenWsSettings } from './workspaces/image'
import { setOpenWsSettings as setChatOpenWsSettings } from './workspaces/chat'

/* ===== 窗口控制（自定义标题栏） ===== */
function initWindowControls(): void {
  $('#btnMin').addEventListener('click', () => win.minimize())
  $('#btnMax').addEventListener('click', () => win.maximize())
  $('#btnClose').addEventListener('click', () => win.close())
}

/* ===== 旧全局设置迁移（首次启动 / 无工作区数据时） ===== */
async function migrateFromSettings(): Promise<void> {
  let s: any = {}
  try {
    s = (await settings.get()) || {}
  } catch {
    /* 无旧配置 */
  }

  // 默认三工作区：GPT 绘图（继承旧生图配置）/ Banana / AI 对话（继承旧对话配置）
  const gpt = makeImageWorkspace('GPT 绘图', null, {
    apiKey: s.apiKey || '',
    baseUrl: s.baseUrl || '',
    model: s.model || 'gpt-image-2',
    saveDir: s.saveDir || '',
    channels: Array.isArray(s.channels) ? s.channels : [],
    provider: s.provider || null
  })
  const banana = makeImageWorkspace('Banana', null, { engine: 'banana', model: 'nano-banana' })
  const ai = makeChatWorkspace('AI 对话', null, {
    baseUrl: (s.chat && s.chat.baseUrl) || '',
    apiKey: (s.chat && s.chat.apiKey) || '',
    model: (s.chat && s.chat.model) || '',
    temperature: s.chat && s.chat.temperature,
    contextRounds: s.chat && s.chat.contextRounds,
    fontSize: s.chat && s.chat.fontSize
  })

  const novel = makeNovelWorkspace('小说工作区')
  const edit = makeEditWorkspace('剪辑工作区')
  store.workspaces = [gpt, banana, ai, novel, edit]
  store.activeId = gpt.id
  persistWorkspaces()
}

async function initWorkspaces(): Promise<void> {
  const data = readStoredState()

  if (data && data.workspaces.length) {
    store.workspaces = data.workspaces
    if (!store.workspaces.some((w) => w.type === 'novel')) store.workspaces.push(makeNovelWorkspace('小说工作区'))
    if (!store.workspaces.some((w) => w.type === 'edit')) store.workspaces.push(makeEditWorkspace('剪辑工作区'))
    // 旧数据兼容：图片工作区缺 engine 时按模型名推断
    store.workspaces.forEach((w: any) => {
      if (w.type === 'image' && !w.engine) {
        w.engine = /banana|gemini/i.test(String(w.model || '')) ? 'banana' : 'gpt'
      }
    })
    store.activeId = data.workspaces.some((w) => w.id === data.activeId)
      ? data.activeId
      : data.workspaces[0].id
  } else {
    await migrateFromSettings()
  }

  // 旧数据补齐专属配色（缺失时按最少使用分配），保证侧边栏头像可区分
  assignWorkspaceColors(store.workspaces)
  persistWorkspaces()

  renderSidebar()
  state.presets = await loadPresets()

  if (store.workspaces.length) {
    await switchWorkspace(store.activeId)
  } else {
    showGallery()
  }
}

async function bootstrap(): Promise<void> {
  if (!window.aurora) {
    const appEl = document.getElementById('app')
    if (appEl) appEl.textContent = '预加载层未就绪（window.aurora 缺失）'
    return
  }

  // 依赖注入：工作区设置弹窗入口（workspaces 通过 hook 调用，避免循环依赖）
  setImageOpenWsSettings((ws) => openWsModal(ws))
  setChatOpenWsSettings((ws) => openWsModal(ws))

  // 装配各层
  initWindowControls()
  initAppSettings()
  initUpdateBadge()
  initOverlayGlobals()
  initNav()
  initGallery()
  initWsSettings()
  initNewWorkspace()

  // 界面设置（主题/字号/密度/动效）：从主进程取权威值，覆盖首帧的缓存值
  await initUiSettings()

  await initWorkspaces()
}

// 首帧：先用 localStorage 缓存把主题贴上，避免启动先闪一下默认样式
applyCachedUi()

void bootstrap()
