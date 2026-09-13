/**
 * 小说工作区（完美复刻 ai-novel-app 的「写小说」能力）
 * -------------------------------------------------------------------------
 * - 书库：浏览 / 新建 / AI 创建 / 导入 / 删除
 * - 阅读器：翻页 / 滚动两种模式，阅读设置（字号/行距/主题），目录，进度
 * - AI：按情节指令「生成下一章 / 重写本章」，配长期记忆系统（角色/伏笔/时间线/章节摘要）
 * - 大纲：四人字标签页（人物 / 地点 / 伏笔 / 章节大纲），可编辑并持久化
 */
import type {
  NovelWorkspace,
  NovelChapter
} from '../state/store'
import { $, persistWorkspaces } from '../state/store'
import type { NovelFileData, NovelOutline } from '../../../shared/novel'
import { createEmptyOutline, normalizeOutline } from '../services/outline'
import {
  generateChapter,
  updateNovelMemory
} from '../services/generation'
import { clearChapterMemory, removeChapterMemory } from '../services/outline'
import { parseParagraphs } from '../services/reader'
import { detector } from '../state/aurora'
import { toast } from '../components/toast'
import { confirmDialog } from '../components/confirm'
import '../styles/workspace/novel-desk.css'
import '../styles/workspace/novel-library.css'

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))
const emptyOutline = () => createEmptyOutline()

/** 写作/阅读可选字体（写作区与沉浸阅读共用）。 */
const READER_FONTS: Array<{ id: string; label: string; stack: string }> = [
  { id: 'default', label: '系统默认', stack: 'var(--font-body)' },
  { id: 'song', label: '宋体', stack: "'Songti SC','SimSun','Noto Serif CJK SC',serif" },
  { id: 'kai', label: '楷体', stack: "'Kaiti SC','KaiTi','STKaiti','Noto Serif CJK SC',serif" },
  { id: 'hei', label: '黑体', stack: "'PingFang SC','Microsoft YaHei','Heiti SC',sans-serif" }
]
function readerFontStack(id?: string): string {
  return (READER_FONTS.find((f) => f.id === id) || READER_FONTS[0]).stack
}

let wsRef: NovelWorkspace | null = null
let view: 'library' | 'reader' = 'library'
let novelId = ''
let chapterIndex = 0
let genMode: 'regenerate' | 'append' = 'append'
let libraryLayout: 'grid' | 'list' = 'grid'
let librarySort: 'updated' | 'created' | 'title' = 'updated'
let libraryQuery = ''

let editorResize: ResizeObserver | null = null
let deskResizeHandler: (() => void) | null = null

const ICONS: Record<string, string> = {
  back: '<path d="m15 18-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
  sparkle: '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/><path d="m19 15-.8 2.2L16 18l2.2.8L19 21l.8-2.2L22 18l-2.2-.8L19 15Z"/>',
  settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10.05 3V3h4v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 21 10.05V10h.05v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  camera: '<path d="M14.5 4 16 6h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l1.5-2h5Z"/><circle cx="12" cy="12.5" r="3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  outline: '<path d="M4 5h16M4 12h10M4 19h16"/><path d="m17 10 3 2-3 2"/>',
  chapters: '<path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  copy: '<rect width="13" height="13" x="8" y="8" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  paint: '<path d="M12 3a8 8 0 1 0 8 8h-3a2 2 0 0 1-2-2V7a4 4 0 0 0-4-4Z"/><circle cx="7.5" cy="10" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="6.5" r=".8" fill="currentColor" stroke="none"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  scan: '<path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M17 4h1.5A1.5 1.5 0 0 1 20 5.5V7M20 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17M7 20H5.5A1.5 1.5 0 0 1 4 18.5V17"/><path d="M7.5 12h9"/>'
}

function icon(name: keyof typeof ICONS, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

function novelWordCount(n: NovelFileData): number {
  return n.chapters.reduce((sum, ch) => sum + ch.content.replace(/\s/g, '').length, 0)
}

function formatCount(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : value.toLocaleString('zh-CN')
}

function formatUpdated(value: number): string {
  const diff = Math.max(0, Date.now() - value)
  const day = 86400000
  if (diff < 3600000) return '刚刚更新'
  if (diff < day) return `${Math.max(1, Math.floor(diff / 3600000))} 小时前`
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function active(): NovelFileData | null {
  return wsRef?.novels.find((n) => n.id === novelId) || wsRef?.novels[0] || null
}

/**
 * 打开「AI 率检测」独立窗口（主进程创建的真实 BrowserWindow）。
 * 阅读器中会把当前章节正文与接口配置一并带过去，书库入口则打开空白窗口供粘贴 / 上传文档。
 * 检测窗口不单独维护接口：大模型检测与改写都用小说工作区「AI 设置」里配置好的接口。
 */
function openAiDetect(mode: 'chapter' | 'library' = 'chapter') {
  const api = detector
  if (!api?.open) {
    toast('当前环境不支持 AI 率检测窗口', 'info')
    return
  }
  const n = mode === 'chapter' ? active() : null
  const chapter = n?.chapters[chapterIndex]
  const text = mode === 'chapter' ? chapter?.content || '' : ''
  const ai = wsRef?.ai
  const cfg = ai && ai.apiKey && ai.model
    ? { baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: 0.2 }
    : undefined
  void api.open({
    text,
    title: mode === 'chapter' && n ? `${n.title} · ${chapter?.title || `第 ${chapterIndex + 1} 章`}` : 'AI 率检测',
    source: mode === 'chapter' && n ? `小说工作区 · 《${n.title}》第 ${chapterIndex + 1} 章` : '小说工作区',
    cfg,
    target: n
      ? { novelId: n.id, novelTitle: n.title, chapterIndex, chapterId: chapter?.id, chapterTitle: chapter?.title }
      : undefined,
    autoRun: !!text.trim()
  })
}

/** 小说工作区 AI 设置 → 检测窗口使用的接口配置（同一份配置，不另开接口）。 */
function detectorCfg() {
  const ai = wsRef?.ai
  if (!ai) return undefined
  return { baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: 0.2 }
}

/** 设置变更后把接口配置推送给已打开的检测窗口。 */
async function pushDetectorCfg() {
  const api = detector
  if (!api?.open || !api.status) return
  const cfg = detectorCfg()
  if (!cfg?.apiKey || !cfg.model) return
  try {
    const st = await api.status()
    if (!st?.open) return
    void api.open({ cfg })
  } catch {
    /* 检测窗口未打开时静默跳过 */
  }
}

/** 把检测窗口的改写结果写回对应章节。 */
function applyDetectorText(payload: { text: string; target?: { novelId?: string; chapterIndex?: number; chapterId?: string } }) {
  const ws = wsRef
  const target = payload?.target
  if (!ws || !target?.novelId || !payload.text) return
  const n = ws.novels.find((item) => item.id === target.novelId)
  if (!n) {
    toast('未找到对应的作品，无法写回', 'error')
    return
  }
  const index = typeof target.chapterIndex === 'number' && target.chapterIndex >= 0
    ? target.chapterIndex
    : n.chapters.findIndex((item) => item.id === target.chapterId)
  const chapter = index >= 0 ? n.chapters[index] : undefined
  if (!chapter) {
    toast('未找到对应的章节，无法写回', 'error')
    return
  }
  chapter.content = payload.text
  chapter.updatedAt = Date.now()
  n.updatedAt = chapter.updatedAt
  n.currentChapter = index
  novelId = n.id
  ws.activeNovelId = n.id
  chapterIndex = index
  view = 'reader'
  save(n)
  render()
  toast(`已把改写后的正文写回《${n.title}》第 ${index + 1} 章`, 'success', 4200)
}

// 检测窗口 ↔ 小说工作区联动（模块级注册一次）
detector?.onApply?.((payload) => applyDetectorText(payload))
detector?.onRequestConfig?.(() => openAiSettings())
function aiCfg() {
  return wsRef?.ai || { baseUrl: '', apiKey: '', model: '', temperature: 0.8, systemPrompt: '你是一位专业的中文小说作家。请保持人物、世界观和叙事风格的一致性。' }
}
async function save(n = active()): Promise<boolean> {
  if (!wsRef) return false
  wsRef.updatedAt = Date.now()
  persistWorkspaces()
  // 同步到磁盘（主进程 novel 目录）
  try {
    if (n) {
      const result = await window.aurora.novel.save(n)
      if (!result.ok) throw new Error('保存失败')
    }
    return true
  } catch {
    toast('保存失败，请稍后重试', 'error')
    return false
  }
}
function render() {
  editorResize?.disconnect()
  const root = $('#novelRoot')
  const n = active()
  if (!wsRef || !root) return
  if (view === 'library') renderLibrary(root)
  else if (n) renderReader(root, n)
  else { view = 'library'; renderLibrary(root) }
}

/* ═══════════════════════════════════════════
  书库视图
═══════════════════════════════════════════ */
function renderLibrary(root: HTMLElement) {
  const ws = wsRef!
  const novels = [...ws.novels].sort((a, b) => {
    if (librarySort === 'title') return a.title.localeCompare(b.title, 'zh-CN')
    return librarySort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
  })
  const chapterCount = ws.novels.reduce((sum, n) => sum + n.chapters.length, 0)
  const wordCount = ws.novels.reduce((sum, n) => sum + novelWordCount(n), 0)
  const recent = [...ws.novels].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const current = recent?.chapters[Math.min(recent.currentChapter || 0, Math.max(0, recent.chapters.length - 1))]
  const recentChapters = ws.novels.flatMap(book => book.chapters.map((chapter, index) => ({ book, chapter, index }))).sort((a, b) => b.chapter.updatedAt - a.chapter.updatedAt).slice(0, 5)
  root.innerHTML = `
    <section class="folio">
      <header class="folio-header"><div class="folio-brand">${icon('book', 22)}<h1>小说工作台</h1></div><div class="folio-header-actions">
        <button class="folio-button" id="novelDetect" title="打开 AI 率检测窗口：由大模型检测上传文档或粘贴文本的 AI 痕迹（可勾选仅用离线算法）">${icon('scan')}AI 率检测</button>
        <button class="folio-button" id="novelImport">${icon('import')}导入作品</button>
        <button class="folio-button" id="novelAiCreate">${icon('sparkle')}AI 创建</button>
        <button class="folio-button folio-primary" id="novelCreate">${icon('plus')}新建作品</button>
        <button class="folio-icon" id="novelSettings" title="AI 设置" aria-label="AI 设置">${icon('settings')}</button>
      </div></header>
      <div class="folio-scroll"><div class="folio-inner">
        <section class="folio-resume" aria-label="最近创作">
          <div class="folio-resume-main"><div class="folio-eyebrow"><span class="folio-dot"></span>${recent ? '最近创作' : '开始创作'}${recent ? `<time>${formatUpdated(recent.updatedAt)}</time>` : ''}</div>
            <h2>${recent ? esc(recent.title) : '你的第一部作品'}</h2>
            <p class="folio-resume-chapter">${current ? `${icon('chapters', 14)}${esc(current.title)}` : '暂无章节'}</p>
            <p class="folio-excerpt">${esc(current?.content.trim().slice(0, 160) || recent?.summary || recent?.premise || '故事尚未落笔。')}</p>
            <div class="folio-resume-actions"><button class="folio-button folio-primary" ${recent ? `data-open-novel="${esc(recent.id)}"` : 'id="novelEmptyCreate"'}>${icon('outline')}${recent ? '继续写作' : '新建作品'}${icon('chevronRight', 14)}</button>${current ? `<button class="folio-button folio-quiet" data-read-novel="${esc(recent.id)}">${icon('book')}进入阅读</button>` : ''}</div>
          </div>
          <dl class="folio-stats"><div><dt>作品</dt><dd>${ws.novels.length}<small>部</small></dd></div><div><dt>章节</dt><dd>${chapterCount}<small>章</small></dd></div><div><dt>累计创作</dt><dd>${formatCount(wordCount)}<small>字</small></dd></div></dl>
        </section>
        <div class="folio-content">
          <section class="folio-collection">
            <div class="folio-section-heading"><h2>我的作品 <span>${ws.novels.length}</span></h2><div class="folio-layout" aria-label="作品视图"><button data-layout="grid" class="${libraryLayout === 'grid' ? 'on' : ''}" aria-pressed="${libraryLayout === 'grid'}" title="网格视图" aria-label="网格视图">${icon('grid')}</button><button data-layout="list" class="${libraryLayout === 'list' ? 'on' : ''}" aria-pressed="${libraryLayout === 'list'}" title="列表视图" aria-label="列表视图">${icon('list')}</button></div></div>
            <div class="folio-filters"><label class="folio-search">${icon('search')}<input id="novelSearch" value="${esc(libraryQuery)}" placeholder="搜索作品或作者" aria-label="搜索作品或作者"></label><select id="novelSort" aria-label="作品排序"><option value="updated" ${librarySort === 'updated' ? 'selected' : ''}>最近更新</option><option value="created" ${librarySort === 'created' ? 'selected' : ''}>最近创建</option><option value="title" ${librarySort === 'title' ? 'selected' : ''}>按名称</option></select></div>
            <div class="folio-grid ${libraryLayout === 'list' ? 'is-list' : ''}" id="novelGrid">
              ${novels.map(x => {
                const cover = x.cover || '#3d5768'
                const isImage = /^(data:|https?:)/.test(cover) || cover.startsWith('/')
                return `<article class="novel-card folio-work" data-id="${esc(x.id)}" data-search="${esc(x.title + ' ' + x.author)}" tabindex="0" aria-label="打开作品：${esc(x.title)}">
                  <div class="folio-work-body">
                    <div class="folio-cover" style="${isImage ? `background-image:url(&quot;${esc(cover)}&quot;)` : `background-color:${esc(cover)}`}">${isImage ? '' : `<span>小说</span><strong>${esc(x.title)}</strong><small>${esc(x.author || '未署名')}</small>`}<button class="folio-cover-edit" data-coverbtn="${esc(x.id)}" aria-label="更换封面" title="更换封面">${icon('camera', 14)}</button></div>
                    <div class="folio-work-copy"><div class="folio-work-label"><span>${x.chapters.length ? '创作中' : '新作品'}</span><button class="folio-icon" data-delete="${esc(x.id)}" title="删除作品" aria-label="删除作品：${esc(x.title)}">${icon('trash', 14)}</button></div><h3>${esc(x.title)}</h3><span class="folio-author">${esc(x.author || '未署名')}</span><p>${esc(x.summary || x.premise || '暂无作品简介')}</p><div class="folio-work-count">${x.chapters.length} 章<span>·</span>${formatCount(novelWordCount(x))} 字</div></div>
                  </div><footer class="folio-work-footer"><time>${formatUpdated(x.updatedAt)}</time><span>打开作品 ${icon('chevronRight', 14)}</span></footer>
                </article>`
              }).join('')}
            </div>
            <div class="folio-no-results" id="folioNoResults" hidden>${icon('search', 24)}<h3>没有找到匹配的作品</h3><button class="folio-button" id="folioClearSearch">清除搜索</button></div>
            ${ws.novels.length ? '' : `<div class="folio-empty">${icon('book', 32)}<h3>作品库还是空的</h3><button class="folio-button" id="novelEmptyAi">${icon('sparkle')}AI 创建作品</button></div>`}
          </section>
          <aside class="folio-recent"><div class="folio-section-heading"><h2>最近章节</h2>${icon('chapters', 16)}</div>
            ${recentChapters.map(({ book, chapter, index }) => `<button class="folio-recent-item" data-open-novel="${esc(book.id)}" data-chapter="${index}"><span class="folio-recent-number">${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(chapter.title)}</strong><span>${esc(book.title)}</span><small>${formatUpdated(chapter.updatedAt)}</small></div>${icon('chevronRight', 14)}</button>`).join('') || '<p class="folio-recent-empty">暂无章节</p>'}
          </aside>
        </div>
      </div></div>
    </section>`
  $('#novelCreate').addEventListener('click', () => quickCreateNovel())
  $('#novelAiCreate').addEventListener('click', () => openAiGenerate())
  $('#novelImport').addEventListener('click', importText)
  $('#novelDetect').addEventListener('click', () => openAiDetect('library'))
  $('#novelSettings').addEventListener('click', () => openAiSettings())
  $('#novelSearch').addEventListener('input', (e) => filterNovels((e.target as HTMLInputElement).value))
  $('#novelSort').addEventListener('change', (e) => { librarySort = (e.target as HTMLSelectElement).value as typeof librarySort; render() })
  root.querySelectorAll<HTMLElement>('[data-layout]').forEach((button) => button.addEventListener('click', () => {
    libraryLayout = button.dataset.layout as typeof libraryLayout
    render()
  }))
  document.getElementById('novelEmptyCreate')?.addEventListener('click', quickCreateNovel)
  document.getElementById('novelEmptyAi')?.addEventListener('click', openAiGenerate)
  root.querySelectorAll<HTMLElement>('[data-open-novel], [data-read-novel]').forEach(button => button.addEventListener('click', () => {
    openLibraryNovel(button.dataset.openNovel || button.dataset.readNovel!, button.dataset.chapter === undefined ? undefined : Number(button.dataset.chapter))
    if (button.dataset.readNovel) openImmersiveReader()
  }))
  root.querySelectorAll<HTMLElement>('.folio-work').forEach(card => card.addEventListener('keydown', event => {
    if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      openLibraryNovel(card.dataset.id!)
    }
  }))
  $('#folioClearSearch').addEventListener('click', () => {
    ;($('#novelSearch') as HTMLInputElement).value = ''
    filterNovels('')
    $('#novelSearch').focus()
  })
  filterNovels(libraryQuery)
  root.querySelectorAll<HTMLElement>('[data-coverbtn]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      openCoverPicker((b as HTMLElement).dataset.coverbtn!)
    })
  )
  root.querySelectorAll<HTMLElement>('.novel-card').forEach((el) =>
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-delete], [data-coverbtn]')) return
      openLibraryNovel(el.dataset.id!)
    })
  )
  root.querySelectorAll<HTMLElement>('[data-delete]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const id = el.dataset.delete
      const n = ws.novels.find((x) => x.id === id)
      const ok = await confirmDialog(
        '删除小说',
        `确定要删除《${n?.title || '这部小说'}》吗？章节与大纲将被一并移除。`,
        '删除'
      )
      if (!ok) return
      ws.novels = ws.novels.filter((x) => x.id !== id)
      if (novelId === id) novelId = ''
      save()
      if (n) void window.aurora.novel.delete(id!)
      render()
    })
  )
}
function filterNovels(q: string) {
  libraryQuery = q
  let count = 0
  document.querySelectorAll<HTMLElement>('.novel-card').forEach((el) => {
    const matches = (el.dataset.search || '').toLowerCase().includes(q.trim().toLowerCase())
    el.hidden = !matches
    if (matches) count++
  })
  const empty = document.getElementById('folioNoResults')
  if (empty) empty.hidden = !q.trim() || count > 0
}
function openLibraryNovel(id: string, index?: number) {
  const n = wsRef?.novels.find(book => book.id === id)
  if (!n || !wsRef) return
  novelId = n.id
  wsRef.activeNovelId = n.id
  chapterIndex = Math.max(0, Math.min(index ?? n.currentChapter ?? 0, Math.max(0, n.chapters.length - 1)))
  n.currentChapter = chapterIndex
  save(n)
  view = 'reader'
  render()
}
function quickCreateNovel() {
  if (!wsRef) return
  let cover = '#0d0d0d'
  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      cover = String(r.result || '#0d0d0d')
      paint()
    }
    r.readAsDataURL(f)
    input.value = ''
  })
  const isImg = () => /^(data:|https?:|\/)/.test(cover)
  const paint = () => {
    overlay.innerHTML = `
      <div class="novel-dialog-card novel-gen-card">
        <div class="novel-gen-head"><h3>新建小说</h3><button class="novel-dialog-x" data-x>×</button></div>
        <div class="novel-create-covers">
          <button class="novel-create-pick" data-pick>
            <span class="novel-create-preview" style="${isImg() ? `background-image:url(&quot;${esc(cover)}&quot;)` : `background-color:${esc(cover)}`}">${isImg() ? '' : '书'}</span>
            <span class="novel-create-pick-label">上传封面</span>
          </button>
          <div class="novel-create-field">
            <label>小说名称 <b class="req">*</b><input id="qc-title" placeholder="给你的故事取个名字..." value="未命名小说" /></label>
            <label>作者<input id="qc-author" placeholder="作者署名" value="我" /></label>
          </div>
        </div>
        <div class="novel-dialog-actions"><button class="ghost-btn" data-x2>取消</button><button class="primary-btn" id="qc-ok">创建</button></div>
      </div>`
    overlay.querySelector('[data-pick]')!.addEventListener('click', (e) => { e.preventDefault(); input.click() })
    overlay.querySelector('#qc-ok')!.addEventListener('click', () => {
      const title = (overlay.querySelector('#qc-title') as HTMLInputElement).value.trim()
      if (!title) { toast('请输入小说名称', 'error'); return }
      const author = (overlay.querySelector('#qc-author') as HTMLInputElement).value.trim() || '我'
      const now = Date.now()
      const n: NovelFileData = {
        id: 'novel-' + now, title, author, cover, summary: '', premise: '',
        style: '', outline: emptyOutline(), currentChapter: 0, currentPage: 0, scrollPercent: 0,
        createdAt: now, updatedAt: now, chapters: []
      }
      wsRef!.novels.unshift(n)
      novelId = n.id
      wsRef!.activeNovelId = novelId
      chapterIndex = 0
      save()
      overlay.remove()
      view = 'reader'
      render()
      toast(`「${title}」已创建`, 'success')
    })
    overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('[data-x2]')!.addEventListener('click', () => overlay.remove())
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  paint()
  overlay.appendChild(input)
  document.body.appendChild(overlay)
}
function importText() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.txt,.md'
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f || !wsRef) return
    const r = new FileReader()
    r.onload = () => {
      const now = Date.now()
      const n: NovelFileData = {
        id: 'novel-' + now, title: f.name.replace(/\.[^.]+$/, ''), author: '导入', cover: '#5d5d5d',
        summary: '', premise: '', style: '', outline: emptyOutline(), currentChapter: 0, currentPage: 0,
        scrollPercent: 0, createdAt: now, updatedAt: now,
        chapters: [{ id: 'ch-' + now, title: '正文', content: String(r.result || ''), updatedAt: now }]
      }
      wsRef!.novels.unshift(n)
      novelId = n.id
      wsRef!.activeNovelId = novelId
      chapterIndex = 0
      save()
      view = 'reader'
      render()
    }
    r.readAsText(f, 'utf-8')
  }
  input.click()
}

/* ===== 封面更换（书库卡片） ===== */
function openCoverPicker(id: string) {
  if (!wsRef) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      const n = wsRef!.novels.find((x) => x.id === id)
      if (!n) return
      n.cover = String(r.result || n.cover)
      save()
      render()
    }
    r.readAsDataURL(f)
  }
  input.click()
}

/* ═══════════════════════════════════════════
  阅读器视图
═══════════════════════════════════════════ */
function renderReader(root: HTMLElement, n: NovelFileData) {
  const ch = n.chapters[chapterIndex]
  if (!ch) { renderEmpty(root, n); return }
  const reader = wsRef!.reader
  const fontStack = readerFontStack(reader.fontFamily)
  root.innerHTML = `
    <section class="desk theme-${reader.theme}${window.innerWidth <= 600 ? ' directory-hidden' : ''}">
      <header class="desk-header">
        <button class="desk-icon" id="novelBack" title="返回作品库" aria-label="返回作品库">${icon('back')}</button>
        <div class="desk-book"><strong>${esc(n.title)}</strong><small>${n.chapters.length} 章 · ${formatCount(novelWordCount(n))} 字</small></div>
        <span class="desk-save" id="deskSaveState" role="status">已保存</span>
        <button class="desk-button" data-act="immersive" title="沉浸阅读本章">${icon('book')}<span>阅读</span></button>
        <button class="desk-icon" id="deskFocus" title="专注写作（Esc 退出）" aria-label="专注写作" aria-pressed="false">${icon('grid')}</button>
      </header>
      <div class="desk-toolbar" role="toolbar" aria-label="写作工具栏">
        <div class="desk-tb-group">
          <button class="desk-tool" data-act="settings" title="字体与排版设置">${icon('type', 15)}<span>字体</span></button>
          <button class="desk-tool" data-act="theme-cycle" title="切换日间 / 夜间背景">${icon('paint', 15)}<span>背景</span></button>
          <span class="desk-tb-sep"></span>
          <button class="desk-icon" data-act="desk-undo" title="撤销（编辑器内）" aria-label="撤销">↶</button>
          <button class="desk-icon" data-act="desk-redo" title="重做（编辑器内）" aria-label="重做">↷</button>
          <button class="desk-tool" data-act="normalize" title="一键整理排版">一键排版</button>
          <button class="desk-tool" data-act="insert-menu" title="插入特殊符号">插入 ▾</button>
          <button class="desk-tool" data-act="input-menu" title="输入设置">输入 ▾</button>
          <button class="desk-icon" id="deskDirectory" title="显示或隐藏目录" aria-label="显示或隐藏目录" aria-expanded="true">${icon('chapters', 15)}</button>
        </div>
        <div class="desk-tb-group desk-tb-right">
          <button class="desk-tool" data-act="desk-focus" title="全屏专注写作">全屏</button>
          <button class="desk-tool" data-act="desk-focus" title="闭关专注写作">闭关</button>
          <button class="desk-tool" data-act="rail-stub" data-stub="查找替换" title="查找替换">查找替换</button>
          <button class="desk-tool" data-act="rail-stub" data-stub="取名" title="取名">取名</button>
          <button class="desk-tool" data-act="rail-stub" data-stub="画师" title="画师">画师</button>
          <button class="desk-tool" data-act="rail-stub" data-stub="历史" title="历史">历史</button>
          <button class="desk-button" id="novelAiMenuBtn" title="AI 创作（生成 / 重写章节）">${icon('sparkle', 15)}AI 创作</button>
          <button class="desk-publish" disabled title="发布功能即将上线">发布投稿至阅文</button>
          <button class="desk-publish muted" disabled title="发布功能即将上线">发布至其他平台</button>
        </div>
      </div>
      <div class="desk-body">
        <aside class="desk-sidebar">
          <div class="desk-sidebar-head"><strong>全书</strong><button class="desk-icon" data-act="search-toggle" title="搜索章节" aria-label="搜索章节">${icon('search', 15)}</button></div>
          <div class="desk-sidebar-tabs">
            <button class="desk-sidebar-tab active" data-act="append">新建章</button>
            <button class="desk-sidebar-tab" data-act="new-volume">新建卷</button>
          </div>
          <label class="desk-search" id="novelSearchWrap" hidden>${icon('search', 14)}<input id="novelChapterFilter" placeholder="搜索章节" aria-label="搜索章节"></label>
          <div class="desk-filter-row"><span>草稿</span><button class="desk-icon" data-act="rail-stub" data-stub="筛选" title="筛选" aria-label="筛选">${icon('list', 14)}</button></div>
          <nav class="desk-chapters" aria-label="章节目录">
            <div class="desk-group"><span>作品相关</span><i>0章</i></div>
            <div class="desk-group"><span>第一卷</span><i>${n.chapters.length}章</i></div>
            ${n.chapters.map((item, i) => `<div class="desk-chapter-row"><button class="desk-chapter ${i === chapterIndex ? 'selected' : ''}" data-act="chapter-inline" data-index="${i}" aria-current="${i === chapterIndex ? 'true' : 'false'}"><span>${String(i + 1).padStart(2, '0')}</span><div><strong>${esc(item.title)}</strong><small>${formatCount(item.content.replace(/\s/g, '').length)} 字</small></div></button><button class="desk-icon desk-chapter-delete" data-sidebar-delete="${esc(item.id)}" title="删除章节" aria-label="删除章节：${esc(item.title)}">${icon('trash', 14)}</button></div>`).join('')}
          </nav>
          <button class="desk-sidebar-new" data-act="append">${icon('plus', 14)} 新建章节</button>
        </aside>
        <main class="desk-main">
          <div class="desk-scroll">
            <article class="desk-manuscript" style="--desk-font:${reader.fontSize}px;--desk-leading:${reader.lineSpacing};--desk-font-family:${fontStack}">
              <div class="desk-chapter-label">第 ${String(chapterIndex + 1).padStart(2, '0')} 章</div>
              <h1 id="novelChapterTitle" contenteditable="true" spellcheck="false" role="textbox" aria-label="章节标题">${esc(ch.title)}</h1>
              <textarea id="novelChapterContent" class="desk-content" spellcheck="false" aria-label="章节正文" placeholder="写下故事的第一句话…">${esc(ch.content)}</textarea>
            </article>
          </div>
          <footer class="desk-status">
            <button class="desk-button" data-act="append">${icon('plus', 14)}新建章节</button>
            <span class="desk-status-center">计划：约 ${formatCount(Math.max(1, chapterIndex + 1) * 2000)} 字 <b>▲</b></span>
            <span class="desk-status-end"><button class="desk-link" data-act="detect">纠错</button><span id="deskWordCount">本章：${formatCount(ch.content.replace(/\s/g, '').length)} 字</span><b>▲</b></span>
          </footer>
        </main>
        <aside class="desk-rail" aria-label="写作工具">
          <button class="desk-rail-item" data-act="detect" title="AI 率检测 / 校对">${icon('scan', 17)}<span>校对</span></button>
          <button class="desk-rail-item" data-act="rail-stub" data-stub="拆书" title="拆书">${icon('book', 17)}<span>拆书</span></button>
          <button class="desk-rail-item" data-act="outline" title="大纲">${icon('outline', 17)}<span>大纲</span></button>
          <button class="desk-rail-item" data-act="outline" title="角色">${icon('grid', 17)}<span>角色</span></button>
          <button class="desk-rail-item" data-act="outline" title="设定">${icon('settings', 17)}<span>设定</span></button>
          <button class="desk-rail-item" data-act="rail-stub" data-stub="关系" title="关系">${icon('list', 17)}<span>关系</span></button>
          <button class="desk-rail-item" data-act="rail-stub" data-stub="双栏" title="双栏">${icon('chapters', 17)}<span>双栏</span></button>
          <button class="desk-rail-item" data-act="rail-stub" data-stub="对比" title="对比">${icon('copy', 17)}<span>对比</span></button>
        </aside>
      </div>
      <button class="desk-icon desk-focus-exit" id="deskFocusExit" title="退出专注（Esc）" aria-label="退出专注">${icon('back')}</button>
    </section>`
  $('#novelBack').addEventListener('click', () => { view = 'library'; render() })
  $('#novelAiMenuBtn').addEventListener('click', openAiMenu)
  const desk = root.querySelector('.desk')!
  // 响应式：窄屏自动收起章节目录，宽屏恢复
  if (deskResizeHandler) window.removeEventListener('resize', deskResizeHandler)
  deskResizeHandler = (): void => {
    if (!desk.isConnected) return
    if (window.innerWidth <= 600) desk.classList.add('directory-hidden')
    else desk.classList.remove('directory-hidden')
  }
  window.addEventListener('resize', deskResizeHandler)
  $('#deskFocus').addEventListener('click', toggleDeskFocus)
  $('#deskFocusExit').addEventListener('click', toggleDeskFocus)
  $('#deskDirectory').addEventListener('click', () => {
    const hidden = desk.classList.toggle('directory-hidden')
    $('#deskDirectory').setAttribute('aria-expanded', String(!hidden))
  })
  $('#novelChapterFilter').addEventListener('input', (event) => {
    const query = (event.target as HTMLInputElement).value.trim().toLowerCase()
    root.querySelectorAll<HTMLElement>('.desk-chapter-row').forEach((item) => {
      item.hidden = !item.textContent?.toLowerCase().includes(query)
    })
  })
  root.querySelectorAll<HTMLElement>('[data-sidebar-delete]').forEach((button) => button.addEventListener('click', () => {
    void deleteNovelChapter(n, button.dataset.sidebarDelete!)
  }))
  bindInlineEditors(n, ch)
}
function renderParagraphs(content: string): string {
  const paras = parseParagraphs(content)
  return paras.map((p) =>
    p.blank ? '<div class="novel-blank"></div>' : `<p class="novel-paragraph${p.indent ? '' : ' no-indent'}">${esc(p.text)}</p>`
  ).join('\n')
}

let inlineSaveTimer: ReturnType<typeof setTimeout> | null = null

function serializeEditableContent(el: HTMLElement): string {
  return (el as HTMLTextAreaElement).value.replace(/\r/g, '')
}

function bindInlineEditors(n: NovelFileData, ch: NovelChapter) {
  const titleEl = document.getElementById('novelChapterTitle')
  const contentEl = document.getElementById('novelChapterContent') as HTMLTextAreaElement | null
  if (!titleEl || !contentEl) return
  // Chromium 126+ 支持 field-sizing: content，正文高度交给 CSS 自动撑开；
  // 老环境退回 JS，但要保留滚动位置，避免"回车后跳回章节开头"。
  const canFieldSize = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')
  const fitContent = (): void => {
    if (canFieldSize) return
    const scroller = contentEl.closest('.desk-scroll') as HTMLElement | null
    const prevTop = scroller ? scroller.scrollTop : 0
    contentEl.style.height = 'auto'
    contentEl.style.height = `${contentEl.scrollHeight}px`
    if (scroller && Math.abs(scroller.scrollTop - prevTop) > 1) scroller.scrollTop = prevTop
  }
  requestAnimationFrame(fitContent)
  let previousWidth = 0
  editorResize = new ResizeObserver(() => {
    if (contentEl.clientWidth !== previousWidth) {
      previousWidth = contentEl.clientWidth
      fitContent()
    }
  })
  editorResize.observe(contentEl)

  let revision = 0
  const persist = async () => {
    const savingRevision = revision
    n.updatedAt = Date.now()
    ch.updatedAt = n.updatedAt
    inlineSaveTimer = null
    const ok = await save(n)
    const status = document.getElementById('deskSaveState')
    if (status && contentEl.isConnected && revision === savingRevision) {
      status.textContent = ok ? '已保存' : '保存失败'
      status.classList.remove('saving')
    }
  }
  const schedulePersist = () => {
    revision++
    const status = document.getElementById('deskSaveState')
    if (status) {
      status.textContent = '保存中…'
      status.classList.add('saving')
    }
    if (inlineSaveTimer) clearTimeout(inlineSaveTimer)
    inlineSaveTimer = setTimeout(persist, 450)
  }
  const flushSave = () => {
    if (inlineSaveTimer) {
      clearTimeout(inlineSaveTimer)
      void persist()
    }
  }
  const pastePlainText = (event: ClipboardEvent) => {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') || ''
    document.execCommand('insertText', false, text)
  }
  /** 自动首行缩进：新段落补一个全角空格（中文小说排版惯例，阅读器按此识别缩进）。 */
  const INDENT = '\u3000'

  titleEl.addEventListener('input', () => {
    ch.title = (titleEl.textContent || '').replace(/[\r\n]+/g, ' ').trim() || '未命名'
    const titleLabel = document.querySelector('.novel-ch-title')
    if (titleLabel) titleLabel.textContent = `/ ${ch.title}`
    schedulePersist()
  })
  titleEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); contentEl.focus() }
  })
  titleEl.addEventListener('blur', flushSave)
  contentEl.addEventListener('input', () => {
    fitContent()
    ch.content = serializeEditableContent(contentEl)
    schedulePersist()
    const counter = document.getElementById('deskWordCount')
    if (counter) counter.textContent = `本章：${formatCount(ch.content.replace(/\s/g, '').length)} 字`
  })
  contentEl.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      flushSave()
      return
    }
    // 回车开启新段落 → 自动补首行缩进。
    // 注意：光标所在行本身是空行（含只有全角缩进的行）时不插入任何内容，
    // 否则每次回车都会再叠一个空行，出现"自动空出一行"。
    if (event.key === 'Enter' && !event.shiftKey) {
      const { selectionStart, selectionEnd, value } = contentEl
      if (selectionStart !== selectionEnd) return
      const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1
      const nextBreak = value.indexOf('\n', selectionStart)
      const currentLine = value.slice(lineStart, nextBreak === -1 ? value.length : nextBreak)
      event.preventDefault()
      if (currentLine.trim() === '') return
      document.execCommand('insertText', false, `\n${INDENT}`)
      fitContent()
      return
    }
    // Tab 缩进一个全角空格，而不是跳出编辑器
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      document.execCommand('insertText', false, INDENT)
      fitContent()
    }
  })
  contentEl.addEventListener('paste', pastePlainText)
  contentEl.addEventListener('blur', flushSave)
}

function renderEmpty(root: HTMLElement, n: NovelFileData) {
  root.innerHTML = `
    <div class="novel-reader-head"><button class="novel-icon-btn" id="novelBack" title="返回书库" aria-label="返回书库">${icon('back', 19)}</button>
      <div class="novel-reader-toolbar"><span class="novel-reader-label">新作品</span><div><strong>${esc(n.title)}</strong><span class="novel-ch-title">/ ${esc(n.author)}</span></div></div>
      <div class="novel-reader-tools"><button class="novel-tool" data-act="outline">${icon('outline', 15)}<span>完善设定</span></button></div>
    </div>
    <div class="novel-empty-book">
      <div class="novel-empty-manuscript"><span>${esc(n.title.slice(0, 1) || '文')}</span></div>
      <h2>第一页，正等你落笔</h2>
      <p>先整理人物与世界，也可以直接给 AI 一段情节，从第一章开始。</p>
      <div class="novel-empty-actions"><button class="novel-action-btn" data-act="outline">${icon('outline', 16)}完善设定</button><button class="novel-action-btn primary" data-act="first">${icon('sparkle', 16)}开始第一章</button></div>
    </div>`
  $('#novelBack').addEventListener('click', () => { view = 'library'; render() })
}

/* ═══════════════════════════════════════════
  写作台小工具：专注 / 主题 / 插入与输入菜单
═══════════════════════════════════════════ */
function toggleDeskFocus(): void {
  const desk = document.querySelector<HTMLElement>('#novelRoot .desk')
  if (!desk) return
  const focused = desk.classList.toggle('is-focused')
  const btn = document.getElementById('deskFocus')
  if (btn) {
    btn.setAttribute('aria-pressed', String(focused))
    btn.setAttribute('title', focused ? '退出专注（Esc）' : '专注写作（Esc 退出）')
  }
  if (focused) {
    document.getElementById('novelChapterContent')?.focus()
    toast('已进入专注写作，按 Esc 退出', 'info', 2600)
  }
}

function cycleDeskTheme(): void {
  if (!wsRef) return
  wsRef.reader.theme = wsRef.reader.theme === 'day' ? 'night' : 'day'
  void save()
  render()
  toast(wsRef.reader.theme === 'night' ? '已切换到夜间背景' : '已切换到日间背景', 'info', 1800)
}

let deskMenuEl: HTMLElement | null = null
function closeDeskMenu(): void {
  deskMenuEl?.remove()
  deskMenuEl = null
}
function openDeskMenu(anchor: HTMLElement, items: Array<{ label: string; act: string; data?: Record<string, string> }>): void {
  closeDeskMenu()
  const menu = document.createElement('div')
  menu.className = 'desk-menu'
  items.forEach((it) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.act = it.act
    if (it.data) Object.entries(it.data).forEach(([k, v]) => { b.dataset[k] = v })
    b.textContent = it.label
    menu.appendChild(b)
  })
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 156)))}px`
  menu.style.top = `${Math.round(r.bottom + 4)}px`
  deskMenuEl = menu
  menu.addEventListener('click', () => {
    window.setTimeout(() => {
      if (deskMenuEl === menu) closeDeskMenu()
    }, 0)
  })
  window.setTimeout(() => {
    const off = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) {
        if (!menu.isConnected) document.removeEventListener('click', off, true)
        else if (deskMenuEl === menu) {
          closeDeskMenu()
          document.removeEventListener('click', off, true)
        }
      }
    }
    document.addEventListener('click', off, true)
  }, 0)
}

/* ═══════════════════════════════════════════
  全局点击委托：阅读器工具栏 / 空书态 / 阅读器翻页
═══════════════════════════════════════════ */
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!el || !wsRef) return
  const act = el.dataset.act
  if (act === 'aimenu') { e.preventDefault(); openAiMenu() }
  else if (act === 'outline') { e.preventDefault(); openOutline(active()?.outline) }
  else if (act === 'chapters') { e.preventDefault(); openChapterList() }
  else if (act === 'settings') { e.preventDefault(); openReaderSettings() }
  else if (act === 'aisettings') { e.preventDefault(); openAiSettings() }
  else if (act === 'first') { e.preventDefault(); createBlankChapter() }
  else if (act === 'append') { e.preventDefault(); createBlankChapter() }
  else if (act === 'rewrite') { e.preventDefault(); openChapterGen(true) }
  else if (act === 'copy-chapter') { e.preventDefault(); void copyActiveChapter() }
  else if (act === 'detect') { e.preventDefault(); openAiDetect('chapter') }
  else if (act === 'immersive') { e.preventDefault(); openImmersiveReader() }
  else if (act === 'desk-focus') { e.preventDefault(); toggleDeskFocus() }
  else if (act === 'theme-cycle') { e.preventDefault(); cycleDeskTheme() }
  else if (act === 'normalize') { e.preventDefault(); normalizeChapterLayout() }
  else if (act === 'desk-undo' || act === 'desk-redo') {
    e.preventDefault()
    const ta = document.getElementById('novelChapterContent') as HTMLTextAreaElement | null
    if (ta) {
      ta.focus()
      document.execCommand(act === 'desk-undo' ? 'undo' : 'redo')
    }
  } else if (act === 'insert-menu') {
    e.preventDefault()
    openDeskMenu(el, [
      { label: '分隔线 ——', act: 'insert-now', data: { insert: '\n——\n' } },
      { label: '省略号 ……', act: 'insert-now', data: { insert: '……' } },
      { label: '破折号 ——', act: 'insert-now', data: { insert: '——' } },
      { label: '空行', act: 'insert-now', data: { insert: '\n\n' } }
    ])
  } else if (act === 'input-menu') {
    e.preventDefault()
    openDeskMenu(el, [
      { label: wsRef.reader.autoIndent === false ? '开启自动首行缩进' : '关闭自动首行缩进', act: 'toggle-indent' }
    ])
  } else if (act === 'insert-now') {
    e.preventDefault()
    const text = el.dataset.insert || ''
    const ta = document.getElementById('novelChapterContent') as HTMLTextAreaElement | null
    if (ta && text) {
      ta.focus()
      document.execCommand('insertText', false, text)
    }
  } else if (act === 'toggle-indent') {
    e.preventDefault()
    wsRef.reader.autoIndent = wsRef.reader.autoIndent === false
    void save()
    toast(wsRef.reader.autoIndent === false ? '已关闭自动首行缩进' : '已开启自动首行缩进', 'info', 2000)
  } else if (act === 'search-toggle') {
    e.preventDefault()
    const wrap = document.getElementById('novelSearchWrap')
    if (wrap) {
      wrap.hidden = !wrap.hidden
      if (!wrap.hidden) (wrap.querySelector('input') as HTMLInputElement | null)?.focus()
    }
  } else if (act === 'new-volume') {
    e.preventDefault()
    toast('分卷功能即将上线', 'info', 2200)
  } else if (act === 'rail-stub') {
    e.preventDefault()
    toast(`${el.dataset.stub || '该'}功能即将上线`, 'info', 2200)
  }
  else if (act === 'chapter-inline') {
    e.preventDefault()
    const n = active()
    chapterIndex = Math.max(0, Math.min(Number(el.dataset.index) || 0, Math.max(0, (n?.chapters.length || 1) - 1)))

    if (n) n.currentChapter = chapterIndex
    save()
    render()
  }
}, true)

async function copyActiveChapter() {
  const n = active()
  const ch = n?.chapters[chapterIndex]
  if (!ch) return
  const text = `${ch.title ? `${ch.title}\n\n` : ''}${ch.content}`
  try {
    await navigator.clipboard.writeText(text)
    toast('本章内容已复制', 'success')
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'; area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    toast('本章内容已复制', 'success')
  }
}

function createBlankChapter() {
  const n = active()
  if (!n) return
  const now = Date.now()
  n.chapters.push({ id: crypto.randomUUID(), title: `第 ${n.chapters.length + 1} 章`, content: '', updatedAt: now })
  chapterIndex = n.chapters.length - 1
  n.currentChapter = chapterIndex
  n.updatedAt = now
  save()
  render()
  requestAnimationFrame(() => document.getElementById('novelChapterContent')?.focus())
}

function openImmersiveReader() {
  if (!wsRef) return
  const n = active()
  if (!n?.chapters.length) return
  const settings = wsRef.reader
  let index = chapterIndex
  let page = 0
  let pages = 1
  const room = document.createElement('section')
  room.className = 'reading-room'
  room.setAttribute('role', 'dialog')
  room.setAttribute('aria-modal', 'true')
  room.setAttribute('aria-label', '小说阅读器')
  const previousFocus = document.activeElement as HTMLElement | null
  const close = () => {
    resize.disconnect()
    document.removeEventListener('keydown', onKey, true)
    room.remove()
    previousFocus?.focus()
  }
  const updateProgress = () => {
    const viewport = room.querySelector<HTMLElement>('.reading-viewport')!
    const progress = settings.mode === 'pagination' ? (pages <= 1 ? 1 : page / (pages - 1)) : viewport.scrollTop / Math.max(1, viewport.scrollHeight - viewport.clientHeight)
    room.querySelector('output')!.textContent = settings.mode === 'pagination' ? `${page + 1} / ${pages} 页` : `${Math.round(progress * 100)}%`
    ;(room.querySelector('[data-progress]') as HTMLInputElement).value = String(Math.round(progress * 100))
    ;(room.querySelector('[data-prev]') as HTMLButtonElement).disabled = index === 0 && (settings.mode === 'scroll' || page === 0)
    ;(room.querySelector('[data-next]') as HTMLButtonElement).disabled = index === n.chapters.length - 1 && (settings.mode === 'scroll' || page === pages - 1)
  }
  const layout = () => {
    room.className = `reading-room theme-${settings.theme}`
    room.style.setProperty('--reading-size', settings.fontSize + 'px')
    room.style.setProperty('--reading-leading', String(settings.lineSpacing))
    room.style.setProperty('--desk-font-family', readerFontStack(settings.fontFamily))
    const viewport = room.querySelector<HTMLElement>('.reading-viewport')!
    const article = room.querySelector<HTMLElement>('.reading-article')!
    viewport.classList.toggle('paged', settings.mode === 'pagination')
    if (settings.mode === 'pagination') {
      article.style.columnWidth = article.clientWidth + 'px'
      article.style.columnGap = '48px'
      pages = Math.max(1, Math.ceil((article.scrollWidth + 48) / (article.clientWidth + 48)))
      page = Math.min(page, pages - 1)
      article.scrollLeft = page * (article.clientWidth + 48)
    } else {
      article.style.columnWidth = ''
      article.scrollLeft = 0
    }
    updateProgress()
  }
  const turn = (direction: number) => {
    if (settings.mode === 'pagination' && page + direction >= 0 && page + direction < pages) {
      page += direction; layout(); return
    }
    if (index + direction < 0 || index + direction >= n.chapters.length) return
    index += direction
    page = 0
    paint()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return }
    if ((event.target as HTMLElement).matches('input, select')) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); turn(event.key === 'ArrowRight' ? 1 : -1) }
    if (event.key === 'Tab') {
      const controls = Array.from(room.querySelectorAll<HTMLElement>('button:not(:disabled), select, input')).filter(el => el.getClientRects().length)
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
    }
  }
  const paint = () => {
    const ch = n.chapters[index]
    room.innerHTML = `
      <header class="reading-head"><button class="desk-icon" data-close title="退出阅读" aria-label="退出阅读">${icon('back')}</button><strong>${esc(n.title)}</strong>
      <select data-toc aria-label="章节目录">${n.chapters.map((c, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${i + 1}. ${esc(c.title)}</option>`).join('')}</select>
      <button class="desk-icon" data-display title="阅读设置" aria-label="阅读设置" aria-expanded="false">${icon('type')}</button></header>
      <div class="reading-settings" hidden><label>字号<input data-size type="range" min="14" max="32" value="${settings.fontSize}"></label><label>行距<input data-leading type="range" min="1.2" max="2.8" step=".1" value="${settings.lineSpacing}"></label>
      ${[['day', '#fff', '日间'], ['green', '#f0f5ef', '护眼'], ['night', '#222426', '夜间']].map(([theme, color, label]) => `<button class="reading-swatch" data-theme="${theme}" style="background:${color}" title="${label}" aria-label="${label}" aria-pressed="${settings.theme === theme}"></button>`).join('')}
      <label>阅读方式<select data-mode><option value="scroll" ${settings.mode === 'scroll' ? 'selected' : ''}>滚动</option><option value="pagination" ${settings.mode === 'pagination' ? 'selected' : ''}>翻页</option></select></label></div>
      <main class="reading-viewport"><article class="reading-article"><small>第 ${index + 1} 章</small><h1>${esc(ch.title)}</h1>${renderParagraphs(ch.content) || '<p class="novel-paragraph">本章暂无正文</p>'}</article></main>
      <footer class="reading-foot"><button class="desk-icon" data-prev title="上一页或上一章" aria-label="上一页或上一章">${icon('chevronLeft')}</button><span>第 ${index + 1} / ${n.chapters.length} 章</span><input data-progress type="range" min="0" max="100" value="0" aria-label="本章阅读进度"><output></output><button class="desk-icon" data-next title="下一页或下一章" aria-label="下一页或下一章">${icon('chevronRight')}</button></footer>`
    room.querySelector('[data-close]')!.addEventListener('click', close)
    room.querySelector('[data-display]')!.addEventListener('click', (event) => {
      const panel = room.querySelector<HTMLElement>('.reading-settings')!
      panel.hidden = !panel.hidden
      ;(event.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!panel.hidden))
      layout()
    })
    room.querySelector('[data-toc]')!.addEventListener('change', event => { index = Number((event.target as HTMLSelectElement).value); page = 0; paint() })
    room.querySelector('[data-prev]')!.addEventListener('click', () => turn(-1))
    room.querySelector('[data-next]')!.addEventListener('click', () => turn(1))
    room.querySelectorAll<HTMLElement>('[data-theme]').forEach(button => button.addEventListener('click', () => {
      settings.theme = button.dataset.theme as typeof settings.theme
      room.querySelectorAll<HTMLElement>('[data-theme]').forEach(b => b.setAttribute('aria-pressed', String(b === button)))
      save(); layout()
    }))
    room.querySelector('[data-size]')!.addEventListener('input', event => { settings.fontSize = Number((event.target as HTMLInputElement).value); save(); layout() })
    room.querySelector('[data-leading]')!.addEventListener('input', event => { settings.lineSpacing = Number((event.target as HTMLInputElement).value); save(); layout() })
    room.querySelector('[data-mode]')!.addEventListener('change', event => { settings.mode = (event.target as HTMLSelectElement).value as typeof settings.mode; page = 0; save(); layout() })
    room.querySelector('[data-progress]')!.addEventListener('input', event => {
      const percent = Number((event.target as HTMLInputElement).value) / 100
      if (settings.mode === 'pagination') { page = Math.round(percent * (pages - 1)); layout() }
      else { const vp = room.querySelector('.reading-viewport')!; vp.scrollTop = percent * (vp.scrollHeight - vp.clientHeight) }
    })
    room.querySelector('.reading-viewport')!.addEventListener('scroll', updateProgress)
    layout()
  }
  const resize = new ResizeObserver(() => { if (room.querySelector('.reading-article')) layout() })
  document.body.appendChild(room)
  paint()
  resize.observe(room)
  document.addEventListener('keydown', onKey, true)
  room.querySelector<HTMLButtonElement>('[data-close]')!.focus()
}
/* ═══════════════════════════════════════════
  AI 菜单（重写本章 / 生成新章节）
═══════════════════════════════════════════ */
function openAiMenu() {
  if (!wsRef) return
  const n = active()
  if (!n) return
  const last = document.querySelector<HTMLElement>('#novelAiMenuBtn, [data-act="aimenu"]')
  const rect = last?.getBoundingClientRect()
  const overlay = document.createElement('div')
  overlay.className = 'novel-menu-mask'
  overlay.style.position = 'fixed'; overlay.style.inset = '0'
  overlay.addEventListener('click', () => overlay.remove())
  const menu = document.createElement('div')
  menu.className = 'novel-menu'
  menu.style.top = `${(rect?.bottom || 80) + 6}px`
  menu.style.right = `${(rect ? window.innerWidth - rect.right : 28) + 0}px`
  menu.innerHTML = `
    <button data-mi="regenerate">↻ 重写本章</button>
    <button data-mi="append">＋ 生成新章节</button>`
  menu.addEventListener('click', (e) => {
    const mi = (e.target as HTMLElement).dataset.mi
    if (!mi) return
    overlay.remove()
    openChapterGen(mi === 'regenerate')
  })
  overlay.appendChild(menu)
  document.body.appendChild(overlay)
}

/* ═══════════════════════════════════════════
  章节生成弹窗（form → generating → memory → done）
═══════════════════════════════════════════ */
function openChapterGen(isRegenerate = false) {
  if (!wsRef) return
  const n = active()
  if (!n) return
  genMode = isRegenerate ? 'regenerate' : 'append'
  const isAppend = genMode === 'append'
  const newChapterIndex = isAppend ? n.chapters.length : chapterIndex
  const existing = !isAppend ? n.chapters[chapterIndex] : null
  const ai = aiCfg()

  // 上下文摘要（前情）
  let prev: { title: string; idea: string; ending: string } | null = null
  if (isAppend && n.chapters.length > 0) {
    const last = n.chapters[n.chapters.length - 1]
    prev = { title: last.title, idea: last.userIdea || '(无指令)', ending: last.content.slice(-300) }
  } else if (!isAppend && chapterIndex > 0) {
    const last = n.chapters[chapterIndex - 1]
    prev = { title: last.title, idea: last.userIdea || '(无指令)', ending: last.content.slice(-300) }
  }

  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog'
  let stage: 'form' | 'generating' | 'memory' | 'done' = 'form'
  let userIdea = existing?.userIdea || ''
  let targetWords = 1200
  let genContent = ''
  let result: { title: string; content: string; userIdea: string } | null = null
  let outlineRef: NovelOutline | undefined

  const wordOptions = [800, 1200, 2000, 3000]
  const doneCb = (ch: NovelChapter, updatedOutline?: NovelOutline) => {
    const nov = active()
    if (!nov) return
    if (isAppend) nov.chapters.push(ch)
    else nov.chapters[chapterIndex] = ch
    if (updatedOutline) nov.outline = updatedOutline
    nov.updatedAt = Date.now()
    save()
    if (isAppend) { chapterIndex = nov.chapters.length - 1; genMode = 'regenerate' }
    render()

  }

  const paint = () => {
    if (stage === 'form') {
      overlay.innerHTML = `
        <div class="novel-dialog-card novel-gen-card">
          <div class="novel-gen-head"><h3>${isAppend ? '写下一章' : '重新生成本章'}</h3><button class="novel-dialog-x" data-x>×</button></div>
          <label>本章情节 <b class="req">*</b>
            <textarea id="gc-idea" rows="5" placeholder="告诉 AI 这一章要写什么，例如：\n\n主角在雪山洞穴中发现了一块发光的古玉，触碰后脑海中出现了上古战争的画面。正当他震惊时，洞穴开始坍塌...">${esc(userIdea)}</textarea>
            <small>AI 会严格遵循你的指令创作，不会自行添加你没有提到的重要情节转折。写得越具体越好。</small>
          </label>
          <div class="novel-gen-words">
            <span class="novel-gen-label">目标字数</span>
            <div class="novel-gen-word-opts">${wordOptions.map((w) => `<button class="${w === targetWords ? 'on' : ''}" data-w="${w}">${w} 字</button>`).join('')}</div>
          </div>
          <div class="novel-gen-context">
            <div class="novel-gen-box"><span class="novel-gen-tag">📘 小说概要</span><p>${esc((n.premise || n.summary || '未设置概要').slice(0, 200))}</p></div>
            ${prev
              ? `<div class="novel-gen-box"><span class="novel-gen-tag">👤 前情：${esc(prev.title)}</span><p>...${esc(prev.ending.slice(-200))}</p></div>`
              : `<div class="novel-gen-box"><p class="dim">${isAppend ? '这是第一章，没有前文。请在上方描述你想写的情节。' : '这是第一章，没有前文。'}</p></div>`}
            <div class="novel-gen-progress">进度：第 <b>${newChapterIndex + 1}</b> 章 ${isAppend ? '<span>（新章节）</span>' : '<span>（重新生成）</span>'}</div>
          </div>
          <button class="novel-gen-submit" id="gc-generate" ${userIdea.trim() ? '' : 'disabled'} disabled>➤ ${isAppend ? '生成本章' : '重新生成'}</button>
        </div>`
      overlay.querySelector('#gc-idea')!.addEventListener('input', (e) => {
        userIdea = (e.target as HTMLTextAreaElement).value
        const btn = overlay.querySelector<HTMLButtonElement>('#gc-generate')!
        btn.disabled = !userIdea.trim()
      })
      overlay.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
        targetWords = Number((b as HTMLElement).dataset.w)
        overlay.querySelectorAll('[data-w]').forEach((o) => o.classList.remove('on'))
        b.classList.add('on')
      }))
      overlay.querySelector('#gc-generate')!.addEventListener('click', () => {
        if (!userIdea.trim()) { toast('请输入本章的情节指令', 'error'); return }
        if (!ai.apiKey.trim()) { toast('请先在小说工作区的 AI 配置中填写 API Key', 'error'); return }
        void runGenerate()
      })
      overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())
      // 实时刷新生成按钮可用性
      const btn = overlay.querySelector<HTMLButtonElement>('#gc-generate')!
      btn.disabled = !userIdea.trim()
    } else if (stage === 'generating') {
      overlay.innerHTML = `
        <div class="novel-dialog-card novel-gen-card novel-gen-center">
          <div class="novel-gen-spinner">◌</div>
          <h3>AI 创作中</h3>
          <p class="dim">${isAppend ? '正在根据你的指令生成新章节...' : '正在根据新指令重新生成...'}</p>
          ${genContent ? `<div class="novel-gen-live">${esc(genContent)}</div>` : ''}
          <button class="novel-gen-cancel" id="gc-cancel">× 取消生成</button>
        </div>`
      overlay.querySelector('#gc-cancel')!.addEventListener('click', () => overlay.remove())
    } else if (stage === 'memory') {
      overlay.innerHTML = `
        <div class="novel-dialog-card novel-gen-card novel-gen-center">
          <div class="novel-gen-spinner">◌</div>
          <h3>正在更新记忆</h3>
          <p class="dim">提取本章的角色状态、伏笔与关键事件，写入长期记忆...</p>
        </div>`
    } else {
      overlay.innerHTML = `
        <div class="novel-dialog-card novel-gen-card novel-gen-center">
          <div class="novel-gen-check">✓</div>
          <h3>生成完成</h3>
          <p class="dim">${isAppend ? `第 ${newChapterIndex + 1} 章已生成` : '本章内容已更新'}</p>
          ${genContent ? `<div class="novel-gen-preview">${esc(genContent.slice(0, 200))}...</div>` : ''}
          <button class="novel-gen-submit" id="gc-confirm">✓ 确认${isAppend ? '并开始阅读' : '更新'}</button>
          <button class="novel-gen-retry" id="gc-retry">不满意，重新生成</button>
        </div>`
      overlay.querySelector('#gc-confirm')!.addEventListener('click', () => {
        if (result) {
          overlay.remove()
          doneCb({ ...result, id: existing?.id || ('ch-' + Date.now()), updatedAt: Date.now() } as NovelChapter, outlineRef)
        }
      })
      overlay.querySelector('#gc-retry')!.addEventListener('click', () => { stage = 'form'; paint() })
    }
  }

  const runGenerate = async () => {
    stage = 'generating'
    paint()
    try {
      const baseOutline = n.outline || emptyOutline()
      const outlineForGeneration = isAppend ? baseOutline : clearChapterMemory(baseOutline, chapterIndex)
      const gen = await generateChapter({
        premise: n.premise || n.summary || '',
        novelTitle: n.title,
        novelStyle: n.style,
        outline: outlineForGeneration,
        chapterIndex: newChapterIndex,
        totalChapters: Math.max(newChapterIndex + 1, n.chapters.length + (isAppend ? 1 : 0)),
        userIdea: userIdea.trim(),
        previousChapters: n.chapters.slice(0, isAppend ? n.chapters.length : chapterIndex),
        apiKey: ai.apiKey,
        model: ai.model,
        wordsPerChapter: targetWords,
        baseUrl: ai.baseUrl,
        temperature: ai.temperature
      })
      genContent = `${gen.title}\n${gen.content}`
      result = gen

      stage = 'memory'
      paint()
      const merged = await updateNovelMemory({
        outline: outlineForGeneration,
        chapterIndex: newChapterIndex,
        chapterTitle: gen.title,
        chapterContent: gen.content,
        userIdea: userIdea.trim(),
        apiKey: ai.apiKey,
        model: ai.model,
        baseUrl: ai.baseUrl
      })
      // 若抽取失败（返回原传入 outline），保留未清除的旧记忆，避免大纲内容被删空
      outlineRef = isAppend
        ? merged
        : merged === outlineForGeneration ? baseOutline : merged

      stage = 'done'
      paint()
    } catch (err: any) {
      toast(err?.message === 'cancelled' ? '已取消生成' : (err?.message || '生成失败'), 'error')
      stage = 'form'
      paint()
    }
  }

  paint()
  overlay.addEventListener('click', (e) => { if (e.target === overlay && stage !== 'generating' && stage !== 'memory') overlay.remove() })
  document.body.appendChild(overlay)
}

/* ═══════════════════════════════════════════
  AI 创建小说弹窗
═══════════════════════════════════════════ */
function openAiGenerate() {
  if (!wsRef) return
  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog'
  let style = '不限'
  paint()
  function paint() {
    overlay.innerHTML = `
      <div class="novel-dialog-card novel-gen-card">
        <div class="novel-gen-head"><h3>创建新小说</h3><button class="novel-dialog-x" data-x>×</button></div>
        <label>小说名称 <b class="req">*</b><input id="ai-title" placeholder="给你的故事取个名字..." value="${esc(title())}" /></label>
        <div class="novel-gen-words"><span class="novel-gen-label">写作风格</span>
          <div class="novel-gen-style" id="ai-styles">${['不限', '热血', '悬疑', '浪漫', '轻松', '黑暗'].map((s) => `<button class="${s === style ? 'on' : ''}" data-s="${s}">${s}</button>`).join('')}</div>
        </div>
        <label>小说概要 <b class="req">*</b><textarea id="ai-premise" rows="5" placeholder="这是一个关于什么的故事？简要描述世界观、主要人物和故事走向。AI 在生成每一章时会参考此概要...">${esc(premise())}</textarea></label>
        <button class="novel-gen-submit" id="ai-create">✨ 创建小说，开始逐章写作</button>
        <p class="novel-gen-footnote">创建后即可逐章输入情节指令，AI 将严格按你的想法创作</p>
      </div>`
    const t = () => (overlay.querySelector('#ai-title') as HTMLInputElement)?.value || ''
    const p = () => (overlay.querySelector('#ai-premise') as HTMLTextAreaElement)?.value || ''
    overlay.querySelector('#ai-styles')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-s]')
      if (!b) return
      style = b.dataset.s || '不限'
      overlay.querySelectorAll('[data-s]').forEach((o) => o.classList.remove('on'))
      b.classList.add('on')
    })
    overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#ai-create')!.addEventListener('click', () => {
      const titleV = t().trim()
      const premiseV = p().trim()
      if (!titleV) { toast('请输入小说名称', 'error'); return }
      if (!premiseV) { toast('请输入小说概要', 'error'); return }
      const now = Date.now()
      const n: NovelFileData = {
        id: 'novel-' + now, title: titleV, author: '我',
        cover: ['#0d0d0d', '#6b7280', '#3d3d3d', '#8a8f98', '#333'][Math.floor(Math.random() * 5)],
        summary: premiseV.slice(0, 80), premise: premiseV, style,
        outline: emptyOutline(), currentChapter: 0, currentPage: 0, scrollPercent: 0,
        createdAt: now, updatedAt: now, chapters: []
      }
      wsRef!.novels.unshift(n)
      novelId = n.id
      wsRef!.activeNovelId = novelId
      chapterIndex = 0
      save()
      overlay.remove()
      view = 'reader'
      render()
      toast(`「${titleV}」已创建，开始写第一章吧`, 'success')
    })
  }
  function title() { return '' }
  function premise() { return '' }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

/* ═══════════════════════════════════════════
  大纲弹窗（人物 / 地点 / 伏笔 / 章节大纲）
═══════════════════════════════════════════ */
function openOutline(outline?: NovelOutline) {
  if (!wsRef) return
  const n = active()
  if (!n) return
  const draft: NovelOutline = normalizeOutline(JSON.parse(JSON.stringify(outline || emptyOutline())))
  let tab: 'characters' | 'locations' | 'foreshadowing' | 'summaries' = 'summaries'
  let showNewChar = false
  let showNewLoc = false

  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog novel-outline'

  const paint = () => {
    const charRows = draft.characters.map((c, i) => `
      <div class="novel-ol-item">
        <div class="novel-ol-item-main">
          <span class="novel-ol-name">${esc(c.name)}</span><span class="novel-ol-role">${esc(c.role)}</span>
          ${c.status ? `<p class="novel-ol-status"><i>现状：</i>${esc(c.status)}</p>` : ''}
          <p class="novel-ol-desc">${esc(c.desc)}</p>
        </div>
        <div class="novel-ol-ops"><button data-e="${i}" data-kind="char" data-name="${esc(c.name)}" data-role="${esc(c.role)}" data-desc="${esc(c.desc)}" data-status="${esc(c.status || '')}" title="编辑">✎</button><button data-d="${i}" data-kind="char" title="删除">✕</button></div>
      </div>`).join('')
    const newCharBlock = showNewChar ? `
      <div class="novel-ol-new">
        <input id="nc-name" placeholder="名字" value=""/><input id="nc-role" placeholder="身份（主角/配角/反派）" value=""/><input id="nc-desc" placeholder="简要描述" value=""/>
        <div class="novel-ol-new-ops"><button class="ok" id="nc-add">添加</button><button id="nc-cancel">取消</button></div>
      </div>` : `<button class="novel-ol-add" id="nc-open">＋ 添加角色</button>`

    const locRows = draft.locations.map((l, i) => `
      <div class="novel-ol-item"><div class="novel-ol-item-main"><span class="novel-ol-name">${esc(l.name)}</span><p class="novel-ol-desc">${esc(l.desc)}</p></div>
        <div class="novel-ol-ops"><button data-d="${i}" data-kind="loc" title="删除">✕</button></div></div>`).join('')
    const newLocBlock = showNewLoc ? `
      <div class="novel-ol-new">
        <input id="nl-name" placeholder="名称" value=""/><input id="nl-desc" placeholder="描述" value=""/>
        <div class="novel-ol-new-ops"><button class="ok" id="nl-add">添加</button><button id="nl-cancel">取消</button></div>
      </div>` : `<button class="novel-ol-add" id="nl-open">＋ 添加地点</button>`

    const fsRows = draft.foreshadowingItems!.map((f, i) => `
      <div class="novel-ol-item novel-ol-fs">
        <span class="novel-ol-fs-num">${i + 1}</span>
        <p class="novel-ol-fs-text">${esc(f.text)}</p>
        <div class="novel-ol-ops"><button data-fs="${f.id}" title="删除">✕</button></div>
      </div>`).join('')

    const sumRows = draft.chapterSummaries.map((cs) => `
      <div class="novel-ol-summary"><span class="novel-ol-ch-num">第${cs.chapterIndex + 1}章</span><span class="novel-ol-ch-title">${esc(cs.title)}</span><p>${esc(cs.summary)}</p></div>`).join('')

    overlay.innerHTML = `
      <div class="novel-ol-card">
        <div class="novel-ol-head"><h3>大纲与设定</h3>
          <div class="novel-ol-head-ops"><button class="ok" id="ol-save">✓ 保存</button><button class="x" data-x>×</button></div>
        </div>
        <div class="novel-ol-tabs">
          <button class="${tab === 'characters' ? 'on' : ''}" data-tab="characters">人物</button>
          <button class="${tab === 'locations' ? 'on' : ''}" data-tab="locations">地点</button>
          <button class="${tab === 'foreshadowing' ? 'on' : ''}" data-tab="foreshadowing">伏笔</button>
          <button class="${tab === 'summaries' ? 'on' : ''}" data-tab="summaries">大纲</button>
        </div>
        <div class="novel-ol-body">
          ${tab === 'characters' ? (draft.characters.length === 0 && !showNewChar ? '<p class="novel-ol-empty">还没有记录角色，AI 会在生成章节时自动更新</p>' : '') + charRows + newCharBlock : ''}
          ${tab === 'locations' ? (draft.locations.length === 0 && !showNewLoc ? '<p class="novel-ol-empty">还没有记录地点</p>' : '') + locRows + newLocBlock : ''}
          ${tab === 'foreshadowing' ? (draft.foreshadowingItems!.length === 0 ? '<p class="novel-ol-empty">还没有记录伏笔</p>' : '') + fsRows + `<div class="novel-ol-fs-add"><input id="fs-input" placeholder="添加伏笔..."/><button class="ok" id="fs-add">＋</button></div>` : ''}
          ${tab === 'summaries' ? (draft.chapterSummaries.length === 0 ? '<p class="novel-ol-empty">还没有章节大纲。AI 会在每次确认生成新章节后自动更新。</p>' : '') + sumRows + (draft.chapterSummaries.length < n.chapters.length ? `<p class="novel-ol-count">已生成 ${draft.chapterSummaries.length}/${n.chapters.length} 章大纲</p>` : '') : ''}
        </div>
      </div>`

    /* tabs */
    overlay.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = (b as HTMLElement).dataset.tab as typeof tab; paint() }))

    /* save / close */
    overlay.querySelector('#ol-save')!.addEventListener('click', () => {
      n.outline = draft
      save()
      overlay.remove()
    })
    overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())

    /* characters CRUD */
    const ncOpen = overlay.querySelector('#nc-open')
    ncOpen?.addEventListener('click', () => { showNewChar = true; paint() })
    const ncAdd = overlay.querySelector('#nc-add')
    ncAdd?.addEventListener('click', () => {
      const name = (overlay.querySelector('#nc-name') as HTMLInputElement).value.trim()
      if (!name) return
      draft.characters.push({ name, role: (overlay.querySelector('#nc-role') as HTMLInputElement).value.trim(), desc: (overlay.querySelector('#nc-desc') as HTMLInputElement).value.trim() })
      showNewChar = false; paint()
    })
    overlay.querySelector('#nc-cancel')?.addEventListener('click', () => { showNewChar = false; paint() })

    /* locations CRUD */
    const nlOpen = overlay.querySelector('#nl-open')
    nlOpen?.addEventListener('click', () => { showNewLoc = true; paint() })
    const nlAdd = overlay.querySelector('#nl-add')
    nlAdd?.addEventListener('click', () => {
      const name = (overlay.querySelector('#nl-name') as HTMLInputElement).value.trim()
      if (!name) return
      draft.locations.push({ name, desc: (overlay.querySelector('#nl-desc') as HTMLInputElement).value.trim() })
      showNewLoc = false; paint()
    })
    overlay.querySelector('#nl-cancel')?.addEventListener('click', () => { showNewLoc = false; paint() })

    /* edits (inline via prompt — 简化，保持源语义) */
    overlay.querySelectorAll('[data-kind="char"][data-e]').forEach((b) => b.addEventListener('click', () => {
      const el = b as HTMLElement
      const i = Number(el.dataset.e)
      const name = prompt('名字', el.dataset.name) ?? ''
      if (!name) return
      const role = prompt('身份（主角/配角/反派）', el.dataset.role) ?? ''
      const desc = prompt('简要描述', el.dataset.desc) ?? ''
      const status = prompt('当前状态（可留空）', el.dataset.status) ?? ''
      draft.characters[i] = { ...draft.characters[i], name, role, desc, status: status || undefined }
      paint()
    }))
    overlay.querySelectorAll('[data-kind="char"][data-d]').forEach((b) => b.addEventListener('click', () => {
      draft.characters.splice(Number((b as HTMLElement).dataset.d), 1); paint()
    }))
    overlay.querySelectorAll('[data-kind="loc"][data-d]').forEach((b) => b.addEventListener('click', () => {
      draft.locations.splice(Number((b as HTMLElement).dataset.d), 1); paint()
    }))

    /* foreshadowing */
    const fsInput = overlay.querySelector('#fs-input') as HTMLInputElement
    const fsAdd = overlay.querySelector('#fs-add')
    if (fsInput && fsAdd) {
      const add = () => {
        const v = fsInput.value.trim()
        if (!v) return
        draft.foreshadowingItems!.push({ id: 'fs_manual_' + Date.now(), text: v, plantedAt: draft.chapterSummaries.length, status: 'open' })
        paint()
      }
      fsAdd.addEventListener('click', add)
      fsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add() })
    }
    overlay.querySelectorAll('[data-fs]').forEach((b) => b.addEventListener('click', () => {
      const id = (b as HTMLElement).dataset.fs!
      draft.foreshadowingItems = draft.foreshadowingItems!.filter((f) => f.id !== id)
      paint()
    }))
  }
  paint()
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}
async function deleteNovelChapter(n: NovelFileData, chapterId: string): Promise<boolean> {
  const chapter = n.chapters.find(item => item.id === chapterId)
  if (!chapter) return false
  const ok = await confirmDialog('删除章节', `确定删除“${chapter.title || '未命名'}”吗？该章节产生的大纲、角色状态、伏笔和时间线也会同步移除。`, '删除')
  if (!ok) return false
  const index = n.chapters.findIndex(item => item.id === chapterId)
  if (index < 0) return false
  n.chapters.splice(index, 1)
  n.outline = removeChapterMemory(n.outline || emptyOutline(), index)
  const selectedIndex = active() === n ? chapterIndex : n.currentChapter
  n.currentChapter = Math.max(0, Math.min(selectedIndex > index ? selectedIndex - 1 : selectedIndex, n.chapters.length - 1))
  n.updatedAt = Date.now()
  if (active() === n) { chapterIndex = n.currentChapter; render() }
  const saved = await save(n)
  if (saved) toast('章节及关联设定已删除', 'success')
  return true
}

function openChapterList() {
  if (!wsRef) return
  const n = active()
  if (!n) return
  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog novel-outline'
  overlay.innerHTML = `
    <div class="novel-ol-card">
      <div class="novel-ol-head"><h3>目录 <span class="novel-ol-count-h">${n.chapters.length} 章</span></h3>
        <div class="novel-ol-head-ops"><button class="x" data-x>×</button></div></div>
      <div class="novel-ol-body novel-toc">
        ${n.chapters.map((ch, i) => `
          <div class="novel-toc-row">
            <button class="novel-toc-item${i === chapterIndex ? ' on' : ''}" data-toc="${i}">
              <span class="novel-toc-num">${i + 1}</span><span class="novel-toc-title">${esc(ch.title || '未命名')}</span>
              ${i === chapterIndex ? '<span class="novel-toc-cur">当前</span>' : ''}
            </button>
            <button class="novel-toc-delete" data-delete-chapter="${i}" title="删除章节" aria-label="删除第 ${i + 1} 章">${icon('trash', 14)}</button>
          </div>`).join('')}
      </div>
    </div>`
  overlay.querySelectorAll('[data-toc]').forEach((b) => b.addEventListener('click', () => {
    chapterIndex = Number((b as HTMLElement).dataset.toc)

    overlay.remove()
    save()
    render()
  }))
  overlay.querySelectorAll<HTMLElement>('[data-delete-chapter]').forEach((button) => button.addEventListener('click', async (e) => {
    e.stopPropagation()
    const chapter = n.chapters[Number(button.dataset.deleteChapter)]
    if (chapter && await deleteNovelChapter(n, chapter.id)) overlay.remove()
  }))
  overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

/* ═══════════════════════════════════════════
  阅读设置弹窗 + AI 配置弹窗
═══════════════════════════════════════════ */
function openAiSettings() {
  if (!wsRef) return
  const ai = wsRef.ai = wsRef.ai || aiCfg()
  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog'
  overlay.innerHTML = `
    <div class="novel-dialog-card novel-gen-card">
      <div class="novel-gen-head"><h3>AI 设置</h3><button class="novel-dialog-x" data-x>×</button></div>
      <p class="dim" style="margin:0 0 4px">配置用于生成章节与大纲的对话模型接口。</p>
      <label>接口地址<input id="ai-base" type="text" placeholder="https://..." value="${esc(ai.baseUrl || '')}" /></label>
      <label>API Key<input id="ai-key" type="password" placeholder="sk-..." value="${esc(ai.apiKey || '')}" /></label>
      <label>模型<input id="ai-model" type="text" placeholder="gpt-4o / deepseek-chat..." value="${esc(ai.model || '')}" /></label>
      <div class="novel-gen-words"><span class="novel-gen-label">温度</span><div class="novel-gen-style" id="ai-temps">
        ${[0.4, 0.7, 0.8, 1.0].map((t) => `<button class="${(ai.temperature == null ? 0.8 : ai.temperature) === t ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}
      </div></div>
      <label>系统提示（可选）<textarea id="ai-sys" rows="4">${esc(ai.systemPrompt || '')}</textarea></label>
      <div class="novel-dialog-actions"><button class="ghost-btn" data-x2>取消</button><button class="primary-btn" id="ai-ok">保存</button></div>
    </div>`
  overlay.querySelectorAll('#ai-temps [data-t]').forEach((b) => b.addEventListener('click', () => {
    overlay.querySelectorAll('#ai-temps [data-t]').forEach((o) => o.classList.remove('on'))
    b.classList.add('on')
  }))
  const ok = () => {
    const pick = overlay.querySelector('#ai-temps .on') as HTMLElement | null
    const temp = pick ? Number(pick.dataset.t) : 0.8
    ai.baseUrl = (overlay.querySelector('#ai-base') as HTMLInputElement).value.trim()
    ai.apiKey = (overlay.querySelector('#ai-key') as HTMLInputElement).value.trim()
    ai.model = (overlay.querySelector('#ai-model') as HTMLInputElement).value.trim()
    ai.temperature = temp
    ai.systemPrompt = (overlay.querySelector('#ai-sys') as HTMLTextAreaElement).value.trim()
    save()
    overlay.remove()
    toast('AI 设置已保存', 'success')
    void pushDetectorCfg()
  }
  overlay.querySelector('#ai-ok')!.addEventListener('click', ok)
  overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())
  overlay.querySelector('[data-x2]')!.addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

/** 整理排版：统一首行缩进、清理行尾空格与多余空行（导入文本后特别好用）。 */
function normalizeChapterLayout() {
  const n = active()
  const ch = n?.chapters[chapterIndex]
  if (!n || !ch) return
  const lines = ch.content.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let blanks = 0
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '')
    if (!line.trim()) {
      blanks++
      if (blanks <= 1) out.push('')
      continue
    }
    blanks = 0
    out.push('\u3000' + line.replace(/^[\s\u3000]+/, ''))
  }
  // 注意：不能用 String.trim()，它会把全角缩进 \u3000 也当作空白去掉
  const next = out.join('\n').replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '')
  if (next === ch.content) {
    toast('排版已经是规范状态', 'info')
    return
  }
  ch.content = next
  save(n)
  render()
  toast('已统一首行缩进并整理空行', 'success')
}

function openReaderSettings() {
  if (!wsRef) return
  const r = wsRef.reader
  let selectedTheme = r.theme
  let selectedFont = r.fontFamily || 'default'
  const overlay = document.createElement('div')
  overlay.className = 'novel-dialog'
  overlay.innerHTML = `
    <div class="novel-dialog-card novel-gen-card">
      <div class="novel-gen-head"><h3>写作与阅读设置</h3><button class="novel-dialog-x" data-x>×</button></div>
      <label>字号<input id="rs-size" type="number" min="15" max="30" value="${r.fontSize}"/>px</label>
      <label>行距<input id="rs-spacing" type="number" min="1.4" max="2.6" step="0.1" value="${r.lineSpacing}"/></label>
      <div class="novel-gen-words"><span class="novel-gen-label">正文字体</span><div class="novel-gen-style" id="rs-fonts">
        ${READER_FONTS.map((f) => `<button class="${selectedFont === f.id ? 'on' : ''}" data-f="${f.id}">${f.label}</button>`).join('')}
      </div></div>
      <div class="novel-gen-words"><span class="novel-gen-label">主题</span><div class="novel-gen-style" id="rs-themes">
        ${['day', 'green', 'night'].map((t) => `<button class="${r.theme === t ? 'on' : ''}" data-t="${t}">${t === 'day' ? '日间' : t === 'green' ? '护眼' : '夜间'}</button>`).join('')}
      </div></div>
      <label class="novel-gen-check-row"><input type="checkbox" id="rs-indent" ${r.autoIndent === false ? '' : 'checked'} />
        <span>自动首行缩进（回车换段时补全角空格，中文小说惯例）</span></label>
      <p class="novel-gen-footnote">快捷键：Ctrl/Cmd + S 立即保存；Esc 退出专注写作；Tab 插入一个全角缩进。</p>
      <div class="novel-dialog-actions">
        <button class="ghost-btn" id="rs-normalize">整理排版</button>
        <button class="ghost-btn" data-x2>取消</button>
        <button class="primary-btn" id="rs-ok">确定</button>
      </div>
    </div>`
  const ok = () => {
    r.theme = selectedTheme
    r.fontFamily = selectedFont
    r.autoIndent = (overlay.querySelector('#rs-indent') as HTMLInputElement).checked
    r.fontSize = Math.max(15, Math.min(30, Number((overlay.querySelector('#rs-size') as HTMLInputElement).value) || 25))
    r.lineSpacing = Math.max(1.4, Math.min(2.6, Number((overlay.querySelector('#rs-spacing') as HTMLInputElement).value) || 1.9))
    save()
    overlay.remove()
    render()
  }
  overlay.querySelector('#rs-ok')!.addEventListener('click', ok)
  overlay.querySelector('#rs-normalize')!.addEventListener('click', () => {
    ok()
    normalizeChapterLayout()
  })
  overlay.querySelector('[data-x]')!.addEventListener('click', () => overlay.remove())
  overlay.querySelector('[data-x2]')!.addEventListener('click', () => overlay.remove())
  const applyFontPreview = () => {
    const desk = document.querySelector<HTMLElement>('#novelRoot .desk-manuscript')
    if (desk) {
      desk.style.setProperty('--desk-font', `${(overlay.querySelector('#rs-size') as HTMLInputElement).value}px`)
      desk.style.setProperty('--desk-leading', (overlay.querySelector('#rs-spacing') as HTMLInputElement).value)
      desk.style.setProperty('--desk-font-family', readerFontStack(selectedFont))
    }
  }
  overlay.querySelector('#rs-fonts')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')
    if (!b) return
    selectedFont = b.dataset.f || 'default'
    overlay.querySelectorAll('#rs-fonts [data-f]').forEach((o) => o.classList.remove('on'))
    b.classList.add('on')
    applyFontPreview()
  })
  overlay.querySelector('#rs-themes')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]')
    if (!b) return
    selectedTheme = b.dataset.t as 'day' | 'green' | 'night'
    overlay.querySelectorAll('#rs-themes [data-t]').forEach((o) => o.classList.remove('on'))
    b.classList.add('on')
    const desk = document.querySelector<HTMLElement>('#novelRoot .desk')
    if (desk) desk.className = `desk theme-${selectedTheme}${desk.classList.contains('directory-hidden') ? ' directory-hidden' : ''}`
  })
  overlay.querySelector('#rs-size')!.addEventListener('input', applyFontPreview)
  overlay.querySelector('#rs-spacing')!.addEventListener('input', applyFontPreview)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

// 专注写作：Esc 退出（沉浸阅读室内按 Esc 由阅读室自身处理）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  const desk = document.querySelector<HTMLElement>('#novelRoot .desk.is-focused')
  if (!desk) return
  desk.classList.remove('is-focused')
  const btn = document.getElementById('deskFocus')
  btn?.setAttribute('aria-pressed', 'false')
  btn?.setAttribute('title', '专注写作（Esc 退出）')
})

/* ═══════════════════════════════════════════
  工作区绑定
═══════════════════════════════════════════ */
export function bindNovelWorkspace(ws: NovelWorkspace) {
  wsRef = ws
  ws.novels = Array.isArray(ws.novels) ? ws.novels : []
  ws.reader = ws.reader || { fontSize: 25, lineSpacing: 1.8, theme: 'day', mode: 'pagination' }
  // 旧默认 18px → 新默认 25px（用户已在设置里显式改过的其他字号不受影响）
  if (ws.reader.fontSize === 18) ws.reader.fontSize = 25
  if (!ws.reader.fontFamily) ws.reader.fontFamily = 'default'
  if (ws.reader.autoIndent === undefined) ws.reader.autoIndent = true
  novelId = ws.activeNovelId || ws.novels[0]?.id || ''
  ws.activeNovelId = novelId
  chapterIndex = 0

  view = 'library'
  render()
}
