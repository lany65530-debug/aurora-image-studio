/**
 * AI 率检测引擎 + 文档文本提取 自检（纯 Node，无需浏览器 / Electron）
 * ---------------------------------------------------------------------------
 * 运行：node verify-ai-detect.cjs
 * 说明：脚本用 node_modules 里的 typescript 在内存中转译 TS 源码后 require，
 *       不产生构建产物，也不依赖 out/ 目录。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const ts = require('typescript')

const ROOT = __dirname
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-detect-selftest-'))

/** 转译并加载 TS 模块（CommonJS）。 */
function loadTs(rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const target = path.join(TMP, rel.replace(/[\\/]/g, '__').replace(/\.ts$/, '.js'))
  fs.writeFileSync(target, js)
  return require(target)
}

const engine = loadTs('src/shared/ai-detect.ts')
const docText = loadTs('src/main/services/doc-text.ts')

/* ═══════════════════════════════════════════
   样本
═══════════════════════════════════════════ */

/** AI 腔调样本：句长均匀 + 套语 + 模板句 + 意象套话 + 段末升华 */
const AI_SAMPLE = `在这个快节奏的时代，我们总是在忙碌中迷失方向。林夏站在渡口的栏杆边，看着远处的城市慢慢醒来。她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。

不是所有的告别都需要仪式，而是有些离开本身就足够沉重。她想起那封信，想起信纸上熟悉又陌生的字迹，嘴角不由得勾起一抹苦笑。风从河面上吹过来，带着水汽，也带着一种说不出的凉意。

或许，这就是成长的意义吧。我们在一次次失去中学会珍惜，在一次次相逢中确认彼此。无论未来如何，那些温暖的瞬间都会成为我们前行的力量。

值得注意的是，记忆从来不会真正消失，它只是沉淀在时光的深处。曾经的承诺，如今看来既是负担，也是礼物。让我们带着这份温柔，继续走向下一个清晨。`

/** 人类写作样本：句长参差、口语语气词、具体锚点、对话、无套语 */
const HUMAN_SAMPLE = `老陈把秤砣往柜台上一放，咣当。三斤二两，他说，少了半两你别给钱。我看着他指甲缝里的黑泥，没说话。

那年夏天热得邪门，巷口的水泥地能烫熟鸡蛋。我妈让我去粮站买面，五斤，用铝盆端回来，路上洒了一路。粮站的王阿姨总戴个红袖章，她数票的时候嘴唇一直在动，像在念经。我排队排到下午三点，前面那老头儿跟人吵架，说他的粮票是六六年的，凭什么不认。王阿姨说，六六年的早作废啦，你留着糊墙吧。周围的人都笑，我也笑，其实我不懂。

后来我常想，要是那天我没笑呢？可能什么都不会变吧。人啊，谁记得谁呢。`

/** 改写后的"人类句"池（模拟大模型改写输出） */
const REWRITE_POOL = [
  '老陈把碗放下。',
  '雨还在下，屋檐在滴水。',
  '她没说话，把信折好塞进兜里。',
  '三斤二两，他数了两遍。',
  '巷口的灯忽明忽暗。',
  '他站着，看了一会儿。',
  '桌上剩半碗冷粥。',
  '风从窗缝里钻进来。'
]

/* ═══════════════════════════════════════════
   1. 算法判定
═══════════════════════════════════════════ */
assert.equal(engine.DEFAULT_THRESHOLD, 30, '零容忍默认标记阈值为 30')
assert.equal(engine.ZERO_TOLERANCE_SCORE, 30, '零容忍判定线为 30%')

const aiReport = engine.analyzeText(AI_SAMPLE, { threshold: engine.DEFAULT_THRESHOLD })
const humanReport = engine.analyzeText(HUMAN_SAMPLE, { threshold: engine.DEFAULT_THRESHOLD })

assert.ok(aiReport.stats.sentences >= 8, '应能正确断句')
assert.ok(aiReport.score > humanReport.score, `AI 样本 (${aiReport.score}%) 应高于人类样本 (${humanReport.score}%)`)
assert.ok(
  aiReport.score - humanReport.score >= 15,
  `两类文本的 AI 率差距应明显（AI ${aiReport.score}% vs 人类 ${humanReport.score}%）`
)
assert.ok(aiReport.score >= 55, `AI 样本应判为疑似（实际 ${aiReport.score}%）`)
assert.ok(humanReport.score < 50, `人类样本不应判为疑似（实际 ${humanReport.score}%）`)
assert.equal(aiReport.level, 'mid')
assert.equal(humanReport.level, 'human')
assert.equal(aiReport.metrics.length, 9, '应有 9 个检测维度')
assert.ok(aiReport.confidence > 0 && aiReport.confidence <= 0.95, '置信度应在 (0,1] 区间')
assert.ok(aiReport.summary.includes('AI 率'), '摘要应包含 AI 率')

const aiMarked = aiReport.sentences.filter((s) => s.score >= aiReport.threshold)
const humanMarked = humanReport.sentences.filter((s) => s.score >= humanReport.threshold)
assert.ok(aiMarked.length >= 3, `AI 样本应标出至少 3 处疑似痕迹（实际 ${aiMarked.length}）`)
assert.equal(humanMarked.length, 0, `人类样本不应标出痕迹（实际 ${humanMarked.length}）`)

/* 2. 命中的痕迹类型应包含句式模板 / AI 套语 */
const aiFlagIds = new Set(aiMarked.flatMap((s) => s.flags.map((f) => f.id)))
assert.ok(aiFlagIds.has('template'), '应识别出句式模板痕迹')
assert.ok(aiFlagIds.has('cliche') || aiFlagIds.has('abstract'), '应识别出套语 / 抒情套话痕迹')
for (const seg of aiMarked) assert.ok(seg.flags.length > 0, '标出的句子必须带命中原因')

/* 3. 偏移正确性：标记区间必须能还原原文 */
for (const seg of aiReport.sentences) {
  assert.equal(AI_SAMPLE.slice(seg.start, seg.end), seg.text, '句子偏移应能还原原文')
}
for (const seg of aiReport.paragraphs) {
  assert.equal(AI_SAMPLE.slice(seg.start, seg.end), seg.text, '段落偏移应能还原原文')
}
assert.equal(engine.contentChars('你好，世界！\n'), 4, '正文字数应剔除标点与空白')
assert.equal(engine.detectLang(AI_SAMPLE), 'zh')

/* 4. 段落切分：中文"一行一段"排版应逐行成段 */
const lineSplit = engine.splitParagraphs('第一段内容较长，写满一句话。\n第二段也写满一句话。\n第三段同样写满一句话。')
assert.equal(lineSplit.length, 3, '每行都是完整句时应逐行成段')
const mergedSplit = engine.splitParagraphs('这是一段被硬换行\n折断的长段落，行尾\n没有句号')
assert.equal(mergedSplit.length, 1, '行尾没有句号时应合并为一段')

/* 5. 大模型检测：提示词 / 解析 */
const detectParts = engine.buildLlmDetectPrompt(AI_SAMPLE, { title: '测试书' })
assert.ok(detectParts.user.includes('[1]'), '提示词中的句子应带编号')
assert.ok(detectParts.user.includes('ai_score'), '提示词应约定 JSON 字段')
assert.ok(detectParts.user.includes('"hint"'), '提示词应要求短片段 hint（缩短输出，避免被截断）')
assert.ok(detectParts.user.includes('不要写 ```'), '提示词应明确禁止代码块标记')
assert.ok(detectParts.user.includes('800 字以内'), '提示词应约束输出长度')
assert.ok(detectParts.sentText === AI_SAMPLE, '提示词应携带原文')
const multiChunkPrompt = engine.buildLlmDetectPrompt(AI_SAMPLE, { part: { index: 2, total: 3 } })
assert.ok(multiChunkPrompt.user.includes('第 2/3 段'), '分块检测应标注块序号')

const llmReply = engine.parseLlmDetectReply(
  '```json\n' +
    JSON.stringify({
      ai_score: 84,
      verdict: '高度疑似 AI 生成',
      summary: '句式模板化明显，句长过于均匀。',
      reasons: ['句式模板化', '抽象抒情套语'],
      suspicious: [
        { sentence: 3, quote: '她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。', reason: '典型 AI 意象套话', severity: 'high' },
        { sentence: 8, quote: '或许，这就是成长的意义吧。', reason: '段末强行升华', severity: 'mid' }
      ]
    }) +
    '\n```'
)
assert.ok(llmReply, '应能解析大模型检测结果')
assert.equal(llmReply.score, 84)
assert.equal(llmReply.reasons.length, 2)
assert.equal(llmReply.suspicious.length, 2)
assert.equal(llmReply.suspicious[0].severity, 'high')
assert.equal(engine.parseLlmDetectReply('抱歉，我无法判断。'), null, '非 JSON 回复应返回 null')
assert.equal(engine.parseLlmDetectReply('{"ai_score": 200}').score, 100, '越界分数应被裁剪')
const sloppyReply = engine.parseLlmDetectReply('{"ai_score": 50, "suspicious": [{"reason": "x"}]}')
assert.equal(sloppyReply.suspicious.length, 0, '既无 quote 又无有效序号时不应产生指认')
const indexOnlyReply = engine.parseLlmDetectReply('{"ai_score": 50, "suspicious": [{"sentence": 2, "reason": "只有序号"}]}')
assert.equal(indexOnlyReply.suspicious.length, 1, '只给句子序号时应保留（按序号兜底定位）')
const indexOnlyReport = engine.buildLlmReport(AI_SAMPLE, indexOnlyReply, { model: 'mock-model' })
assert.equal(
  indexOnlyReport.sentences.filter((s) => s.score >= indexOnlyReport.threshold).length,
  1,
  '序号兜底应能标出第二句'
)

/* 5b. 解析容错：真实模型常见的不合格输出都应能救回来 */
const detailed = (raw) => engine.parseLlmDetectReplyDetailed(raw)

// 前后带说明文字（旧实现用 firstIndexOf/lastIndexOf 会切错）
const withProse = detailed(
  '好的，以下是检测结果：\n{"ai_score": 66, "reasons": ["套语多"], "suspicious": []}\n希望有帮助！（评分标准：0-100）'
)
assert.ok(withProse.result, '带前后说明文字也应能解析')
assert.equal(withProse.result.score, 66)

// 中文引号 + 全角逗号/冒号当 JSON 分隔符（模型最常见的两类混用）
const curly = detailed(
  '{“ai_score”：70，“verdict”：“疑似”，“reasons”：[“句式模板化”，“句长过于均匀”]，“suspicious”：[{“sentence”：3，“hint”：“她的心中涌起”，“reason”：“抒情套话”，“severity”：“high”}]}'
)
assert.ok(curly.result, '中文引号作定界符应能修复')
assert.equal(curly.result.score, 70)
assert.equal(curly.result.reasons.length, 2, '全角逗号分隔的理由数组应完整解析')
assert.equal(curly.result.suspicious.length, 1)
assert.equal(curly.result.suspicious[0].hint, '她的心中涌起')
assert.equal(curly.result.suspicious[0].severity, 'high')

// ASCII 引号 + 全角逗号当作元素分隔符（本次线上问题的原始形态）
const fullWidthComma = detailed(
  '{"ai_score": "82%", "verdict": "高度疑似 AI 生成"， "reasons": ["句式模板化", "句长过于均匀"]， "suspicious": [{"sentence": 1, "hint": "在这个快节奏", "reason": "模板开场", "severity": "high"}，{"sentence": 3, "hint": "她的心中涌起", "reason": "套话", "severity": "mid"}]}'
)
assert.ok(fullWidthComma.result, '全角逗号作分隔符应能修复')
assert.equal(fullWidthComma.result.score, 82)
assert.equal(fullWidthComma.result.reasons.length, 2)
assert.equal(fullWidthComma.result.suspicious.length, 2, '全角逗号分隔的数组元素应全部保留')

// 顿号作分隔符
assert.equal(detailed('{"ai_score": 33, "reasons": ["甲"、"乙"]}').result.reasons.length, 2, '顿号分隔应能修复')

// 合法 JSON 里字符串内的中文引号不能被破坏
const innerQuotes = detailed('{"ai_score": 20, "suspicious": [{"hint": "他说：“走吧。”", "reason": "对话", "severity": "low"}]}')
assert.ok(innerQuotes.result, '合法 JSON 应原样解析')
assert.equal(innerQuotes.result.suspicious[0].hint, '他说：“走吧。”', '字符串内容里的中文引号必须保留')

// 尾随逗号 + 字符串里的裸换行
const messy = detailed('{"ai_score": 44, "reasons": ["句子太长\n缺少细节",], "suspicious": [],}')
assert.ok(messy.result, '尾随逗号与裸换行应能修复')
assert.equal(messy.result.score, 44)
assert.equal(messy.result.reasons.length, 1)

// 分数写法：百分比字符串 / 0-1 小数
assert.equal(detailed('{"ai_score": "82%"}').result.score, 82, '百分比字符串应能识别')
assert.equal(detailed('{"ai_score": 0.82}').result.score, 82, '0-1 量纲应换算成百分制')

// 被 max_tokens 截断：仍应抢救出分数与已完整的指认
const truncatedRaw =
  '{"ai_score": 77, "verdict": "高度疑似", "reasons": ["句长均匀"], "suspicious": [{"sentence": 1, "hint": "在这个快节奏", "reason": "模板开场", "severity": "high"}, {"sentence": 3, "hint": "她的心中涌起", "reas'
const truncatedOutcome = detailed(truncatedRaw)
assert.ok(truncatedOutcome.result, '被截断的 JSON 应尽力抢救')
assert.equal(truncatedOutcome.result.score, 77, '截断后仍应保留分数')
assert.ok(truncatedOutcome.result.suspicious.length >= 1, '截断后应保留已完整的指认')

// 包裹 / 别名 / 中文字段名
assert.equal(detailed('{"result": {"aiScore": 61}}').result.score, 61, '应兼容包裹与别名键')
assert.equal(detailed('{"AI率": "55%"}').result.score, 55, '应兼容中文字段名')

// 完全没有 JSON：正则兜底
const loose = detailed(
  '检测结果：ai_score: 73\nreasons: ["套语密集", "句长均匀"]\nsuspicious: {"sentence": 4, "hint": "风从河面上吹过来", "reason": "意象套话", "severity": "mid"}'
)
assert.ok(loose.result, '非 JSON 文本应走正则兜底')
assert.equal(loose.result.score, 73)
assert.equal(loose.result.suspicious.length, 1)

// 彻底无法解析：给出失败类型、原因与原始返回
const broken = detailed('抱歉，我无法完成这个任务。')
assert.equal(broken.result, null)
assert.equal(broken.kind, 'json')
assert.ok(broken.error && broken.error.includes('不是 JSON'), '应说明失败类型')
assert.ok(broken.raw.includes('抱歉'), '应保留模型原始返回')
assert.equal(detailed('').kind, 'empty')
assert.ok(detailed('').error.includes('没有返回任何内容'))
const noScore = detailed('{"foo": 1, "bar": []}')
assert.equal(noScore.result, null)
assert.equal(noScore.kind, 'shape')
assert.ok(noScore.error.includes('ai_score'), '应提示缺少 ai_score')

// 修复提示词
const repairPrompt = engine.buildLlmRepairPrompt('{"ai_score": "七十七", "reasons": []}')
assert.ok(repairPrompt.user.includes('JSON') && repairPrompt.user.includes('ai_score'), '修复提示词应要求 JSON 且含字段说明')
assert.ok(repairPrompt.system.includes('JSON'))

/* 6. 大模型检测：quote 定位（精确 / 标点差异 / 找不到） */
const exactSpan = engine.locateQuote(AI_SAMPLE, '她的心中涌起一股难以言喻的情绪')
assert.ok(exactSpan && AI_SAMPLE.slice(exactSpan.start, exactSpan.end).startsWith('她的心中涌起'), '精确 quote 应能定位')
const fuzzyQuote = '她的心中涌起一股难以言喻的情绪,仿佛被什么东西轻轻触动了.' // 半角标点 + 句号
const fuzzySpan = engine.locateQuote(AI_SAMPLE, fuzzyQuote)
assert.ok(fuzzySpan, '标点/全半角差异的 quote 也应能定位')
assert.ok(AI_SAMPLE.slice(fuzzySpan.start, fuzzySpan.end).includes('难以言喻'), '归一化定位应落在对应原文上')
assert.equal(engine.locateQuote(AI_SAMPLE, '这段文字根本不在原文里出现'), null, '不存在的 quote 应返回 null')
assert.equal(
  engine.locateQuote(AI_SAMPLE, '她的心中涌起一股难以言喻的情绪', [exactSpan]),
  null,
  '已被占用的区间不应重复定位'
)

/* 7. 大模型检测：构建报告（算法不参与） */
const llmReport = engine.buildLlmReport(AI_SAMPLE, llmReply, { model: 'mock-model' })
assert.equal(llmReport.mode, 'llm', '报告应标记为大模型模式')
assert.equal(llmReport.score, 84, 'AI 率应直接取大模型判定分')
assert.equal(llmReport.metrics.length, 0, '大模型模式不输出算法维度')
assert.equal(llmReport.llm.used, true)
assert.equal(llmReport.llm.ok, true)
const llmMarked = llmReport.sentences.filter((s) => s.score >= llmReport.threshold)
assert.equal(llmMarked.length, 2, `应标出模型指认的两处（实际 ${llmMarked.length}）`)
for (const seg of llmMarked) {
  assert.equal(AI_SAMPLE.slice(seg.start, seg.end), seg.text, '标注片段必须能还原原文')
  assert.ok(seg.flags.some((f) => f.id === 'llm'), '标注应带大模型判定痕迹')
}
assert.equal(llmMarked[0].level, 'high', 'high 等级应映射为高度疑似')
assert.equal(llmReport.tolerance.pass, false, 'AI 率 84% 应判为不通过')
assert.ok(llmReport.tolerance.reasons.some((r) => r.includes('84%')), '判定理由应写明分数')
assert.ok(Array.isArray(llmReport.tolerance.conditions) && llmReport.tolerance.conditions.length >= 3, '判定应逐条给出条件状态')
assert.equal(llmReport.tolerance.rule, 'standard')
const condById = (report, id) => report.tolerance.conditions.find((c) => c.id === id)
assert.equal(condById(llmReport, 'detect').pass, true)
assert.equal(condById(llmReport, 'score').pass, false, '84% 应不满足「AI 率 < 30%」')
assert.equal(llmReport.llm.highSeverity, 1, '应统计「高」等级指认数量')

/* 7b. 判定规则：低 AI 率不等于必然通过，但也不因单句偶发指认就一票否决 */
const seq = (text, severity) => ({ score: 12, reasons: [], suspicious: [{ quote: text, reason: 'x', severity }] })

// 低分 + 无指认 → 通过
const passClean = engine.buildLlmReport(HUMAN_SAMPLE, engine.parseLlmDetectReply('{"ai_score": 12, "suspicious": []}'))
assert.equal(passClean.tolerance.pass, true, '低分且无指认应通过')

// 低分 + 1 处「中」等级指认 → 标准规则下通过（偶发单句视为误判容忍）
const passOneMid = engine.buildLlmReport(AI_SAMPLE, engine.parseLlmDetectReply(JSON.stringify(seq('她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。', 'mid'))))
assert.equal(passOneMid.tolerance.pass, true, '低分 + 单处「中」指认应通过（标准规则）')
assert.equal(condById(passOneMid, 'count').pass, true)
assert.equal(passOneMid.tolerance.conditions.some((c) => !c.pass), false, '通过时所有条件都应满足')

// 低分 + 1 处「高」等级指认 → 不通过
const failOneHigh = engine.buildLlmReport(AI_SAMPLE, engine.parseLlmDetectReply(JSON.stringify(seq('她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。', 'high'))))
assert.equal(failOneHigh.tolerance.pass, false, '低分但存在「高」等级指认应不通过')
assert.equal(condById(failOneHigh, 'severity').pass, false)
assert.ok(failOneHigh.tolerance.reasons.some((r) => r.includes('「高」等级')), '理由应说明是高等级指认')

// 低分 + 3 处指认 → 不通过（成片）
const threeMarks = engine.parseLlmDetectReply(
  JSON.stringify({
    ai_score: 12,
    reasons: [],
    suspicious: [
      { quote: '在这个快节奏的时代，我们总是在忙碌中迷失方向。', reason: 'a', severity: 'mid' },
      { quote: '她的心中涌起一股难以言喻的情绪，仿佛被什么东西轻轻触动了。', reason: 'b', severity: 'mid' },
      { quote: '或许，这就是成长的意义吧。', reason: 'c', severity: 'mid' }
    ]
  })
)
const failThree = engine.buildLlmReport(AI_SAMPLE, threeMarks)
assert.equal(failThree.tolerance.pass, false, '低分但 3 处指认应不通过')
assert.ok(failThree.tolerance.reasons.some((r) => r.includes('成片阈值')), '理由应说明达到成片阈值')

// 最严格规则：低分 + 1 处「中」指认也不通过
const strictReport = engine.withStrictRule(passOneMid, true)
assert.equal(strictReport.tolerance.pass, false, '最严格规则下任意指认即不通过')
assert.equal(strictReport.tolerance.rule, 'strict-any')
assert.equal(condById(strictReport, 'count').label.includes('最严格'), true, '应标注最严格规则')
assert.equal(engine.withStrictRule(strictReport, false).tolerance.pass, true, '切回标准规则应恢复通过')

// 模型判定为人类写作：通过
const cleanReply = engine.parseLlmDetectReply('{"ai_score": 12, "verdict": "未检出 AI 痕迹", "reasons": ["句式自然"], "suspicious": []}')
const cleanReport = engine.buildLlmReport(HUMAN_SAMPLE, cleanReply, { model: 'mock-model' })
assert.equal(cleanReport.tolerance.pass, true, '低分且无指认应通过')
assert.equal(cleanReport.sentences.filter((s) => s.score >= cleanReport.threshold).length, 0, '无指认时不应有标注')

// 指认句无法定位时进入 missing，不影响通过判定之外的流程
const missingReply = engine.parseLlmDetectReply(
  '{"ai_score": 40, "reasons": ["疑似"], "suspicious": [{"quote": "这段文字根本不存在", "reason": "x", "severity": "mid"}]}'
)
const missingReport = engine.buildLlmReport(AI_SAMPLE, missingReply, { model: 'mock-model' })
assert.equal(missingReport.llm.missing.length, 1, '无法定位的指认应记录在 missing')
assert.equal(missingReport.sentences.filter((s) => s.score >= missingReport.threshold).length, 0, '无法定位则不应产生标注')

// 检测失败 / 未执行：一律不通过
const failureReport = engine.buildLlmFailureReport(AI_SAMPLE, 'HTTP 500：服务不可用', { model: 'mock-model' })
assert.equal(failureReport.tolerance.pass, false, '大模型检测失败应判为不通过')
assert.ok(failureReport.tolerance.reasons.some((r) => r.includes('500')), '失败原因应写进判定理由')
assert.equal(failureReport.llm.ok, false)

/* 8. 仅算法模式：不参与零容忍认定 */
assert.equal(aiReport.mode, 'algorithm', 'analyzeText 应标记为算法模式')
assert.equal(aiReport.tolerance.pass, false, '仅算法模式不作零容忍认定')
assert.ok(aiReport.tolerance.reasons.some((r) => r.includes('未调用大模型')), '应说明未使用大模型')
assert.equal(humanReport.tolerance.pass, false, '算法模式下即使疑似度低也不认定通过')
assert.ok(aiReport.metrics.length === 9, '算法模式仍有 9 个维度')

/* 9. 长文本分块：块偏移可映射回全文 */
const longText = Array.from({ length: 12 }, (_, i) => `第${i + 1}段。`.repeat(1) + '甲'.repeat(400)).join('\n\n')
const chunks = engine.chunkTextWithOffsets(longText, 1000)
assert.ok(chunks.length > 1, '长文本应被分块')
for (const chunk of chunks) {
  assert.equal(longText.slice(chunk.start, chunk.end), chunk.text, '分块偏移应能还原全文片段')
}
assert.equal(chunks[0].start, 0, '首块应从 0 开始')
assert.equal(chunks[chunks.length - 1].end, longText.length, '末块应覆盖到结尾')
assert.ok(chunks.every((c) => c.text.length <= 1000), '每块长度应受控')
const merged = engine.mergeLlmChunkResults(
  [
    { score: 90, reasons: ['A'], suspicious: [{ quote: 'x', reason: 'r', severity: 'high' }] },
    { score: 10, reasons: ['B'], suspicious: [] }
  ],
  [100, 300]
)
assert.equal(merged.score, 30, '分块分数应按字数加权（90*100 + 10*300 = 12000 / 400 = 30）')
assert.equal(merged.reasons.length, 2, '理由应合并')
assert.equal(merged.suspicious.length, 1, '痕迹应合并')

/* 8. 降 AI 味：提示词 → 解析 → 就地替换 → 复检 */
const targets = aiMarked.map((s) => ({
  index: s.index,
  text: s.text,
  reasons: s.flags.map((f) => f.label)
}))
const rewriteParts = engine.buildSentenceRewritePrompt(targets, { before: '前文一句', after: '后文一句' })
const numbered = rewriteParts.user.match(/^\[\d+\]/gm) || []
assert.equal(numbered.length, targets.length, '改写提示词应逐句编号')
assert.ok(rewriteParts.user.includes('只输出 JSON'), '改写提示词应约束输出格式')
assert.equal(rewriteParts.items[0].index, targets[0].index, '编号 1 应对应第一个待改写句')
assert.ok(rewriteParts.user.includes('句长必须明显起伏'), '改写提示词应要求句长起伏')
assert.ok(rewriteParts.user.includes(engine.AI_TONE_BLACKLIST[0]), '改写提示词应列出禁用套语')
assert.ok(!rewriteParts.user.includes('加强要求'), '普通强度不含加强要求')
const strongParts = engine.buildSentenceRewritePrompt(targets, { strength: 'strong' })
assert.ok(strongParts.user.includes('加强要求'), 'strong 强度应追加加强要求')
const strongPolish = engine.buildPolishPrompt('一段正文。'.repeat(20), { strength: 'strong' })
assert.ok(strongPolish.user.includes('加强要求'), '整篇润色的 strong 强度也应追加加强要求')
assert.ok(engine.findAiTonePhrases('她的心中涌起一股难以言喻的情绪，仿佛被触动了。').length >= 2, '本地套语自检应能识别 AI 腔')
assert.equal(engine.findAiTonePhrases('老陈把碗放下，没说话。').length, 0, '自然文本不应命中套语')

const mockReply = JSON.stringify({
  sentences: targets.map((item, i) => ({ index: i + 1, text: REWRITE_POOL[i % REWRITE_POOL.length] }))
})
const parsedRewrites = engine.parseRewriteReply(mockReply, rewriteParts.items)
assert.equal(parsedRewrites.length, targets.length, '所有改写都应被解析')
assert.deepEqual(
  parsedRewrites.map((r) => r.index),
  targets.map((t) => t.index),
  '改写结果应映射回原句序号'
)
assert.deepEqual(engine.parseRewriteReply('{"sentences":[{"index":99,"text":"越界"}]}', rewriteParts.items), [], '越界编号应被丢弃')
assert.deepEqual(engine.parseRewriteReply('不是 JSON', rewriteParts.items), [], '非 JSON 应返回空数组')

const applied = engine.applyRewrites(
  AI_SAMPLE,
  aiReport.sentences.map((s) => ({ index: s.index, start: s.start, end: s.end })),
  parsedRewrites
)
assert.equal(applied.applied, parsedRewrites.length, '所有改写都应落到原文')
for (const sentence of REWRITE_POOL.slice(0, parsedRewrites.length)) {
  assert.ok(applied.text.includes(sentence), `改写后的句子应出现在正文中：${sentence}`)
}
assert.ok(!applied.text.includes('值得注意的是'), '改写应移除套语原文')

const rewrittenReport = engine.analyzeText(applied.text, { threshold: engine.DEFAULT_THRESHOLD })
assert.ok(rewrittenReport.rawScore < aiReport.rawScore, `改写后算法分应下降（${aiReport.rawScore} → ${rewrittenReport.rawScore}）`)
// 改写后再交给大模型判定：应通过
const rewrittenClean = engine.parseLlmDetectReply('{"ai_score": 12, "verdict": "未检出 AI 痕迹", "reasons": ["句式自然"], "suspicious": []}')
const rewrittenLlmReport = engine.buildLlmReport(applied.text, rewrittenClean, { model: 'test-model' })
assert.equal(rewrittenLlmReport.tolerance.pass, true, '改写后大模型应判定通过')

/* 9. 整篇润色提示词 / 解析 / 分批 */
const polishParts = engine.buildPolishPrompt('一段正文。'.repeat(30), { title: '测试书' })
assert.ok(polishParts.user.includes('只输出 JSON'), '润色提示词应约束输出格式')
assert.ok(polishParts.user.includes('测试书'))
assert.equal(engine.parsePolishReply('{"text":"改写后的正文，这是一段足够长的内容。"}'), '改写后的正文，这是一段足够长的内容。')
assert.equal(engine.parsePolishReply('好的，以下是改写后的文本：\n\n他放下碗，没说话。'), '他放下碗，没说话。', '纯文本回复应能兜底解析')
assert.equal(engine.parsePolishReply(''), null)
assert.equal(engine.parsePolishReply('太短'), null, '过短结果应丢弃')
const rewriteChunks = engine.chunkTextForRewrite(`${'甲'.repeat(200)}\n\n${'乙'.repeat(200)}\n\n${'丙'.repeat(200)}`, 300)
assert.equal(rewriteChunks.length, 3, '长文本应按段落分批')
assert.ok(rewriteChunks.every((c) => c.length <= 320), '每批长度应受控')

/* 10. 报告导出（两种模式） */
const llmMarkdown = engine.buildReportMarkdown(llmReport, { title: '大模型报告', source: '自检', llmModel: 'mock-model' })
assert.ok(llmMarkdown.includes('# 大模型报告'))
assert.ok(llmMarkdown.includes('大模型检测'))
assert.ok(llmMarkdown.includes('零容忍判定'))
assert.ok(llmMarkdown.includes('疑似 AI 痕迹标注'))
assert.ok(!llmMarkdown.includes('## 检测维度'), '大模型模式不应输出算法维度表')
const algoMarkdown = engine.buildReportMarkdown(aiReport, { title: '算法报告', source: '自检' })
assert.ok(algoMarkdown.includes('仅算法检测'))
assert.ok(algoMarkdown.includes('## 检测维度（离线算法，仅供参考）'), '算法模式应输出维度表')

/* 11. 边界：空文本 / 极短文本不崩溃 */
const empty = engine.analyzeText('')
assert.equal(empty.stats.sentences, 0)
assert.ok(Number.isFinite(empty.score))
const tiny = engine.analyzeText('嗯。')
assert.ok(tiny.confidence <= 0.5, '极短文本置信度应偏低')
assert.ok(engine.splitSentences('').length === 0)

/* ═══════════════════════════════════════════
   12. 文档文本提取
═══════════════════════════════════════════ */
const txt = docText.extractDocumentText('a.txt', Buffer.from('渡口的来信\n\n风从河面吹来。', 'utf8'))
assert.equal(txt.format, 'text')
assert.ok(txt.text.includes('渡口的来信'))

const html = docText.extractDocumentText('a.html', Buffer.from('<html><body><p>甲段</p><p>乙段&nbsp;丙</p><script>var a=1</script></body></html>'))
assert.equal(html.format, 'html')
assert.equal(html.text, '甲段\n乙段 丙')

const docWarning = docText.extractDocumentText('legacy.doc', Buffer.from('D0CF11E0', 'hex'))
assert.equal(docWarning.text, '')
assert.ok(/docx/.test(docWarning.warning || ''), '.doc 应给出提示')

/* GBK 回退 */
const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa3])
assert.equal(docText.decodeTextBuffer(gbkBytes), '中文。', 'GBK 编码文本应能正确解码')

/* 构造一个最小 DOCX（ZIP + word/document.xml）验证解压链路 */
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8')
    const comp = zlib.deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, comp)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += local.length + nameBuf.length + comp.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, eocd])
}

const documentXml =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<w:document><w:body>' +
  '<w:p><w:r><w:t>第一章 渡口</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>风从河面吹来，带着水汽。</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>他说：</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>&lt;那就走吧&gt;</w:t></w:r></w:p>' +
  '</w:body></w:document>'
const docx = buildZip([
  ['[Content_Types].xml', '<Types/>'],
  ['word/document.xml', documentXml]
])
const docxResult = docText.extractDocumentText('小说.docx', docx)
assert.equal(docxResult.format, 'docx')
assert.equal(docxResult.warning, undefined)
assert.equal(docxResult.text, '第一章 渡口\n风从河面吹来，带着水汽。\n他说：\t<那就走吧>')

const brokenDocx = docText.extractDocumentText('bad.docx', Buffer.from('PK\u0003\u0004not a real zip'))
assert.equal(brokenDocx.text, '')
assert.ok(brokenDocx.warning, '损坏的 docx 应给出警告而不是抛错')

const otherZip = docText.extractDocumentText('table.xlsx', docx)
assert.ok(/暂不支持/.test(otherZip.warning || ''), '其他 ZIP 格式应给出明确提示')

fs.rmSync(TMP, { recursive: true, force: true })

console.log(
  `PASS: 默认检测由大模型完成 —— 84% 判定不通过并标出 ${llmMarked.length} 处（quote 精确定位，含标点差异容错），` +
    `12% 判定通过；检测失败/未执行一律不通过（理由：${failureReport.tolerance.reasons[0]}）。`
)
console.log(
  `PASS: 仅算法模式（需显式勾选）—— AI 样本 ${aiReport.score}% / 人类样本 ${humanReport.score}%，维度 ${aiReport.metrics.length} 项，` +
    `但两例均不作零容忍认定：${aiReport.tolerance.reasons[0]}`
)
console.log(
  `PASS: 长文本分块检测 —— ${chunks.length} 块偏移可还原全文，分数按字数加权（${merged.score}%）；` +
    `降 AI 味闭环：改写 ${applied.applied} 句后算法分 ${aiReport.rawScore}% → ${rewrittenReport.rawScore}%，大模型复检判定 ${
      rewrittenLlmReport.tolerance.pass ? '通过' : '不通过'
    }。`
)
console.log('PASS: 文档提取 txt/html/docx/GBK 与异常提示均通过。')
