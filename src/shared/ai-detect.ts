/**
 * 全局共享：AI 率检测引擎（纯函数实现，不依赖 DOM / Electron / 文件系统）
 * ---------------------------------------------------------------------------
 * 目标：在离线、无大模型的情况下，也能对文本给出「AI 生成倾向」的可解释评估，
 * 并逐句标出疑似 AI 痕迹（供检测窗口高亮标注）。
 *
 * 检测维度（权重见 METRIC_WEIGHTS）：
 *  1. 句长节奏     —— 人类句子长短参差，AI 句子长度高度均匀（低 burstiness）
 *  2. 段落结构     —— AI 段落长度 / 句数过于工整
 *  3. AI 套语      —— "值得注意的是 / 综上所述 / moreover" 等论文腔过渡语
 *  4. 句式模板     —— "不是…而是…" "仿佛…一般" 等模板化句法
 *  5. 抽象抒情套语 —— "心中涌起一股…" "空气中弥漫着…" 等意象套话
 *  6. 口语与标点   —— 人类口语碎片 / 语气词 / 省略号更多，AI 标点过于规范
 *  7. 用词丰富度   —— 去重字符比、一次性字符比
 *  8. 复读与重复   —— 重复 n-gram / 重复句子 / 重复句首
 *  9. 具体信息密度 —— 数字、量词、时间地点等具体锚点密度偏低
 *
 * 说明：默认检测完全由大模型完成（buildLlmDetectPrompt / parseLlmDetectReply /
 * buildLlmReport）；离线算法仅在用户显式勾选「只依赖算法检测」时使用（analyzeText）。
 * 另有可选的「一键降低 AI 率」改写提示词（buildSentenceRewritePrompt /
 * buildPolishPrompt）。
 */

/* ═══════════════════════════════════════════
   类型
═══════════════════════════════════════════ */

export type DetectLevel = 'human' | 'light' | 'mid' | 'high'
/**
 * 检测模式：
 * - `llm`：默认。完全由大模型判定 AI 率与痕迹位置，不使用离线算法参与判定。
 * - `algorithm`：仅在用户显式勾选「只依赖算法检测」时使用，结果仅供参考。
 */
export type DetectMode = 'llm' | 'algorithm'
export type DetectLang = 'zh' | 'en'
export type DetectFlagId =
  | 'cliche'
  | 'template'
  | 'abstract'
  | 'rhythm'
  | 'repetition'
  | 'punct'
  | 'concrete'
  | 'llm'

/** 单条疑似痕迹标记。 */
export interface DetectFlag {
  id: DetectFlagId
  /** 痕迹名称，如「AI 高频套语」 */
  label: string
  /** 命中细节，如「值得注意的是」 */
  detail: string
  /** 该痕迹对句子得分的贡献（0-100 量纲） */
  weight: number
}

/** 文档级检测维度。 */
export interface DetectMetric {
  id: string
  label: string
  /** 该维度的「AI 倾向」得分（0-100，越高越像 AI） */
  score: number
  /** 原始观测值，展示用短文本 */
  value: string
  /** 综合权重（skipped 时该维度不参与加权） */
  weight: number
  /** 人话解释 */
  hint: string
  /** 样本不足（如文本过短导致用词丰富度 / 重复度不可靠）时标记为跳过 */
  skipped?: boolean
}

/** 句子 / 段落级检测结果（带原文偏移，供高亮标注）。 */
export interface DetectSegment {
  index: number
  kind: 'sentence' | 'paragraph'
  /** 在原文中的起始偏移（含） */
  start: number
  /** 在原文中的结束偏移（不含） */
  end: number
  text: string
  /** 0-100 疑似 AI 得分 */
  score: number
  level: DetectLevel
  flags: DetectFlag[]
}

export interface DetectStats {
  chars: number
  contentChars: number
  sentences: number
  paragraphs: number
  avgSentence: number
  sentenceCv: number
  paraCv: number
  clichePer1000: number
  templatePer1000: number
  abstractPer1000: number
  colloquialPer1000: number
  concretePer1000: number
  distinctCharRatio: number
  repeatRatio: number
}

/** 大模型指认的一处疑似 AI 痕迹。 */
export interface LlmSuspiciousItem {
  /** 模型给出的句子序号（1-based，对应提示词里的方括号编号，仅作定位兜底） */
  sentence?: number
  /** 原文片段（整句逐字复制时定位最精确，可为空） */
  quote?: string
  /** 短片段（句首 8-15 字，逐字复制）。输出更短，能显著降低被 max_tokens 截断的概率 */
  hint?: string
  /** 为什么判为 AI 痕迹 */
  reason: string
  severity: 'high' | 'mid' | 'low'
}

/** 大模型检测的结构化结果。 */
export interface LlmDetectResult {
  score: number
  verdict?: string
  summary?: string
  reasons: string[]
  suspicious: LlmSuspiciousItem[]
}

/** 大模型检测的执行情况（主路径）。 */
export interface DetectLlmReview {
  used: boolean
  ok?: boolean
  /** 大模型给出的 AI 率（0-100）——默认模式下即最终 AI 率 */
  score?: number
  /** 大模型给出的一句话结论 */
  verdict?: string
  summary?: string
  reasons: string[]
  /** 已成功定位到原文的句子序号（0-based，对应 report.sentences 的 index） */
  flagged: number[]
  /** 指认中「高」等级的数量（判定条件之一） */
  highSeverity?: number
  /** 分块检测时各块的 AI 率（便于看出"某一段特别高"） */
  chunkScores?: number[]
  /** 原始指认清单（含 quote） */
  suspicious?: LlmSuspiciousItem[]
  /** 指认了但无法在原文定位的片段（原文可能已被改动） */
  missing?: LlmSuspiciousItem[]
  /** 长文本分块检测的块数 */
  chunks?: number
  model?: string
  /** 输出被 max_tokens 截断（finish_reason=length）时为 true */
  truncated?: boolean
  /** 模型结束原因（诊断用） */
  finishReason?: string
  /** 解析失败时保留模型原始返回（截断展示），便于排查 */
  rawReply?: string
  /** 解析失败的具体原因 */
  parseError?: string
  error?: string
}

/**
 * 零容忍判定：默认模式下以大模型检测结果为准。
 * 逐条列出判定条件与当前状态，界面据此说明「为什么通过 / 为什么不通过」。
 * 「只依赖算法」模式下不作零容忍认定（无法通过）。
 */
export interface DetectCondition {
  id: 'detect' | 'score' | 'severity' | 'count'
  /** 条件名，如「AI 率 < 30%」 */
  label: string
  /** 当前值，如「12%」 */
  value: string
  /** 该条件是否满足 */
  pass: boolean
}

export interface DetectTolerance {
  pass: boolean
  label: string
  advice: string
  reasons: string[]
  /** 判定line 用的分值：大模型模式=大模型分；算法模式=算法分（仅供参考） */
  strictScore: number
  /** 判定条件逐条状态（界面直接展示，避免"分数很低却没过"的困惑） */
  conditions: DetectCondition[]
  /** 本次使用的判定规则 */
  rule: 'standard' | 'strict-any' | 'algorithm'
}

/** 触发零容忍判定的 AI 倾向阈值（大模型判定同样适用）。 */
export const ZERO_TOLERANCE_SCORE = 30

/** 标准规则下允许的指认句数量上限（达到该数量说明是成片的 AI 腔，而非偶发误判）。 */
export const ZERO_TOLERANCE_MARK_LIMIT = 3

export interface DetectReport {
  /** 本次结果来自哪种检测方式 */
  mode: DetectMode
  /** 最终 AI 率（0-100）：大模型模式=模型判定分；算法模式=算法综合分（按置信度收敛） */
  score: number
  /** 未收敛的原始分（算法模式=算法原始加权分；大模型模式=模型判定分） */
  rawScore: number
  level: DetectLevel
  /** 结论文案，如「高度疑似 AI 生成」 */
  verdict: string
  /** 置信度 0-1（按文本长度估算，仅作提示） */
  confidence: number
  /** 一句话总结 */
  summary: string
  lang: DetectLang
  /** 检测维度：仅「只依赖算法」模式有值；大模型模式为空 */
  metrics: DetectMetric[]
  sentences: DetectSegment[]
  paragraphs: DetectSegment[]
  /** 聚合后的痕迹命中统计（按次数降序） */
  flagsTop: Array<{ id: DetectFlagId; label: string; count: number }>
  stats: DetectStats
  /** 标记阈值（≥ 该得分的句子被标为疑似） */
  threshold: number
  /** 大模型检测结果（默认模式的主结果） */
  llm: DetectLlmReview
  /** 零容忍判定 */
  tolerance: DetectTolerance
  generatedAt: number
}

export interface DetectOptions {
  /** 标记阈值，默认 30（零容忍：轻微及以上痕迹即标注） */
  threshold?: number
}

/** 默认标记阈值：零容忍模式下 30 分以上即标注。 */
export const DEFAULT_THRESHOLD = 30

/** 检测对象定位（用于把改写结果写回小说章节）。 */
export interface DetectorTarget {
  novelId?: string
  novelTitle?: string
  chapterIndex?: number
  chapterId?: string
  chapterTitle?: string
}

/** 打开检测窗口时携带的载荷。 */
export interface DetectorOpenPayload {
  /** 预填文本（如小说当前章节正文） */
  text?: string
  /** 来源标题（用于窗口副标题与报告） */
  title?: string
  /** 来源说明，如「小说工作区 · 第 3 章」 */
  source?: string
  /** 复核接口配置（来自小说工作区的 AI 设置） */
  cfg?: DetectorCfg
  /** 写回目标（小说章节） */
  target?: DetectorTarget
  /** 是否在打开后立即执行检测 */
  autoRun?: boolean
}

/** 把改写结果写回小说章节。 */
export interface DetectorApplyArgs {
  text: string
  target?: DetectorTarget
}

export interface DetectorCfg {
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
}

export interface DetectorFileResult {
  ok: boolean
  name?: string
  text?: string
  warning?: string
  /** 用户取消了文件选择 */
  canceled?: boolean
  error?: string
}

export interface DetectorExportArgs {
  name?: string
  content: string
}

export interface DetectorExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/* ═══════════════════════════════════════════
   词典 / 规则
═══════════════════════════════════════════ */

/** 强特征 AI 套语（论文腔 / 总结腔，虚构叙事里极少自然出现） */
const CLICHE_STRONG_ZH = [
  '值得注意的是',
  '值得一提的是',
  '需要指出的是',
  '值得一提的是',
  '不难发现',
  '由此可见',
  '综上所述',
  '总而言之',
  '总的来说',
  '总的来讲',
  '毋庸置疑',
  '众所周知',
  '不言而喻',
  '换句话说',
  '换言之',
  '在某种程度上',
  '从某种意义上',
  '与此同时',
  '更重要的是',
  '首先',
  '其次',
  '再次',
  '最后',
  '此外',
  '综上',
  '正因如此',
  '一方面',
  '另一方面',
  '发挥着重要作用',
  '起到了关键作用',
  '具有重要意义',
  '产生深远影响',
  '不可忽视',
  '随着社会的发展',
  '随着时代的发展',
  '在这个快节奏',
  '飞速发展的时代',
  '日益增长',
  '越来越多的人',
  '不仅仅是',
  '更是一种'
]

/** 弱特征连接词（人类写作也常用，权重较低） */
const CLICHE_WEAK_ZH = ['然而', '因此', '而且', '并且', '同时', '不仅', '虽然', '从而', '进而', '以及', '其中', '关于']

/** 英文 AI 高频套语 */
const CLICHE_EN = [
  'moreover',
  'furthermore',
  'in conclusion',
  'in summary',
  'it is worth noting',
  'it is important to note',
  'delve into',
  'a testament to',
  'rich tapestry',
  'plays a crucial role',
  'plays a vital role',
  "in today's fast-paced world",
  'in the ever-evolving',
  'navigate the complexities',
  'serves as a reminder',
  'unlock the potential',
  'when it comes to',
  'a double-edged sword',
  'the realm of',
  'not only',
  'as a result',
  'on the other hand'
]

/** 句式模板（正则，命中即为强疑似痕迹；允许分句内出现逗号，但不跨句匹配） */
const TEMPLATES_ZH = [
  /不是[^。！？\n]{1,16}而是[^。！？\n]{1,16}/g,
  /并非[^。！？\n]{1,16}而是[^。！？\n]{1,16}/g,
  /既[^。！？\n]{1,14}又[^。！？\n]{1,14}/g,
  /不仅[^。！？\n]{1,16}(还|也|更)[^。！？\n]{1,16}/g,
  /不仅在于[^。！？\n]{1,16}更在于[^。！？\n]{1,16}/g,
  /无论[^。！？\n]{1,16}(都|总)[^。！？\n]{0,16}/g,
  /(仿佛|似乎|好像|宛如|犹如)[^。！？\n]{1,20}(一般|一样|似的)/g,
  /(让|令|使)[^。！？\n]{1,12}(变得|显得|感到|陷入)/g,
  /(随着|伴随着)[^。！？\n]{1,16}(的|地|而)/g,
  /(是|成为|成了)[^。！？\n]{1,12}的(开始|缩影|写照|见证|象征|一部分|意义|证明)/g,
  /(或许|也许|大概)[，,][^。！？\n]{1,18}(吧|了|的)[。！？]/g,
  /(这一切|而这|这或许|这也许)[^。！？\n]{1,20}[。！？]/g,
  /[^，。！？；\n]{2,12}[，,](是|也是|更是)[^，。！？；\n]{2,12}[，,](也是|更是|同样是)[^，。！？；\n]{2,12}/g
]

const TEMPLATES_EN = [
  /not only[^.!?\n]{1,30}but also/gi,
  /it is not[^.!?\n]{1,20}but rather/gi,
  /(as if|as though)[^.!?\n]{1,30}/gi,
  /(a|an) (testament|reminder|symbol) (to|of)/gi,
  /from [^.!?\n]{1,20} to [^.!?\n]{1,20},/gi
]

/** 抽象抒情 / 意象套语（AI 小说最典型的"万能句"） */
const IMAGERY_ZH = [
  /(一种|一股|一丝|一抹|一份)[^，。！？；\n]{1,10}的(感觉|情绪|力量|暖意|凉意|孤独|希望|悲伤|喜悦|存在|味道|气息|温柔|坚定)/g,
  /(心中|心底|心里|胸口)(涌起|升起|泛起|掠过|划过|蔓延|泛起)/g,
  /(眼中|眼底|眼里|眸光)(闪过|划过|掠过|浮现|泛起)/g,
  /嘴角(勾起|扬起|浮现|挂起)/g,
  /(空气|四周|周围|房间|屋子)(里|中)?(弥漫|充满|飘着|萦绕)/g,
  /(说不出|无法言喻|难以名状|前所未有)的/g,
  /(时光|岁月|记忆|命运|世界|灵魂|温度|气息|目光|沉默|孤独|温柔|远方|人间)(的|在|里|中)/g,
  /(再也|再也无法|不由自主|情不自禁|鬼使神差|下意识)/g
]

/** 反光收尾（段末升华句） */
const REFLECTIVE_END_ZH = /(或许|也许|大概|毕竟|终究|原来)[^。！？\n]{0,20}(吧|了|的|呢)[。！？]\s*$/

/** 中文语气词 / 口语碎片 */
const COLLOQUIAL_ZH = /[吧呢啊吗嘛呗哦呀啦咯喽哎嗯哼喂诶]|(?:的话|一样|什么的|来着|似的|得慌)/g

/** 具体信息锚点：数字、数量短语、时间、地点（避免把"一个"这类泛指算作具体信息） */
const CONCRETE_ZH =
  /[0-9０-９]|(?:[一二三四五六七八九十百千万两几半0-9]+)(?:个人|个|只|条|张|件|把|座|间|杯|辆|片|颗|朵|根|本|页|步|层|米|公里|天|年|月|日|点|分|秒|岁|次|回|遍|声|句|块|毛|位|名|家|口|户|群|堆|排|列|段|顿|碗|桶|双|束|阵|成|截)|(?:今天|昨天|明天|第二天|那天|那年|当天|次年|清晨|傍晚|深夜|午后|黄昏|凌晨|早上|中午|晚上|上午|下午|昨晚|刚才|春天|夏天|秋天|冬天)|(?:省|市|县|区|镇|村|街|路|巷|号楼)/g

const CONCRETE_EN =
  /\b\d+\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi

/** 英文口语 / 缩略（AI 正式文体很少用） */
const COLLOQUIAL_EN = /\b\w+'(s|t|re|ve|ll|d|m)\b/gi

/** 常用四字成语 / 四字格（AI 抒情散文的高频填充物） */
const IDIOMS_ZH = [
  '一如既往', '不由自主', '不约而同', '心照不宣', '若有所思', '恍然大悟', '措手不及', '无动于衷',
  '无能为力', '无可奈何', '迫不及待', '小心翼翼', '络绎不绝', '川流不息', '熙熙攘攘', '万籁俱寂',
  '鸦雀无声', '悄然无声', '悄无声息', '夜深人静', '晨曦微露', '绚丽多彩', '五彩斑斓', '波光粼粼',
  '潺潺流水', '鸟语花香', '生机勃勃', '郁郁葱葱', '银装素裹', '漫天飞舞', '纷至沓来', '接踵而至',
  '蜂拥而至', '此起彼伏', '油然而生', '突如其来', '刻骨铭心', '记忆犹新', '历历在目', '历久弥新',
  '恍如隔世', '光阴似箭', '岁月如梭', '时光荏苒', '白驹过隙', '沧海桑田', '物是人非', '世事无常',
  '浮想联翩', '思绪万千', '感慨万千', '百感交集', '五味杂陈', '心如止水', '心潮澎湃', '热血沸腾',
  '怦然心动', '心旷神怡', '如释重负', '如坐针毡', '辗转反侧', '寝食难安', '不知所措', '茫然若失',
  '怅然若失', '失魂落魄', '魂牵梦萦', '念念不忘', '心心念念', '夜不能寐', '默默无闻', '不言而喻',
  '独一无二', '至关重要', '举足轻重', '无可厚非', '理所当然', '顺理成章', '水到渠成', '循序渐进',
  '与日俱增', '层出不穷', '屡见不鲜', '不胜枚举', '显而易见', '一针见血', '恰如其分', '恰到好处',
  '淋漓尽致', '栩栩如生', '惟妙惟肖', '入木三分', '跃然纸上', '意味深长', '耐人寻味', '发人深省',
  '引人深思', '无以复加', '油然而生', '挥之不去', '历久弥坚'
]

const METRIC_WEIGHTS: Record<string, number> = {
  rhythm: 0.16,
  paragraph: 0.1,
  cliche: 0.16,
  template: 0.14,
  imagery: 0.1,
  punct: 0.08,
  lexical: 0.1,
  repeat: 0.08,
  concrete: 0.08
}

const LEVEL_TEXT: Record<DetectLevel, string> = {
  human: '人类写作特征明显',
  light: '轻微 AI 痕迹',
  mid: '中度疑似 AI 生成',
  high: '高度疑似 AI 生成'
}

/* ═══════════════════════════════════════════
   基础工具
═══════════════════════════════════════════ */

export function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function mean(list: number[]): number {
  if (!list.length) return 0
  let sum = 0
  for (const v of list) sum += v
  return sum / list.length
}

function stdDev(list: number[]): number {
  if (list.length < 2) return 0
  const m = mean(list)
  let acc = 0
  for (const v of list) acc += (v - m) * (v - m)
  return Math.sqrt(acc / (list.length - 1))
}

/** 变异系数（标准差 / 均值），衡量"节奏波动"：越低越像 AI。 */
function cv(list: number[]): number {
  const m = mean(list)
  return m > 0 ? stdDev(list) / m : 0
}

/** 正文有效字符数（剔除空白、标点、符号）。 */
export function contentChars(text: string): number {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '').length
}

/** 文本语言判定：中日韩字符占比。 */
export function detectLang(text: string): DetectLang {
  const src = String(text ?? '')
  const cjk = (src.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  const latin = (src.match(/[A-Za-z]/g) || []).length
  if (cjk === 0 && latin === 0) return 'zh'
  return cjk >= latin * 0.2 ? 'zh' : 'en'
}

export function detectLevel(score: number): DetectLevel {
  if (score < 30) return 'human'
  if (score < 50) return 'light'
  if (score < 70) return 'mid'
  return 'high'
}

export function levelText(level: DetectLevel): string {
  return LEVEL_TEXT[level]
}

/**
 * 零容忍判定（默认规则，逐条可查）：
 * 1. 大模型检测必须完成（无结论一律不通过）
 * 2. AI 率 < 30%
 * 3. 没有「高」等级指认（模型明确指出的强痕迹）
 * 4. 指认句少于 3 处（偶发单句可能是误判，成片才是 AI 腔）
 * 任一条件不满足即判为不通过。
 * `strictAnyMark=true` 时改用最严格规则：只要存在任意指认句就不通过。
 */
export function evaluateTolerance(input: {
  mode: DetectMode
  llm: DetectLlmReview
  /** 仅算法模式下的算法分（仅供参考） */
  algorithmScore?: number
  markedCount: number
  /** 指认句中「高」等级的数量 */
  highSeverityCount?: number
  /** 最严格规则：任意指认即不通过 */
  strictAnyMark?: boolean
}): DetectTolerance {
  const { mode, llm, markedCount } = input
  const algorithmScore = input.algorithmScore ?? 0
  const highCount = input.highSeverityCount ?? llm.highSeverity ?? 0
  const strictAny = input.strictAnyMark === true

  if (mode === 'algorithm') {
    return {
      pass: false,
      label: '仅算法模式 · 未作零容忍认定',
      advice: '当前只跑了离线算法，没有大模型参与判定。取消勾选「只依赖算法检测」即可用大模型重新检测。',
      reasons: [
        '本章检测未调用大模型：按零容忍规则，仅算法结果不足以认定通过',
        `算法倾向 ${Math.round(algorithmScore)}%（仅供参考）`
      ],
      strictScore: Math.round(clamp(algorithmScore)),
      rule: 'algorithm',
      conditions: [
        { id: 'detect', label: '由大模型完成检测', value: '未执行', pass: false },
        { id: 'score', label: `AI 率 < ${ZERO_TOLERANCE_SCORE}%`, value: `${Math.round(algorithmScore)}%（算法）`, pass: algorithmScore < ZERO_TOLERANCE_SCORE }
      ]
    }
  }

  const llmScore = llm.used && llm.ok && typeof llm.score === 'number' ? llm.score : null
  const detected = llmScore !== null
  const conditions: DetectCondition[] = [
    {
      id: 'detect',
      label: '大模型检测完成',
      value: detected ? '已完成' : llm.used ? '失败' : '未执行',
      pass: detected
    },
    {
      id: 'score',
      label: `AI 率 < ${ZERO_TOLERANCE_SCORE}%`,
      value: detected ? `${Math.round(llmScore as number)}%` : '—',
      pass: detected && (llmScore as number) < ZERO_TOLERANCE_SCORE
    }
  ]
  if (strictAny) {
    conditions.push({
      id: 'count',
      label: '没有任何指认句（最严格规则）',
      value: `${markedCount} 处`,
      pass: markedCount === 0
    })
  } else {
    conditions.push({
      id: 'severity',
      label: '没有「高」等级指认',
      value: `${highCount} 处`,
      pass: highCount === 0
    })
    conditions.push({
      id: 'count',
      label: `指认句 < ${ZERO_TOLERANCE_MARK_LIMIT} 处`,
      value: `${markedCount} 处`,
      pass: markedCount < ZERO_TOLERANCE_MARK_LIMIT
    })
  }

  const reasons: string[] = []
  if (!detected) {
    reasons.push(
      !llm.used
        ? '大模型检测未执行：零容忍模式必须先完成一次大模型检测'
        : `大模型检测失败${llm.error ? `（${llm.error}）` : ''}：请检查小说工作区配置的接口后重新检测`
    )
  } else {
    if ((llmScore as number) >= ZERO_TOLERANCE_SCORE) {
      reasons.push(`AI 率 ${Math.round(llmScore as number)}%，未低于判定线 ${ZERO_TOLERANCE_SCORE}%`)
    }
    if (strictAny) {
      if (markedCount > 0) reasons.push(`最严格规则下存在 ${markedCount} 处指认句`)
    } else {
      if (highCount > 0) reasons.push(`存在 ${highCount} 处「高」等级 AI 痕迹指认`)
      if (markedCount >= ZERO_TOLERANCE_MARK_LIMIT) {
        reasons.push(`指认句 ${markedCount} 处，达到成片阈值（${ZERO_TOLERANCE_MARK_LIMIT} 处）`)
      }
    }
  }

  const pass = reasons.length === 0
  const markedNote = strictAny
    ? '（最严格规则：任意指认即不通过）'
    : `（标准规则：AI 率 < ${ZERO_TOLERANCE_SCORE}% 且无「高」等级指认、指认句少于 ${ZERO_TOLERANCE_MARK_LIMIT} 处）`
  return {
    pass,
    label: pass ? '通过 · 未检出 AI 痕迹' : '不通过 · 检出 AI 痕迹',
    advice: pass
      ? `已满足全部判定条件${markedNote}，可继续创作。`
      : `未满足的判定条件见上${markedNote}；可用「一键降低 AI 率」改写后自动复检。`,
    reasons,
    strictScore: Math.round(clamp(llmScore ?? 0)),
    rule: strictAny ? 'strict-any' : 'standard',
    conditions
  }
}

/** 切换「最严格规则」后重新计算判定（不重跑检测）。 */
export function withStrictRule(report: DetectReport, strictAnyMark: boolean): DetectReport {
  const markedCount = report.sentences.filter((s) => s.score >= report.threshold).length
  if (report.mode === 'algorithm') {
    return { ...report, tolerance: evaluateTolerance({ mode: 'algorithm', llm: report.llm, algorithmScore: report.rawScore, markedCount, strictAnyMark }) }
  }
  return {
    ...report,
    tolerance: evaluateTolerance({
      mode: 'llm',
      llm: report.llm,
      markedCount,
      highSeverityCount: report.llm.highSeverity ?? 0,
      strictAnyMark
    })
  }
}

export interface TextSegment {
  text: string
  start: number
  end: number
  index: number
}

const STRONG_END = new Set(['。', '！', '？', '!', '?', '…'])
const SOFT_END = new Set(['；', ';'])
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '》', '〉', '"', "'", '】', ']'])

/** 断句：强终止符切分，引号/括号跟随前句；换行视为句边界。 */
export function splitSentences(text: string): TextSegment[] {
  const src = String(text ?? '')
  const out: TextSegment[] = []
  let start = -1
  let i = 0
  const push = (endExclusive: number): void => {
    if (start < 0) return
    const rawSeg = src.slice(start, endExclusive)
    const lead = rawSeg.search(/\S/)
    if (lead >= 0) {
      const body = rawSeg.replace(/\s+$/, '')
      if (body.trim()) {
        out.push({ text: body, start: start + lead, end: start + body.length, index: out.length })
      }
    }
    start = -1
  }
  while (i < src.length) {
    const ch = src[i]
    if (start < 0) {
      if (/\s/.test(ch)) {
        i++
        continue
      }
      start = i
    }
    if (STRONG_END.has(ch)) {
      let j = i + 1
      while (j < src.length && STRONG_END.has(src[j])) j++
      while (j < src.length && CLOSERS.has(src[j])) j++
      push(j)
      i = j
      continue
    }
    if (ch === '\n') {
      push(i)
      i++
      continue
    }
    if (SOFT_END.has(ch) && i - start >= 26) {
      push(i + 1)
      i++
      continue
    }
    i++
  }
  push(src.length)
  return out
}

function splitLines(src: string): TextSegment[] {
  const out: TextSegment[] = []
  let start = 0
  for (let i = 0; i <= src.length; i++) {
    if (i === src.length || src[i] === '\n') {
      out.push({ text: src.slice(start, i), start, end: i, index: out.length })
      start = i + 1
    }
  }
  return out
}

/**
 * 分段：空行分块；块内若"每行都是完整句且行较短"（中文网络小说常见排版），
 * 则按行成段，否则整块视为一段。
 */
export function splitParagraphs(text: string): TextSegment[] {
  const src = String(text ?? '')
  const out: TextSegment[] = []
  let group: TextSegment[] = []

  const flush = (): void => {
    if (!group.length) return
    const items = group.filter((l) => l.text.trim())
    if (!items.length) {
      group = []
      return
    }
    const perLine =
      items.length > 1 &&
      items.every((l) => /[。！？…”」』.!?]$/.test(l.text.trim())) &&
      items.every((l) => l.text.trim().length <= 64)
    if (perLine) {
      for (const l of items) {
        const s = l.start + (l.text.length - l.text.trimStart().length)
        const e = l.start + l.text.trimEnd().length
        out.push({ text: src.slice(s, e), start: s, end: e, index: out.length })
      }
    } else {
      const first = items[0]
      const last = items[items.length - 1]
      const s = first.start + (first.text.length - first.text.trimStart().length)
      const e = last.start + last.text.trimEnd().length
      out.push({ text: src.slice(s, e), start: s, end: e, index: out.length })
    }
    group = []
  }

  for (const line of splitLines(src)) {
    if (!line.text.trim()) {
      flush()
      continue
    }
    group.push(line)
  }
  flush()
  return out
}

interface PatternHit {
  text: string
  start: number
  end: number
}

/** 收集正则命中片段（自动重置 lastIndex，正则需带 g 标志）。 */
function findHits(text: string, patterns: RegExp[]): PatternHit[] {
  const out: PatternHit[] = []
  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) {
        re.lastIndex++
        continue
      }
      out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
      if (out.length > 4000) return out
    }
  }
  return out
}

/** 统计关键词命中次数（中文直接包含匹配，英文按单词边界）。 */
function countKeywords(text: string, keywords: string[]): number {
  let count = 0
  for (const kw of keywords) {
    if (!kw) continue
    if (/^[a-z' ]+$/i.test(kw)) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
      count += (text.match(re) || []).length
    } else {
      let from = 0
      for (;;) {
        const at = text.indexOf(kw, from)
        if (at < 0) break
        count++
        from = at + kw.length
      }
    }
  }
  return count
}

function hitInRange(hits: PatternHit[], start: number, end: number): PatternHit[] {
  return hits.filter((h) => h.start >= start && h.end <= end)
}

function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0'
}

/* ═══════════════════════════════════════════
   主流程
═══════════════════════════════════════════ */

export function analyzeText(raw: string, options: DetectOptions = {}): DetectReport {
  const text = String(raw ?? '')
  const threshold = clamp(Math.round(options.threshold ?? DEFAULT_THRESHOLD), 10, 95)
  const lang = detectLang(text)
  const sentences = splitSentences(text)
  const paragraphs = splitParagraphs(text)
  const chars = text.length
  const content = contentChars(text)
  const per1000 = (n: number): number => (content > 0 ? (n * 1000) / content : 0)

  const sentenceLens = sentences.map((s) => contentChars(s.text))
  const avgSentence = mean(sentenceLens)
  const sentenceCv = cv(sentenceLens)
  const paraLens = paragraphs.map((p) => p.text ? contentChars(p.text) : 0)
  const paraCv = cv(paraLens.filter((n) => n > 0))

  /* ---- 词典 / 规则命中 ---- */
  const clicheStrong = lang === 'zh' ? countKeywords(text, CLICHE_STRONG_ZH) : countKeywords(text, CLICHE_EN)
  const clicheWeak = lang === 'zh' ? countKeywords(text, CLICHE_WEAK_ZH) : 0
  const clicheHits = clicheStrong + clicheWeak * 0.4
  const templateHits = findHits(text, lang === 'zh' ? TEMPLATES_ZH : TEMPLATES_EN)
  const imageryHits = lang === 'zh' ? findHits(text, IMAGERY_ZH) : []
  const colloquialHits = (text.match(lang === 'zh' ? COLLOQUIAL_ZH : COLLOQUIAL_EN) || []).length
  const concreteHits = (text.match(lang === 'zh' ? CONCRETE_ZH : CONCRETE_EN) || []).length
  const idiomHits = lang === 'zh' ? countIdioms(text) : 0
  const exclaim = (text.match(/[！!]/g) || []).length
  const ellipsis = (text.match(/…|\.\.\./g) || []).length
  const dash = (text.match(/——|—|--/g) || []).length

  /* ---- 用词丰富度 ---- */
  const bodyChars = (text.match(/[\u4e00-\u9fa5a-zA-Z0-9]/g) || []) as string[]
  const charCount = new Map<string, number>()
  for (const c of bodyChars) charCount.set(c.toLowerCase(), (charCount.get(c.toLowerCase()) || 0) + 1)
  const distinct = charCount.size
  const distinctCharRatio = bodyChars.length > 0 ? distinct / bodyChars.length : 0
  const hapax = [...charCount.values()].filter((n) => n === 1).length
  const hapaxRatio = distinct > 0 ? hapax / distinct : 0

  /* ---- 重复度 ---- */
  const flat = bodyChars.join('')
  const repeatRatio = ngramRepeatRatio(flat, 8)
  const sentenceCount = new Map<string, number>()
  for (const s of sentences) {
    const key = contentChars(s.text) >= 6 ? s.text.replace(/[\s\p{P}\p{S}]/gu, '') : ''
    if (key) sentenceCount.set(key, (sentenceCount.get(key) || 0) + 1)
  }
  const dupSentences = [...sentenceCount.entries()].filter(([, n]) => n > 1)
  const dupSentenceCount = dupSentences.reduce((sum, [, n]) => sum + n, 0)
  const dupSentenceRatio = sentences.length > 0 ? dupSentenceCount / sentences.length : 0
  const openerCount = new Map<string, number>()
  for (const s of sentences) {
    const key = (s.text.match(/[\u4e00-\u9fa5a-zA-Z]{2}/) || [''])[0]
    if (key) openerCount.set(key, (openerCount.get(key) || 0) + 1)
  }
  const topOpener = [...openerCount.values()].sort((a, b) => b - a)[0] || 0
  const openerRepeat = sentences.length > 4 ? topOpener / sentences.length : 0

  /* ---- 各维度得分（0-100，越高越像 AI） ---- */
  // 文本过短时，需要统计样本的维度（段落结构 / 用词丰富度 / 重复度）不参与加权，避免噪声
  const sampleEnough = content >= 600 && sentences.length >= 8
  const paragraphEnough = paragraphs.length >= 6
  const rhythmScore = clamp(0.6 * clamp(((0.78 - sentenceCv) / 0.53) * 100) + 0.4 * clamp((nearMeanRatio(sentenceLens, avgSentence, 0.18) - 0.3) / 0.5 * 100))
  const paragraphScore = clamp(
    0.6 * clamp(((0.95 - paraCv) / 0.6) * 100) +
      0.4 * clamp((sentencesPerParagraphUniformity(sentences, paragraphs) - 0.3) / 0.6 * 100)
  )
  const clicheScore = clamp((per1000(clicheHits) / 6) * 100)
  const templateScore = clamp((per1000(templateHits.length) / 5) * 100)
  const imageryScore = clamp((per1000(imageryHits.length) / 4) * 100)
  const punctScore = clamp(
    0.5 * clamp(((2.4 - per1000(colloquialHits)) / 2.4) * 100) +
      0.25 * clamp(((1.6 - per1000(exclaim)) / 1.6) * 100) +
      0.25 * clamp(((1.2 - per1000(ellipsis + dash)) / 1.2) * 100)
  )
  const lexicalScore = sampleEnough
    ? clamp(0.6 * clamp(((0.46 - distinctCharRatio) / 0.16) * 100) + 0.4 * clamp(((0.6 - hapaxRatio) / 0.24) * 100))
    : 45
  const repeatScore = sampleEnough
    ? clamp(
        0.5 * clamp(((repeatRatio - 0.02) / 0.1) * 100) +
          0.3 * clamp((dupSentenceRatio / 0.08) * 100) +
          0.2 * clamp(((openerRepeat - 0.08) / 0.16) * 100)
      )
    : 45
  const concreteScore = clamp(((10 - per1000(concreteHits)) / 10) * 100)

  const metrics: DetectMetric[] = [
    {
      id: 'rhythm',
      label: '句长节奏',
      score: rhythmScore,
      value: `句长波动 ${fixed(sentenceCv)}，均值 ${Math.round(avgSentence)} 字`,
      weight: METRIC_WEIGHTS.rhythm,
      hint: '人类句子长短参差（波动通常 0.5 以上），AI 句子长度高度均匀。'
    },
    {
      id: 'paragraph',
      label: '段落结构',
      score: paragraphScore,
      value: paragraphEnough
        ? `${paragraphs.length} 段，段落长度波动 ${fixed(paraCv)}`
        : `段落数较少（${paragraphs.length} 段），本项不参与加权`,
      weight: METRIC_WEIGHTS.paragraph,
      skipped: !paragraphEnough,
      hint: 'AI 段落长短、句数过于工整，人类段落随情绪起伏。'
    },
    {
      id: 'cliche',
      label: 'AI 套语',
      score: clicheScore,
      value: `每千字 ${fixed(per1000(clicheHits), 1)} 处`,
      weight: METRIC_WEIGHTS.cliche,
      hint: '「值得注意的是 / 综上所述 / moreover」等过渡与总结套语密度。'
    },
    {
      id: 'template',
      label: '句式模板',
      score: templateScore,
      value: `每千字 ${fixed(per1000(templateHits.length), 1)} 处`,
      weight: METRIC_WEIGHTS.template,
      hint: '「不是…而是…」「仿佛…一般」「不仅…还…」等模板化句法。'
    },
    {
      id: 'imagery',
      label: '抽象抒情套语',
      score: imageryScore,
      value: `每千字 ${fixed(per1000(imageryHits.length), 1)} 处`,
      weight: METRIC_WEIGHTS.imagery,
      hint: '「心中涌起一股…」「空气中弥漫着…」等意象万能句。'
    },
    {
      id: 'punct',
      label: '口语与标点',
      score: punctScore,
      value: `语气词/缩略 ${fixed(per1000(colloquialHits), 1)}/千字，感叹号 ${exclaim}，省略号 ${ellipsis}`,
      weight: METRIC_WEIGHTS.punct,
      hint: '人类写作口语碎片、语气词、省略号更多；AI 标点过于规范。'
    },
    {
      id: 'lexical',
      label: '用词丰富度',
      score: lexicalScore,
      value: sampleEnough
        ? `去重字符比 ${fixed(distinctCharRatio)}，一次性字符比 ${fixed(hapaxRatio)}，四字成语 ${fixed(per1000(idiomHits), 1)}/千字`
        : `文本较短（${content} 字），用字统计不可靠，本项不参与加权`,
      weight: METRIC_WEIGHTS.lexical,
      skipped: !sampleEnough,
      hint: 'AI 倾向反复使用同一批高频字词，用字分布更集中。'
    },
    {
      id: 'repeat',
      label: '复读与重复',
      score: repeatScore,
      value: sampleEnough
        ? `重复 8-gram 占比 ${fixed(repeatRatio * 100, 1)}%，重复句占比 ${fixed(dupSentenceRatio * 100, 1)}%，最高频句首占比 ${fixed(openerRepeat * 100, 1)}%`
        : `文本较短（${content} 字），重复度统计不可靠，本项不参与加权`,
      weight: METRIC_WEIGHTS.repeat,
      skipped: !sampleEnough,
      hint: '重复句式、重复短句、重复句首是 AI 续写的典型残留。'
    },
    {
      id: 'concrete',
      label: '具体信息密度',
      score: concreteScore,
      value: `每千字 ${fixed(per1000(concreteHits), 1)} 处数字/量词/时空锚点`,
      weight: METRIC_WEIGHTS.concrete,
      hint: '人类叙事信息更具体（时间、地点、数量），AI 更爱抽象概括。'
    }
  ]

  // 只在可计算的维度上归一化权重（短文本会跳过用字/重复度两项）
  const activeWeight = metrics.reduce((sum, m) => sum + (m.skipped ? 0 : m.weight), 0) || 1
  const rawScore = clamp(metrics.reduce((sum, m) => sum + (m.skipped ? 0 : m.score * m.weight), 0) / activeWeight)

  /* ---- 逐句标注 ---- */
  const dupKeys = new Set(dupSentences.map(([key]) => key))
  const meanLen = avgSentence
  // 全文节奏底色：整篇句长高度均匀时，每个句子都分到一份"工整"印象
  const rhythmBase = sentenceCv < 0.6 && sentences.length >= 5 ? clamp(((0.6 - sentenceCv) / 0.45) * 100) * 0.14 : 0
  const sentenceSegments: DetectSegment[] = sentences.map((s) => {
    const localTemplates = hitInRange(templateHits, s.start, s.end)
    const localImagery = hitInRange(imageryHits, s.start, s.end)
    const localStrong = countKeywords(s.text, lang === 'zh' ? CLICHE_STRONG_ZH : CLICHE_EN)
    const localWeak = lang === 'zh' ? countKeywords(s.text, CLICHE_WEAK_ZH) : 0
    const len = contentChars(s.text)
    const commas = (s.text.match(/[，,]/g) || []).length
    const localIdioms = lang === 'zh' ? countIdioms(s.text) : 0
    const localCollo = (s.text.match(lang === 'zh' ? COLLOQUIAL_ZH : COLLOQUIAL_EN) || []).length
    const isDialogue = /^[“「"']/.test(s.text.trim())
    const key = len >= 6 ? s.text.replace(/[\s\p{P}\p{S}]/gu, '') : ''
    const flags: DetectFlag[] = []

    let evidence = 0
    if (localStrong > 0) {
      const w = Math.min(40, 25 * Math.min(2, localStrong))
      evidence += w
      flags.push({ id: 'cliche', label: 'AI 高频套语', detail: firstKeyword(s.text, lang === 'zh' ? CLICHE_STRONG_ZH : CLICHE_EN), weight: w })
    }
    if (localWeak >= 2) {
      evidence += 8
      flags.push({ id: 'cliche', label: '连接词堆叠', detail: `${localWeak} 个过渡连接词`, weight: 8 })
    }
    if (localTemplates.length) {
      const w = Math.min(45, 26 * Math.min(2, localTemplates.length))
      evidence += w
      flags.push({ id: 'template', label: '句式模板', detail: localTemplates[0].text.trim().slice(0, 24), weight: w })
    }
    if (localImagery.length) {
      const w = Math.min(40, 20 * Math.min(2, localImagery.length))
      evidence += w
      flags.push({ id: 'abstract', label: '抽象抒情套语', detail: localImagery[0].text.trim().slice(0, 24), weight: w })
    }
    if (commas >= 5) {
      evidence += 16
      flags.push({ id: 'template', label: '长逗号链', detail: `单句 ${commas} 个逗号，欧化长句`, weight: 16 })
    } else if (commas >= 3) {
      evidence += 9
      flags.push({ id: 'rhythm', label: '长逗号链', detail: `单句 ${commas} 个逗号`, weight: 9 })
    }
    if (rhythmBase >= 6 && meanLen > 0 && len >= 10 && Math.abs(len - meanLen) <= 0.3 * meanLen) {
      const w = Math.round(rhythmBase)
      evidence += w
      // 只有句子本身已具备可疑度时才记录这条"节奏印记"，避免整篇每句都挂同一条痕迹
      if (evidence >= 25) {
        flags.push({
          id: 'rhythm',
          label: '节奏过于工整',
          detail: `句长 ${len} 字贴近全文均值 ${Math.round(meanLen)} 字（全文波动仅 ${fixed(sentenceCv)}）`,
          weight: w
        })
      }
    }
    if (localIdioms >= 2) {
      evidence += 10
      flags.push({ id: 'template', label: '成语堆叠', detail: `${localIdioms} 个四字成语`, weight: 10 })
    }
    if (REFLECTIVE_END_ZH.test(s.text) && lang === 'zh') {
      evidence += 15
      flags.push({ id: 'abstract', label: '段末升华句', detail: '结尾套用"或许…吧"式反思', weight: 15 })
    }
    if (key && dupKeys.has(key)) {
      evidence += 26
      flags.push({ id: 'repetition', label: '重复句', detail: '全文出现多次的相同句子', weight: 26 })
    }
    if (isDialogue && localCollo === 0) {
      evidence += 5
      flags.push({ id: 'punct', label: '对话缺口语感', detail: '对话句中无语气词/口语碎片', weight: 5 })
    }
    const localConcrete = (s.text.match(lang === 'zh' ? CONCRETE_ZH : CONCRETE_EN) || []).length
    if (len >= 24 && localConcrete === 0) {
      evidence += 5
      flags.push({ id: 'concrete', label: '缺少具体信息', detail: '长句中无数字/量词/时空锚点', weight: 5 })
    }

    const clamped = clamp(evidence)
    return {
      index: s.index,
      kind: 'sentence' as const,
      start: s.start,
      end: s.end,
      text: s.text,
      score: Math.round(clamped),
      level: detectLevel(clamped),
      flags
    }
  })

  const paragraphSegments: DetectSegment[] = paragraphs.map((p) => {
    const inner = sentenceSegments.filter((s) => s.start >= p.start && s.end <= p.end)
    const base = inner.length ? mean(inner.map((s) => s.score)) : clamp(concreteScore * 0.5)
    const allSuspicious = inner.length >= 3 && inner.every((s) => s.score >= 45)
    const score = clamp(base + (allSuspicious ? 8 : 0))
    const flagMap = new Map<DetectFlagId, DetectFlag>()
    for (const s of inner) {
      for (const f of s.flags) {
        const prev = flagMap.get(f.id)
        if (!prev) flagMap.set(f.id, { ...f, detail: f.detail })
        else prev.weight += f.weight
      }
    }
    return {
      index: p.index,
      kind: 'paragraph' as const,
      start: p.start,
      end: p.end,
      text: p.text,
      score: Math.round(score),
      level: detectLevel(score),
      flags: [...flagMap.values()].sort((a, b) => b.weight - a.weight)
    }
  })

  const flagCount = new Map<DetectFlagId, { label: string; count: number }>()
  for (const s of sentenceSegments) {
    for (const f of s.flags) {
      const prev = flagCount.get(f.id)
      if (prev) prev.count += 1
      else flagCount.set(f.id, { label: f.label, count: 1 })
    }
  }
  const flagsTop = [...flagCount.entries()]
    .map(([id, v]) => ({ id, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count)

  /* ---- 置信度：文本越短越不确定 ---- */
  const confidence =
    content >= 2000 ? 0.95 : content >= 900 ? 0.88 : content >= 300 ? 0.7 : content >= 150 ? 0.58 : content >= 60 ? 0.45 : 0.32
  const score = Math.round(clamp(50 + (rawScore - 50) * confidence))
  const level = detectLevel(score)
  const marked = sentenceSegments.filter((s) => s.score >= threshold)

  const stats: DetectStats = {
    chars,
    contentChars: content,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avgSentence: Math.round(avgSentence * 10) / 10,
    sentenceCv: Math.round(sentenceCv * 1000) / 1000,
    paraCv: Math.round(paraCv * 1000) / 1000,
    clichePer1000: Math.round(per1000(clicheHits) * 10) / 10,
    templatePer1000: Math.round(per1000(templateHits.length) * 10) / 10,
    abstractPer1000: Math.round(per1000(imageryHits.length) * 10) / 10,
    colloquialPer1000: Math.round(per1000(colloquialHits) * 10) / 10,
    concretePer1000: Math.round(per1000(concreteHits) * 10) / 10,
    distinctCharRatio: Math.round(distinctCharRatio * 1000) / 1000,
    repeatRatio: Math.round(repeatRatio * 1000) / 1000
  }

  const topNorm = [...metrics]
    .filter((m) => !m.skipped)
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .slice(0, 2)
  const summary = buildSummary({ score, level, stats, markedCount: marked.length, top: topNorm, confidence })
  const llm: DetectLlmReview = { used: false, reasons: [], flagged: [] }

  return {
    mode: 'algorithm',
    score,
    rawScore: Math.round(rawScore),
    level,
    verdict: LEVEL_TEXT[level],
    confidence,
    summary,
    lang,
    metrics: metrics.map((m) => ({ ...m, score: Math.round(m.score), value: m.value })),
    sentences: sentenceSegments,
    paragraphs: paragraphSegments,
    flagsTop,
    stats,
    threshold,
    llm,
    tolerance: evaluateTolerance({ mode: 'algorithm', llm, algorithmScore: rawScore, markedCount: marked.length }),
    generatedAt: Date.now()
  }
}

function buildSummary(input: {
  score: number
  level: DetectLevel
  stats: DetectStats
  markedCount: number
  top: DetectMetric[]
  confidence: number
}): string {
  const { score, stats, markedCount, top, confidence } = input
  const parts: string[] = []
  parts.push(`全文 ${stats.contentChars.toLocaleString('zh-CN')} 字 / ${stats.sentences} 句 / ${stats.paragraphs} 段`)
  parts.push(`综合 AI 率 ${score}%，命中 ${markedCount} 处疑似痕迹`)
  if (top.length) {
    parts.push(`最突出特征：${top.map((m) => `${m.label}（${m.value}）`).join('、')}`)
  }
  if (confidence < 0.7) parts.push('文本较短，置信度中等，建议提供更长的段落再判断')
  return `${parts.join('；')}。`
}

function nearMeanRatio(list: number[], m: number, tolerance: number): number {
  if (!list.length || m <= 0) return 0
  const near = list.filter((v) => Math.abs(v - m) <= tolerance * m).length
  return near / list.length
}

/** 每段句子数的一致性：越接近 1 说明段段句数相同（AI 特征）。 */
function sentencesPerParagraphUniformity(sentences: TextSegment[], paragraphs: TextSegment[]): number {
  if (paragraphs.length < 3) return 0.4
  const counts = paragraphs.map((p) => sentences.filter((s) => s.start >= p.start && s.end <= p.end).length)
  const m = mean(counts)
  if (m <= 0) return 0.4
  const same = counts.filter((c) => Math.abs(c - m) <= 0.5).length / counts.length
  return same
}

/** 重复 n-gram 占比：出现 ≥2 次的 n-gram 实例数 / 总数。 */
function ngramRepeatRatio(flat: string, n: number): number {
  if (flat.length < n * 2) return 0
  const seen = new Map<string, number>()
  for (let i = 0; i + n <= flat.length; i++) {
    const gram = flat.slice(i, i + n)
    seen.set(gram, (seen.get(gram) || 0) + 1)
  }
  let repeats = 0
  for (const count of seen.values()) if (count > 1) repeats += count
  const total = flat.length - n + 1
  return total > 0 ? repeats / total : 0
}

/** 统计四字成语命中数（按词表匹配，避免把任意四字短语都当成成语）。 */
function countIdioms(text: string): number {
  let n = 0
  for (const idiom of IDIOMS_ZH) if (text.includes(idiom)) n++
  return n
}

function firstKeyword(text: string, keywords: string[]): string {
  for (const kw of keywords) {
    if (!kw) continue
    if (/^[a-z' ]+$/i.test(kw)) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      const m = text.match(re)
      if (m) return m[0]
    } else if (text.includes(kw)) {
      return kw
    }
  }
  return '套语'
}

/* ═══════════════════════════════════════════
   大模型检测（默认主路径）
   ---------------------------------------------------------------------------
   检测完全由大模型完成：模型直接给出 AI 率、判定依据与逐条疑似痕迹。
   模型必须逐字回引原文片段（quote）用于精确高亮，句子序号仅作定位兜底。
   离线算法不参与判定，仅在用户显式勾选「只依赖算法检测」时单独使用。
═══════════════════════════════════════════ */

export interface LlmDetectPromptParts {
  system: string
  user: string
  /** 送检句子数 */
  sentSentences: number
  /** 送检文本（分块检测时为本块内容） */
  sentText: string
}

/** 单次送检的最大字符数（超出则分块检测后聚合）。 */
export const LLM_DETECT_CHUNK = 6000

/** 构造大模型检测提示词：逐句编号 + 要求逐字回引原文片段。 */
export function buildLlmDetectPrompt(
  text: string,
  options: { title?: string; part?: { index: number; total: number } } = {}
): LlmDetectPromptParts {
  const sentences = splitSentences(text)
  const body = sentences.length ? sentences.map((s, i) => `[${i + 1}] ${s.text.trim()}`).join('\n') : String(text ?? '')
  const partNote =
    options.part && options.part.total > 1
      ? `（这是全文的第 ${options.part.index}/${options.part.total} 段，请只针对本段判断）`
      : ''
  const system = [
    '你是中文文本的 AI 生成痕迹鉴定专家，只依据文本自身的语言证据判断，不猜测作者身份。',
    '你熟悉大语言模型写作的典型特征：句式模板化（"不是…而是…""仿佛…一般""不仅…还…"）、',
    '句长与段落过于均匀、论文腔过渡语（"值得注意的是""综上所述"）、意象套话（"心中涌起一股…""嘴角勾起一抹…"）、',
    '抽象抒情替代具体细节、段末强行升华、成语与排比堆叠。',
    '你也清楚人类写作的特征：句长参差、口语与语气词、具体器物与数字、对话不规整、偶有冗余与跳跃。',
    '你只输出 JSON，不写任何解释。'
  ].join('\n')
  const user = [
    `下面是一段按句编号的中文文本${options.title ? `（出自《${options.title}》）` : ''}${partNote}。`,
    '请判断它由 AI 生成的程度，并逐条指出疑似 AI 痕迹。',
    '',
    '【硬性要求】',
    '1. 只输出一个 JSON 对象，直接以 { 开头，不要写 ``` 代码块标记，不要输出任何解释文字；',
    '2. 字段：',
    '   - ai_score：0-100 的整数，整体 AI 生成概率（人类写作应低于 30，明显 AI 腔应高于 70）；',
    '   - verdict：一句话结论（不超过 20 字）；',
    '   - summary：1-2 句总体判断，说明像 AI 的原因与不确定之处；',
    '   - reasons：数组，2-4 条判定依据，每条不超过 20 字；',
    '   - suspicious：数组，列出疑似 AI 的句子（最多 20 条），元素形如',
    '     {"sentence": 12, "hint": "该句开头 8-15 个字", "reason": "为什么像 AI（不超过 20 字）", "severity": "high|mid|low"}；',
    '3. hint 只取该句开头的 8-15 个字，必须与原文逐字一致（含标点），不要整句照抄、不要改写；',
    '4. 只需给出最典型的句子，无法确定时宁可少报，不要编造；',
    '5. 不要为了"看起来有用"而一律给高分：自然的中文写作应给出低分与空数组；',
    '6. 控制输出长度：整个 JSON 尽量在 800 字以内，确保能完整输出。',
    '',
    '【文本开始】',
    body,
    '【文本结束】'
  ].join('\n')
  return { system, user, sentSentences: sentences.length, sentText: text }
}

/* ---- 长文本分块（按段落/句子边界切分，块内偏移可映射回全文） ---- */

export interface TextChunk {
  text: string
  /** 在全文中的起始偏移 */
  start: number
  /** 在全文中的结束偏移（不含） */
  end: number
}

/** 把长文本按段落边界切块；单段超长时退化为按句切分。 */
export function chunkTextWithOffsets(text: string, limit = LLM_DETECT_CHUNK): TextChunk[] {
  const src = String(text ?? '')
  if (!src.trim()) return []
  if (src.length <= limit) return [{ text: src, start: 0, end: src.length }]

  const chunks: TextChunk[] = []
  let current: TextChunk | null = null
  const flush = (): void => {
    if (current && current.text.trim()) chunks.push(current)
    current = null
  }
  const append = (start: number, end: number): void => {
    if (current && end - current.start <= limit) current = { text: src.slice(current.start, end), start: current.start, end }
    else {
      flush()
      current = { text: src.slice(start, end), start, end }
    }
  }

  let cursor = 0
  for (const block of src.split(/(\n\s*\n)/)) {
    if (!block) continue
    const blockStart = cursor
    cursor += block.length
    if (block.length <= limit) {
      append(blockStart, cursor)
      continue
    }
    flush()
    for (const sentence of splitSentences(block)) {
      append(blockStart + sentence.start, blockStart + sentence.end)
    }
  }
  flush()
  return chunks.filter((c) => c.text.trim())
}

/* ---- 解析（容错：代码块包裹 / 前后说明 / 全角引号 / 尾逗号 / 截断 / 松散字段） ---- */

/** 去掉 Markdown 代码块围栏。 */
function stripFences(raw: string): string {
  return String(raw ?? '').replace(/```[a-zA-Z]*/g, '')
}

/** 分数归一化：支持 "82"、"82%"、"0.82"。 */
function normalizeScore(value: unknown): number | null {
  let n = Number(value)
  if (!Number.isFinite(n)) {
    const m = /-?\d+(?:\.\d+)?/.exec(String(value ?? ''))
    if (!m) return null
    n = Number(m[0])
  }
  if (!Number.isFinite(n)) return null
  if (n > 0 && n <= 1) n *= 100 // 0-1 量纲
  return clamp(n)
}

/** 从 from 处扫描一个平衡的 JSON 片段（字符串感知），失败返回 null。 */
function balancedJsonAt(text: string, from: number): string | null {
  const open = text[from]
  if (open !== '{' && open !== '[') return null
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      stack.pop()
      if (!stack.length) return text.slice(from, i + 1)
    }
  }
  return null
}

/** 返回未闭合的括号栈；字符串未闭合时返回 null。 */
function openStack(text: string): string[] | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return inString ? null : stack
}

/** 尝试修复被 max_tokens 截断的 JSON：回退到最后一个完整元素并补齐括号。 */
function closeTruncatedJson(fragment: string): string | null {
  let out = fragment.trim()
  for (let guard = 0; guard < 60 && out.length > 2; guard++) {
    const trimmed = out.replace(/[,:\s]+$/, '')
    const stack = openStack(trimmed)
    if (stack) {
      if (!stack.length) return trimmed
      const closers = stack
        .slice()
        .reverse()
        .map((ch) => (ch === '{' ? '}' : ']'))
        .join('')
      return `${trimmed}${closers}`
    }
    const cut = Math.max(trimmed.lastIndexOf(','), trimmed.lastIndexOf('{'), trimmed.lastIndexOf('['))
    if (cut <= 0) return null
    out = trimmed.slice(0, cut)
  }
  return null
}

/** 字符串外的全角标点 → JSON 标点（模型常把 ，、： 当 JSON 分隔符），并清理尾随逗号。 */
function outerPunctuationFix(source: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of source) {
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '，' || ch === '、' || ch === '；') {
      out += ','
      continue
    }
    if (ch === '：') {
      out += ':'
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

/** 字符串内的裸换行/制表符 → 空格（JSON 不允许裸控制字符）。 */
function escapeControlChars(source: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of source) {
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (ch === '\n' || ch === '\r' || ch === '\t') {
        out += ' '
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

/** 中文引号作键名 / 作值定界符的针对性修复。 */
function curlyQuoteFix(source: string): string {
  return source
    .replace(/[“]([A-Za-z_][A-Za-z0-9_]*)[”](\s*[:：])/g, '"$1"$2')
    .replace(/([:：]\s*)[“]([^“”\n]*)[”]/g, '$1"$2"')
}

/**
 * 多轮修复后再解析：覆盖真实模型最常见的几类不合格输出。
 * 顺序上先做"安全"修复（不动字符串内容），不行再逐步激进。
 */
function parseWithRepairs(candidate: string): any | null {
  const attempts: string[] = []
  const push = (value: string): void => {
    if (!attempts.includes(value)) attempts.push(value)
  }
  const safe = outerPunctuationFix(candidate)
  push(candidate)
  push(escapeControlChars(safe))
  push(curlyQuoteFix(candidate))
  push(escapeControlChars(outerPunctuationFix(curlyQuoteFix(candidate))))

  // 整段没有 ASCII 引号：几乎可以确定中文引号就是定界符
  if (!candidate.includes('"')) {
    const curly = candidate.replace(/[“”]/g, '"')
    push(curly)
    push(escapeControlChars(outerPunctuationFix(curly)))
    push(escapeControlChars(outerPunctuationFix(curly).replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')))
  }

  // 最后兜底：不区分字符串内外，统一全角 → 半角
  push(
    escapeControlChars(
      candidate
        .replace(/[“”]/g, '"')
        .replace(/，|、/g, ',')
        .replace(/：/g, ':')
        .replace(/,\s*([}\]])/g, '$1')
    )
  )

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/** 把任意 JSON 对象规整为检测结果。 */
function shapeLlmResult(parsed: any): LlmDetectResult | null {
  if (!parsed || typeof parsed !== 'object') return null
  // 兼容 {result:{...}} / {data:{...}} / {检测结果:{...}} 等包裹
  const nodes: any[] = [parsed]
  for (const key of ['result', 'data', 'output', '检测结果', 'report']) {
    if (parsed[key] && typeof parsed[key] === 'object') nodes.push(parsed[key])
  }
  for (const node of nodes) {
    const score = normalizeScore(node.ai_score ?? node.aiScore ?? node.score ?? node['AI率'] ?? node.aiRate)
    if (score === null) continue
    const reasons = (Array.isArray(node.reasons) ? node.reasons : Array.isArray(node.reason) ? node.reason : [])
      .map((r: unknown) => String(r).trim())
      .filter(Boolean)
      .slice(0, 8)
    const rawList = Array.isArray(node.suspicious)
      ? node.suspicious
      : Array.isArray(node.suspicious_sentences)
        ? node.suspicious_sentences
        : Array.isArray(node.sentences)
          ? node.sentences
          : []
    const suspicious: LlmSuspiciousItem[] = []
    for (const entry of rawList) {
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        const quote = String(record.quote ?? record.text ?? record.原文 ?? '').trim()
        const hint = String(record.hint ?? record.prefix ?? record.句首 ?? '').trim()
        const sentenceRaw = Number(record.sentence ?? record.index ?? record.序号)
        const hasIndex = Number.isInteger(sentenceRaw) && sentenceRaw > 0
        if (!quote && !hint && !hasIndex) continue
        const severityRaw = String(record.severity ?? record.level ?? '').toLowerCase()
        const severity: LlmSuspiciousItem['severity'] =
          severityRaw === 'high' || severityRaw === 'mid' || severityRaw === 'low'
            ? (severityRaw as LlmSuspiciousItem['severity'])
            : severityRaw.includes('高')
              ? 'high'
              : severityRaw.includes('低')
                ? 'low'
                : 'mid'
        suspicious.push({
          quote: quote || undefined,
          hint: hint || undefined,
          reason: String(record.reason ?? record.why ?? record.原因 ?? '').trim().slice(0, 120) || '模型判定为典型 AI 句式',
          severity,
          sentence: hasIndex ? sentenceRaw : undefined
        })
      } else if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) {
        suspicious.push({ reason: '模型指认该句存在 AI 痕迹', severity: 'mid', sentence: entry })
      }
    }
    return {
      score,
      verdict: node.verdict === undefined ? undefined : String(node.verdict).slice(0, 40),
      summary: node.summary === undefined ? undefined : String(node.summary).slice(0, 400),
      reasons,
      suspicious: suspicious.slice(0, 60)
    }
  }
  return null
}

/** 完全没有可用 JSON 时的兜底：用正则抠出分数、理由与指认。 */
function looseExtract(text: string): LlmDetectResult | null {
  const scoreMatch = /(?:ai[_\s-]*score|aiScore|ai[_\s-]*rate|score|AI\s*率)\s*["”']?\s*[:：=]\s*["“]?\s*(\d+(?:\.\d+)?)\s*%?/i.exec(text)
  if (!scoreMatch) return null
  const score = normalizeScore(scoreMatch[1])
  if (score === null) return null

  const reasons: string[] = []
  const reasonsBlock = /"reasons"\s*[:：]\s*\[([\s\S]*?)\]/.exec(text)
  if (reasonsBlock) {
    for (const m of reasonsBlock[1].matchAll(/["“]([^"”]{2,60})["”]/g)) {
      if (reasons.length < 6) reasons.push(m[1].trim())
    }
  }
  const suspicious: LlmSuspiciousItem[] = []
  for (const block of text.matchAll(/\{[^{}]*\}/g)) {
    const body = block[0]
    const quote = /["“](?:quote|text|原文)["”]\s*[:：]\s*["“]([^"”]{2,120})["”]/.exec(body)
    const hint = /["“](?:hint|prefix|句首)["”]\s*[:：]\s*["“]([^"”]{2,60})["”]/.exec(body)
    const sentence = /["“]?(?:sentence|index|序号)["”]?\s*[:：]\s*(\d+)/.exec(body)
    if (!quote && !hint && !sentence) continue
    const severityRaw = /["“]?(?:severity|level)["”]?\s*[:：]\s*["“]?(high|mid|low|高|中|低)/i.exec(body)
    suspicious.push({
      quote: quote ? quote[1] : undefined,
      hint: hint ? hint[1] : undefined,
      reason: (/["“](?:reason|why|原因)["”]\s*[:：]\s*["“]([^"”]{2,120})["”]/.exec(body) || [])[1] || '模型指认该句存在 AI 痕迹',
      severity:
        severityRaw && /high|高/i.test(severityRaw[1]) ? 'high' : severityRaw && /low|低/i.test(severityRaw[1]) ? 'low' : 'mid',
      sentence: sentence ? Number(sentence[1]) : undefined
    })
    if (suspicious.length >= 60) break
  }
  const verdict = /["“]verdict["”]\s*[:：]\s*["“]([^"”]{2,40})["”]/.exec(text)
  const summary = /["“]summary["”]\s*[:：]\s*["“]([^"”]{2,300})["”]/.exec(text)
  return {
    score,
    verdict: verdict ? verdict[1] : undefined,
    summary: summary ? summary[1] : undefined,
    reasons,
    suspicious
  }
}

export interface LlmParseOutcome {
  result: LlmDetectResult | null
  /** 解析失败的原因（可直接展示给用户） */
  error?: string
  /** 失败类型：empty=模型没返回内容，json=不是可用 JSON，shape=JSON 里没有可用分数 */
  kind: 'ok' | 'empty' | 'json' | 'shape'
  /** 模型原始返回（截断，供诊断展示） */
  raw: string
}

/** 解析大模型检测结果（多策略容错），并给出失败原因与原始返回。 */
export function parseLlmDetectReplyDetailed(raw: string): LlmParseOutcome {
  const original = String(raw ?? '')
  const text = stripFences(original).trim()
  if (!text) return { result: null, kind: 'empty', error: '模型没有返回任何内容（可能是 max_tokens 太小或接口异常）', raw: '' }

  const candidates: string[] = []
  for (let i = 0; i < text.length && candidates.length < 8; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    const balanced = balancedJsonAt(text, i)
    if (balanced) {
      candidates.push(balanced)
      i += balanced.length - 1
      continue
    }
    const closed = closeTruncatedJson(text.slice(i))
    if (closed) candidates.push(closed)
    break
  }
  // 无平衡片段时，退而尝试从第一个 { 开始做截断修复
  if (!candidates.length) {
    const first = text.indexOf('{')
    if (first >= 0) {
      const closed = closeTruncatedJson(text.slice(first))
      if (closed) candidates.push(closed)
    }
  }

  for (const candidate of candidates) {
    let parsed: any = null
    try {
      parsed = JSON.parse(candidate)
    } catch {
      parsed = parseWithRepairs(candidate)
    }
    if (!parsed && candidate.startsWith('[') ) {
      // 数组包裹：取第一个对象
      const inner = candidate.slice(1, -1)
      try {
        parsed = JSON.parse(`{${inner}}`)
      } catch {
        parsed = null
      }
    }
    const shaped = shapeLlmResult(parsed)
    if (shaped) return { result: shaped, kind: 'ok', raw: original }
  }

  const loose = looseExtract(text)
  if (loose) return { result: loose, kind: 'ok', raw: original }

  const snippet = text.slice(0, 200).replace(/\s+/g, ' ')
  return {
    result: null,
    kind: candidates.length ? 'shape' : 'json',
    error: candidates.length
      ? `模型返回的 JSON 里找不到可用的 ai_score（返回片段：${snippet}）`
      : `模型返回的内容不是 JSON（返回片段：${snippet}）`,
    raw: original
  }
}

/** 兼容入口：只要结果。 */
export function parseLlmDetectReply(raw: string): LlmDetectResult | null {
  return parseLlmDetectReplyDetailed(raw).result
}

/** 解析失败时的修复提示词：让模型把自己的输出整理成严格 JSON。 */
export function buildLlmRepairPrompt(raw: string): { system: string; user: string } {
  const snippet = String(raw ?? '').slice(0, 4000)
  return {
    system: '你是 JSON 格式化工具，只输出一个严格的 JSON 对象，不输出任何解释、注释或代码块标记。',
    user: [
      '下面是一段不合格的模型输出，请把它整理成严格 JSON。',
      '',
      '【输出要求】',
      '1. 只输出 JSON 对象，直接以 { 开头、以 } 结尾，不要写 ``` 代码块标记；',
      '2. 必须包含字段：ai_score（0-100 整数）、verdict（≤20 字）、summary（≤100 字）、',
      '   reasons（字符串数组，≤4 条，每条 ≤20 字）、',
      '   suspicious（数组，元素为 {"sentence": 整数可选, "hint": "句首 8-15 字", "reason": "≤20 字", "severity": "high|mid|low"}）；',
      '3. 只搬运原有信息，不要新增判断、不要改变分数；信息缺失时用空数组或空字符串；',
      '4. 确保 JSON 合法：字符串内不要出现未转义的换行，不要有尾随逗号。',
      '',
      '【待整理的输出】',
      snippet
    ].join('\n')
  }
}

/* ---- 原文定位（quote 优先，序号兜底，忽略空白/标点差异） ---- */

/** 去掉空白与标点后的文本，附「归一化位置 → 原文位置」映射。 */
function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/[\s\p{P}\p{S}]/u.test(ch)) continue
    normalized += ch.toLowerCase()
    map.push(i)
  }
  return { normalized, map }
}

/** 在原文中定位模型回引的片段；找不到返回 null。 */
export function locateQuote(
  text: string,
  quote: string,
  usedRanges: Array<{ start: number; end: number }> = []
): { start: number; end: number } | null {
  const needle = String(quote ?? '').trim()
  if (!needle) return null
  const overlaps = (start: number, end: number): boolean => usedRanges.some((r) => start < r.end && end > r.start)

  // 1) 精确匹配
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    if (!overlaps(at, at + needle.length)) return { start: at, end: at + needle.length }
    from = at + 1
  }
  // 2) 归一化匹配（忽略空白与标点差异，模型常把全角/半角或标点写歪）
  const { normalized, map } = normalizeWithMap(text)
  const target = normalizeWithMap(needle).normalized
  if (!target) return null
  let searchFrom = 0
  for (;;) {
    const at = normalized.indexOf(target, searchFrom)
    if (at < 0) break
    const start = map[at]
    const end = map[at + target.length - 1] + 1
    if (start !== undefined && end !== undefined && !overlaps(start, end)) return { start, end }
    searchFrom = at + 1
  }
  return null
}

interface LocatedSpan {
  item: LlmSuspiciousItem
  start: number
  end: number
}

const SEVERITY_SCORE: Record<LlmSuspiciousItem['severity'], number> = { high: 92, mid: 72, low: 52 }

/** 把模型指认项定位到原文：整句 quote → 短片段 hint → 句首匹配 → 句子序号，扩展到所在整句。 */
function locateSuspicious(
  text: string,
  items: LlmSuspiciousItem[],
  sentences: TextSegment[]
): { spans: LocatedSpan[]; missing: LlmSuspiciousItem[] } {
  const spans: LocatedSpan[] = []
  const missing: LlmSuspiciousItem[] = []
  for (const item of items) {
    const used = (): Array<{ start: number; end: number }> => spans.map((s) => ({ start: s.start, end: s.end }))
    let span = locateQuote(text, item.quote ?? '', used())
    if (!span && item.hint) span = locateQuote(text, item.hint, used())
    if (!span && item.hint) {
      // 句首片段匹配：忽略标点后比较前缀
      const target = item.hint.replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 6)
      if (target) {
        const hit = sentences.find(
          (s) => s.text.replace(/[\s\p{P}\p{S}]/gu, '').startsWith(target) && !used().some((r) => s.start < r.end && s.end > r.start)
        )
        if (hit) span = { start: hit.start, end: hit.end }
      }
    }
    if (!span && item.sentence && sentences[item.sentence - 1]) {
      const fallback = sentences[item.sentence - 1]
      if (!used().some((r) => fallback.start < r.end && fallback.end > r.start)) {
        span = { start: fallback.start, end: fallback.end }
      }
    }
    if (!span) {
      missing.push(item)
      continue
    }
    const holder = sentences.find((s) => s.start <= span!.start && s.end >= span!.end)
    spans.push({ item, start: holder ? holder.start : span.start, end: holder ? holder.end : span.end })
  }
  return { spans, missing }
}

/** 用大模型结果构建检测报告（默认模式：算法完全不参与判定）。 */
export function buildLlmReport(
  text: string,
  result: LlmDetectResult,
  options: {
    threshold?: number
    model?: string
    chunks?: number
    chunkScores?: number[]
    truncated?: boolean
    finishReason?: string
    strictAnyMark?: boolean
    extraMissing?: LlmSuspiciousItem[]
  } = {}
): DetectReport {
  const src = String(text ?? '')
  const threshold = clamp(Math.round(options.threshold ?? DEFAULT_THRESHOLD), 10, 95)
  const sentences = splitSentences(src)
  const paragraphs = splitParagraphs(src)
  const { spans, missing } = locateSuspicious(src, result.suspicious, sentences)

  // 同一句被多次指认：合并原因，取最严重等级
  const hitByIndex = new Map<number, { score: number; reasons: string[]; severity: LlmSuspiciousItem['severity'] }>()
  const fragments: LocatedSpan[] = []
  for (const span of spans) {
    const holderIndex = sentences.findIndex((s) => s.start === span.start && s.end === span.end)
    if (holderIndex < 0) {
      fragments.push(span)
      continue
    }
    const score = SEVERITY_SCORE[span.item.severity]
    const prev = hitByIndex.get(holderIndex)
    if (!prev) {
      hitByIndex.set(holderIndex, { score, reasons: [span.item.reason], severity: span.item.severity })
    } else {
      prev.score = Math.max(prev.score, score)
      if (!prev.reasons.includes(span.item.reason)) prev.reasons.push(span.item.reason)
      if (score > SEVERITY_SCORE[prev.severity]) prev.severity = span.item.severity
    }
  }

  const sentenceSegments: DetectSegment[] = sentences.map((s, i) => {
    const hit = hitByIndex.get(i)
    if (!hit) {
      return { index: i, kind: 'sentence' as const, start: s.start, end: s.end, text: s.text, score: 0, level: 'human' as DetectLevel, flags: [] }
    }
    return {
      index: i,
      kind: 'sentence' as const,
      start: s.start,
      end: s.end,
      text: s.text,
      score: Math.round(hit.score),
      level: detectLevel(hit.score),
      flags: [
        {
          id: 'llm' as DetectFlagId,
          label:
            hit.severity === 'high'
              ? 'AI 痕迹（大模型判定·高）'
              : hit.severity === 'mid'
                ? 'AI 痕迹（大模型判定·中）'
                : 'AI 痕迹（大模型判定·低）',
          detail: hit.reasons.join('；'),
          weight: Math.round(hit.score)
        }
      ]
    }
  })

  // quote 落在句子之外（跨句或半句）时单独标注，保证高亮精确
  const fragmentSegments: DetectSegment[] = fragments.map((span, i) => ({
    index: sentenceSegments.length + i,
    kind: 'sentence' as const,
    start: span.start,
    end: span.end,
    text: src.slice(span.start, span.end),
    score: SEVERITY_SCORE[span.item.severity],
    level: detectLevel(SEVERITY_SCORE[span.item.severity]),
    flags: [
      {
        id: 'llm' as DetectFlagId,
        label: 'AI 痕迹（大模型判定）',
        detail: span.item.reason,
        weight: SEVERITY_SCORE[span.item.severity]
      }
    ]
  }))

  const allSegments = [...sentenceSegments, ...fragmentSegments].sort((a, b) => a.start - b.start)
  const marked = allSegments.filter((s) => s.score >= threshold)

  const paragraphSegments: DetectSegment[] = paragraphs.map((p, i) => {
    const inner = allSegments.filter((s) => s.start >= p.start && s.end <= p.end)
    const score = inner.length ? Math.max(...inner.map((s) => s.score)) : 0
    const flagMap = new Map<DetectFlagId, DetectFlag>()
    for (const s of inner) for (const f of s.flags) if (!flagMap.has(f.id)) flagMap.set(f.id, { ...f })
    return {
      index: i,
      kind: 'paragraph' as const,
      start: p.start,
      end: p.end,
      text: p.text,
      score,
      level: detectLevel(score),
      flags: [...flagMap.values()]
    }
  })

  const flagCount = new Map<DetectFlagId, { label: string; count: number }>()
  for (const s of allSegments) {
    for (const f of s.flags) {
      const prev = flagCount.get(f.id)
      if (prev) prev.count += 1
      else flagCount.set(f.id, { label: f.label, count: 1 })
    }
  }

  const content = contentChars(src)
  const lens = sentences.map((s) => contentChars(s.text))
  const avgSentence = mean(lens)
  const sentenceCv = cv(lens)
  const confidence = content >= 2000 ? 0.95 : content >= 900 ? 0.88 : content >= 300 ? 0.7 : content >= 150 ? 0.58 : 0.45
  const score = Math.round(clamp(result.score))
  const level = detectLevel(score)
  const missingItems = [...(options.extraMissing ?? []), ...missing]
  const highSeverity = spans.filter((span) => span.item.severity === 'high').length
  const llm: DetectLlmReview = {
    used: true,
    ok: true,
    score,
    verdict: result.verdict,
    summary: result.summary,
    reasons: result.reasons,
    flagged: marked.map((s) => s.index),
    highSeverity,
    chunkScores: options.chunkScores,
    suspicious: result.suspicious,
    missing: missingItems,
    chunks: options.chunks,
    model: options.model,
    truncated: options.truncated,
    finishReason: options.finishReason
  }
  const summaryParts = [
    `大模型检测：AI 率 ${score}%${result.verdict ? `（${result.verdict}）` : ''}`,
    `全文 ${content.toLocaleString('zh-CN')} 字 / ${sentences.length} 句 / ${paragraphs.length} 段`,
    `标出 ${marked.length} 处疑似痕迹${missingItems.length ? `，另有 ${missingItems.length} 处无法在原文定位` : ''}`,
    result.reasons.length ? `判定依据：${result.reasons.slice(0, 2).join('、')}` : ''
  ].filter(Boolean)

  return {
    mode: 'llm',
    score,
    rawScore: score,
    level,
    verdict: result.verdict || LEVEL_TEXT[level],
    confidence,
    summary: `${summaryParts.join('；')}。${result.summary ? ` ${result.summary}` : ''}`.trim(),
    lang: detectLang(src),
    metrics: [],
    sentences: allSegments,
    paragraphs: paragraphSegments,
    flagsTop: [...flagCount.entries()]
      .map(([id, v]) => ({ id, label: v.label, count: v.count }))
      .sort((a, b) => b.count - a.count),
    stats: {
      chars: src.length,
      contentChars: content,
      sentences: sentences.length,
      paragraphs: paragraphs.length,
      avgSentence: Math.round(avgSentence * 10) / 10,
      sentenceCv: Math.round(sentenceCv * 1000) / 1000,
      paraCv: 0,
      clichePer1000: 0,
      templatePer1000: 0,
      abstractPer1000: 0,
      colloquialPer1000: 0,
      concretePer1000: 0,
      distinctCharRatio: 0,
      repeatRatio: 0
    },
    threshold,
    llm,
    tolerance: evaluateTolerance({
      mode: 'llm',
      llm,
      markedCount: marked.length,
      highSeverityCount: highSeverity,
      strictAnyMark: options.strictAnyMark
    }),
    generatedAt: Date.now()
  }
}

/** 大模型检测失败/未执行时的报告（判定为不通过）。 */
export function buildLlmFailureReport(
  text: string,
  error: string | undefined,
  options: {
    threshold?: number
    model?: string
    executed?: boolean
    rawReply?: string
    finishReason?: string
    parseError?: string
    strictAnyMark?: boolean
  } = {}
): DetectReport {
  const src = String(text ?? '')
  const threshold = clamp(Math.round(options.threshold ?? DEFAULT_THRESHOLD), 10, 95)
  const sentences = splitSentences(src)
  const truncated = options.finishReason === 'length'
  const llm: DetectLlmReview = {
    used: options.executed !== false,
    ok: false,
    reasons: [],
    flagged: [],
    model: options.model,
    error,
    rawReply: options.rawReply ? options.rawReply.slice(0, 2000) : undefined,
    parseError: options.parseError,
    finishReason: options.finishReason,
    truncated
  }
  const reason = error || '未执行大模型检测'
  const hint = truncated
    ? '模型输出被 max_tokens 截断（finish_reason=length），生成内容不完整。'
    : ''
  return {
    mode: 'llm',
    score: 0,
    rawScore: 0,
    level: 'human',
    verdict: '检测未完成',
    confidence: 0,
    summary: `大模型检测未完成：${reason}。${hint}零容忍模式下无结论即视为未通过，可在「大模型判定」页查看模型原始返回并重试。`,
    lang: detectLang(src),
    metrics: [],
    sentences: sentences.map((s, i) => ({
      index: i,
      kind: 'sentence' as const,
      start: s.start,
      end: s.end,
      text: s.text,
      score: 0,
      level: 'human' as const,
      flags: []
    })),
    paragraphs: [],
    flagsTop: [],
    stats: {
      chars: src.length,
      contentChars: contentChars(src),
      sentences: sentences.length,
      paragraphs: splitParagraphs(src).length,
      avgSentence: 0,
      sentenceCv: 0,
      paraCv: 0,
      clichePer1000: 0,
      templatePer1000: 0,
      abstractPer1000: 0,
      colloquialPer1000: 0,
      concretePer1000: 0,
      distinctCharRatio: 0,
      repeatRatio: 0
    },
    threshold,
    llm,
    tolerance: evaluateTolerance({
      mode: 'llm',
      llm,
      markedCount: 0,
      highSeverityCount: 0,
      strictAnyMark: options.strictAnyMark
    }),
    generatedAt: Date.now()
  }
}

/** 聚合多块检测结果：分数按正文字数加权，理由与痕迹合并。 */
export function mergeLlmChunkResults(results: LlmDetectResult[], weights: number[]): LlmDetectResult {
  if (!results.length) return { score: 0, reasons: [], suspicious: [] }
  const totalWeight = results.reduce((sum, _r, i) => sum + Math.max(1, weights[i] ?? 0), 0)
  const weighted = results.reduce((sum, r, i) => sum + r.score * Math.max(1, weights[i] ?? 0), 0)
  const reasons: string[] = []
  for (const r of results) {
    for (const reason of r.reasons) if (!reasons.includes(reason) && reasons.length < 8) reasons.push(reason)
  }
  const suspicious: LlmSuspiciousItem[] = []
  for (const r of results) suspicious.push(...r.suspicious)
  const primary = results.reduce((best, r) => (r.score > best.score ? r : best), results[0])
  return {
    score: clamp(weighted / totalWeight),
    verdict: primary.verdict,
    summary: results.map((r) => r.summary).filter(Boolean).join(' ').slice(0, 400) || undefined,
    reasons,
    suspicious: suspicious.slice(0, 60)
  }
}

/* ═══════════════════════════════════════════
   降 AI 味：句式改写 / 整篇润色
═══════════════════════════════════════════ */

/** 待改写的一条句子。 */
export interface RewriteItem {
  /** 原句在全文中的句子序号（0-based） */
  index: number
  text: string
  /** 命中的痕迹说明，注入提示词帮助模型对症下药 */
  reasons: string[]
}

export interface RewritePromptParts {
  system: string
  user: string
  items: RewriteItem[]
}

/** 单次请求最多改写多少句，避免输出被截断。 */
export const REWRITE_BATCH = 10

/** 改写强度：strong 用于「改了一轮还是没降下来」时加大力度。 */
export type RewriteStrength = 'normal' | 'strong'

/** 必须清除的 AI 套语（同时用于提示词与本地自检）。 */
export const AI_TONE_BLACKLIST = [
  '值得注意的是',
  '值得一提的是',
  '不难发现',
  '综上所述',
  '总而言之',
  '总的来说',
  '由此可见',
  '与此同时',
  '更重要的是',
  '在某种程度上',
  '仿佛',
  '宛如',
  '犹如',
  '似乎',
  '一种说不出的',
  '难以言喻',
  '心中涌起',
  '嘴角勾起',
  '眼中闪过',
  '空气中弥漫着',
  '时光的深处',
  '岁月的长河',
  '或许，这就是',
  '也许，这就是',
  '让我们',
  '无论未来如何',
  '在一次次'
]

/** 命中套语黑名单的条目（本地自检用，不参与 AI 率判定）。 */
export function findAiTonePhrases(text: string): string[] {
  const hits: string[] = []
  for (const phrase of AI_TONE_BLACKLIST) {
    if (text.includes(phrase)) hits.push(phrase)
  }
  return hits
}

/** 构造「逐句改写」提示词：编号 1..n 与 items 顺序一一对应。 */
export function buildSentenceRewritePrompt(
  items: RewriteItem[],
  context: { before?: string; after?: string; style?: string; strength?: RewriteStrength } = {}
): RewritePromptParts {
  const strong = context.strength === 'strong'
  const system = [
    '你是资深中文小说编辑，专门把"AI 腔"的句子改写成有个人语感、经得起细读的自然中文。',
    '你只输出 JSON，不写任何解释。'
  ].join('\n')
  const list = items
    .map((item, i) => {
      const why = item.reasons.length ? `（命中痕迹：${item.reasons.join('、')}）` : ''
      return `[${i + 1}] ${item.text.trim()}${why}`
    })
    .join('\n')
  const user = [
    '下面是从一篇中文小说里挑出的句子，请逐句改写，消除典型的 AI 生成痕迹。',
    '',
    ...(context.before ? ['【前文（仅供理解语境，不要改写、不要输出）】', context.before, ''] : []),
    ...(context.after ? ['【后文（仅供理解语境，不要改写、不要输出）】', context.after, ''] : []),
    '【需要改写的句子】',
    list,
    '',
    '【改写要求】',
    '1. 保留原句的信息、人物、对话内容与叙事视角：不得增删情节、事件、人物；',
    '2. 句长必须明显起伏：同一批改写里要有 4-10 字的短句，也要有 25 字以上的长句，禁止句句等长、禁止排比与对仗；',
    `3. 严禁出现这些套语（出现即失败）：${AI_TONE_BLACKLIST.join('、')}；`,
    '4. 用具体的动作、器物、数字、时间地点替代抽象抒情；不要新增比喻、不要堆砌四字成语；',
    '5. 允许口语、语气词、短句、不完整句；宁可平实具体，也不要"文艺"；',
    '6. 长度与原文接近（±40%），保持中文全角标点；',
    ...(context.style ? [`7. 贴近这本书的既有文风：${context.style}`] : []),
    ...(strong
      ? [
          '',
          '【加强要求（上一轮改写后 AI 率没有下降）】',
          '- 不要只换同义词或调整语序：把句子结构也改掉（主谓倒置、拆成两句、换成对话或动作描写）；',
          '- 拆掉"总-分""抒情-升华"的写法，删掉任何解释性、总结性的句子成分；',
          '- 每句都要有可看见的具体事物或动作。'
        ]
      : []),
    '',
    `只输出 JSON：{"sentences":[{"index":1,"text":"改写后的句子"},{"index":2,"text":"改写后的句子"}]}，index 必须与上面的方括号编号一致。`
  ].join('\n')
  return { system, user, items }
}

/** 解析改写结果：把提示词编号换回原句序号。 */
export function parseRewriteReply(raw: string, items: RewriteItem[]): Array<{ index: number; text: string }> {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: any
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const list = Array.isArray(parsed?.sentences) ? parsed.sentences : Array.isArray(parsed?.rewrites) ? parsed.rewrites : []
  const out: Array<{ index: number; text: string }> = []
  for (const entry of list) {
    const slot = Number(entry?.index ?? entry?.id)
    const body = String(entry?.text ?? entry?.rewritten ?? '').trim()
    if (!Number.isInteger(slot) || slot < 1 || slot > items.length || !body) continue
    const target = items[slot - 1]
    if (!target) continue
    if (body === target.text.trim()) continue
    out.push({ index: target.index, text: body })
  }
  return out
}

export interface RewriteRange {
  index: number
  start: number
  end: number
}

/** 把改写结果按原文偏移替换回全文（自后向前替换，避免偏移错位）。 */
export function applyRewrites(
  text: string,
  targets: RewriteRange[],
  rewrites: Array<{ index: number; text: string }>
): { text: string; applied: number } {
  const byIndex = new Map(rewrites.map((r) => [r.index, r.text]))
  const edits = targets
    .filter((t) => byIndex.has(t.index) && t.start >= 0 && t.end > t.start && t.end <= text.length)
    .map((t) => ({ start: t.start, end: t.end, text: byIndex.get(t.index) as string }))
    .sort((a, b) => a.start - b.start)
  // 去掉重叠区间（保留靠前的编辑）
  const kept: typeof edits = []
  let cursor = -1
  for (const edit of edits) {
    if (edit.start < cursor) continue
    kept.push(edit)
    cursor = edit.end
  }
  let out = text
  for (let i = kept.length - 1; i >= 0; i--) {
    out = out.slice(0, kept[i].start) + kept[i].text + out.slice(kept[i].end)
  }
  return { text: out, applied: kept.length }
}

/** 整篇润色提示词。 */
export function buildPolishPrompt(
  text: string,
  options: { title?: string; style?: string; strength?: RewriteStrength } = {}
): { system: string; user: string } {
  const strong = options.strength === 'strong'
  const system = [
    '你是资深中文小说编辑，擅长把"AI 味"很重的段落改写成有个人语感的自然叙事。',
    '你只输出 JSON，不写任何解释。'
  ].join('\n')
  const user = [
    `下面是一段中文小说文本${options.title ? `（《${options.title}》）` : ''}，AI 生成痕迹明显，请整段改写以降低 AI 味。`,
    '',
    '【改写要求】',
    '1. 情节、人物、对话内容、时间地点与信息量必须保持一致，不得增删事件或人物；',
    '2. 打破工整的段落与句长节奏：长短句交错（既有 4-10 字短句，也有 25 字以上长句），允许停顿与口语；',
    `3. 严禁出现这些套语（出现即失败）：${AI_TONE_BLACKLIST.join('、')}；删除段末升华与总结句；`,
    '4. 抽象抒情改成具体动作、器物、数字、空间坐标、身体感受；不要新增比喻与四字成语；',
    ...(options.style ? [`5. 贴近既有文风：${options.style}`] : []),
    ...(strong
      ? [
          '',
          '【加强要求（上一轮改写后 AI 率没有下降）】',
          '- 不要只做同义替换：重排句序、拆并句子、把抒情句改成动作或对话；',
          '- 删掉所有解释性、总结性、升华性的句子成分，只留可看见的动作与事物；',
          '- 段落长度不要与原文一致，允许长短明显不均。'
        ]
      : []),
    '',
    '只输出 JSON：{"text":"改写后的完整文本"}（保留原有段落划分）。',
    '【文本开始】',
    text,
    '【文本结束】'
  ].join('\n')
  return { system, user }
}

/** 解析整篇润色结果：优先取 JSON 字段，模型直接输出正文时按纯文本兜底。 */
export function parsePolishReply(raw: string): string | null {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      const body = String(parsed?.text ?? parsed?.content ?? parsed?.result ?? '').trim()
      if (body) return body
    } catch {
      /* 落到纯文本兜底 */
    }
  }
  // 纯文本兜底：剔除可能的引导语后按正文处理
  const cleaned = text
    .replace(/^(好的|当然|没问题|以下是|这是|下面是)[^\n]{0,40}\n+/g, '')
    .replace(/^【[^】]{0,20}】\s*/, '')
    .trim()
  if (/^(抱歉|无法|不能)/.test(cleaned)) return null
  return contentChars(cleaned) >= 6 ? cleaned : null
}

/** 按段落边界切分长文本，供整篇润色分批调用。 */
export function chunkTextForRewrite(text: string, limit = 3000): string[] {
  const src = String(text ?? '')
  if (src.length <= limit) return src.trim() ? [src] : []
  const blocks = src.split(/(\n\s*\n)/)
  const chunks: string[] = []
  let buffer = ''
  for (const block of blocks) {
    if ((buffer + block).length > limit && buffer.trim()) {
      chunks.push(buffer)
      buffer = block
    } else {
      buffer += block
    }
  }
  if (buffer.trim()) chunks.push(buffer)
  return chunks.map((c) => c.trim()).filter(Boolean)
}

/* ═══════════════════════════════════════════
   报告导出
═══════════════════════════════════════════ */

export function buildReportMarkdown(
  report: DetectReport,
  meta: { title?: string; source?: string; llmModel?: string } = {}
): string {
  const lines: string[] = []
  const title = meta.title || 'AI 率检测报告'
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 检测时间：${new Date(report.generatedAt).toLocaleString('zh-CN')}`)
  if (meta.source) lines.push(`- 文本来源：${meta.source}`)
  lines.push(`- 文本规模：${report.stats.contentChars.toLocaleString('zh-CN')} 字 / ${report.stats.sentences} 句 / ${report.stats.paragraphs} 段`)
  if (report.mode === 'llm') {
    lines.push(`- 检测方式：**大模型检测**（${meta.llmModel || report.llm.model || '未记录模型'}${report.llm.chunks && report.llm.chunks > 1 ? `，分 ${report.llm.chunks} 块` : ''}）`)
    lines.push(`- AI 率：**${report.score}%**（${report.verdict}）`)
  } else {
    lines.push('- 检测方式：**仅算法检测**（未调用大模型，结果仅供参考）')
    lines.push(`- AI 倾向：**${report.score}%**（${report.verdict}，算法原始分 ${report.rawScore}%，置信度 ${Math.round(report.confidence * 100)}%）`)
  }
  lines.push(
    `- 零容忍判定：**${report.tolerance.label}**（判定线 ${ZERO_TOLERANCE_SCORE}%，判定值 ${report.tolerance.strictScore}%）`
  )
  if (report.tolerance.reasons.length) {
    for (const reason of report.tolerance.reasons) lines.push(`  - ${reason}`)
  }
  if (report.mode === 'llm') {
    if (report.llm.ok) {
      if (report.llm.reasons.length) {
        lines.push('- 大模型判定依据：')
        for (const r of report.llm.reasons) lines.push(`  - ${r}`)
      }
      if (report.llm.summary) lines.push(`- 大模型总体判断：${report.llm.summary}`)
      if (report.llm.missing?.length) {
        lines.push(`- 另有 ${report.llm.missing.length} 处指认无法在当前原文中定位（原文可能已被修改）`)
      }
    } else {
      lines.push(`- 大模型检测未完成：${report.llm.error || '未知原因'}`)
    }
  }
  lines.push('')
  lines.push('> ' + report.summary)
  lines.push('')
  if (report.mode === 'algorithm' && report.metrics.length) {
    lines.push('## 检测维度（离线算法，仅供参考）')
    lines.push('')
    lines.push('| 维度 | 得分 | 权重 | 观测值 |')
    lines.push('| --- | --- | --- | --- |')
    for (const m of report.metrics) {
      lines.push(`| ${m.label} | ${m.score}${m.skipped ? '（不参与）' : ''} | ${m.skipped ? '—' : `${Math.round(m.weight * 100)}%`} | ${m.value} |`)
    }
    lines.push('')
  }
  lines.push('## 疑似 AI 痕迹标注')
  lines.push('')
  const marked = report.sentences.filter((s) => s.score >= report.threshold)
  if (!marked.length) {
    lines.push('未发现达到标记阈值的句子。')
  } else {
    lines.push(`共 ${marked.length} 处（阈值 ${report.threshold}）：`)
    lines.push('')
    for (const s of marked.slice(0, 200)) {
      const why = s.flags.map((f) => `${f.label}${f.detail ? `(${f.detail})` : ''}`).join('、') || '综合可疑'
      lines.push(`- **[${s.score}] ${why}**：${s.text.trim().slice(0, 160)}`)
    }
    if (marked.length > 200) lines.push(`- …其余 ${marked.length - 200} 处已省略`)
  }
  lines.push('')
  lines.push('## 说明')
  lines.push('')
  lines.push('本报告由极光工作室「AI 率检测」的启发式统计模型生成（句长节奏、句式模板、套语密度、重复度等），')
  lines.push('属于可解释的语言特征评估，不代表判定性结论；请结合创作过程与更多上下文自行判断。')
  return lines.join('\n')
}
