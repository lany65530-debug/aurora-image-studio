/**
 * 剪辑工作区（视频 / 音频编辑器）
 * -------------------------------------------------------------------------
 * 媒体库：导入视频 / 音频，读取时长、分辨率、音频波形
 * 时间线：多视频 / 音频轨，拖放、移动、缩放、裁剪、分割、复制、删除、吸附、缩放
 * 预览：播放 / 暂停 / 定位，视频滤镜（亮度/对比度/饱和度/灰度/模糊）、旋转、不透明度，
 *       音频音量 / 淡入淡出，WebAudio 混音
 * 导出：音频 -> WAV（离线渲染）；视频 -> WebM（画布 + WebAudio 实时录制）
 */
import type { EditWorkspace } from '../state/store'
import { $, persistWorkspaces } from '../state/store'
import type {
  EditClip,
  EditFileInfo,
  EditKeyframe,
  EditKeyframeProp,
  EditKeyframes,
  EditMedia,
  EditProject,
  EditTextAlign,
  EditTextStyle,
  EditTrack,
  EditTransitionType,
  EditTrackKind,
  EditorProgressEvent,
  ExportQuality,
  FfmpegStatus
} from '../../../shared/editor'
import {
  EDIT_RESOLUTIONS,
  KEYFRAME_PROPS,
  TRANSITIONS,
  clipEnd,
  createDefaultEditProject,
  createDefaultFilter,
  createDefaultTextStyle,
  editUid,
  evalKeyframes,
  formatTime,
  projectContentEnd
} from '../../../shared/editor'
import { editor as editorApi } from '../state/aurora'
import { toast } from '../components/toast'
import { confirmDialog } from '../components/confirm'
import '../styles/workspace/editor.css'

const HEAD = 132
const MIN_CLIP = 0.05

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))

/* ===== 模块状态 ===== */
let wsRef: EditWorkspace | null = null
/** 多选：选中的片段 id 集合；primaryId 是属性面板的主片段。 */
const selectedIds = new Set<string>()
let primaryId = ''
/** 复制 / 粘贴缓冲。 */
let clipClipboard: EditClip[] = []
let shellBuilt = false
let playing = false
let rafId = 0
let playStartReal = 0
let playStartT = 0
let history: string[] = []
let historyIndex = -1
const audioEls = new Map<string, HTMLAudioElement>()
let audioPool: HTMLElement | null = null
let previewVideo: HTMLVideoElement | null = null
/** 转场预览用的第二个视频元素（B 轨）。 */
let previewVideoB: HTMLVideoElement | null = null

/* WebAudio 预览 / 导出 */
let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null
const sourcedEls = new WeakSet<HTMLMediaElement>()
const decodedBuffers = new Map<string, AudioBuffer>()

/* FFmpeg / 转码代理 / 缩略图 */
let ffmpegInfo: FfmpegStatus | null = null
const thumbCache = new Map<string, string>()
/** 视频胶片带（多帧拼接图）缓存。 */
const filmstripCache = new Map<string, string>()
let progressUnsub: (() => void) | null = null
let exporting = false

/* 自动保存 / 崩溃恢复 */
let autosaveTimer: ReturnType<typeof setInterval> | null = null
let pendingRecovery: { savedAt: number; project: unknown } | null = null

/* ===== 基础访问 ===== */
function project(): EditProject {
  return (wsRef as EditWorkspace).project
}
function findMedia(id: string): EditMedia | undefined {
  return project().media.find((m) => m.id === id)
}
function findTrack(id: string): EditTrack | undefined {
  return project().tracks.find((t) => t.id === id)
}
function findClip(id: string): EditClip | undefined {
  return project().clips.find((c) => c.id === id)
}
function mediaUrl(m: EditMedia): string {
  // 非 Web 友好格式会先转码出代理文件，预览 / 波形统一用代理
  if (m.proxyUrl) return m.proxyUrl
  if (m.url) return m.url
  const encoded = encodeURI(m.path.replace(/\\/g, '/'))
  return 'file:///' + encoded
}

/** 供 ffmpeg / 波形读取的真实本地路径（优先进程内的代理文件）。 */
function mediaLocalPath(m: EditMedia): string {
  return m.proxyPath || m.path
}
function trackIndex(id: string): number {
  return project().tracks.findIndex((t) => t.id === id)
}
function trackKind(kind: EditTrackKind): EditTrackKind {
  return kind
}
function compatible(media: EditMedia, track: EditTrack): boolean {
  if (track.locked) return false
  return trackKind(track.kind) === (media.kind === 'video' ? 'video' : 'audio')
}
/** 片段所在轨道的类型（决定它是「画面」还是「声音」）。 */
function clipTrackKind(clip: EditClip): EditTrackKind {
  return findTrack(clip.trackId)?.kind || 'video'
}
/** 素材是否含音频（未探测时按「可能含音频」处理）。 */
function mediaHasAudio(media: EditMedia): boolean {
  if (media.kind === 'audio') return true
  return media.hasAudio !== false
}
function refreshDuration(): void {
  const p = project()
  p.duration = Math.max(30, Math.ceil(projectContentEnd(p) + 5))
}

/* ===== 选择（支持多选 + A/V 链接联动） ===== */
function primaryClip(): EditClip | undefined {
  if (primaryId) {
    const found = findClip(primaryId)
    if (found) return found
  }
  const first = selectedIds.values().next().value
  return first ? findClip(first) : undefined
}
function selectedClips(): EditClip[] {
  return project().clips.filter((c) => selectedIds.has(c.id))
}
/** 把链接组里的其它片段一起纳入选择。 */
function expandLinked(ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const links = new Set<string>()
  out.forEach((id) => {
    const c = findClip(id)
    if (c?.linkId) links.add(c.linkId)
  })
  if (links.size) {
    project().clips.forEach((c) => {
      if (c.linkId && links.has(c.linkId)) out.add(c.id)
    })
  }
  return out
}
function renderSelectionStyles(): void {
  document.querySelectorAll<HTMLElement>('.ed-clip.selected').forEach((el) => el.classList.remove('selected'))
  selectedIds.forEach((id) => {
    document.querySelector<HTMLElement>(`.ed-clip[data-clip-id="${id}"]`)?.classList.add('selected')
  })
}
function selectClips(ids: Iterable<string>, additive = false): void {
  const explicit = [...ids]
  const next = additive ? new Set(selectedIds) : new Set<string>()
  for (const id of explicit) next.add(id)
  const expanded = expandLinked(next)
  selectedIds.clear()
  expanded.forEach((id) => selectedIds.add(id))
  // 主片段跟最后一次显式点击保持一致（属性面板 / 操作作用于它）
  if (!additive && explicit.length) primaryId = explicit[explicit.length - 1]
  else if (!selectedIds.has(primaryId)) primaryId = explicit[explicit.length - 1] || [...selectedIds][0] || ''
  renderSelectionStyles()
  renderInspector()
}
function clearSelection(): void {
  selectedIds.clear()
  primaryId = ''
  renderSelectionStyles()
  renderInspector()
}
/** 与选中片段链接的音频片段（用于预览 / 导出时避免声音重复）。 */
function linkedAudioOf(clip: EditClip): EditClip | undefined {
  if (!clip.linkId) return undefined
  return project().clips.find((c) => c.linkId === clip.linkId && c.id !== clip.id && clipTrackKind(c) === 'audio')
}

/* ===== 转场 ===== */
/** 同轨前一个片段（允许已经和本片段重叠一个转场时长）。 */
function previousClipOnTrack(clip: EditClip): EditClip | undefined {
  const p = project()
  const slack = (clip.transition?.duration || 0) + 0.1
  return p.clips
    .filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start < clip.start + 0.001 && clipEnd(c) <= clip.start + slack)
    .sort((a, b) => clipEnd(b) - clipEnd(a))[0]
}

function addTransition(): void {
  const clip = primaryClip()
  if (!clip || clip.text || clipTrackKind(clip) !== 'video') return
  const prev = previousClipOnTrack(clip)
  if (!prev) {
    toast('该片段前面没有相邻片段，无法添加转场', 'error')
    return
  }
  if (clip.start - clipEnd(prev) > 0.5) {
    toast('与前一个片段间隔过大，先让它们相邻再添加转场', 'error')
    return
  }
  const d = Math.max(0.1, Math.min(0.6, prev.duration / 2, clip.duration / 2))
  clip.start = clipEnd(prev) - d
  clip.transition = { type: clip.transition?.type || 'dissolve', duration: d }
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
  toast('已添加转场', 'success', 1800)
}

function removeTransition(): void {
  const clip = primaryClip()
  if (!clip?.transition) return
  const prev = previousClipOnTrack(clip)
  const d = clip.transition.duration
  delete clip.transition
  clip.start = prev ? clipEnd(prev) : clip.start + d
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
}

function applyTransitionInput(el: HTMLInputElement | HTMLSelectElement, commit: boolean): void {
  const clip = primaryClip()
  if (!clip?.transition) return
  const prop = (el as HTMLElement).dataset.transProp
  if (prop === 'type') {
    clip.transition.type = el.value as EditTransitionType
  } else if (prop === 'duration') {
    const prev = previousClipOnTrack(clip)
    const maxD = prev ? Math.min(prev.duration - 0.05, clip.duration - 0.05) : 3
    const d = clamp(Number((el as HTMLInputElement).value) || 0.5, 0.1, Math.max(0.1, maxD))
    clip.transition.duration = d
    if (prev) clip.start = clipEnd(prev) - d
  }
  const out = document.querySelector<HTMLElement>('#edInspector [data-out="transitionDuration"]')
  if (out) out.textContent = clip.transition.duration.toFixed(2) + 's'
  if (!playing) syncMedia(true)
  if (commit) {
    refreshDuration()
    pushHistory()
    persistWorkspaces()
    renderAll()
  }
}

/* ===== 关键帧 ===== */
function clipLocalTime(clip: EditClip, t: number): number {
  return Math.max(0, t - clip.start)
}
function clipStaticValue(clip: EditClip, prop: EditKeyframeProp): number {
  if (prop === 'opacity') return clip.opacity
  if (prop === 'volume') return clip.volume
  if (prop === 'rotation') return clip.rotation
  return Number((clip.filter as unknown as Record<string, number>)[prop] ?? 0)
}
/** 取片段在时间线 t 处、指定属性的值（有关键帧则插值）。 */
function clipValue(clip: EditClip, prop: EditKeyframeProp, t: number): number {
  return evalKeyframes(clip.keyframes?.[prop], clipLocalTime(clip, t), clipStaticValue(clip, prop))
}
function cssFilterAt(clip: EditClip, t: number): string {
  const f = clip.filter
  return `brightness(${clipValue(clip, 'brightness', t)}%) contrast(${clipValue(clip, 'contrast', t)}%) saturate(${clipValue(clip, 'saturate', t)}%) grayscale(${clipValue(clip, 'grayscale', t)}%) blur(${f.blur}px)`
}
function keyframeIndexAt(clip: EditClip, prop: EditKeyframeProp, local: number): number {
  return (clip.keyframes?.[prop] || []).findIndex((k) => Math.abs(k.t - local) <= 0.06)
}
function writeKeyframes(clip: EditClip, prop: EditKeyframeProp, list: EditKeyframe[]): void {
  clip.keyframes = clip.keyframes || {}
  if (list.length) clip.keyframes[prop] = list
  else delete clip.keyframes[prop]
  if (!Object.keys(clip.keyframes).length) delete clip.keyframes
}
function setKeyframeAt(clip: EditClip, prop: EditKeyframeProp, local: number, value: number): void {
  const list = [...(clip.keyframes?.[prop] || [])]
  const idx = list.findIndex((k) => Math.abs(k.t - local) <= 0.06)
  const t = Math.round(Math.max(0, local) * 100) / 100
  if (idx >= 0) list[idx] = { ...list[idx], v: value }
  else list.push({ t, v: value, e: 'linear' })
  list.sort((a, b) => a.t - b.t)
  writeKeyframes(clip, prop, list)
}
function setClipStaticValue(clip: EditClip, prop: EditKeyframeProp, value: number): void {
  if (prop === 'opacity') clip.opacity = value
  else if (prop === 'volume') clip.volume = value
  else if (prop === 'rotation') clip.rotation = value
  else (clip.filter as unknown as Record<string, number>)[prop] = value
}
function kfFormat(prop: EditKeyframeProp, v: number): string {
  if (prop === 'opacity') return `${Math.round(v * 100)}%`
  if (prop === 'volume') return `${Math.round(v * 100)}%`
  if (prop === 'rotation') return `${v.toFixed(0)}°`
  if (prop === 'grayscale') return `${v.toFixed(0)}%`
  return v.toFixed(0)
}
function toggleKeyframe(prop: EditKeyframeProp): void {
  const clip = primaryClip()
  if (!clip) return
  const local = clipLocalTime(clip, project().playhead)
  const idx = keyframeIndexAt(clip, prop, local)
  if (idx >= 0) {
    const list = [...(clip.keyframes?.[prop] || [])]
    list.splice(idx, 1)
    writeKeyframes(clip, prop, list)
  } else {
    setKeyframeAt(clip, prop, local, clipValue(clip, prop, project().playhead))
  }
  pushHistory()
  persistWorkspaces()
  renderAll()
  if (!playing) syncMedia(true)
}
function applyKeyframeInput(el: HTMLInputElement, commit: boolean): void {
  const clip = primaryClip()
  if (!clip) return
  const prop = (el as HTMLElement).dataset.kfProp as EditKeyframeProp
  const spec = KEYFRAME_PROPS.find((p) => p.id === prop)
  if (!spec) return
  const value = clamp(Number(el.value) || 0, spec.min, spec.max)
  const local = clipLocalTime(clip, project().playhead)
  if (clip.keyframes?.[prop]?.length) setKeyframeAt(clip, prop, local, value)
  else setClipStaticValue(clip, prop, value)
  const out = document.querySelector<HTMLElement>(`#edInspector [data-kf-out="${prop}"]`)
  if (out) out.textContent = kfFormat(prop, value)
  if (!playing) syncMedia(true)
  if (commit) {
    pushHistory()
    persistWorkspaces()
    renderAll()
  }
}

/* ===== 文字 / 字幕 ===== */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return `rgba(0, 0, 0, ${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** 新建文字 / 字幕片段（放在第一条可用视频轨上）。 */
function addTextClip(content = '点击右侧属性面板编辑文字', style?: Partial<EditTextStyle>): EditClip | null {
  const p = project()
  const track = p.tracks.find((t) => t.kind === 'video' && !t.locked)
  if (!track) {
    toast('没有可用的视频轨，无法添加文字', 'error')
    return null
  }
  const clip: EditClip = {
    id: editUid('c'),
    mediaId: '',
    trackId: track.id,
    start: p.playhead,
    inPoint: 0,
    duration: 3,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    rotation: 0,
    filter: createDefaultFilter(),
    text: { ...createDefaultTextStyle(content), ...(style || {}) }
  }
  p.clips.push(clip)
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  selectClips([clip.id])
  renderAll()
  return clip
}

function parseTimecode(v: string): number {
  const m = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(v.trim())
  if (!m) return NaN
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}
function formatTimecode(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(ss)},${pad(ms, 3)}`
}

interface SubtitleCue {
  start: number
  end: number
  text: string
}
/** 解析 SRT / WebVTT（宽松）。 */
function parseSubtitle(input: string): SubtitleCue[] {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const cues: SubtitleCue[] = []
  const blocks = text.split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (!lines.length) continue
    let idx = 0
    if (/^\d+$/.test(lines[0].trim())) idx = 1
    const timeLine = lines[idx]
    if (!timeLine || !timeLine.includes('-->')) continue
    const [a, b] = timeLine.split('-->')
    const start = parseTimecode(a)
    const end = parseTimecode((b || '').trim().split(/\s+/)[0])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const content = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '').trim()
    if (!content) continue
    cues.push({ start, end, text: content })
  }
  return cues
}
/** 把文字片段导出为 SRT。 */
function buildSrt(clips: EditClip[]): string {
  const list = clips.filter((c) => c.text && c.text.content.trim()).sort((a, b) => a.start - b.start)
  return list
    .map((c, i) => `${i + 1}\n${formatTimecode(c.start)} --> ${formatTimecode(clipEnd(c))}\n${c.text!.content.trim()}\n`)
    .join('\n')
}

/** 把解析出的字幕条目批量创建为文字片段。 */
function applySubtitleCues(cues: SubtitleCue[]): number {
  if (!cues.length) return 0
  const p = project()
  const track = p.tracks.find((t) => t.kind === 'video' && !t.locked)
  if (!track) {
    toast('没有可用的视频轨，无法导入字幕', 'error')
    return 0
  }
  const created: string[] = []
  cues.forEach((cue) => {
    const clip: EditClip = {
      id: editUid('c'),
      mediaId: '',
      trackId: track.id,
      start: cue.start,
      inPoint: 0,
      duration: Math.max(0.3, cue.end - cue.start),
      speed: 1,
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      opacity: 1,
      rotation: 0,
      filter: createDefaultFilter(),
      text: { ...createDefaultTextStyle(cue.text), fontSize: 52, y: 0.86 }
    }
    p.clips.push(clip)
    created.push(clip.id)
  })
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  selectClips(created)
  renderAll()
  return created.length
}

async function importSubtitle(): Promise<void> {
  try {
    const res = await editorApi.pickSubtitle()
    if (!res.ok) {
      if (!res.canceled) toast(res.error || '读取字幕失败', 'error')
      return
    }
    const count = applySubtitleCues(parseSubtitle(res.content || ''))
    if (!count) {
      toast('没有解析到字幕条目（支持 SRT / VTT）', 'error')
      return
    }
    toast(`已导入 ${count} 条字幕`, 'success', 2600)
  } catch (e) {
    toast('导入字幕失败：' + (e as Error).message, 'error')
  }
}

async function exportSubtitle(): Promise<void> {
  const clips = project().clips.filter((c) => c.text && c.text.content.trim())
  if (!clips.length) {
    toast('时间线上没有文字 / 字幕片段', 'info')
    return
  }
  const srt = buildSrt(clips)
  const data = new TextEncoder().encode(srt)
  const res = await editorApi.save({ name: '字幕.srt', data, filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
  if (res.ok) toast('字幕已导出：' + res.path, 'success', 4000)
  else if (!res.canceled) toast('导出字幕失败：' + (res.error || ''), 'error')
}

/* ===== 文字绘制（预览叠加 + 导出 PNG） ===== */
function wrapText(ctx: CanvasRenderingContext2D, content: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const raw of String(content || '').split('\n')) {
    if (!raw) {
      out.push('')
      continue
    }
    let line = ''
    for (const ch of raw) {
      const next = line + ch
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line)
        line = ch
      } else {
        line = next
      }
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function drawTextLayer(ctx: CanvasRenderingContext2D, st: EditTextStyle, W: number, H: number): void {
  const scale = H / 1080
  const fontSize = Math.max(1, st.fontSize * scale)
  ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${fontSize}px ${st.fontFamily}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = st.align
  const lines = wrapText(ctx, st.content, W * 0.92)
  const lineHeight = fontSize * 1.28
  const totalH = lines.length * lineHeight
  const x = st.x * W
  const startY = st.y * H - totalH / 2 + lineHeight / 2
  if (st.background) {
    const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width), 0)
    const padX = fontSize * 0.35
    const padY = fontSize * 0.18
    const bx = x - (st.align === 'center' ? maxW / 2 : st.align === 'right' ? maxW : 0) - padX
    ctx.fillStyle = hexToRgba(st.backgroundColor, 0.6)
    roundRect(ctx, bx, startY - lineHeight / 2 - padY, maxW + padX * 2, totalH + padY * 2, fontSize * 0.18)
    ctx.fill()
  }
  lines.forEach((line, i) => {
    const ly = startY + i * lineHeight
    if (st.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)'
      ctx.shadowBlur = fontSize * 0.12
      ctx.shadowOffsetY = fontSize * 0.06
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
    }
    if (st.stroke && st.strokeWidth > 0) {
      ctx.lineWidth = Math.max(1, st.strokeWidth * scale)
      ctx.strokeStyle = st.strokeColor
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, ly)
    }
    ctx.fillStyle = st.color
    ctx.fillText(line, x, ly)
  })
}

/** 在预览区渲染活动文字叠加层。 */
function renderTextOverlay(): void {
  const layer = $('#edTextLayer')
  const preview = $('#edPreview')
  if (!layer || !preview) return
  const p = project()
  const t = p.playhead
  const clips = p.clips
    .filter((c) => c.text && clipTrackKind(c) === 'video' && !findTrack(c.trackId)?.hidden && clipActive(c, t))
    .sort((a, b) => trackIndex(a.trackId) - trackIndex(b.trackId))
  layer.innerHTML = ''
  if (!clips.length) return
  const video = previewVideo
  if (video && video.videoWidth) {
    const pr = preview.getBoundingClientRect()
    const vr = video.getBoundingClientRect()
    layer.style.left = `${vr.left - pr.left}px`
    layer.style.top = `${vr.top - pr.top}px`
    layer.style.width = `${vr.width}px`
    layer.style.height = `${vr.height}px`
  } else {
    layer.style.left = '0'
    layer.style.top = '0'
    layer.style.width = '100%'
    layer.style.height = '100%'
  }
  const h = layer.clientHeight || preview.clientHeight || 540
  const scale = h / 1080
  clips.forEach((c) => {
    const st = c.text as EditTextStyle
    const el = document.createElement('div')
    el.className = 'ed-overlay-text'
    el.textContent = st.content
    el.style.left = `${st.x * 100}%`
    el.style.top = `${st.y * 100}%`
    el.style.transform =
      st.align === 'left' ? 'translate(0, -50%)' : st.align === 'right' ? 'translate(-100%, -50%)' : 'translate(-50%, -50%)'
    el.style.fontFamily = st.fontFamily
    el.style.fontSize = `${Math.max(1, st.fontSize * scale)}px`
    el.style.color = st.color
    el.style.fontWeight = st.bold ? '700' : '400'
    el.style.fontStyle = st.italic ? 'italic' : 'normal'
    el.style.textAlign = st.align
    if (st.shadow) el.style.textShadow = '0 2px 6px rgba(0, 0, 0, 0.8)'
    if (st.stroke) el.style.webkitTextStroke = `${Math.max(1, st.strokeWidth * scale * 0.5)}px ${st.strokeColor}`
    if (st.background) {
      el.style.background = hexToRgba(st.backgroundColor, 0.6)
      el.style.padding = `${0.12 * st.fontSize * scale}px ${0.3 * st.fontSize * scale}px`
      el.style.borderRadius = '6px'
    }
    el.style.opacity = String(c.opacity * audioFade(c, t))
    layer.appendChild(el)
  })
}

async function renderTextPng(clip: EditClip, W: number, H: number): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  drawTextLayer(ctx, clip.text as EditTextStyle, W, H)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}

/** 导出前把文字片段渲染成透明 PNG，写入临时目录并返回 clipId -> 路径。 */
async function prepareTextImages(W: number, H: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const clips = project().clips.filter((c) => c.text && c.text.content.trim())
  for (const clip of clips) {
    const data = await renderTextPng(clip, W, H)
    if (!data) continue
    const tmp = await editorApi.tempFile({ name: `text-${clip.id}.png` })
    if (!tmp.ok || !tmp.path) continue
    const written = await editorApi.writeFile({ path: tmp.path, data })
    if (written.ok && written.path) out[clip.id] = written.path
  }
  return out
}

/* ===== 历史（撤销 / 重做） ===== */
function snapshot(): string {
  return JSON.stringify(project())
}
function resetHistory(): void {
  history = [snapshot()]
  historyIndex = 0
}
function pushHistory(): void {
  const snap = snapshot()
  if (history[historyIndex] === snap) return
  history = history.slice(0, historyIndex + 1)
  history.push(snap)
  if (history.length > 80) history.shift()
  historyIndex = history.length - 1
}
function restore(snap: string): void {
  if (!wsRef) return
  wsRef.project = JSON.parse(snap) as EditProject
  refreshDuration()
  persistWorkspaces()
  renderAll()
}
function undo(): void {
  if (historyIndex <= 0) return
  historyIndex--
  restore(history[historyIndex])
}
function redo(): void {
  if (historyIndex >= history.length - 1) return
  historyIndex++
  restore(history[historyIndex])
}

/* ===== 媒体导入 ===== */
async function importMedia(): Promise<void> {
  try {
    const res = await editorApi.import()
    if (!res.ok) {
      if (!res.canceled) toast(res.error || '导入失败', 'error')
      return
    }
    await addMediaFiles(res.files)
  } catch (e) {
    toast('导入失败：' + (e as Error).message, 'error')
  }
}

async function addMediaPaths(paths: string[]): Promise<void> {
  const res = await editorApi.resolve({ paths })
  await addMediaFiles(res.files || [])
}

async function addMediaFiles(files: EditFileInfo[]): Promise<void> {
  if (!wsRef || !files.length) return
  const p = project()
  let added = 0
  for (const f of files) {
    if (!f.kind) {
      toast(`不支持的格式：${f.name}`, 'error')
      continue
    }
    if (p.media.some((m) => m.path === f.path)) continue
    p.media.push({ id: editUid('m'), name: f.name, path: f.path, url: f.url, kind: f.kind, duration: 0 })
    added++
  }
  if (!added) return
  if (files.length === p.media.length && !projectContentEnd(p)) {
    /* 首次导入提示下一步 */
  }
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
  for (const media of p.media.filter((m) => !m.duration)) void enrichMedia(media)
  toast(`已导入 ${added} 个媒体文件，可拖到时间线或点击「+」添加`, 'success')
}

/**
 * 媒体入库后补齐信息：
 * 优先 ffprobe（时长 / 分辨率 / 编码 / 是否可直接播放），
 * 非 Web 友好格式自动转码出 MP4 代理；没有 ffmpeg 时回退到浏览器元数据。
 */
async function enrichMedia(media: EditMedia): Promise<void> {
  if (!wsRef) return
  if (ffmpegInfo === null) {
    try {
      ffmpegInfo = await editorApi.ffmpegStatus()
    } catch {
      ffmpegInfo = null
    }
  }
  if (ffmpegInfo?.available) {
    const res = await editorApi.probe({ path: media.path })
    if (res.ok) {
      media.duration = res.duration > 0 ? res.duration : media.duration
      media.width = res.width
      media.height = res.height
      media.container = res.container
      media.videoCodec = res.videoCodec
      media.audioCodec = res.audioCodec
      media.hasAudio = res.hasAudio
      media.needsProxy = !res.playable
      // MediaRecorder 等生成的 WebM 头部没有 duration，ffprobe 也可能给 0：
      // 交给浏览器 seek 兜底拿真实时长。
      if (!(media.duration > 0)) await probeWithElement(media)
      persistWorkspaces()
      renderAll()
      if (media.needsProxy) {
        const ok = await transcodeMedia(media)
        if (!ok) toast(`「${media.name}」编码不受支持，且自动转码失败`, 'error', 5200)
      }
      void loadThumbnail(media)
      if (media.kind === 'video') void loadFilmstrip(media)
      if (media.kind === 'audio' || res.hasAudio) void computeWaveform(media)
      return
    }
  }
  await probeWithElement(media)
}

/** 转码非 Web 友好素材为 MP4 代理（进度通过 editor:progress 推送）。 */
async function transcodeMedia(media: EditMedia): Promise<boolean> {
  setStatus(`正在转码「${media.name}」…`)
  try {
    const res = await editorApi.transcode({ path: media.path, mediaId: media.id })
    if (res.ok && res.proxyPath) {
      media.proxyPath = res.proxyPath
      media.proxyUrl = res.proxyUrl
      if (res.duration) media.duration = res.duration
      persistWorkspaces()
      renderAll()
      void loadThumbnail(media)
      if (media.kind === 'video') void loadFilmstrip(media)
      setStatus('')
      return true
    }
    setStatus('')
    return false
  } catch {
    setStatus('')
    return false
  }
}

/** 抽一帧作为媒体缩略图（缓存于内存，不写入工程）。 */
async function loadThumbnail(media: EditMedia): Promise<void> {
  if (thumbCache.has(media.id)) return
  try {
    const at = Math.min(0.5, Math.max(0, (media.duration || 1) / 2))
    const res = await editorApi.thumbnail({ path: media.proxyPath || media.path, at })
    if (res.ok && res.dataUrl) {
      thumbCache.set(media.id, res.dataUrl)
      renderMedia()
      renderTimeline()
    }
  } catch {
    /* 缩略图失败不影响编辑 */
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

const filmstripLoading = new Set<string>()
/** 生成真实胶片带：抽 6 帧横向拼成一张长图，平铺到片段背景。 */
async function loadFilmstrip(media: EditMedia): Promise<void> {
  if (media.kind !== 'video' || filmstripCache.has(media.id) || filmstripLoading.has(media.id)) return
  if (!ffmpegInfo?.available) return
  filmstripLoading.add(media.id)
  try {
    const dur = media.duration || 0
    const frames = 6
    const thumbs: string[] = []
    for (let i = 0; i < frames; i++) {
      const at = dur > 0 ? Math.min(dur - 0.05, (dur * i) / frames + Math.min(0.2, dur / 20)) : 0
      const res = await editorApi.thumbnail({ path: media.proxyPath || media.path, at })
      if (res.ok && res.dataUrl) thumbs.push(res.dataUrl)
    }
    if (thumbs.length < 2) return
    const first = await loadImage(thumbs[0])
    const fh = Math.max(32, Math.round((first.naturalHeight || 90) * 0.5))
    const fw = Math.max(56, Math.round((first.naturalWidth || 160) * 0.5))
    const strip = document.createElement('canvas')
    strip.width = fw * thumbs.length
    strip.height = fh
    const ctx = strip.getContext('2d')
    if (!ctx) return
    for (let i = 0; i < thumbs.length; i++) {
      const img = await loadImage(thumbs[i])
      ctx.drawImage(img, i * fw, 0, fw, fh)
    }
    filmstripCache.set(media.id, strip.toDataURL('image/jpeg', 0.72))
    renderTimeline()
  } catch {
    /* 胶片带失败回退单帧缩略图 */
  } finally {
    filmstripLoading.delete(media.id)
  }
}

/** 无 ffmpeg 时的兜底：用浏览器媒体元素读元数据。 */
async function probeWithElement(media: EditMedia): Promise<void> {
  const el = document.createElement(media.kind === 'video' ? 'video' : 'audio')
  el.preload = 'metadata'
  el.muted = true
  const cleanup = (): void => {
    el.removeAttribute('src')
    el.load()
  }
  const done = (): void => {
    cleanup()
    persistWorkspaces()
    renderAll()
  }
  el.addEventListener(
    'loadedmetadata',
    () => {
      if (el instanceof HTMLVideoElement) {
        media.width = el.videoWidth || undefined
        media.height = el.videoHeight || undefined
      }
      const d = el.duration
      if (Number.isFinite(d) && d > 0) {
        media.duration = d
        done()
        return
      }
      // MediaRecorder 录制的 WebM 头里没有 duration（Infinity）：
      // seek 到极大值让浏览器解析出真实时长，超时则退化为 5s。
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        const fd = el.duration
        media.duration = Number.isFinite(fd) && fd > 0 ? fd : 5
        done()
      }
      el.addEventListener('durationchange', settle, { once: true })
      el.addEventListener('seeked', settle, { once: true })
      try {
        el.currentTime = 1e101
      } catch {
        settle()
      }
      setTimeout(settle, 1500)
    },
    { once: true }
  )
  el.addEventListener(
    'error',
    () => {
      toast(`无法解析媒体「${media.name}」，可能编码不受支持`, 'error')
      cleanup()
    },
    { once: true }
  )
  el.src = mediaUrl(media)
  el.load()
  if (media.kind === 'audio') void computeWaveform(media)
}

/** 解码音频并计算波形峰值（最多 600 个点）。 */
async function computeWaveform(media: EditMedia): Promise<void> {
  if (media.peaks?.length) return
  try {
    const res = await editorApi.read({ path: mediaLocalPath(media), maxBytes: 48 * 1024 * 1024 })
    if (!res.ok || !res.data) return
    const copy = new Uint8Array(res.data.byteLength)
    copy.set(res.data)
    const ac = getAudioContext()
    const buffer = await ac.decodeAudioData(copy.buffer as ArrayBuffer)
    // 多分辨率：约 120 点/秒（600 ~ 4096），绘制时再按当前缩放重采样
    const buckets = clamp(Math.round((buffer.duration || 1) * 120), 600, 4096)
    const channels: Float32Array[] = []
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c))
    const step = Math.max(1, Math.floor(buffer.length / buckets))
    const peaks: number[] = []
    for (let i = 0; i < buckets; i++) {
      let max = 0
      const start = i * step
      const end = Math.min(buffer.length, start + step)
      for (let j = start; j < end; j += 4) {
        for (const data of channels) max = Math.max(max, Math.abs(data[j]))
      }
      peaks.push(Math.round(max * 1000) / 1000)
    }
    media.peaks = peaks
    persistWorkspaces()
    renderTimeline()
  } catch {
    /* 波形失败不影响编辑 */
  }
}

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

function connectElement(el: HTMLMediaElement): void {
  const ac = getAudioContext()
  if (!masterGain) {
    masterGain = ac.createGain()
    masterGain.connect(ac.destination)
  }
  if (sourcedEls.has(el)) return
  try {
    const src = ac.createMediaElementSource(el)
    src.connect(masterGain)
    sourcedEls.add(el)
  } catch {
    /* 已连接或不可用 */
  }
}

/* ===== 时间线操作 ===== */
function firstTrack(kind: EditTrackKind): EditTrack | undefined {
  return project().tracks.find((t) => t.kind === kind && !t.locked)
}

function addMediaToTimeline(mediaId: string, trackId?: string, atTime?: number): EditClip | null {
  const p = project()
  const media = findMedia(mediaId)
  if (!media) return null
  const wantKind: EditTrackKind = media.kind === 'video' ? 'video' : 'audio'
  const explicit = trackId ? findTrack(trackId) : undefined
  const track = explicit && explicit.kind === wantKind ? explicit : firstTrack(wantKind)
  if (!track) {
    toast('没有可用的' + (wantKind === 'video' ? '视频' : '音频') + '轨道', 'error')
    return null
  }
  const duration = Math.max(0.2, media.duration || 5)
  // 默认追加到轨道末尾，避免完全重叠
  const appendAt = p.clips.filter((c) => c.trackId === track.id).reduce((max, c) => Math.max(max, clipEnd(c)), 0)
  const start = Math.max(0, atTime ?? (p.clips.length ? p.playhead : appendAt))

  // 视频 + 音频自动成组：视频片段放视频轨，音频片段放音频轨，共享 linkId
  const audioTrack = p.tracks.find((t) => t.kind === 'audio' && !t.locked)
  const linkId = media.kind === 'video' && mediaHasAudio(media) && audioTrack ? editUid('link') : undefined
  const base: Omit<EditClip, 'id' | 'trackId'> = {
    mediaId,
    start,
    inPoint: 0,
    duration,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    rotation: 0,
    filter: createDefaultFilter(),
    ...(linkId ? { linkId } : {})
  }
  const clip: EditClip = { ...base, id: editUid('c'), trackId: track.id }
  p.clips.push(clip)
  const created = [clip.id]
  if (linkId && audioTrack) {
    const audioClip: EditClip = { ...base, id: editUid('c'), trackId: audioTrack.id }
    p.clips.push(audioClip)
    created.push(audioClip.id)
  }
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  selectClips(created)
  renderAll()
  return clip
}

function splitAtPlayhead(): void {
  const p = project()
  const t = p.playhead
  const pool = selectedIds.size ? selectedClips() : p.clips
  const targets = pool.filter((c) => !findTrack(c.trackId)?.locked && t > c.start + MIN_CLIP && t < clipEnd(c) - MIN_CLIP)
  if (!targets.length) {
    toast('播放头位置没有可分割的片段', 'info')
    return
  }
  // 按链接组分组：同组片段用同一个新 linkId，保证右半段仍然 A/V 联动
  const groups = new Map<string, EditClip[]>()
  targets.forEach((c) => {
    const key = c.linkId || `solo:${c.id}`
    const arr = groups.get(key) || []
    arr.push(c)
    groups.set(key, arr)
  })
  const created: string[] = []
  groups.forEach((clips, key) => {
    const rightLink = key.startsWith('solo:') ? undefined : editUid('link')
    clips.forEach((c) => {
      const offset = t - c.start
      const right: EditClip = {
        ...c,
        id: editUid('c'),
        start: t,
        inPoint: c.inPoint + offset * c.speed,
        duration: c.duration - offset,
        ...(rightLink ? { linkId: rightLink } : { linkId: undefined })
      }
      c.duration = offset
      p.clips.push(right)
      created.push(right.id)
    })
  })
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  selectClips(created)
  renderAll()
}

/** 删除选中片段；ripple=true 时把同轨后面的片段整体左移（涟漪删除）。 */
function deleteSelected(ripple = false): void {
  if (!selectedIds.size) return
  const p = project()
  const removed = p.clips.filter((c) => selectedIds.has(c.id))
  if (!removed.length) return
  if (ripple) {
    const byTrack = new Map<string, EditClip[]>()
    removed.forEach((c) => {
      const arr = byTrack.get(c.trackId) || []
      arr.push(c)
      byTrack.set(c.trackId, arr)
    })
    byTrack.forEach((clips, trackId) => {
      const firstStart = Math.min(...clips.map((c) => c.start))
      const total = clips.reduce((sum, c) => sum + c.duration, 0)
      p.clips.forEach((c) => {
        if (c.trackId === trackId && !selectedIds.has(c.id) && c.start >= firstStart) {
          c.start = Math.max(0, c.start - total)
        }
      })
    })
  }
  p.clips = p.clips.filter((c) => !selectedIds.has(c.id))
  clearSelection()
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
}

function duplicateSelected(): void {
  const clips = selectedClips()
  if (!clips.length) return
  const p = project()
  const minStart = Math.min(...clips.map((c) => c.start))
  const maxEnd = Math.max(...clips.map((c) => clipEnd(c)))
  const shift = maxEnd - minStart
  const linkMap = new Map<string, string>()
  const created: string[] = []
  clips.forEach((c) => {
    let linkId = c.linkId
    if (linkId) {
      if (!linkMap.has(linkId)) linkMap.set(linkId, editUid('link'))
      linkId = linkMap.get(linkId)
    }
    const copy: EditClip = { ...c, id: editUid('c'), start: c.start + shift, linkId }
    p.clips.push(copy)
    created.push(copy.id)
  })
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  selectClips(created)
  renderAll()
}

/** 复制选中片段到剪贴板。 */
function copySelected(): void {
  const clips = selectedClips()
  if (!clips.length) return
  clipClipboard = clips.map((c) => ({ ...c, filter: { ...c.filter } }))
  toast(`已复制 ${clips.length} 个片段`, 'info', 1600)
}

/** 粘贴到播放头（保持相对位置与链接关系）。 */
function pasteClipboard(): void {
  if (!clipClipboard.length) return
  const p = project()
  const t = p.playhead
  const base = Math.min(...clipClipboard.map((c) => c.start))
  const linkMap = new Map<string, string>()
  const created: string[] = []
  clipClipboard.forEach((c) => {
    let linkId = c.linkId
    if (linkId) {
      if (!linkMap.has(linkId)) linkMap.set(linkId, editUid('link'))
      linkId = linkMap.get(linkId)
    }
    const copy: EditClip = {
      ...c,
      id: editUid('c'),
      start: Math.max(0, t + (c.start - base)),
      linkId,
      filter: { ...c.filter }
    }
    p.clips.push(copy)
    created.push(copy.id)
  })
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  selectClips(created)
  renderAll()
  toast(`已粘贴 ${created.length} 个片段`, 'success', 1600)
}

/** 给选中片段建立 / 解除链接。 */
function linkSelected(): void {
  const clips = selectedClips()
  if (clips.length < 2) {
    toast('至少选择两个片段才能链接', 'info')
    return
  }
  const linkId = editUid('link')
  clips.forEach((c) => {
    c.linkId = linkId
  })
  pushHistory()
  persistWorkspaces()
  renderTimeline()
  renderInspector()
  toast(`已链接 ${clips.length} 个片段`, 'success', 1800)
}
function unlinkSelected(): void {
  const clips = selectedClips()
  if (!clips.length) return
  clips.forEach((c) => {
    delete c.linkId
  })
  pushHistory()
  persistWorkspaces()
  renderTimeline()
  renderInspector()
  toast('已取消链接', 'info', 1600)
}

function snapStart(start: number, duration: number, excludeId: string): number {
  const p = project()
  if (!p.snap) return Math.max(0, start)
  const candidates: number[] = [p.playhead, 0]
  p.clips.forEach((c) => {
    if (c.id === excludeId) return
    candidates.push(c.start, clipEnd(c))
  })
  const threshold = 8 / p.zoom
  let best = start
  let bestDelta = threshold
  for (const c of candidates) {
    const d1 = Math.abs(start - c)
    if (d1 < bestDelta) {
      bestDelta = d1
      best = c
    }
    const d2 = Math.abs(start + duration - c)
    if (d2 < bestDelta) {
      bestDelta = d2
      best = c - duration
    }
  }
  return Math.max(0, best)
}

/* ===== 渲染：媒体库 ===== */
function renderMedia(): void {
  const list = $('#edMediaList')
  if (!list) return
  const p = project()
  if (!p.media.length) {
    list.innerHTML = '<div class="ed-empty">还没有媒体<br /><span>点击「导入媒体」添加视频 / 音频</span></div>'
    return
  }
  list.innerHTML = ''
  p.media.forEach((m) => {
    const el = document.createElement('div')
    el.className = 'ed-media-item'
    el.draggable = true
    el.dataset.mediaId = m.id
    const meta =
      m.kind === 'video'
        ? `${m.width && m.height ? `${m.width}×${m.height} · ` : ''}${formatTime(m.duration)}`
        : formatTime(m.duration)
    const thumb = thumbCache.get(m.id)
    const icon = thumb
      ? `<img class="ed-media-thumb" src="${thumb}" alt="" />`
      : `<span class="ed-media-icon ${m.kind}">${m.kind === 'video' ? '▶' : '♪'}</span>`
    const tag = m.needsProxy ? (m.proxyPath ? '<i class="ed-tag">代理</i>' : '<i class="ed-tag warn">转码中</i>') : ''
    el.innerHTML = `
      ${icon}
      <span class="ed-media-info"><strong title="${esc(m.name)}">${esc(m.name)}</strong><small>${meta}${tag}</small></span>
      <button class="ed-mini" data-act="add-media" data-media-id="${m.id}" title="添加到时间线">+</button>
      <button class="ed-mini danger" data-act="remove-media" data-media-id="${m.id}" title="从媒体库移除">×</button>`
    list.appendChild(el)
  })
}

/* ===== 渲染：时间线 ===== */
function viewDuration(): number {
  return Math.max(60, projectContentEnd(project()) + 10)
}

function drawWave(canvas: HTMLCanvasElement | null, peaks?: number[]): void {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
  if (!peaks || !peaks.length) {
    ctx.fillRect(0, h / 2 - 1, w, 2)
    return
  }
  // 按当前画布宽度重采样峰值：缩放越大画得越细，实现多分辨率波形
  const step = peaks.length / w
  for (let x = 0; x < w; x++) {
    const s = Math.min(peaks.length - 1, Math.floor(x * step))
    const e = Math.max(s + 1, Math.min(peaks.length, Math.floor((x + 1) * step)))
    let amp = 0
    for (let i = s; i < e; i++) amp = Math.max(amp, peaks[i])
    const hh = Math.max(1, Math.max(0.04, amp) * (h * 0.46))
    ctx.fillRect(x, h / 2 - hh, 1, hh * 2)
  }
}

function buildClipEl(clip: EditClip): HTMLElement {
  const p = project()
  const media = findMedia(clip.mediaId)
  const isText = !!clip.text
  const isAudio = !isText && clipTrackKind(clip) === 'audio'
  const el = document.createElement('div')
  el.className =
    `ed-clip ${isText ? 'text' : isAudio ? 'audio' : 'video'}` +
    (selectedIds.has(clip.id) ? ' selected' : '') +
    (clip.linkId ? ' linked' : '')
  el.dataset.clipId = clip.id
  el.style.left = clip.start * p.zoom + 'px'
  el.style.width = Math.max(10, clip.duration * p.zoom) + 'px'
  const label = isText ? clip.text!.content.split('\n')[0] || '文字' : clip.label || media?.name || '片段'
  el.innerHTML =
    '<span class="ed-clip-handle l" data-handle="l"></span>' +
    (isText
      ? '<span class="ed-text-glyph">T</span>'
      : isAudio
        ? `<canvas class="ed-wave" width="${clamp(Math.round(clip.duration * p.zoom), 40, 2400)}" height="46"></canvas>`
        : '<span class="ed-filmstrip"></span>') +
    `<span class="ed-clip-label">${esc(label)}</span>` +
    (clip.linkId ? '<span class="ed-link-dot" title="已链接 A/V"></span>' : '') +
    '<span class="ed-clip-handle r" data-handle="r"></span>'
  if (clip.transition) {
    const badge = document.createElement('span')
    badge.className = 'ed-transition-badge'
    badge.style.width = `${Math.max(12, clip.transition.duration * p.zoom)}px`
    const label = TRANSITIONS.find((t) => t.id === clip.transition!.type)?.label || '转场'
    badge.title = `${label} ${clip.transition.duration.toFixed(2)}s`
    badge.textContent = '⇄'
    el.appendChild(badge)
  }
  if (clip.keyframes) {
    const times = new Set<number>()
    Object.values(clip.keyframes).forEach((list) => (list || []).forEach((k) => times.add(Math.round(k.t * 100) / 100)))
    times.forEach((kt) => {
      const dot = document.createElement('i')
      dot.className = 'ed-kf-dot'
      dot.style.left = `${kt * p.zoom}px`
      dot.title = `关键帧 ${kt.toFixed(2)}s`
      el.appendChild(dot)
    })
  }
  if (isAudio) {
    drawWave(el.querySelector('canvas'), media?.peaks)
  } else if (!isText) {
    const strip = filmstripCache.get(clip.mediaId)
    const thumb = thumbCache.get(clip.mediaId)
    if (strip) {
      el.classList.add('has-thumb', 'filmstrip')
      el.style.backgroundImage = `linear-gradient(90deg, rgba(0,0,0,0.3), rgba(0,0,0,0.1)), url("${strip}")`
    } else if (thumb) {
      el.classList.add('has-thumb')
      el.style.backgroundImage = `linear-gradient(90deg, rgba(0,0,0,0.45), rgba(0,0,0,0.15)), url("${thumb}")`
    }
  }
  return el
}

function renderTimeline(): void {
  const inner = $('#edTlInner')
  const ruler = $('#edRuler')
  const rows = $('#edTlRows')
  if (!inner || !ruler || !rows) return
  const p = project()
  const view = viewDuration()
  const width = view * p.zoom
  inner.style.setProperty('--tl-width', width + 'px')
  inner.style.width = HEAD + width + 'px'

  const step = p.zoom >= 140 ? 1 : p.zoom >= 70 ? 2 : p.zoom >= 35 ? 5 : 10
  let ticks = ''
  for (let t = 0; t <= view + 0.001; t += step) {
    ticks += `<div class="ed-tick" style="left:${(t * p.zoom).toFixed(1)}px"><span>${formatTime(t).replace(/\.\d+$/, '')}</span></div>`
  }
  ruler.style.width = width + 'px'
  ruler.innerHTML = ticks

  rows.innerHTML = ''
  p.tracks.forEach((track) => {
    const row = document.createElement('div')
    row.className = 'ed-tl-row'
    row.dataset.trackId = track.id
    const head = document.createElement('div')
    head.className = 'ed-tl-head'
    head.innerHTML =
      `<span class="ed-tl-name" title="${esc(track.name)}">${esc(track.name)}</span>` +
      `<button class="ed-track-btn${track.muted ? ' on' : ''}" data-act="track-mute" data-track-id="${track.id}" title="静音">M</button>` +
      `<button class="ed-track-btn${track.hidden ? ' on' : ''}" data-act="track-hide" data-track-id="${track.id}" title="隐藏画面">V</button>` +
      `<button class="ed-track-btn${track.locked ? ' on' : ''}" data-act="track-lock" data-track-id="${track.id}" title="锁定">L</button>` +
      (p.tracks.length > 1
        ? `<button class="ed-track-btn danger" data-act="track-remove" data-track-id="${track.id}" title="删除轨道">×</button>`
        : '')
    const lane = document.createElement('div')
    lane.className = `ed-lane ${track.kind}`
    lane.dataset.trackId = track.id
    lane.style.width = width + 'px'
    p.clips.filter((c) => c.trackId === track.id).forEach((c) => lane.appendChild(buildClipEl(c)))
    row.appendChild(head)
    row.appendChild(lane)
    rows.appendChild(row)
  })
  updatePlayhead()
}

function updatePlayhead(): void {
  const p = project()
  const ph = $('#edPlayhead')
  if (ph) ph.style.left = HEAD + p.playhead * p.zoom + 'px'
  const seek = $('#edSeek') as HTMLInputElement | null
  if (seek) seek.value = String(p.playhead)
  const total = Math.max(1, projectContentEnd(p) || p.duration || 30)
  const time = $('#edTime')
  if (time) time.textContent = `${formatTime(p.playhead)} / ${formatTime(total)}`
}

/* ===== 渲染：属性面板 ===== */
function renderInspector(): void {
  const box = $('#edInspector')
  if (!box) return
  const clip = primaryClip()
  const p = project()
  if (!clip) {
    box.innerHTML = `
      <div class="ed-panel-head"><strong>项目设置</strong></div>
      <div class="ed-inspector-body">
        <label class="ed-field"><span>分辨率</span>
          <select data-act="proj-resolution">
            ${Object.entries(EDIT_RESOLUTIONS).map(([k, v]) => `<option value="${k}"${p.resolution === k ? ' selected' : ''}>${v.label} (${v.width}×${v.height})</option>`).join('')}
          </select>
        </label>
        <label class="ed-field"><span>帧率</span>
          <select data-act="proj-fps">
            ${[24, 25, 30, 50, 60].map((f) => `<option value="${f}"${p.fps === f ? ' selected' : ''}>${f} fps</option>`).join('')}
          </select>
        </label>
        <div class="ed-stat"><span>媒体</span><strong>${p.media.length}</strong></div>
        <div class="ed-stat"><span>片段</span><strong>${p.clips.length}</strong></div>
        <div class="ed-stat"><span>总时长</span><strong>${formatTime(projectContentEnd(p))}</strong></div>
        <p class="ed-hint">在时间线上选中片段后，这里会显示剪辑属性。</p>
      </div>`
    return
  }
  // 只有选中了「多个互不相关的片段」才显示多选面板；
  // A/V 链接（同一 linkId）仍显示主片段的属性，方便设置转场/滤镜等。
  const selectedNow = selectedClips()
  const selectionGroups = new Set(selectedNow.map((c) => c.linkId || c.id))
  if (selectionGroups.size > 1) {
    const clips = selectedNow
    const linked = clips.some((c) => c.linkId)
    box.innerHTML = `
      <div class="ed-panel-head"><strong>已选 ${clips.length} 个片段</strong></div>
      <div class="ed-inspector-body">
        <div class="ed-stat"><span>视频片段</span><strong>${clips.filter((c) => clipTrackKind(c) === 'video').length}</strong></div>
        <div class="ed-stat"><span>音频片段</span><strong>${clips.filter((c) => clipTrackKind(c) === 'audio').length}</strong></div>
        <div class="ed-stat"><span>链接状态</span><strong>${linked ? '含链接组' : '未链接'}</strong></div>
        <div class="ed-actions">
          <button class="ed-btn" data-act="link">链接选中</button>
          <button class="ed-btn" data-act="unlink">取消链接</button>
          <button class="ed-btn" data-act="copy">复制</button>
          <button class="ed-btn" data-act="ripple-delete">涟漪删除</button>
          <button class="ed-btn danger" data-act="delete">删除</button>
        </div>
        <p class="ed-hint">多选时可整体移动 / 裁剪（拖动任意选中片段）；链接后 A/V 片段会联动。</p>
      </div>`
    return
  }
  const media = findMedia(clip.mediaId)
  const isVideo = !clip.text && clipTrackKind(clip) === 'video'
  box.innerHTML = `
    <div class="ed-panel-head"><strong>片段属性</strong><span class="ed-inspector-name">${esc(media?.name || '')}</span></div>
    <div class="ed-inspector-body">
      <div class="ed-field-row">
        <label class="ed-field"><span>起点(s)</span><input type="number" step="0.01" min="0" data-clip-prop="start" value="${clip.start.toFixed(2)}" /></label>
        <label class="ed-field"><span>时长(s)</span><input type="number" step="0.01" min="${MIN_CLIP}" data-clip-prop="duration" value="${clip.duration.toFixed(2)}" /></label>
      </div>
      <label class="ed-field"><span>入点(s)</span><input type="number" step="0.01" min="0" data-clip-prop="inPoint" value="${clip.inPoint.toFixed(2)}" /></label>
      <label class="ed-field"><span>速度 <b data-out="speed">${clip.speed.toFixed(2)}×</b></span><input type="range" min="0.25" max="4" step="0.05" data-clip-prop="speed" value="${clip.speed}" /></label>
      <label class="ed-field"><span>音量 <b data-out="volume">${Math.round(clip.volume * 100)}%</b></span><input type="range" min="0" max="2" step="0.01" data-clip-prop="volume" value="${clip.volume}" /></label>
      <div class="ed-field-row">
        <label class="ed-field"><span>淡入(s)</span><input type="number" step="0.05" min="0" data-clip-prop="fadeIn" value="${clip.fadeIn}" /></label>
        <label class="ed-field"><span>淡出(s)</span><input type="number" step="0.05" min="0" data-clip-prop="fadeOut" value="${clip.fadeOut}" /></label>
      </div>
      <label class="ed-check"><input type="checkbox" data-clip-prop="muted"${clip.muted ? ' checked' : ''} /> 静音该片段</label>
      ${
        isVideo
          ? `<div class="ed-divider">画面</div>
             <label class="ed-field"><span>不透明度 <b data-out="opacity">${Math.round(clip.opacity * 100)}%</b></span><input type="range" min="0" max="1" step="0.01" data-clip-prop="opacity" value="${clip.opacity}" /></label>
             <label class="ed-field"><span>旋转</span>
               <select data-clip-prop="rotation">
                 ${[0, 90, 180, 270].map((r) => `<option value="${r}"${clip.rotation === r ? ' selected' : ''}>${r}°</option>`).join('')}
               </select>
             </label>
             <label class="ed-field"><span>亮度 <b data-out="brightness">${clip.filter.brightness}%</b></span><input type="range" min="0" max="200" step="1" data-filter-prop="brightness" value="${clip.filter.brightness}" /></label>
             <label class="ed-field"><span>对比度 <b data-out="contrast">${clip.filter.contrast}%</b></span><input type="range" min="0" max="200" step="1" data-filter-prop="contrast" value="${clip.filter.contrast}" /></label>
             <label class="ed-field"><span>饱和度 <b data-out="saturate">${clip.filter.saturate}%</b></span><input type="range" min="0" max="200" step="1" data-filter-prop="saturate" value="${clip.filter.saturate}" /></label>
             <label class="ed-field"><span>灰度 <b data-out="grayscale">${clip.filter.grayscale}%</b></span><input type="range" min="0" max="100" step="1" data-filter-prop="grayscale" value="${clip.filter.grayscale}" /></label>
             <label class="ed-field"><span>模糊 <b data-out="blur">${clip.filter.blur}px</b></span><input type="range" min="0" max="20" step="0.5" data-filter-prop="blur" value="${clip.filter.blur}" /></label>
             <div class="ed-divider">转场</div>
             ${
               clip.transition
                 ? `<label class="ed-field"><span>类型</span>
                      <select data-trans-prop="type">
                        ${TRANSITIONS.map((t) => `<option value="${t.id}"${clip.transition!.type === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}
                      </select>
                    </label>
                    <label class="ed-field"><span>时长 <b data-out="transitionDuration">${clip.transition.duration.toFixed(2)}s</b></span><input type="range" min="0.1" max="2" step="0.05" data-trans-prop="duration" value="${clip.transition.duration}" /></label>
                    <div class="ed-actions"><button class="ed-btn danger" data-act="remove-transition">移除转场</button></div>`
                 : `<p class="ed-hint">与同轨前一个相邻片段之间可添加转场（会与前一帧重叠过渡）。</p>
                    <div class="ed-actions"><button class="ed-btn" data-act="add-transition">添加转场</button></div>`
             }`
          : ''
      }
      ${
        clip.text
          ? `<div class="ed-divider">文字 / 字幕</div>
             <label class="ed-field"><span>内容</span><textarea class="ed-textarea" rows="2" data-text-prop="content">${esc(clip.text.content)}</textarea></label>
             <div class="ed-field-row">
               <label class="ed-field"><span>字号</span><input type="number" min="12" max="220" step="1" data-text-prop="fontSize" value="${clip.text.fontSize}" /></label>
               <label class="ed-field"><span>颜色</span><input type="color" data-text-prop="color" value="${clip.text.color}" /></label>
             </div>
             <div class="ed-field-row">
               <label class="ed-field"><span>对齐</span>
                 <select data-text-prop="align">
                   ${(['left', 'center', 'right'] as const).map((a) => `<option value="${a}"${clip.text!.align === a ? ' selected' : ''}>${a === 'left' ? '左对齐' : a === 'center' ? '居中' : '右对齐'}</option>`).join('')}
                 </select>
               </label>
               <label class="ed-field"><span>描边色</span><input type="color" data-text-prop="strokeColor" value="${clip.text.strokeColor}" /></label>
             </div>
             <label class="ed-field"><span>水平位置 <b data-out="x">${Math.round(clip.text.x * 100)}%</b></span><input type="range" min="0" max="1" step="0.01" data-text-prop="x" value="${clip.text.x}" /></label>
             <label class="ed-field"><span>垂直位置 <b data-out="y">${Math.round(clip.text.y * 100)}%</b></span><input type="range" min="0" max="1" step="0.01" data-text-prop="y" value="${clip.text.y}" /></label>
             <label class="ed-check"><input type="checkbox" data-text-prop="bold"${clip.text.bold ? ' checked' : ''} /> 粗体</label>
             <label class="ed-check"><input type="checkbox" data-text-prop="italic"${clip.text.italic ? ' checked' : ''} /> 斜体</label>
             <label class="ed-check"><input type="checkbox" data-text-prop="stroke"${clip.text.stroke ? ' checked' : ''} /> 描边</label>
             <label class="ed-check"><input type="checkbox" data-text-prop="shadow"${clip.text.shadow ? ' checked' : ''} /> 阴影</label>
             <label class="ed-check"><input type="checkbox" data-text-prop="background"${clip.text.background ? ' checked' : ''} /> 背景条</label>`
          : ''
      }
      <div class="ed-divider">关键帧</div>
      <div class="ed-kf">
        ${KEYFRAME_PROPS.map((spec) => {
          const list = clip.keyframes?.[spec.id] || []
          const local = Math.max(0, p.playhead - clip.start)
          const atKf = list.some((k) => Math.abs(k.t - local) <= 0.06)
          const val = clipValue(clip, spec.id, p.playhead)
          return `<div class="ed-kf-row">
            <span class="ed-kf-label">${spec.label}</span>
            <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" data-kf-prop="${spec.id}" value="${val}" />
            <b data-kf-out="${spec.id}">${kfFormat(spec.id, val)}</b>
            <button class="ed-kf-diamond${atKf ? ' on' : ''}" data-act="kf-toggle" data-kf-prop="${spec.id}" title="在播放头添加 / 删除关键帧">◆</button>
            <i class="ed-kf-count">${list.length || ''}</i>
          </div>`
        }).join('')}
        ${
          KEYFRAME_PROPS.some((spec) => (clip.keyframes?.[spec.id] || []).length)
            ? `<div class="ed-kf-list">${KEYFRAME_PROPS.filter((spec) => (clip.keyframes?.[spec.id] || []).length)
                .map(
                  (spec) =>
                    `<div class="ed-kf-list-row"><span>${spec.label}</span><div class="ed-kf-chips">${(clip.keyframes?.[spec.id] || [])
                      .map(
                        (k, i) =>
                          `<button class="ed-kf-chip" data-act="kf-seek" data-kf-prop="${spec.id}" data-kf-index="${i}" title="跳转到该关键帧">${k.t.toFixed(2)}s · ${kfFormat(spec.id, k.v)}<i data-act="kf-del" data-kf-prop="${spec.id}" data-kf-index="${i}" title="删除">×</i></button>`
                      )
                      .join('')}</div></div>`
                )
                .join('')}</div>`
            : '<p class="ed-hint">拖动滑杆，或把播放头放到目标时间后点 ◆ 打关键帧，可做淡入淡出 / 音量 / 亮度等动画。</p>'
        }
      </div>
      <div class="ed-stat"><span>链接</span><strong>${clip.linkId ? '已链接 A/V' : '未链接'}</strong></div>
      <div class="ed-actions">
        <button class="ed-btn" data-act="split">分割</button>
        <button class="ed-btn" data-act="duplicate">复制</button>
        <button class="ed-btn" data-act="copy">复制到剪贴板</button>
        <button class="ed-btn" data-act="link">链接</button>
        <button class="ed-btn" data-act="unlink">取消链接</button>
        <button class="ed-btn" data-act="reset-filter">重置滤镜</button>
        <button class="ed-btn" data-act="ripple-delete">涟漪删除</button>
        <button class="ed-btn danger" data-act="delete">删除片段</button>
      </div>
    </div>`
}

/* ===== 渲染入口 ===== */
function setStatus(text: string): void {
  const el = $('#edExportState')
  if (el) el.textContent = text
}

function renderAll(): void {
  renderMedia()
  renderTimeline()
  renderInspector()
  updatePlayhead()
  renderTextOverlay()
}

/* ===== 播放 ===== */
function clipActive(clip: EditClip, t: number): boolean {
  return t >= clip.start - 0.001 && t < clipEnd(clip) - 0.001
}
function audioFade(clip: EditClip, t: number): number {
  const local = t - clip.start
  let gain = 1
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= clamp(local / clip.fadeIn, 0, 1)
  const remain = clip.duration - local
  if (clip.fadeOut > 0 && remain < clip.fadeOut) gain *= clamp(remain / clip.fadeOut, 0, 1)
  return gain
}
function activeVideoClip(t: number): EditClip | null {
  const p = project()
  const list = p.clips
    .filter((c) => {
      const media = findMedia(c.mediaId)
      const track = findTrack(c.trackId)
      return !!media && track?.kind === 'video' && !track.hidden && media.kind === 'video' && clipActive(c, t)
    })
    .sort((a, b) => trackIndex(a.trackId) - trackIndex(b.trackId))
  return list[0] || null
}
function getAudioEl(clip: EditClip): HTMLAudioElement {
  let el = audioEls.get(clip.id)
  if (!el) {
    el = document.createElement('audio')
    el.preload = 'auto'
    audioPool?.appendChild(el)
    audioEls.set(clip.id, el)
  }
  const media = findMedia(clip.mediaId)
  if (media && el.dataset.mediaId !== media.id) {
    el.dataset.mediaId = media.id
    el.src = mediaUrl(media)
    connectElement(el)
  }
  return el
}
/** 把某个片段同步到指定 video 元素（不含透明度/变换，由调用方决定）。 */
function applyVideoEl(el: HTMLVideoElement, clip: EditClip, t: number, force: boolean): void {
  const media = findMedia(clip.mediaId)
  if (!media) return
  if (el.dataset.mediaId !== media.id) {
    el.dataset.mediaId = media.id
    el.src = mediaUrl(media)
    connectElement(el)
  }
  const expected = clip.inPoint + (t - clip.start) * clip.speed
  el.playbackRate = clip.speed
  if (force || el.paused || Math.abs(el.currentTime - expected) > 0.3) {
    try {
      el.currentTime = Math.max(0, expected)
    } catch {
      /* 元数据未就绪 */
    }
  }
  if (playing && el.paused) void el.play().catch(() => {})
  el.style.filter = cssFilterAt(clip, t)
}

/** 当前播放头是否落在某个转场窗口内（窗口 = [进入片段起点, 起点 + 时长]）。 */
function activeTransition(t: number): { from: EditClip; to: EditClip; type: EditTransitionType } | null {
  const p = project()
  for (const to of p.clips) {
    const tr = to.transition
    if (!tr) continue
    const d = Math.max(0.05, tr.duration)
    if (t < to.start || t >= to.start + d) continue
    if (findTrack(to.trackId)?.hidden) continue
    const from = p.clips.find(
      (c) => c.trackId === to.trackId && c.id !== to.id && c.start < to.start && clipEnd(c) > to.start
    )
    if (!from) continue
    return { from, to, type: tr.type }
  }
  return null
}

function syncMedia(force = false): void {
  if (!wsRef || !previewVideo) return
  const p = project()
  const t = p.playhead
  const empty = $('#edPreviewEmpty')
  const tr = activeTransition(t)
  const mediaB = previewVideoB
  if (tr && mediaB) {
    const d = Math.max(0.05, tr.to.transition?.duration || 0.5)
    const prog = clamp((t - tr.to.start) / d, 0, 1)
    applyVideoEl(previewVideo, tr.from, t, force)
    applyVideoEl(mediaB, tr.to, t, force)
    mediaB.style.display = 'block'
    let aOpacity = 1
    let bOpacity = 1
    let clipPath = ''
    let transform = `translate(-50%, -50%) rotate(${clipValue(tr.to, 'rotation', t)}deg)`
    if (tr.type === 'fadeblack') {
      aOpacity = Math.max(0, 1 - prog * 2)
      bOpacity = Math.max(0, prog * 2 - 1)
    } else if (tr.type === 'wipeleft') {
      clipPath = `inset(0 ${Math.round((1 - prog) * 100)}% 0 0)`
    } else if (tr.type === 'slideleft') {
      transform = `translate(-50%, -50%) translateX(${Math.round((1 - prog) * 100)}%) rotate(${clipValue(tr.to, 'rotation', t)}deg)`
    } else if (tr.type === 'zoomin') {
      bOpacity = prog
      transform = `translate(-50%, -50%) scale(${(0.6 + 0.4 * prog).toFixed(3)}) rotate(${clipValue(tr.to, 'rotation', t)}deg)`
    } else {
      bOpacity = prog
    }
    previewVideo.style.opacity = String(clipValue(tr.from, 'opacity', t) * aOpacity)
    previewVideo.style.transform = `translate(-50%, -50%) rotate(${clipValue(tr.from, 'rotation', t)}deg)`
    previewVideo.style.clipPath = ''
    mediaB.style.opacity = String(clipValue(tr.to, 'opacity', t) * bOpacity)
    mediaB.style.clipPath = clipPath
    mediaB.style.transform = transform
    // 声音交叉（A/V 链接时由音频轨片段负责）
    const fromLinked = !!linkedAudioOf(tr.from)
    const toLinked = !!linkedAudioOf(tr.to)
    previewVideo.muted = fromLinked
    previewVideo.volume = fromLinked ? 0 : clamp((tr.from.muted ? 0 : clipValue(tr.from, 'volume', t)) * (1 - prog), 0, 1)
    mediaB.muted = toLinked
    mediaB.volume = toLinked ? 0 : clamp((tr.to.muted ? 0 : clipValue(tr.to, 'volume', t)) * prog, 0, 1)
    if (empty) empty.style.display = 'none'
  } else {
    if (mediaB) {
      mediaB.style.display = 'none'
      mediaB.style.clipPath = ''
      if (!mediaB.paused) mediaB.pause()
    }
    const v = activeVideoClip(t)
    if (v) {
      applyVideoEl(previewVideo, v, t, force)
      // A/V 链接时声音交给音频轨片段，视频元素只出画面，避免重复播放
      const linkedAudio = linkedAudioOf(v)
      const linkedTrack = linkedAudio ? findTrack(linkedAudio.trackId) : undefined
      const linkedAudible = !!linkedAudio && !!linkedTrack && !linkedTrack.muted && clipActive(linkedAudio, t)
      previewVideo.muted = linkedAudible
      previewVideo.volume = linkedAudible ? 0 : clamp(v.muted ? 0 : clipValue(v, 'volume', t), 0, 1)
      previewVideo.style.opacity = String(clipValue(v, 'opacity', t))
      previewVideo.style.transform = `translate(-50%, -50%) rotate(${clipValue(v, 'rotation', t)}deg)`
      previewVideo.style.clipPath = ''
      if (empty) empty.style.display = 'none'
    } else {
      if (!previewVideo.paused) previewVideo.pause()
      previewVideo.style.opacity = '1'
      previewVideo.style.filter = 'none'
      previewVideo.style.transform = 'translate(-50%, -50%)'
      previewVideo.style.clipPath = ''
      if (empty) empty.style.display = previewVideo.dataset.mediaId ? 'none' : ''
    }
  }
  // 音频轨混音（视频轨的音频由上面的 video 元素负责；A/V 链接时视频元素已静音）
  p.clips.forEach((c) => {
    if (clipTrackKind(c) !== 'audio') return
    const el = getAudioEl(c)
    const track = findTrack(c.trackId)
    const active = track && !track.muted && clipActive(c, t)
    if (active) {
      const expected = c.inPoint + (t - c.start) * c.speed
      el.playbackRate = c.speed
      if (force || el.paused || Math.abs(el.currentTime - expected) > 0.3) {
        try {
          el.currentTime = Math.max(0, expected)
        } catch {
          /* 忽略 */
        }
      }
      el.volume = clamp((c.muted ? 0 : clipValue(c, 'volume', t)) * audioFade(c, t), 0, 1)
      if (playing && el.paused) void el.play().catch(() => {})
      if (!playing && !el.paused) el.pause()
    } else if (!el.paused) {
      el.pause()
    }
  })
  renderTextOverlay()
}

function setPlayhead(t: number, force = true): void {
  if (!wsRef) return
  const p = project()
  const max = Math.max(0.1, projectContentEnd(p) || p.duration || 30)
  p.playhead = clamp(t, 0, max)
  updatePlayhead()
  syncMedia(force)
  if (!playing) renderInspector()
}

function tick(): void {
  if (!playing || !wsRef) return
  const p = project()
  const t = playStartT + (performance.now() - playStartReal) / 1000
  const end = Math.max(0.1, projectContentEnd(p))
  p.playhead = Math.min(t, end)
  updatePlayhead()
  syncMedia()
  if (t >= end) {
    playing = false
    updatePlayButton()
    return
  }
  rafId = requestAnimationFrame(tick)
}

function play(): void {
  if (!wsRef || playing) return
  const p = project()
  if (projectContentEnd(p) <= 0.05) {
    toast('时间线还是空的，先把媒体拖进来', 'info')
    return
  }
  void getAudioContext().resume()
  if (p.playhead >= projectContentEnd(p) - 0.02) p.playhead = 0
  playing = true
  playStartReal = performance.now()
  playStartT = p.playhead
  syncMedia(true)
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(tick)
  updatePlayButton()
}
function pause(): void {
  playing = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  if (previewVideo && !previewVideo.paused) previewVideo.pause()
  audioEls.forEach((el) => {
    if (!el.paused) el.pause()
  })
  updatePlayButton()
}
function stopPlayback(): void {
  pause()
  if (wsRef) setPlayhead(0)
}
function updatePlayButton(): void {
  const btn = $('#edPlayBtn')
  if (btn) btn.textContent = playing ? '❚❚' : '▶'
}

/* ===== 指针拖动：移动 / 裁剪 ===== */
function startClipDrag(ev: PointerEvent, clip: EditClip, mode: 'move' | 'trim-l' | 'trim-r'): void {
  ev.preventDefault()
  const p = project()
  const dragClips = selectedIds.has(clip.id) ? selectedClips() : [clip]
  const single = dragClips.length === 1
  const canChangeTrack = single && !clip.linkId
  const originals = dragClips.map((c) => ({ clip: c, start: c.start, inPoint: c.inPoint, duration: c.duration, trackId: c.trackId }))
  const startX = ev.clientX
  const startY = ev.clientY
  let moved = false

  const applyLayout = (c: EditClip): void => {
    const el = document.querySelector<HTMLElement>(`.ed-clip[data-clip-id="${c.id}"]`)
    if (!el) return
    el.style.left = c.start * p.zoom + 'px'
    el.style.width = Math.max(10, c.duration * p.zoom) + 'px'
    if (single) {
      const lane = document.querySelector<HTMLElement>(`.ed-lane[data-track-id="${c.trackId}"]`)
      if (lane && el.parentElement !== lane) lane.appendChild(el)
    }
  }

  const onMove = (e: PointerEvent): void => {
    const dx = e.clientX - startX
    if (!moved && (Math.abs(dx) > 2 || Math.abs(e.clientY - startY) > 2)) moved = true
    if (mode === 'move') {
      // 整体移动：不允许任何片段移到负时间
      const minStart = Math.min(...originals.map((o) => o.start))
      const delta = Math.max(dx / p.zoom, -minStart)
      const anchor = originals.find((o) => o.clip.id === clip.id) || originals[0]
      const snapped = snapStart(anchor.start + delta, anchor.duration, clip.id)
      const finalDelta = delta + (snapped - (anchor.start + delta))
      originals.forEach((o) => {
        o.clip.start = Math.max(0, o.start + finalDelta)
      })
      if (canChangeTrack) {
        const lane = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.ed-lane')
        const track = lane ? findTrack(lane.dataset.trackId || '') : undefined
        const media = findMedia(clip.mediaId)
        if (track && media && compatible(media, track)) clip.trackId = track.id
        else clip.trackId = originals[0].trackId
      }
    } else if (mode === 'trim-l') {
      const minDt = Math.max(...originals.map((o) => Math.max(-o.start, -o.inPoint / o.clip.speed)))
      const maxDt = Math.min(...originals.map((o) => o.duration - MIN_CLIP))
      const dt = clamp(dx / p.zoom, minDt, maxDt)
      originals.forEach((o) => {
        o.clip.start = o.start + dt
        o.clip.inPoint = Math.max(0, o.inPoint + dt * o.clip.speed)
        o.clip.duration = o.duration - dt
      })
    } else {
      const minDt = Math.min(...originals.map((o) => MIN_CLIP - o.duration))
      const maxDt = Math.min(
        ...originals.map((o) => {
          const media = findMedia(o.clip.mediaId)
          const sm = media?.duration || Infinity
          return Number.isFinite(sm) ? (sm - o.inPoint) / o.clip.speed - o.duration : Infinity
        })
      )
      const dt = clamp(dx / p.zoom, minDt, maxDt)
      originals.forEach((o) => {
        o.clip.duration = Math.max(MIN_CLIP, o.duration + dt)
      })
    }
    originals.forEach((o) => applyLayout(o.clip))
    updatePlayhead()
  }

  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (!moved) return
    if (mode === 'move' && canChangeTrack) {
      const media = findMedia(clip.mediaId)
      const track = findTrack(clip.trackId)
      if (!track || !media || !compatible(media, track)) clip.trackId = originals[0].trackId
    }
    refreshDuration()
    pushHistory()
    persistWorkspaces()
    renderAll()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
}

function laneTimeFromEvent(e: PointerEvent, lane: HTMLElement): number {
  const rect = lane.getBoundingClientRect()
  return (e.clientX - rect.left) / project().zoom
}

/** 空白轨道：单击定位播放头，拖拽框选多个片段。 */
function startLaneSelection(ev: PointerEvent, lane: HTMLElement): void {
  const surface = $('#edTlInner')
  const marquee = $('#edMarquee')
  const startX = ev.clientX
  const startY = ev.clientY
  let dragging = false
  const onMove = (e: PointerEvent): void => {
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!dragging && Math.hypot(dx, dy) < 4) return
    dragging = true
    if (!surface || !marquee) return
    const r = surface.getBoundingClientRect()
    const x1 = Math.min(startX, e.clientX) - r.left
    const x2 = Math.max(startX, e.clientX) - r.left
    const y1 = Math.min(startY, e.clientY) - r.top
    const y2 = Math.max(startY, e.clientY) - r.top
    marquee.hidden = false
    marquee.style.left = `${x1}px`
    marquee.style.top = `${y1}px`
    marquee.style.width = `${x2 - x1}px`
    marquee.style.height = `${y2 - y1}px`
  }
  const onUp = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (marquee) marquee.hidden = true
    if (!dragging) {
      clearSelection()
      setPlayhead(laneTimeFromEvent(ev, lane))
      return
    }
    if (!surface) return
    const r = surface.getBoundingClientRect()
    const x1 = Math.min(startX, e.clientX) - r.left
    const x2 = Math.max(startX, e.clientX) - r.left
    const y1 = Math.min(startY, e.clientY) - r.top
    const y2 = Math.max(startY, e.clientY) - r.top
    const ids: string[] = []
    surface.querySelectorAll<HTMLElement>('.ed-clip').forEach((el) => {
      const b = el.getBoundingClientRect()
      const l = b.left - r.left
      const t = b.top - r.top
      if (l < x2 && l + b.width > x1 && t < y2 && t + b.height > y1) ids.push(el.dataset.clipId || '')
    })
    selectClips(ids, e.shiftKey || e.ctrlKey || e.metaKey)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

/* ===== 导出：WAV ===== */
async function loadAudioBuffer(media: EditMedia): Promise<AudioBuffer | null> {
  const cached = decodedBuffers.get(media.id)
  if (cached) return cached
  try {
    const res = await editorApi.read({ path: mediaLocalPath(media), maxBytes: 96 * 1024 * 1024 })
    if (!res.ok || !res.data) return null
    const copy = new Uint8Array(res.data.byteLength)
    copy.set(res.data)
    const buffer = await getAudioContext().decodeAudioData(copy.buffer as ArrayBuffer)
    decodedBuffers.set(media.id, buffer)
    return buffer
  } catch {
    return null
  }
}

function encodeWav(buffer: AudioBuffer): Uint8Array {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const dataLength = frames * channels * 2
  const out = new ArrayBuffer(44 + dataLength)
  const view = new DataView(out)
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataLength, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c))
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = clamp(chans[c][i], -1, 1)
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return new Uint8Array(out)
}

/** 离线渲染音频混合结果（导出 WAV / 自检使用）。 */
async function renderAudioWav(): Promise<Uint8Array | null> {
  const p = project()
  const end = projectContentEnd(p)
  if (end <= 0 || !p.clips.length) {
    toast('时间线为空，无法导出', 'info')
    return null
  }
  const sampleRate = 44100
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(end * sampleRate)), sampleRate)
  let scheduled = 0
  for (const clip of p.clips) {
    const media = findMedia(clip.mediaId)
    if (!media) continue
    // A/V 链接：视频片段的声音由链接音频片段负责，避免重复
    if (clipTrackKind(clip) === 'video' && linkedAudioOf(clip)) continue
    const buffer = await loadAudioBuffer(media)
    if (!buffer) continue
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = clip.speed
    const gain = ctx.createGain()
    const vol = clip.muted ? 0 : clamp(clip.volume, 0, 2)
    const a = clip.start
    const d = clip.duration
    gain.gain.setValueAtTime(clip.fadeIn > 0 ? 0 : vol, a)
    if (clip.fadeIn > 0) gain.gain.linearRampToValueAtTime(vol, a + Math.min(clip.fadeIn, d))
    if (clip.fadeOut > 0) {
      gain.gain.setValueAtTime(vol, Math.max(a + Math.min(clip.fadeIn, d), a + d - clip.fadeOut))
      gain.gain.linearRampToValueAtTime(0, a + d)
    }
    src.connect(gain)
    gain.connect(ctx.destination)
    const offset = Math.min(clip.inPoint, Math.max(0, buffer.duration - 0.01))
    const playDur = Math.max(0.01, Math.min(d * clip.speed, buffer.duration - offset))
    try {
      src.start(a, offset, playDur)
      scheduled++
    } catch {
      /* 忽略单个片段调度失败 */
    }
  }
  if (!scheduled) {
    toast('没有可解码的音频轨，无法导出音频', 'error')
    return null
  }
  const rendered = await ctx.startRendering()
  return encodeWav(rendered)
}

async function exportAudio(): Promise<void> {
  const btn = $('#edExportAudioBtn') as HTMLButtonElement | null
  if (btn) btn.disabled = true
  try {
    const wav = await renderAudioWav()
    if (!wav) return
    const res = await editorApi.save({
      name: '剪辑-音频.wav',
      data: wav,
      filters: [{ name: 'WAV 音频', extensions: ['wav'] }]
    })
    if (res.ok) toast('音频已导出：' + res.path, 'success', 4000)
    else if (!res.canceled) toast('导出失败：' + (res.error || ''), 'error')
  } catch (e) {
    toast('导出音频失败：' + (e as Error).message, 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

/* ===== 导出：WebM 视频（画布 + WebAudio 实时录制） ===== */
function pickMime(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  for (const m of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
    } catch {
      /* 继续尝试 */
    }
  }
  return 'video/webm'
}

function drawVideoFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, clip: EditClip, W: number, H: number, t: number): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return
  ctx.save()
  ctx.globalAlpha = clamp(clipValue(clip, 'opacity', t), 0, 1)
  ctx.filter = cssFilterAt(clip, t)
  ctx.translate(W / 2, H / 2)
  ctx.rotate((clipValue(clip, 'rotation', t) * Math.PI) / 180)
  const scale = Math.max(W / vw, H / vh)
  const dw = vw * scale
  const dh = vh * scale
  ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
}

/** 实时录制（时长 = 项目时长，画面来自时间线预览），返回 WebM 数据。 */
async function renderVideoWebm(): Promise<Uint8Array | null> {
  const p = project()
  const end = projectContentEnd(p)
  if (end <= 0 || !p.clips.length) {
    toast('时间线为空，无法导出', 'info')
    return null
  }
  if (typeof MediaRecorder === 'undefined') {
    toast('当前环境不支持视频导出', 'error')
    return null
  }
  const size = EDIT_RESOLUTIONS[p.resolution]
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const ac = getAudioContext()
  await ac.resume()
  if (!masterGain) connectElement(previewVideo as HTMLMediaElement)
  const dest = ac.createMediaStreamDestination()
  masterGain?.connect(dest)
  const stream = canvas.captureStream(p.fps)
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
  const mime = pickMime()
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 })
  } catch {
    toast('无法启动视频编码器', 'error')
    return null
  }
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const finished = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }))
  })
  stopPlayback()
  setPlayhead(0)
  const status = $('#edExportState')
  if (status) status.textContent = '正在导出视频…'
  rec.start(250)
  play()
  await new Promise<void>((resolve) => {
    const draw = (): void => {
      const t = project().playhead
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const v = activeVideoClip(t)
      if (v && previewVideo && previewVideo.readyState >= 2) drawVideoFrame(ctx, previewVideo, v, canvas.width, canvas.height, t)
      if (t >= end - 0.02 || !playing) {
        resolve()
        return
      }
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  })
  pause()
  rec.stop()
  try {
    masterGain?.disconnect(dest)
  } catch {
    /* 忽略 */
  }
  const blob = await finished
  if (status) status.textContent = ''
  if (!blob.size) {
    toast('视频导出失败（没有录到画面）', 'error')
    return null
  }
  return new Uint8Array(await blob.arrayBuffer())
}

/** 导出视频：录制后弹保存框。 */
async function exportVideo(): Promise<void> {
  const btn = $('#edExportVideoBtn') as HTMLButtonElement | null
  if (btn) btn.disabled = true
  try {
    const data = await renderVideoWebm()
    if (!data) return
    const res = await editorApi.save({
      name: '剪辑-视频.webm',
      data,
      filters: [{ name: 'WebM 视频', extensions: ['webm'] }]
    })
    if (res.ok) toast('视频已导出：' + res.path, 'success', 4000)
    else if (!res.canceled) toast('导出失败：' + (res.error || ''), 'error')
  } catch (e) {
    toast('导出视频失败：' + (e as Error).message, 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

/* ===== FFmpeg 状态 ===== */
async function refreshFfmpegStatus(force = false): Promise<void> {
  try {
    ffmpegInfo = force ? await editorApi.ffmpegRecheck() : await editorApi.ffmpegStatus()
  } catch {
    ffmpegInfo = null
  }
  renderFfmpegStatus()
}

function renderFfmpegStatus(): void {
  const el = $('#edFfmpegStatus') as HTMLButtonElement | null
  if (!el) return
  if (!ffmpegInfo) {
    el.textContent = 'FFmpeg 状态未知'
  } else if (ffmpegInfo.available) {
    const hw = ffmpegInfo.encoders.includes('h264_nvenc')
      ? ' · NVENC'
      : ffmpegInfo.encoders.includes('h264_qsv')
        ? ' · QSV'
        : ffmpegInfo.encoders.includes('h264_amf')
          ? ' · AMF'
          : ''
    el.textContent = 'FFmpeg 已就绪' + hw
    el.title = `${ffmpegInfo.ffmpeg}\n来源：${ffmpegInfo.source}`
    el.classList.add('ready')
  } else {
    el.textContent = '未检测到 FFmpeg · 点击设置'
    el.title = 'MP4 导出与格式转码需要 FFmpeg；也可设置环境变量 AURORA_FFMPEG_PATH'
    el.classList.remove('ready')
  }
  const mp4 = document.querySelector<HTMLOptionElement>('#edExportFormat option[value="mp4"]')
  if (mp4) mp4.disabled = !ffmpegInfo?.available
  const format = $('#edExportFormat') as HTMLSelectElement | null
  if (format && !ffmpegInfo?.available && format.value === 'mp4') format.value = 'webm'
}

async function chooseFfmpeg(): Promise<void> {
  try {
    const res = await editorApi.ffmpegChoose()
    if (res.status) ffmpegInfo = res.status
    if (res.ok) toast('FFmpeg 已设置：' + (ffmpegInfo?.ffmpeg || ''), 'success', 4200)
    else if (!res.canceled) toast('该文件不是可用的 FFmpeg', 'error')
  } catch (e) {
    toast('设置 FFmpeg 失败：' + (e as Error).message, 'error')
  }
  renderFfmpegStatus()
}

/* ===== 导出对话框 ===== */
function openExportDialog(): void {
  if (projectContentEnd(project()) <= 0.05) {
    toast('时间线还是空的，无法导出', 'info')
    return
  }
  if (exporting) {
    toast('正在导出中，请稍候', 'info')
    return
  }
  const modal = $('#edExportModal')
  if (!modal) return
  const p = project()
  const resSel = $('#edExportResolution') as HTMLSelectElement | null
  const fpsSel = $('#edExportFps') as HTMLSelectElement | null
  if (resSel) {
    resSel.innerHTML = Object.entries(EDIT_RESOLUTIONS)
      .map(([k, v]) => `<option value="${k}"${p.resolution === k ? ' selected' : ''}>${v.label} (${v.width}×${v.height})</option>`)
      .join('')
  }
  if (fpsSel) {
    fpsSel.innerHTML = [24, 25, 30, 50, 60].map((f) => `<option value="${f}"${p.fps === f ? ' selected' : ''}>${f} fps</option>`).join('')
  }
  const format = $('#edExportFormat') as HTMLSelectElement | null
  if (format) format.value = ffmpegInfo?.available ? 'mp4' : 'webm'
  const hint = $('#edExportHint')
  if (hint) {
    hint.textContent = ffmpegInfo?.available
      ? 'FFmpeg 直接渲染时间线（非实时），支持 H.264/AAC MP4。'
      : '未检测到 FFmpeg：将回退为实时录制 WebM（耗时≈视频时长）。点击 FFmpeg 按钮可指定路径。'
  }
  modal.hidden = false
  if (ffmpegInfo === null) void refreshFfmpegStatus()
  else renderFfmpegStatus()
}

function closeExportDialog(): void {
  const modal = $('#edExportModal')
  if (modal) modal.hidden = true
}

async function confirmExport(): Promise<void> {
  if (exporting) return
  const format = ($('#edExportFormat') as HTMLSelectElement)?.value || 'mp4'
  const resKey = (($('#edExportResolution') as HTMLSelectElement)?.value || project().resolution) as EditProject['resolution']
  const fps = Number(($('#edExportFps') as HTMLSelectElement)?.value || project().fps)
  const quality = (($('#edExportQuality') as HTMLSelectElement)?.value || 'medium') as ExportQuality
  closeExportDialog()
  if (format === 'mp4' && ffmpegInfo?.available) await exportTimelineMp4(resKey, fps, quality)
  else await exportVideo()
}

async function exportTimelineMp4(resolution: EditProject['resolution'], fps: number, quality: ExportQuality): Promise<void> {
  const btn = $('#edExportVideoBtn') as HTMLButtonElement | null
  const confirm = $('#edExportConfirm') as HTMLButtonElement | null
  exporting = true
  if (btn) btn.disabled = true
  if (confirm) confirm.disabled = true
  setStatus('导出中 0%')
  try {
    const size = EDIT_RESOLUTIONS[resolution] || EDIT_RESOLUTIONS['1080p']
    // 文字 / 字幕先渲染成透明 PNG，再交给 FFmpeg 叠加
    const textImages = await prepareTextImages(size.width, size.height)
    const res = await editorApi.exportTimeline({
      project: JSON.parse(JSON.stringify(project())) as EditProject,
      width: size.width,
      height: size.height,
      fps,
      quality,
      textImages
    })
    if (res.ok) {
      toast('视频已导出：' + res.path, 'success', 5000)
      project().resolution = resolution
      project().fps = fps
      persistWorkspaces()
    } else if (!res.canceled) {
      toast('导出失败：' + (res.error || '未知错误'), 'error', 6500)
    }
  } catch (e) {
    toast('导出失败：' + (e as Error).message, 'error', 6500)
  } finally {
    exporting = false
    if (btn) btn.disabled = false
    if (confirm) confirm.disabled = false
    setStatus('')
  }
}

/** 订阅主进程 ffmpeg 进度事件（转码 / 导出）。 */
function bindEditorProgress(): void {
  if (progressUnsub) return
  progressUnsub = editorApi.onProgress((e: EditorProgressEvent) => {
    if (!document.querySelector('.view-edit.active')) return
    if (e.stage === 'done') {
      setStatus('')
      return
    }
    const label = e.stage === 'transcode' ? '转码' : e.stage === 'export' ? '导出' : ''
    setStatus(`${label} ${Math.round(e.percent)}%${e.message ? ' · ' + e.message : ''}`)
  })
}

/* ===== 自动保存 / 崩溃恢复 ===== */
function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function setAutosaveState(text: string): void {
  const el = $('#edAutosaveState')
  if (el) el.textContent = text
}

async function flushAutosave(): Promise<void> {
  if (!wsRef) return
  try {
    const res = await editorApi.recoverySave({ id: wsRef.id, project: JSON.parse(JSON.stringify(project())) })
    if (res.ok && res.savedAt) setAutosaveState(`已自动保存 ${formatClock(res.savedAt)}`)
  } catch {
    /* 自动保存失败不打扰用户 */
  }
}

function startAutosave(): void {
  if (autosaveTimer) clearInterval(autosaveTimer)
  autosaveTimer = setInterval(() => {
    void flushAutosave()
  }, 4000)
}

async function checkRecovery(): Promise<void> {
  if (!wsRef) return
  pendingRecovery = null
  const banner = $('#edRecoveryBanner')
  if (banner) banner.hidden = true
  try {
    const data = await editorApi.recoveryLoad({ id: wsRef.id })
    if (!data) return
    if (JSON.stringify(data.project) === JSON.stringify(wsRef.project)) return
    pendingRecovery = { savedAt: data.savedAt, project: data.project }
    const text = $('#edRecoveryText')
    if (text) text.textContent = `发现 ${formatClock(data.savedAt)} 的自动保存内容（上次可能是异常退出），是否恢复？`
    if (banner) banner.hidden = false
  } catch {
    /* 忽略恢复检查失败 */
  }
}

function restoreRecovery(): void {
  if (!wsRef || !pendingRecovery) return
  try {
    wsRef.project = JSON.parse(JSON.stringify(pendingRecovery.project)) as EditProject
    ensureProject(wsRef)
    selectedIds.clear()
    primaryId = ''
    persistWorkspaces()
    resetHistory()
    renderAll()
    void editorApi.recoveryClear({ id: wsRef.id })
    pendingRecovery = null
    const banner = $('#edRecoveryBanner')
    if (banner) banner.hidden = true
    toast('已恢复自动保存的内容', 'success', 3000)
  } catch (e) {
    toast('恢复失败：' + (e as Error).message, 'error')
  }
}

function discardRecovery(): void {
  if (!wsRef) return
  void editorApi.recoveryClear({ id: wsRef.id })
  pendingRecovery = null
  const banner = $('#edRecoveryBanner')
  if (banner) banner.hidden = true
  toast('已忽略自动保存内容', 'info', 2000)
}

/* ===== 壳层 ===== */
function shellHtml(): string {
  return `
  <div class="editor-shell">
    <div class="ed-recovery" id="edRecoveryBanner" hidden>
      <span id="edRecoveryText">发现自动保存的编辑内容，是否恢复？</span>
      <button class="ed-btn" data-act="recovery-restore">恢复</button>
      <button class="ed-btn ghost" data-act="recovery-discard">忽略</button>
    </div>
    <aside class="ed-media">
      <div class="ed-panel-head">
        <strong>媒体库</strong>
        <div class="ed-head-actions">
          <button class="ed-btn primary" data-act="import">导入媒体</button>
          <button class="ed-btn ghost" data-act="clear-media" title="清空媒体库">清空</button>
        </div>
      </div>
      <div class="ed-media-list" id="edMediaList"></div>
    </aside>
    <section class="ed-stage">
      <div class="ed-preview" id="edPreview">
        <video id="edVideo" playsinline></video>
        <video id="edVideoB" playsinline></video>
        <div class="ed-text-layer" id="edTextLayer"></div>
        <div class="ed-preview-empty" id="edPreviewEmpty">
          <strong>预览窗口</strong>
          <span>导入媒体并拖到时间线后，这里会显示画面</span>
        </div>
      </div>
      <div class="ed-transport">
        <button class="ed-icon-btn" data-act="play" id="edPlayBtn" title="播放 / 暂停（空格）">▶</button>
        <button class="ed-icon-btn" data-act="stop" title="回到开头">■</button>
        <span class="ed-time" id="edTime">00:00.00 / 00:00.00</span>
        <input class="ed-seek" type="range" id="edSeek" min="0" max="30" step="0.01" value="0" title="拖动定位" />
        <button class="ed-btn" data-act="split" title="在播放头分割（S）">分割</button>
        <button class="ed-btn" data-act="duplicate" title="复制选中片段">复制</button>
        <button class="ed-btn" data-act="delete" title="删除选中片段（Delete）">删除</button>
        <button class="ed-btn ghost" data-act="undo" title="撤销（Ctrl+Z）">撤销</button>
        <button class="ed-btn ghost" data-act="redo" title="重做（Ctrl+Shift+Z）">重做</button>
        <span class="ed-spacer"></span>
        <span class="ed-autosave" id="edAutosaveState"></span>
        <span class="ed-export-state" id="edExportState"></span>
        <button class="ed-btn ghost ed-ffmpeg" data-act="ffmpeg-choose" id="edFfmpegStatus" title="点击设置 FFmpeg 路径">FFmpeg 检测中…</button>
        <button class="ed-btn" data-act="export-audio" id="edExportAudioBtn">导出音频</button>
        <button class="ed-btn primary" data-act="export-video" id="edExportVideoBtn">导出</button>
      </div>
    </section>
    <aside class="ed-inspector" id="edInspector"></aside>
    <section class="ed-timeline">
      <div class="ed-tl-toolbar">
        <button class="ed-btn ghost" data-act="add-video-track">+ 视频轨</button>
        <button class="ed-btn ghost" data-act="add-audio-track">+ 音频轨</button>
        <button class="ed-btn ghost" data-act="ripple-delete" title="删除选中并左移后续片段（Shift+Delete）">涟漪删除</button>
        <button class="ed-btn ghost" data-act="link" title="链接选中片段（Ctrl+G）">链接</button>
        <button class="ed-btn ghost" data-act="unlink" title="取消链接（Ctrl+Shift+G）">取消链接</button>
        <button class="ed-btn ghost" data-act="copy" title="复制（Ctrl+C）">复制</button>
        <button class="ed-btn ghost" data-act="paste" title="粘贴到播放头（Ctrl+V）">粘贴</button>
        <button class="ed-btn ghost" data-act="add-text" title="在播放头添加文字 / 标题">+ 文字</button>
        <button class="ed-btn ghost" data-act="import-subtitle" title="导入 SRT / VTT 字幕">导入字幕</button>
        <button class="ed-btn ghost" data-act="export-subtitle" title="把文字片段导出为 SRT">导出字幕</button>
        <label class="ed-check"><input type="checkbox" data-act="toggle-snap" id="edSnap" /> 吸附</label>
        <label class="ed-zoom"><span>缩放</span><input type="range" data-act="zoom" id="edZoom" min="20" max="300" step="1" /></label>
        <span class="ed-spacer"></span>
        <span class="ed-tl-hint">拖拽片段移动 · 拖两端裁剪 · 双击媒体添加到时间线</span>
      </div>
      <div class="ed-tl-scroll" id="edTlScroll">
        <div class="ed-tl-inner" id="edTlInner">
          <div class="ed-ruler" id="edRuler"></div>
          <div class="ed-tl-rows" id="edTlRows"></div>
          <div class="ed-playhead" id="edPlayhead"><i></i></div>
          <div class="ed-marquee" id="edMarquee" hidden></div>
        </div>
      </div>
    </section>
  </div>
  <div class="ed-modal" id="edExportModal" hidden>
    <div class="ed-modal-card">
      <div class="ed-modal-head"><strong>导出视频</strong><button class="ed-mini" data-act="export-cancel" title="关闭">×</button></div>
      <div class="ed-modal-body">
        <label class="ed-field"><span>格式</span>
          <select id="edExportFormat">
            <option value="mp4">MP4（H.264 / AAC）</option>
            <option value="webm">WebM（兼容兜底）</option>
          </select>
        </label>
        <label class="ed-field"><span>分辨率</span><select id="edExportResolution"></select></label>
        <label class="ed-field"><span>帧率</span><select id="edExportFps"></select></label>
        <label class="ed-field"><span>质量</span>
          <select id="edExportQuality">
            <option value="high">高（体积大，画质好）</option>
            <option value="medium">中（推荐）</option>
            <option value="fast">快（体积小）</option>
          </select>
        </label>
        <p class="ed-hint" id="edExportHint"></p>
      </div>
      <div class="ed-modal-actions">
        <button class="ed-btn" data-act="export-cancel">取消</button>
        <button class="ed-btn primary" data-act="export-confirm" id="edExportConfirm">开始导出</button>
      </div>
    </div>
  </div>`
}

/* ===== 事件绑定（只在首次构建时挂一次） ===== */
function bindShell(): void {
  const root = $('#editorRoot')
  if (!root) return

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const actEl = target.closest<HTMLElement>('[data-act]')
    const act = actEl?.dataset.act
    if (!act) return
    if (act === 'import') void importMedia()
    else if (act === 'clear-media') void clearMedia()
    else if (act === 'add-media') addMediaToTimeline(actEl!.dataset.mediaId || '')
    else if (act === 'remove-media') removeMedia(actEl!.dataset.mediaId || '')
    else if (act === 'play') (playing ? pause() : play())
    else if (act === 'stop') stopPlayback()
    else if (act === 'split') splitAtPlayhead()
    else if (act === 'duplicate') duplicateSelected()
    else if (act === 'delete') deleteSelected()
    else if (act === 'ripple-delete') deleteSelected(true)
    else if (act === 'copy') copySelected()
    else if (act === 'paste') pasteClipboard()
    else if (act === 'add-transition') addTransition()
    else if (act === 'remove-transition') removeTransition()
    else if (act === 'recovery-restore') restoreRecovery()
    else if (act === 'recovery-discard') discardRecovery()
    else if (act === 'kf-toggle') toggleKeyframe(actEl!.dataset.kfProp as EditKeyframeProp)
    else if (act === 'kf-seek') {
      const clip = primaryClip()
      const prop = actEl!.dataset.kfProp as EditKeyframeProp
      const k = clip?.keyframes?.[prop]?.[Number(actEl!.dataset.kfIndex)]
      if (clip && k) setPlayhead(clip.start + k.t)
    } else if (act === 'kf-del') {
      const clip = primaryClip()
      const prop = actEl!.dataset.kfProp as EditKeyframeProp
      const idx = Number(actEl!.dataset.kfIndex)
      if (clip) {
        const list = [...(clip.keyframes?.[prop] || [])]
        list.splice(idx, 1)
        writeKeyframes(clip, prop, list)
        pushHistory()
        persistWorkspaces()
        renderAll()
        if (!playing) syncMedia(true)
      }
    }
    else if (act === 'add-text') addTextClip()
    else if (act === 'import-subtitle') void importSubtitle()
    else if (act === 'export-subtitle') void exportSubtitle()
    else if (act === 'link') linkSelected()
    else if (act === 'unlink') unlinkSelected()
    else if (act === 'undo') undo()
    else if (act === 'redo') redo()
    else if (act === 'export-audio') void exportAudio()
    else if (act === 'export-video') openExportDialog()
    else if (act === 'export-cancel') closeExportDialog()
    else if (act === 'export-confirm') void confirmExport()
    else if (act === 'ffmpeg-choose') void chooseFfmpeg()
    else if (act === 'add-video-track') addTrack('video')
    else if (act === 'add-audio-track') addTrack('audio')
    else if (act === 'track-mute') toggleTrack(actEl!.dataset.trackId || '', 'muted')
    else if (act === 'track-hide') toggleTrack(actEl!.dataset.trackId || '', 'hidden')
    else if (act === 'track-lock') toggleTrack(actEl!.dataset.trackId || '', 'locked')
    else if (act === 'track-remove') removeTrack(actEl!.dataset.trackId || '')
    else if (act === 'reset-filter') resetFilter()
  })

  root.addEventListener('dblclick', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.ed-media-item')
    if (item?.dataset.mediaId) addMediaToTimeline(item.dataset.mediaId)
  })

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    if (el.id === 'edSeek') {
      pause()
      setPlayhead(Number(el.value))
      return
    }
    if (el.id === 'edZoom') {
      project().zoom = clamp(Number(el.value), 20, 300)
      persistWorkspaces()
      renderTimeline()
      return
    }
    if (el.dataset.transProp) {
      applyTransitionInput(el, false)
      return
    }
    if (el.dataset.kfProp) {
      applyKeyframeInput(el, false)
      return
    }
    if (el.dataset.clipProp || el.dataset.filterProp || el.dataset.textProp) applyInspectorInput(el, false)
  })

  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    if (el.dataset.act === 'toggle-snap') {
      project().snap = (el as HTMLInputElement).checked
      persistWorkspaces()
      return
    }
    if (el.dataset.act === 'proj-resolution') {
      project().resolution = el.value as EditProject['resolution']
      pushHistory()
      persistWorkspaces()
      return
    }
    if (el.dataset.act === 'proj-fps') {
      project().fps = Number(el.value)
      pushHistory()
      persistWorkspaces()
      return
    }
    if (el.dataset.transProp) {
      applyTransitionInput(el, true)
      return
    }
    if (el.dataset.kfProp) {
      applyKeyframeInput(el as HTMLInputElement, true)
      return
    }
    if (el.dataset.clipProp || el.dataset.filterProp || el.dataset.textProp) {
      applyInspectorInput(el as HTMLInputElement, true)
    }
  })

  root.addEventListener('pointerdown', (e) => {
    const ev = e as PointerEvent
    const clipEl = (ev.target as HTMLElement).closest<HTMLElement>('.ed-clip')
    if (clipEl) {
      const clip = findClip(clipEl.dataset.clipId || '')
      if (!clip || findTrack(clip.trackId)?.locked) return
      const additive = ev.ctrlKey || ev.metaKey
      if (ev.shiftKey && primaryId && primaryId !== clip.id) {
        // Shift：同轨按时间顺序区间选择
        const laneEl = clipEl.parentElement
        const ids = laneEl ? [...laneEl.querySelectorAll<HTMLElement>('.ed-clip')].map((n) => n.dataset.clipId || '') : []
        const anchorIdx = ids.indexOf(primaryId)
        const idx = ids.indexOf(clip.id)
        if (anchorIdx >= 0 && idx >= 0) {
          const [a, b] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx]
          selectClips(ids.slice(a, b + 1), additive)
        } else {
          selectClips([clip.id], additive)
        }
      } else if (additive) {
        if (selectedIds.has(clip.id)) {
          selectedIds.delete(clip.id)
          renderSelectionStyles()
          renderInspector()
        } else {
          selectClips([clip.id], true)
        }
      } else if (!selectedIds.has(clip.id)) {
        selectClips([clip.id])
      } else {
        primaryId = clip.id
        renderInspector()
      }
      const handle = (ev.target as HTMLElement).dataset.handle
      startClipDrag(ev, clip, handle === 'l' ? 'trim-l' : handle === 'r' ? 'trim-r' : 'move')
      return
    }
    const lane = (ev.target as HTMLElement).closest<HTMLElement>('.ed-lane')
    if (lane) {
      startLaneSelection(ev, lane)
      return
    }
    const ruler = (ev.target as HTMLElement).closest<HTMLElement>('.ed-ruler')
    if (ruler) setPlayhead((ev.clientX - ruler.getBoundingClientRect().left) / project().zoom)
  })

  root.addEventListener('dragstart', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.ed-media-item')
    if (item?.dataset.mediaId) e.dataTransfer?.setData('text/aurora-media', item.dataset.mediaId)
  })
  root.addEventListener('dragover', (e) => {
    const lane = (e.target as HTMLElement).closest<HTMLElement>('.ed-lane')
    if (lane) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
  })
  root.addEventListener('drop', (e) => {
    const lane = (e.target as HTMLElement).closest<HTMLElement>('.ed-lane')
    if (!lane) return
    const mediaId = e.dataTransfer?.getData('text/aurora-media')
    if (mediaId) {
      e.preventDefault()
      addMediaToTimeline(mediaId, lane.dataset.trackId, Math.max(0, laneTimeFromEvent(e as unknown as PointerEvent, lane)))
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAutosave()
  })

  document.addEventListener('keydown', (e) => {
    if (!document.querySelector('.view-edit.active')) return
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.code === 'Space') {
      e.preventDefault()
      playing ? pause() : play()
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault()
      splitAtPlayhead()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      deleteSelected(e.shiftKey)
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      redo()
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      selectClips(project().clips.map((c) => c.id))
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault()
      copySelected()
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault()
      pasteClipboard()
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault()
      if (e.shiftKey) unlinkSelected()
      else linkSelected()
    }
  })
}

function applyInspectorInput(el: HTMLInputElement | HTMLSelectElement, commit: boolean): void {
  const clip = primaryClip()
  if (!clip) return
  const tprop = (el as HTMLElement).dataset.textProp
  if (tprop && clip.text) {
    const st = clip.text
    const boolProps = ['bold', 'italic', 'stroke', 'shadow', 'background']
    if (boolProps.includes(tprop)) {
      ;(st as unknown as Record<string, boolean>)[tprop] = (el as HTMLInputElement).checked
    } else if (tprop === 'align') {
      st.align = el.value as EditTextAlign
    } else if (tprop === 'content') {
      st.content = (el as unknown as HTMLTextAreaElement).value
    } else if (tprop === 'color' || tprop === 'strokeColor') {
      ;(st as unknown as Record<string, string>)[tprop] = (el as HTMLInputElement).value
    } else {
      const value = Number((el as HTMLInputElement).value)
      if (Number.isFinite(value)) (st as unknown as Record<string, number>)[tprop] = value
    }
    const out = document.querySelector<HTMLElement>(`#edInspector [data-out="${tprop}"]`)
    if (out) {
      const cur = (st as unknown as Record<string, number | string>)[tprop]
      out.textContent = tprop === 'x' || tprop === 'y' ? `${Math.round(Number(cur) * 100)}%` : String(cur)
    }
    renderTextOverlay()
    if (commit) {
      pushHistory()
      persistWorkspaces()
      renderTimeline()
    }
    return
  }
  const prop = el.dataset.clipProp
  const fprop = el.dataset.filterProp
  const num = Number((el as HTMLInputElement).value)
  if (prop === 'muted') {
    clip.muted = (el as HTMLInputElement).checked
  } else if (prop === 'rotation') {
    clip.rotation = Number(el.value)
  } else if (prop) {
    if (!Number.isFinite(num)) return
    if (prop === 'start') clip.start = Math.max(0, num)
    else if (prop === 'duration') {
      const media = findMedia(clip.mediaId)
      const maxDur = media?.duration ? (media.duration - clip.inPoint) / clip.speed : Infinity
      clip.duration = clamp(num, MIN_CLIP, maxDur)
    } else if (prop === 'inPoint') clip.inPoint = Math.max(0, num)
    else if (prop === 'speed') clip.speed = clamp(num, 0.25, 4)
    else if (prop === 'volume') clip.volume = clamp(num, 0, 2)
    else if (prop === 'fadeIn') clip.fadeIn = Math.max(0, num)
    else if (prop === 'fadeOut') clip.fadeOut = Math.max(0, num)
    else if (prop === 'opacity') clip.opacity = clamp(num, 0, 1)
  } else if (fprop) {
    ;(clip.filter as unknown as Record<string, number>)[fprop] = num
  }
  // 更新数值回显
  const out = document.querySelector<HTMLElement>(`#edInspector [data-out="${prop || fprop}"]`)
  if (out) {
    if (prop === 'speed') out.textContent = clip.speed.toFixed(2) + '×'
    else if (prop === 'volume') out.textContent = Math.round(clip.volume * 100) + '%'
    else if (prop === 'opacity') out.textContent = Math.round(clip.opacity * 100) + '%'
    else if (fprop === 'blur') out.textContent = clip.filter.blur + 'px'
    else out.textContent = String(num) + '%'
  }
  if (!playing) syncMedia(true)
  if (commit) {
    refreshDuration()
    pushHistory()
    persistWorkspaces()
    renderTimeline()
  }
}

/* ===== 媒体 / 轨道维护 ===== */
async function clearMedia(): Promise<void> {
  if (!wsRef) return
  const p = project()
  if (!p.media.length) return
  const ok = await confirmDialog('清空媒体库', '将移除全部媒体与时间线片段（本地文件不会被删除）。', '清空')
  if (!ok) return
  p.media = []
  p.clips = []
  audioEls.forEach((el) => el.remove())
  audioEls.clear()
  decodedBuffers.clear()
  selectedIds.clear()
  primaryId = ''
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
}

function removeMedia(mediaId: string): void {
  const p = project()
  p.media = p.media.filter((m) => m.id !== mediaId)
  p.clips = p.clips.filter((c) => c.mediaId !== mediaId)
  decodedBuffers.delete(mediaId)
  selectedIds.clear()
  primaryId = ''
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
}

function addTrack(kind: EditTrackKind): void {
  const p = project()
  const count = p.tracks.filter((t) => t.kind === kind).length + 1
  const track: EditTrack = {
    id: editUid('t'),
    name: `${kind === 'video' ? '视频' : '音频'} ${count}`,
    kind,
    muted: false,
    hidden: false,
    locked: false
  }
  p.tracks.push(track)
  pushHistory()
  persistWorkspaces()
  renderTimeline()
}

function toggleTrack(trackId: string, key: 'muted' | 'hidden' | 'locked'): void {
  const track = findTrack(trackId)
  if (!track) return
  track[key] = !track[key]
  pushHistory()
  persistWorkspaces()
  renderTimeline()
  if (!playing) syncMedia(true)
}

function removeTrack(trackId: string): void {
  const p = project()
  if (p.tracks.length <= 1) {
    toast('至少保留一条轨道', 'info')
    return
  }
  p.tracks = p.tracks.filter((t) => t.id !== trackId)
  p.clips = p.clips.filter((c) => c.trackId !== trackId)
  refreshDuration()
  pushHistory()
  persistWorkspaces()
  renderAll()
}

function resetFilter(): void {
  const clip = primaryClip()
  if (!clip) return
  clip.filter = createDefaultFilter()
  clip.opacity = 1
  clip.rotation = 0
  pushHistory()
  persistWorkspaces()
  renderInspector()
  syncMedia(true)
}

/* ===== 装配 ===== */
function ensureProject(ws: EditWorkspace): void {
  if (!ws.project || typeof ws.project !== 'object') ws.project = createDefaultEditProject()
  const p = ws.project
  if (!Array.isArray(p.media)) p.media = []
  if (!Array.isArray(p.tracks) || !p.tracks.length) p.tracks = createDefaultEditProject().tracks
  if (!Array.isArray(p.clips)) p.clips = []
  p.zoom = clamp(Number(p.zoom) || 90, 20, 300)
  p.playhead = Math.max(0, Number(p.playhead) || 0)
  p.snap = p.snap !== false
  p.fps = Number(p.fps) || 30
  p.resolution = p.resolution && EDIT_RESOLUTIONS[p.resolution] ? p.resolution : '1080p'
  p.clips.forEach((c) => {
    c.speed = clamp(Number(c.speed) || 1, 0.25, 4)
    c.volume = clamp(Number(c.volume) ?? 1, 0, 2)
    c.opacity = clamp(Number(c.opacity) ?? 1, 0, 1)
    c.fadeIn = Math.max(0, Number(c.fadeIn) || 0)
    c.fadeOut = Math.max(0, Number(c.fadeOut) || 0)
    c.rotation = clamp(Number(c.rotation) || 0, -360, 360)
    c.filter = { ...createDefaultFilter(), ...(c.filter || {}) }
    if (c.keyframes && typeof c.keyframes === 'object') {
      const normalized: EditKeyframes = {}
      KEYFRAME_PROPS.forEach((spec) => {
        const list = (c.keyframes as EditKeyframes)[spec.id]
        if (!Array.isArray(list) || !list.length) return
        normalized[spec.id] = list
          .map((k) => ({
            t: Math.max(0, Number(k.t) || 0),
            v: clamp(Number(k.v) || 0, spec.min, spec.max),
            e: (['linear', 'easeIn', 'easeOut', 'easeInOut'].includes(String(k.e)) ? k.e : 'linear') as EditKeyframe['e']
          }))
          .sort((a, b) => a.t - b.t)
      })
      c.keyframes = Object.keys(normalized).length ? normalized : undefined
    } else {
      c.keyframes = undefined
    }
    if (c.text) {
      c.mediaId = ''
      c.text = { ...createDefaultTextStyle(), ...c.text }
      c.text.fontSize = clamp(Number(c.text.fontSize) || 64, 12, 260)
      c.text.x = clamp(Number(c.text.x) || 0.5, 0, 1)
      c.text.y = clamp(Number(c.text.y) || 0.82, 0, 1)
    }
    if (c.transition) {
      c.transition.type = TRANSITIONS.some((t) => t.id === c.transition!.type) ? c.transition.type : 'dissolve'
      c.transition.duration = clamp(Number(c.transition.duration) || 0.5, 0.1, 3)
    }
  })
  refreshDuration()
}

export function bindEditorWorkspace(ws: EditWorkspace): void {
  pause()
  wsRef = ws
  ensureProject(ws)
  selectedIds.clear()
  primaryId = ''
  const root = $('#editorRoot')
  if (!root) return
  if (!shellBuilt || !root.querySelector('.editor-shell')) {
    root.innerHTML = shellHtml()
    audioPool = document.createElement('div')
    audioPool.className = 'ed-audio-pool'
    root.querySelector('.editor-shell')?.appendChild(audioPool)
    shellBuilt = true
    bindShell()
  }
  previewVideo = $('#edVideo') as HTMLVideoElement
  previewVideoB = $('#edVideoB') as HTMLVideoElement
  resetHistory()
  const p = project()
  const snap = $('#edSnap') as HTMLInputElement | null
  if (snap) snap.checked = p.snap
  const zoom = $('#edZoom') as HTMLInputElement | null
  if (zoom) zoom.value = String(p.zoom)
  const seek = $('#edSeek') as HTMLInputElement | null
  if (seek) seek.max = String(viewDuration())
  renderAll()
  updatePlayButton()
  bindEditorProgress()
  void refreshFfmpegStatus()
  startAutosave()
  void flushAutosave()
  void checkRecovery()
  // 供自检 / 自动化调用（不参与业务逻辑）
  ;(window as unknown as Record<string, unknown>).__auroraEditor = {
    addPaths: addMediaPaths,
    addToTimeline: (mediaId: string, at?: number) => addMediaToTimeline(mediaId, undefined, at),
    getState: () => JSON.parse(JSON.stringify(project())),
    setPlayhead,
    play,
    pause,
    split: splitAtPlayhead,
    undo,
    redo,
    renderAudioWav,
    renderVideoWebm,
    exportVideo,
    refreshFfmpegStatus,
    getFfmpegStatus: () => ffmpegInfo,
    getSelection: () => [...selectedIds],
    selectAll: () => selectClips(project().clips.map((c) => c.id)),
    select: (ids: string[], additive = false) => selectClips(ids, additive),
    clearSelection: () => clearSelection(),
    rippleDelete: () => deleteSelected(true),
    link: linkSelected,
    unlink: unlinkSelected,
    copy: copySelected,
    paste: pasteClipboard,
    toggleKeyframe: (prop: EditKeyframeProp) => toggleKeyframe(prop),
    getKeyframes: () => primaryClip()?.keyframes || null,
    setKeyframe: (prop: EditKeyframeProp, kt: number, v: number) => {
      const clip = primaryClip()
      if (!clip) return false
      setKeyframeAt(clip, prop, kt, v)
      pushHistory()
      persistWorkspaces()
      renderAll()
      if (!playing) syncMedia(true)
      return true
    },
    kfValueAt: (prop: EditKeyframeProp) => {
      const clip = primaryClip()
      return clip ? clipValue(clip, prop, project().playhead) : null
    },
    addTransition,
    removeTransition,
    getActiveTransition: () => {
      const t = activeTransition(project().playhead)
      return t ? { type: t.type, from: t.from.id, to: t.to.id } : null
    },
    addText: (content?: string) => addTextClip(content),
    importSrtText: (text: string) => applySubtitleCues(parseSubtitle(text)),
    buildSrtText: () => buildSrt(project().clips),
    prepareTextImages,
    textOverlayCount: () => document.querySelectorAll('#edTextLayer .ed-overlay-text').length,
    flushAutosave,
    stopAutosave: () => {
      if (autosaveTimer) clearInterval(autosaveTimer)
      autosaveTimer = null
    },
    getWorkspaceId: () => wsRef?.id || '',
    checkRecovery,
    restoreRecovery,
    discardRecovery,
    getPendingRecovery: () => (pendingRecovery ? { savedAt: pendingRecovery.savedAt } : null),
    filmstripCount: () => filmstripCache.size,
    setZoom: (z: number) => {
      project().zoom = clamp(Number(z) || 90, 20, 300)
      persistWorkspaces()
      renderTimeline()
    },
    textPngDataUrl: (clipId: string, w: number, h: number) => {
      const clip = findClip(clipId)
      if (!clip?.text) return null
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      drawTextLayer(ctx, clip.text, w, h)
      return canvas.toDataURL('image/png')
    }
  }
}
