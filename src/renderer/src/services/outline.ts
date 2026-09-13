/**
 * 小说长期记忆系统（移植自 ai-novel-app/src/services/outlineService.ts）
 * ---------------------------------------------------------------------
 * 处理小说大纲（outline）的规范化、关键词检索、Prompt 组装、
 * 记忆更新（AI 抽取）与重写章节时的记忆回滚。
 * 纯函数，无 I/O 副作用，渲染层可安全调用。
 */
import type {
  NovelCharacter,
  NovelForeshadowingItem,
  NovelChapterSummary,
  NovelOutline,
  NovelTimelineEvent
} from '../../../shared/novel'

export interface RetrievedMemory {
  characters: NovelCharacter[]
  locations: { name: string; desc: string }[]
  openForeshadowing: NovelForeshadowingItem[]
  relevantSummaries: NovelChapterSummary[]
  timeline: NovelTimelineEvent[]
}

/* ===== 创建 / 规范化 ===== */

/** 创建空的 outline */
export function createEmptyOutline(): NovelOutline {
  return {
    characters: [],
    locations: [],
    foreshadowing: [],
    chapterSummaries: [],
    foreshadowingItems: [],
    timeline: []
  }
}

/** 兼容旧数据：把纯文本 foreshadowing 迁移为结构化 items，补齐缺失数组；去重并剥离回声前缀 */
export function normalizeOutline(outline?: NovelOutline | null): NovelOutline {
  const base = outline || createEmptyOutline()
  const items: NovelForeshadowingItem[] = base.foreshadowingItems
    ? [...base.foreshadowingItems]
    : []

  if (items.length === 0 && base.foreshadowing && base.foreshadowing.length > 0) {
    base.foreshadowing.forEach((text, i) => {
      items.push({ id: `fs_legacy_${i}`, text, plantedAt: 0, status: 'open' })
    })
  }

  // 去重：同 id 保留第一条；剥离 AI 回声的 [fs_x_x] 前缀
  const seen = new Set<string>()
  const deduped: NovelForeshadowingItem[] = []
  for (const f of items) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    const cleanText = f.text.replace(/^\s*\[fs_\d+_\d+\]\s*/, '').trim()
    deduped.push({ ...f, text: cleanText || f.text })
  }

  return {
    characters: base.characters || [],
    locations: base.locations || [],
    foreshadowing: base.foreshadowing || [],
    chapterSummaries: base.chapterSummaries || [],
    foreshadowingItems: deduped,
    timeline: base.timeline || []
  }
}

/* ===== 关键词检索层（零依赖） ===== */

/** 从文本中抽取候选实体词（中文 2-8 字连续片段 + 已知实体命中） */
function extractQueryTokens(text: string, knownEntities: string[]): string[] {
  const tokens = new Set<string>()

  for (const entity of knownEntities) {
    if (entity && text.includes(entity)) tokens.add(entity)
  }

  const cleaned = text.replace(/[，。！？、；："""''「」『』（）\s]+/g, ' ')
  cleaned.split(' ').forEach((seg) => {
    const s = seg.trim()
    if (s.length >= 2 && s.length <= 8) tokens.add(s)
  })

  return [...tokens]
}

function scoreText(target: string, tokens: string[]): number {
  let score = 0
  for (const t of tokens) {
    if (target.includes(t)) score += t.length >= 2 ? 2 : 1
  }
  return score
}

/**
 * 关键词检索：根据「本章指令 + 最近章节内容」召回最相关的记忆。
 * 角色/伏笔为「必带」的常驻记忆，摘要/时间线按相关度排序取前 N 条。
 */
export function retrieveMemory(
  outline: NovelOutline,
  query: string,
  opts: { maxSummaries?: number; recentChapterIdx?: number } = {}
): RetrievedMemory {
  const o = normalizeOutline(outline)
  const maxSummaries = opts.maxSummaries ?? 12

  const knownEntities = [
    ...o.characters.flatMap((c) => [c.name, ...(c.aliases || [])]),
    ...o.locations.map((l) => l.name)
  ].filter(Boolean)

  const tokens = extractQueryTokens(query, knownEntities)

  // 角色：命中查询的排前，其余按最近出场兜底带上（主角类角色始终保留）
  const rankedChars = [...o.characters]
    .map((c) => {
      const hay = `${c.name} ${(c.aliases || []).join(' ')} ${c.desc} ${c.status || ''}`
      const hit = scoreText(hay, tokens)
      const roleBoost = /主角|主人公|男主|女主/.test(c.role) ? 100 : 0
      const recencyBoost = c.lastChapter ?? -1
      return { c, score: hit + roleBoost + recencyBoost * 0.01 }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)

  // 地点：命中查询的召回
  const rankedLocs = o.locations.filter((l) => scoreText(`${l.name} ${l.desc}`, tokens) > 0)

  // 待回收伏笔：全部带上（这是最容易被遗忘的信息）
  const openForeshadowing = (o.foreshadowingItems || []).filter((f) => f.status === 'open')

  // 摘要：相关度 + 时间近度打分
  const lastIdx = opts.recentChapterIdx ?? (o.chapterSummaries.length - 1)
  const relevantSummaries = [...o.chapterSummaries]
    .map((cs) => {
      const hay = `${cs.title} ${cs.summary} ${(cs.keywords || []).join(' ')}`
      const rel = scoreText(hay, tokens)
      const recency = lastIdx >= 0 ? Math.max(0, 5 - (lastIdx - cs.chapterIndex)) : 0
      return { cs, score: rel * 3 + recency }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSummaries)
    .map((x) => x.cs)
    .sort((a, b) => a.chapterIndex - b.chapterIndex)

  // 时间线：命中查询 + 全书骨架事件（全量保留，事件本就精简）
  const timeline = [...(o.timeline || [])].sort((a, b) => a.chapterIndex - b.chapterIndex)

  return {
    characters: rankedChars,
    locations: rankedLocs,
    openForeshadowing,
    relevantSummaries,
    timeline
  }
}

/* ===== Prompt 组装 ===== */

/** 把检索到的记忆格式化为「故事圣经」上下文文本 */
export function buildMemoryPrompt(mem: RetrievedMemory): string {
  const parts: string[] = []

  if (mem.characters.length > 0) {
    parts.push('【人物档案（必须严格保持一致，禁止改名/改设定）】')
    mem.characters.forEach((c) => {
      const line = [`- ${c.name}（${c.role}）：${c.desc}`]
      if (c.status) line.push(`  现状：${c.status}`)
      if (c.relationships && Object.keys(c.relationships).length > 0) {
        const rel = Object.entries(c.relationships)
          .map(([k, v]) => `${k}=${v}`)
          .join('；')
        line.push(`  关系：${rel}`)
      }
      parts.push(line.join('\n'))
    })
    parts.push('')
  }

  if (mem.locations.length > 0) {
    parts.push('【相关地点】')
    mem.locations.forEach((l) => parts.push(`- ${l.name}：${l.desc}`))
    parts.push('')
  }

  if (mem.timeline.length > 0) {
    parts.push('【故事时间线（全书关键事件，不可与之矛盾）】')
    mem.timeline.forEach((t) => parts.push(`第${t.chapterIndex + 1}章：${t.event}`))
    parts.push('')
  }

  if (mem.relevantSummaries.length > 0) {
    parts.push('【相关前情摘要】')
    mem.relevantSummaries.forEach((cs) =>
      parts.push(`第${cs.chapterIndex + 1}章「${cs.title}」：${cs.summary}`)
    )
    parts.push('')
  }

  if (mem.openForeshadowing.length > 0) {
    parts.push('【待回收伏笔（后续需呼应，不可遗忘）】')
    mem.openForeshadowing.forEach((f, i) =>
      parts.push(`${i + 1}. ${f.text}（第${f.plantedAt + 1}章埋下）`)
    )
    parts.push('')
  }

  return parts.join('\n')
}

/* ===== 记忆更新：Prompt / 解析 / 应用 ===== */

/** 给 AI 的 prompt：读完新章节后抽取记忆更新 */
export function buildOutlineUpdatePrompt(
  existing: NovelOutline,
  chapterIndex: number,
  chapterTitle: string,
  chapterContent: string,
  userIdea: string
): string {
  const o = normalizeOutline(existing)
  const existingChars = o.characters
    .map((c) => `${c.name}（${c.role}）现状：${c.status || '未知'}`)
    .join('\n')
  const openFores = (o.foreshadowingItems || [])
    .filter((f) => f.status === 'open')
    .map((f) => `[${f.id}] ${f.text}`)
    .join('\n')

  return [
    '你是一位严谨的小说连续性编辑。请阅读新完成的章节，抽取需要写入「长期记忆」的信息。',
    '',
    '【本章信息】',
    `章节：第${chapterIndex + 1}章「${chapterTitle}」`,
    `作者指令：${userIdea}`,
    '正文内容：',
    chapterContent.slice(0, 6000),
    '',
    '【当前记忆】',
    `已知角色及现状：\n${existingChars || '（无）'}`,
    `待回收伏笔：\n${openFores || '（无）'}`,
    '',
    '请输出严格的 JSON（禁止 markdown 代码块包裹），格式：',
    '{',
    '  "summary": "本章一句话摘要，≤80字，只写关键事件",',
    '  "keywords": ["本章出现的关键角色/地点/物品"],',
    '  "timelineEvent": "本章推动主线的关键事件（若无重大进展给空字符串）",',
    '  "characterUpdates": [',
    '    {"name":"角色名","role":"主角/配角/反派","desc":"若是新角色则填简介，老角色可省略","status":"本章结束时该角色的最新状态","relationships":{"某角色":"关系变化"}}',
    '  ],',
    '  "newLocations": [{"name":"","desc":""}],',
    '  "newForeshadowing": ["本章新埋下的伏笔"],',
    '  "resolvedForeshadowing": ["被回收伏笔的 id，取自上面的方括号编号"]',
    '}',
    '',
    '规则：',
    '- characterUpdates 必须包含本章有状态变化或新登场的角色，status 要具体（位置/伤势/心境/目标）',
    '- 老角色若本章无变化可不列出；新角色必须给 desc',
    '- summary 精炼客观，不要评论',
    '- 没有的字段用空数组或空字符串'
  ].join('\n')
}

export interface OutlineUpdate {
  summary: string
  keywords: string[]
  timelineEvent: string
  characterUpdates: {
    name: string
    role?: string
    desc?: string
    status?: string
    relationships?: Record<string, string>
  }[]
  newLocations: { name: string; desc: string }[]
  newForeshadowing: string[]
  resolvedForeshadowing: string[]
}

/** 解析 AI 返回的记忆更新 JSON */
export function parseOutlineUpdate(raw: string): OutlineUpdate | null {
  try {
    let json = raw.trim()
    const codeMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (codeMatch) json = codeMatch[1].trim()
    const braceStart = json.indexOf('{')
    const braceEnd = json.lastIndexOf('}')
    if (braceStart >= 0 && braceEnd > braceStart) {
      json = json.slice(braceStart, braceEnd + 1)
    }
    const parsed = JSON.parse(json) as Record<string, unknown>
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k): k is string => typeof k === 'string')
        : [],
      timelineEvent: typeof parsed.timelineEvent === 'string' ? parsed.timelineEvent : '',
      characterUpdates: Array.isArray(parsed.characterUpdates) ? parsed.characterUpdates : [],
      newLocations: Array.isArray(parsed.newLocations) ? parsed.newLocations : [],
      newForeshadowing: Array.isArray(parsed.newForeshadowing)
        ? parsed.newForeshadowing.filter((f): f is string => typeof f === 'string')
        : [],
      resolvedForeshadowing: Array.isArray(parsed.resolvedForeshadowing)
        ? parsed.resolvedForeshadowing.map((x) => String(x))
        : []
    }
  } catch {
    return null
  }
}

/** 应用记忆更新到 outline —— 全量持久化，不丢弃任何历史 */
export function applyOutlineUpdate(
  existing: NovelOutline,
  update: OutlineUpdate,
  chapterIndex: number,
  chapterTitle: string
): NovelOutline {
  const o = normalizeOutline(existing)

  // 角色：合并更新状态与关系，并记录本章产生的状态快照（用于重写该章时回滚）
  const mergedChars: NovelCharacter[] = o.characters.map((c) => ({ ...c }))
  for (const cu of update.characterUpdates) {
    if (!cu.name) continue
    const idx = mergedChars.findIndex((c) => c.name === cu.name)
    if (idx >= 0) {
      const prev = mergedChars[idx]
      const hasChange = Boolean(cu.status) || Boolean(cu.relationships && Object.keys(cu.relationships).length > 0)
      // 同一章重复更新（如失败重试）时，先移除该章旧快照再追加，避免重复记录
      const statusLog = (prev.statusLog || []).filter((s) => s.chapterIndex !== chapterIndex)
      if (hasChange) {
        statusLog.push({
          chapterIndex,
          status: prev.status,
          relationships: prev.relationships ? { ...prev.relationships } : undefined
        })
      }
      mergedChars[idx] = {
        ...prev,
        role: cu.role || prev.role,
        desc: cu.desc || prev.desc,
        status: cu.status || prev.status,
        relationships: { ...(prev.relationships || {}), ...(cu.relationships || {}) },
        lastChapter: chapterIndex,
        statusLog
      }
    } else {
      mergedChars.push({
        name: cu.name,
        role: cu.role || '配角',
        desc: cu.desc || '',
        status: cu.status,
        relationships: cu.relationships,
        firstChapter: chapterIndex,
        lastChapter: chapterIndex,
        // 新角色在本章“出生”，回滚时该章之前状态视为不存在（status/relationships 均为 undefined）
        statusLog: [{ chapterIndex, status: undefined, relationships: undefined }]
      })
    }
  }

  // 地点：去重新增
  const mergedLocs = [...o.locations]
  for (const nl of update.newLocations) {
    if (nl?.name && !mergedLocs.find((l) => l.name === nl.name)) {
      mergedLocs.push({ name: nl.name, desc: nl.desc || '', firstChapter: chapterIndex })
    }
  }

  // 伏笔：回收旧的 + 新增；id 使用全局递增序号，避免同章多次更新时产生重复 id
  const items: NovelForeshadowingItem[] = (o.foreshadowingItems || []).map((f) => {
    if (update.resolvedForeshadowing.includes(f.id)) {
      return { ...f, status: 'resolved' as const, resolvedAt: chapterIndex }
    }
    return f
  })

  const usedIds = new Set(items.map((f) => f.id))
  let nextSeq = items.reduce((max, f) => {
    const m = f.id.match(/^fs_\d+_(\d+)$/)
    return m ? Math.max(max, parseInt(m[1], 10) + 1) : max
  }, 0)
  update.newForeshadowing.forEach((rawText) => {
    // 剥离 AI 把「待回收伏笔」清单原样抄回的前缀，如 [fs_0_0]
    const text = rawText.replace(/^\s*\[fs_\d+_\d+\]\s*/, '').trim()
    if (!text) return
    let id = `fs_${chapterIndex}_${nextSeq++}`
    while (usedIds.has(id)) {
      id = `fs_${chapterIndex}_${nextSeq++}`
    }
    usedIds.add(id)
    items.push({ id, text, plantedAt: chapterIndex, status: 'open' })
  })

  // 章节摘要：全量追加（同章覆盖）
  const summaries: NovelChapterSummary[] = o.chapterSummaries.filter(
    (cs) => cs.chapterIndex !== chapterIndex
  )
  summaries.push({
    chapterIndex,
    title: chapterTitle,
    summary: (update.summary || '').slice(0, 80),
    keywords: update.keywords
  })
  summaries.sort((a, b) => a.chapterIndex - b.chapterIndex)

  // 时间线：有关键事件才记
  const timeline: NovelTimelineEvent[] = (o.timeline || []).filter(
    (t) => t.chapterIndex !== chapterIndex
  )
  if (update.timelineEvent && update.timelineEvent.trim()) {
    timeline.push({ chapterIndex, event: update.timelineEvent.trim() })
  }
  timeline.sort((a, b) => a.chapterIndex - b.chapterIndex)

  return {
    characters: mergedChars,
    locations: mergedLocs,
    foreshadowing: items.filter((f) => f.status === 'open').map((f) => f.text),
    chapterSummaries: summaries,
    foreshadowingItems: items,
    timeline
  }
}

/* ===== 重写章节时，清除该章节的所有记忆条目 ===== */

/**
 * 从 outline 中移除指定章节的所有记忆数据（摘要/时间线/伏笔），
 * 并将角色状态/关系回滚到该章节更新之前的快照（若该章曾修改过）。
 */
export function clearChapterMemory(outline: NovelOutline, chapterIndex: number): NovelOutline {
  const o = normalizeOutline(outline)

  const summaries = o.chapterSummaries.filter((cs) => cs.chapterIndex !== chapterIndex)
  const timeline = (o.timeline || []).filter((t) => t.chapterIndex !== chapterIndex)
  const items = (o.foreshadowingItems || []).filter((f) => f.plantedAt !== chapterIndex)

  // 角色状态回滚：找到该章留下的快照，把 status/relationships 还原为快照记录的“章节前”状态，
  // 并把该快照从 statusLog 中移除，避免重写后残留过期的历史记录。
  const characters: NovelCharacter[] = o.characters.map((c) => {
    const log = c.statusLog || []
    const snapshot = log.find((s) => s.chapterIndex === chapterIndex)
    if (!snapshot) return c

    const remainingLog = log.filter((s) => s.chapterIndex !== chapterIndex)
    return {
      ...c,
      status: snapshot.status,
      relationships: snapshot.relationships,
      statusLog: remainingLog,
      lastChapter:
        c.lastChapter === chapterIndex
          ? remainingLog.length > 0
            ? Math.max(...remainingLog.map((s) => s.chapterIndex))
            : undefined
          : c.lastChapter
    }
  })

  return {
    ...o,
    characters,
    chapterSummaries: summaries,
    timeline,
    foreshadowingItems: items,
    foreshadowing: items.filter((f) => f.status === 'open').map((f) => f.text)
  }
}

/**
 * 删除章节时移除该章产生的记忆，并将后续章节的索引前移。
 * 角色状态先按重写逻辑回滚；如果角色正是在被删除章节首次出现，则一并移除。
 */
export function removeChapterMemory(outline: NovelOutline, chapterIndex: number): NovelOutline {
  const cleared = clearChapterMemory(outline, chapterIndex)
  const shift = (idx?: number): number | undefined =>
    idx === undefined ? undefined : idx > chapterIndex ? idx - 1 : idx

  const characters = cleared.characters
    .filter((c) => c.firstChapter === undefined || c.firstChapter !== chapterIndex)
    .map((c) => ({
      ...c,
      firstChapter: shift(c.firstChapter),
      lastChapter: shift(c.lastChapter),
      statusLog: c.statusLog?.filter((s) => s.chapterIndex !== chapterIndex).map((s) => ({
        ...s,
        chapterIndex: shift(s.chapterIndex) as number
      }))
    }))

  const locations = cleared.locations
    .filter((location) => location.firstChapter === undefined || location.firstChapter !== chapterIndex)
    .map((location) => ({
      ...location,
      firstChapter: shift(location.firstChapter)
    }))

  const foreshadowingItems = (cleared.foreshadowingItems || []).map((f) => ({
    ...f,
    plantedAt: shift(f.plantedAt) as number,
    resolvedAt: shift(f.resolvedAt)
  }))
  const chapterSummaries = cleared.chapterSummaries
    .filter((s) => s.chapterIndex !== chapterIndex)
    .map((s) => ({ ...s, chapterIndex: shift(s.chapterIndex) as number }))
  const timeline = (cleared.timeline || [])
    .filter((t) => t.chapterIndex !== chapterIndex)
    .map((t) => ({ ...t, chapterIndex: shift(t.chapterIndex) as number }))

  return {
    ...cleared,
    characters,
    locations,
    foreshadowingItems,
    foreshadowing: foreshadowingItems.filter((f) => f.status === 'open').map((f) => f.text),
    chapterSummaries,
    timeline
  }
}
