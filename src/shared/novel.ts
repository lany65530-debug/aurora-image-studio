/**
 * 全局共享：小说（Novel）领域类型定义。
 * 对应复刻自 ai-novel-app 的 Novel 结构，渲染层与主进程共同消费数据契约。
 */

/** 角色状态快照：记录某一章更新后角色的状态/关系，用于重写该章时回滚 */
export interface CharacterStatusSnapshot {
  /** 产生这次状态变更的章节（0-based） */
  chapterIndex: number
  status?: string
  relationships?: Record<string, string>
}

export interface NovelCharacter {
  name: string
  role: string
  desc: string
  /** 角色当前状态（位置/心境/伤势/目标等，随剧情更新） */
  status?: string
  /** 别名/称呼，用于检索命中 */
  aliases?: string[]
  /** 与其他角色的关系，key=对方名字 value=关系描述 */
  relationships?: Record<string, string>
  /** 按章节记录的状态变更历史，用于重写某章时把状态回滚到该章之前 */
  statusLog?: CharacterStatusSnapshot[]
  /** 首次出场章节（0-based） */
  firstChapter?: number
  /** 最近一次出场章节（0-based） */
  lastChapter?: number
}

export interface NovelLocation {
  name: string
  desc: string
  /** 首次出现章节（0-based），旧数据可为空 */
  firstChapter?: number
}

export interface NovelChapterSummary {
  chapterIndex: number
  title: string
  /** AI 自动生成的大纲摘要，≤80字 */
  summary: string
  /** 本章关键实体（角色/地点/物品），用于关键词检索 */
  keywords?: string[]
}

/** 时间线事件：贯穿全书的关键剧情节点 */
export interface NovelTimelineEvent {
  chapterIndex: number
  /** 事件描述，一句话 */
  event: string
}

/** 结构化伏笔项 */
export interface NovelForeshadowingItem {
  id: string
  /** 伏笔内容 */
  text: string
  /** 埋下的章节（0-based） */
  plantedAt: number
  /** 状态：待回收 / 已回收 */
  status: 'open' | 'resolved'
  /** 回收章节（0-based），status=resolved 时有效 */
  resolvedAt?: number
}

export interface NovelOutline {
  characters: NovelCharacter[]
  locations: NovelLocation[]
  /** 旧版纯文本伏笔（保留兼容），新逻辑优先使用 foreshadowingItems */
  foreshadowing: string[]
  chapterSummaries: NovelChapterSummary[]
  /** 结构化伏笔（含回收状态） */
  foreshadowingItems?: NovelForeshadowingItem[]
  /** 全书时间线关键事件 */
  timeline?: NovelTimelineEvent[]
}

/** 章节数据（含用户情节指令） */
export interface NovelChapterData {
  id: string
  title: string
  content: string
  /** 用户对该章节的情节指令 */
  userIdea?: string
  updatedAt: number
}

/** 落盘 / 运行时的小说完整对象 */
export interface NovelFileData {
  id: string
  title: string
  author: string
  /** 封面色值 */
  cover: string
  /** 小说整体概要/设定 */
  summary: string
  /** 小说概要/设定（源 premise 映射） */
  premise: string
  /** 写作风格 */
  style: string
  /** 小说大纲（AI 自动维护，用户可编辑） */
  outline: NovelOutline
  currentChapter: number
  currentPage: number
  scrollPercent: number
  createdAt: number
  updatedAt: number
  chapters: NovelChapterData[]
}

/** 书库卡片轻量字段（不含章节正文） */
export interface NovelSummary {
  id: string
  title: string
  author: string
  summary: string
  cover: string
  chapterCount: number
  currentChapter: number
  updatedAt: number
}

/* ===== IPC 载荷 ===== */
export interface NovelGetResult {
  ok: boolean
  novel?: NovelFileData
  error?: string
}
export type NovelSaveResult = { ok: boolean; error?: string }
export type NovelDeleteResult = { ok: boolean; error?: string }
