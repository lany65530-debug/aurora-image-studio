# 复刻 ai-novel-app 完整小说创作能力 到 v2「小说工作区」

## Context（背景与目标）

用户希望把独立应用 `F:\AInew\ai-novel-app`（React + Express + data/ JSON 落盘）的**完整小说创作体验**，原样复刻进 v2 极光工作室（Electron + 原生 TS）现有的「小说工作区」`workspaces/novel.ts`。

要复刻的核心能力：

1. **AI 章节生成**：输入「本章情节指令」+ 目标字数 → 流式生成连贯章节 → 自动更新长期记忆。
2. **长期记忆系统（结构化 outline）**：人物/地点/伏笔/章节摘要/时间线 + 关键词检索召回 + 每章后 AI 抽取更新 + **重写章节时回滚该章记忆**。
3. **完整阅读器**：翻页(分页)/滚动双模式、字号/行距/主题(day/green/night)、目录面板、AI 菜单（重写本章/生成新章节）、AI 生成下一章、进度恢复/保存。
4. **UI 弹窗**：章节生成弹窗（form→generating→memory→done 四阶段）、大纲弹窗（人物/地点/伏笔/大纲四 tab）、AI 创建小说弹窗。

已与用户确认的架构决定：

- **AI 接入**：复用 v2 现有 IPC `window.aurora.chat.send` + `chat.onChunk` 流式（不复刻 fetch/proxy 网络层，只复刻 prompt 组装与记忆逻辑）。

- **数据落盘**：搬成 data/ JSON 文件落盘（新增主进程 IPC 读写磁盘），localStorage 仅作轻量镜像。

***

## 数据模型

### 新建 `src/shared/novel.ts`（shared 共享类型）

逐一对应源项目 `src/types/index.ts`：

- `NovelCharacter`（name/role/desc/status/aliases/relationships/statusLog/firstChapter/lastChapter）

- `NovelLocation`、`NovelChapterSummary`、`NovelTimelineEvent`

- `NovelForeshadowingItem`（id/text/plantedAt/status:'open'|'resolved'/resolvedAt）

- `NovelOutline`（characters/locations/**foreshadowing(旧版字符串数组，必须保留)**/chapterSummaries/**foreshadowingItems**/timeline）

- `NovelChapterData`（id/title/content/**userIdea?**/updatedAt）

- `NovelFileData`（id/title/author/summary/cover/**premise**/**style**/outline/currentChapter/currentPage/scrollPercent/createdAt/updatedAt/chapters）

- 落盘载荷：`NovelSummary`(书库卡片轻量字段)、`NovelGetResult`、`NovelSaveResult`、`NovelDeleteResult`

### 修改 `src/renderer/src/state/store.ts`

- `export type NovelChapter = NovelChapterData`（兼容现有引用）

- `NovelWorkspace.novels` 元素类型改为 `NovelFileData`

- `reader.theme: 'day'|'green'|'night'` 已存在，无需改枚举

***

## 主进程：落盘 IPC

### 新建 `src/main/services/novel-store.ts`（参考 services/library.ts 原子写 + 队列）

- 落盘目录：`<userData>/novels/<sanitize(id)>.json`（`sanitize = id.replace(/[\\/:*?"<>|]/g,'_')`，沿用 chat.ts 附件做法）

- `saveNovelFile`（tmp+rename 原子写）、`loadNovelFile`、`deleteNovelFile`、`listNovelSummaries`（只读头字段，不读章节 body）；用串行队列包「读-改-写」

### 新建 `src/main/controllers/novel.ts`

- `IPC.Novel.list/get/save/delete` 四个 handler

### 修改

- `src/main/config/paths.ts`：加 `novelsDir = () => join(userDataPath(),'novels')`

- `src/shared/ipc.ts`：加 `Novel: { list/get/save/delete }`

- `src/main/index.ts`：`registerNovelIpc()`

### 预加载三层暴露 novel 组

- `src/shared/aurora-api.ts`（类型契约）

- `src/preload/api.ts`（ipcRenderer.invoke）

- `src/renderer/src/state/aurora.ts`（`export const novel = {...}` 映射）

***

## 渲染层：纯逻辑移植（1:1，无网络）

### 新建 `src/renderer/src/services/outline.ts`

逐字移植 `ai-novel-app/src/services/outlineService.ts` 全部导出：
`createEmptyOutline / normalizeOutline / retrieveMemory / buildMemoryPrompt / buildOutlineUpdatePrompt / parseOutlineUpdate / applyOutlineUpdate / clearChapterMemory`

- **必须保留** `foreshadowing:string[]` 与 `foreshadowingItems` 双字段迁移逻辑，否则记忆系统失效。

### 新建 `src/renderer/src/services/generation.ts`

从 `ai-novel-app/src/services/generationService.ts` 移植 **prompt 组装层**：

- `styleGuideMap/buildStyleGuide/buildRecentChapters/system&user prompt 分段/validateOutput`

- `generateChapterWithIdea` → 改为 **v2:** **`chat.send`** **+** **`chat.onChunk`** **流式**（sessionId 前缀 `nv_<novelId>_<nonce>`），取消用 `chat.stop(sessionId)`

- `updateNovelMemory` → 非流式 `await chat.send` 全文 → `parseOutlineUpdate + applyOutlineUpdate`

### 新建 `src/renderer/src/services/reader.ts`

- 移植 `readerService.ts` 的 `parseParagraphs`

- 封装 `makePaginator(viewport, box, padding)`：CSS columns (`column-width=viewportW-48, gap=48, fill:auto`) + ResizeObserver 测量 `pageCount=Math.max(1,round(box.scrollWidth/viewportW))` + `scrollTo left=page*viewportW`（单步 smooth、换章/恢复 auto）+ `disconnect()`

***

## 渲染层：UI 弹窗（React 转译成纯 DOM）

### 新建 `src/renderer/src/modals/novelChapterGenerate.ts`

状态机每译 `ChapterGenerateModal.tsx`：`form→generating(流式预览+取消)→memory→done(确认/重新生成)`

- 重写模式：生成前 `clearChapterMemory`；若抽取失败则回退 `baseOutline`（照抄源项目 `rebuilt === outlineForGeneration ? baseOutline : rebuilt`）

### 新建 `src/renderer/src/modals/novelOutline.ts`

`OutlineModal.tsx`：4 tab（人物/地点/伏笔/章节大纲）增删改查，`structuredClone` 起稿，保存时落 `outline`

### 新建 `src/renderer/src/modals/novelAiGenerate.ts`

`AIGenerateModal.tsx`：名称 + 风格（不限/热血/悬疑/浪漫/轻松/黑暗）+ 概要 → 创建空书并进入「开始写第一章」引导

***

## 渲染层：`workspaces/novel.ts` 重构（orchestrator）

- MODULE\_SINGLETON 持有 `view / novelId / chapterIndex / pageIndex / pageCount / readingMode / streamingSessionId / 弹窗开关`

- 保留书库视图；阅读器改为**沉浸式分页/滚动双模式**（含目录、AI 菜单、阅读设置、AI 生成下一章）

- `save`：debounce 写 localStorage 轻量镜像 + `void novel.save(dfile)` 落盘

- 流式接线：`bindNovelWorkspace` 内 `chat.onChunk` 按 `nv_` 前缀 + `streamingSessionId` 过滤，finally/取消清空

- 进度恢复/保存：翻页 `currentChapter/currentPage`、滚动 `currentChapter/scrollPercent`，debounce 600ms

- 主题：reader 根 DOM 挂 `data-novel-theme="day|green|night"`

***

## 样式 `src/renderer/src/styles/workspace/novel.css`

- 阅读器分页列布局 / 滚动布局、四阶段生成弹窗、大纲 4 tab、AI 菜单、阅读设置菜单、翻页滑动条

- 主题用局部 `[data-novel-theme]` 作用域三组变量（不污染全局 Aurora tokens）

- 复刻源 `day/green/night` 配色：day #F7F4F0/#1A1A2E、green #C4DCC5/#2C3E2C、night #1A1A35/#E8E8F0

***

## 旧数据处理

`bindNovelWorkspace` 启动时：

- 磁盘有数据 → 以磁盘为准加载

- 磁盘空但 localStorage 有旧 novels → 规范化后逐本写盘（`premise=summary`、`style='不限'`、`outline=createEmptyOutline()`、进度归零、章节补 `userIdea`），一次性迁移，之后统一走磁盘

## 已接受的范围限制

- v2 `chat.send` 不写 `max_tokens`，字数依赖 system prompt「目标字数约 N 字」。本期接受；可选增强（步骤 11）给 `ChatConfigOverride` 加 `maxTokens` 并透传到 `chat.ts` body。

- 记忆更新失败不阻断主流程（fail-safe 返回原 outline）

## 实施顺序（依赖）

1. `src/shared/novel.ts`(新) + `store.ts` 类型扩展
2. `paths.ts` + `novel-store.ts`(新)
3. `ipc.ts` + `controllers/novel.ts`(新) + `main/index.ts`
4. `aurora-api.ts` + `preload/api.ts` + `state/aurora.ts`
5. `services/outline.ts`(新)
6. `services/generation.ts`(新)
7. `services/reader.ts`(新)
8. `modals/novelChapterGenerate.ts`、`novelOutline.ts`、`novelAiGenerate.ts`(新)
9. `workspaces/novel.ts` 重构
10. `novel.css`
11. （可选）maxTokens 透传

## 验证

1. 启动 v2：`npm run dev`（或 electron:dev），进入小说工作区
2. 新建小说 → 确认书库卡片、进入空书引导
3. AI 创建小说 → 生成 5 章大纲空章节
4. 章节生成：填情节指令+字数 → 观察流式预览 → memory 阶段 → 确认后章节写入并可阅读
5. 大纲弹窗：确认人物/位点/伏笔/章节摘要 tab 增删改查、AI 自动写入记忆
6. 重写本章 → 确认旧记忆被回滚、新内容生成
7. 阅读器：翻页/滚动切换、字号/行距/主题、目录跳转、进度恢复
8. 重启应用 → 数据从磁盘恢复；检查 `<userData>/novels/` 生成了 JSON
9. 用源项目同 API Key 跑通一章，对比连贯性

