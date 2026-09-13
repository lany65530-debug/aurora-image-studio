/**
 * AI 章节生成 + 记忆抽取（移植自 ai-novel-app/src/services/generationService.ts）
 * ------------------------------------------------------------------------
 * 原项目经 Express 代理 + SSE 流式返回；本应用统一通过主进程 chat.send 调用
 * （内部同样走 OpenAI 兼容格式流式，渲染层拿到完整结果）。Prompt 组装逻辑
 * 与原项目保持一致，保证「长期记忆检索 + 章节生成」行为一致。
 */
import type { NovelOutline, NovelChapterData } from '../../../shared/novel'
import { chat } from '../state/aurora'
import {
  retrieveMemory,
  buildMemoryPrompt,
  buildOutlineUpdatePrompt,
  parseOutlineUpdate,
  applyOutlineUpdate
} from './outline'

/* ===== 风格详细描述 ===== */
const styleGuideMap: Record<string, string> = {
  '热血': '节奏明快、动作描写丰富、情感激昂、对话简洁有力、善用短句营造紧张感',
  '悬疑': '氛围压抑、细节伏笔多、对话含蓄、节奏由慢到快、注重心理描写和环境渲染',
  '浪漫': '情感细腻、心理活动丰富、场景描写唯美、对话温柔、节奏舒缓',
  '轻松': '语言幽默风趣、对话活泼、场景明亮、节奏轻快、适当加入诙谐元素',
  '黑暗': '氛围压抑、描写冷峻、对话简洁冷硬、节奏沉重、注重绝望感和冲突',
  '不限': '根据情节自然选择文风，保持流畅生动'
}

function buildStyleGuide(style: string): string {
  return styleGuideMap[style] || style || '根据情节自然选择文风，保持流畅生动'
}

/* ===== 近景上下文：最近 N 章完整正文（长期记忆由检索层负责） ===== */
function buildRecentChapters(
  previousChapters: { title: string; content: string; userIdea?: string }[],
  recentCount: number = 2
): string {
  if (previousChapters.length === 0) return ''

  const parts: string[] = []
  const total = previousChapters.length
  const recent = previousChapters.slice(-recentCount)

  recent.forEach((ch, i) => {
    const idx = total - recent.length + i
    parts.push(`【第${idx + 1}章「${ch.title}」完整正文】`)
    parts.push(ch.content)
    parts.push('')
  })

  return parts.join('\n')
}

/** 生成单章所需参数 */
export interface GenerationParams {
  premise: string
  novelTitle: string
  novelStyle: string
  outline?: NovelOutline
  chapterIndex: number
  totalChapters: number
  userIdea: string
  previousChapters: { title: string; content: string; userIdea?: string }[]
  apiKey: string
  model: string
  wordsPerChapter: number
  baseUrl?: string
  temperature?: number
}

/** 生成结果：章节标题 + 正文 + 用户指令 */
export interface GeneratedChapter {
  title: string
  content: string
  userIdea: string
}

/**
 * 指令驱动的章节生成。构建 System/User Prompt（与源项目一致），
 * 经 chat.send 返回完整内容，并拆出首行标题与正文。
 * 可在 stage 回调中通知 UI 当前阶段/进度。
 */
export async function generateChapter(params: GenerationParams): Promise<GeneratedChapter> {
  const {
    premise,
    novelTitle,
    novelStyle,
    outline,
    chapterIndex,
    totalChapters,
    userIdea,
    previousChapters,
    apiKey,
    model,
    wordsPerChapter,
    baseUrl,
    temperature
  } = params

  // ── 构建 System Prompt ──
  const styleGuide = buildStyleGuide(novelStyle)
  const isFirstChapter = chapterIndex === 0
  const displayIndex = chapterIndex + 1

  // 关键词检索：用「本章指令 + 最近一章正文」作为查询，召回相关长期记忆
  const recentTail =
    previousChapters.length > 0 ? previousChapters[previousChapters.length - 1].content.slice(-800) : ''
  const query = `${userIdea}\n${recentTail}`
  const outlineText = outline
    ? buildMemoryPrompt(retrieveMemory(outline, query, { recentChapterIdx: chapterIndex - 1 }))
    : ''

  const systemPrompt = [
    `你是一位专业的中文小说作家，正在创作小说《${novelTitle}》。`,
    '',
    '【核心原则】',
    '1. 严格遵循用户提供的「本章情节指令」来创作。你只能在指令框架内添加细节、对话和环境描写。',
    '2. 禁止添加用户指令中没有提到的重要情节转折、新角色（路人除外）、或改变已有的人物关系。',
    '3. 与小说前文保持人物、设定、情节的连贯一致。如果本章指令与前一章结尾存在矛盾，以本章指令为准，但应尽量平滑过渡。',
    '',
    ...(premise ? ['【小说总设定】', premise.slice(0, 800), ''] : []),
    ...(outlineText ? [outlineText, ''] : []),
    `【写作风格】${styleGuide}`,
    '',
    '【格式要求】',
    `- 第一行必须是章节标题，格式：「第${displayIndex}章 章节名」`,
    '- 每个段落控制在 2-4 句话（约 80-150 字），一段写完后必须换行开始新段落，禁止连续写超过 200 字的大段落',
    '- 段落之间用空行分隔',
    '- 对话密集处应频繁换行，每句对话独立成段',
    '- 使用中文全角标点符号',
    '- 对话用「」或 "" 括起来',
    `- 目标字数：约 ${wordsPerChapter} 字`,
    '',
    isFirstChapter
      ? '这是小说的第一章，需要建立世界观并引出主要人物。'
      : '请自然衔接前一章的结尾，保持情节连贯。'
  ].join('\n')

  // ── 构建 User Prompt ──
  const fullContext = buildRecentChapters(previousChapters, 2)
  const userPromptParts: string[] = []

  if (fullContext) {
    userPromptParts.push(fullContext)
    userPromptParts.push('')
  }

  userPromptParts.push('══════════════════════════════')
  userPromptParts.push('【本章情节指令 — 必须严格遵循】')
  userPromptParts.push(userIdea)
  userPromptParts.push('══════════════════════════════')
  userPromptParts.push('')
  userPromptParts.push(`请根据以上指令创作第 ${displayIndex}/${totalChapters} 章。第一行写标题，之后写正文。`)

  const userPrompt = userPromptParts.join('\n')

  // ── 调用 API（走统一 chat 通道，非流式返回值） ──
  const res = await chat.send({
    cfg: {
      baseUrl: baseUrl || '',
      apiKey,
      model,
      temperature: temperature ?? 0.8
    },
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  })

  if (!res.ok) {
    throw new Error('error' in res ? (res as { error: string }).error : 'AI 请求失败')
  }
  if ('aborted' in res && res.aborted) throw new Error('cancelled')

  const content = (res as { content: string }).content || ''

  // 提取标题和正文
  const titleLine = content.split('\n')[0] || `第${displayIndex}章`
  const contentBody = content.includes('\n')
    ? content.slice(content.indexOf('\n') + 1).trim()
    : ''
  const title = titleLine.replace(/^[#\s【】]*/, '').trim()

  return {
    title: title || `第${displayIndex}章`,
    content: contentBody || content,
    userIdea: userIdea.trim()
  }
}

/* ===== 记忆更新：章节完成后抽取长期记忆 ===== */

export interface MemoryUpdateParams {
  outline: NovelOutline
  chapterIndex: number
  chapterTitle: string
  chapterContent: string
  userIdea: string
  apiKey: string
  model: string
  baseUrl?: string
}

/**
 * 读完新章节，调用 AI 抽取记忆更新并合并回 outline。
 * 失败时返回原 outline（不阻断主流程）。
 */
export async function updateNovelMemory(params: MemoryUpdateParams): Promise<NovelOutline> {
  const {
    outline,
    chapterIndex,
    chapterTitle,
    chapterContent,
    userIdea,
    apiKey,
    model,
    baseUrl
  } = params

  try {
    const prompt = buildOutlineUpdatePrompt(outline, chapterIndex, chapterTitle, chapterContent, userIdea)

    const res = await chat.send({
      cfg: { baseUrl: baseUrl || '', apiKey, model, temperature: 0.2 },
      systemPrompt: '你是严谨的小说连续性编辑，只输出 JSON。',
      messages: [{ role: 'user', content: prompt }]
    })

    if (!res.ok || 'aborted' in res) return outline

    const raw = (res as { content: string }).content || ''
    const update = parseOutlineUpdate(raw)
    if (!update) return outline

    return applyOutlineUpdate(outline, update, chapterIndex, chapterTitle)
  } catch {
    return outline
  }
}

/* ===== 章节构造 ===== */
export function makeChapter(partial?: Partial<NovelChapterData>): NovelChapterData {
  const now = Date.now()
  return {
    id: `ch-${now}`,
    title: '未命名章节',
    content: '',
    updatedAt: now,
    ...(partial || {})
  }
}