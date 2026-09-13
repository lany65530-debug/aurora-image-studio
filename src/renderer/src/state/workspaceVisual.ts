/**
 * 渲染层 · 工作区视觉标识
 * ------------------------------------------------------------
 * 为侧边栏里的工作区提供稳定的「类型标签 + 专属配色」，
 * 解决工作区一多、头像又只有首字母时难以分辨的问题。
 * 本模块保持零 DOM 依赖，便于单独测试。
 */
import type { Workspace } from './store'

export type WsType = 'image' | 'chat' | 'novel' | 'edit'

/** 参与配色的最小工作区信息。 */
export interface WsColorInput {
  id: string
  color?: number | null
}

export interface WsColor {
  /** 头像底色（浅色，保证深色字母可读） */
  bg: string
  /** 头像前景色 / 类型角标颜色 */
  fg: string
  /** 描边色，与底色同色系 */
  line: string
}

/** 工作区类型的完整名称（用于 tooltip / 弹窗）。 */
export const WS_TYPE_LABEL: Record<WsType, string> = {
  image: '图片工作区',
  chat: '聊天工作区',
  novel: '小说工作区',
  edit: '剪辑工作区'
}

/** 工作区类型的短标签（用于侧边栏副标题）。 */
export const WS_TYPE_SHORT: Record<WsType, string> = {
  image: '图片',
  chat: '聊天',
  novel: '小说',
  edit: '剪辑'
}

/**
 * 12 色低饱和调色板：浅底 + 深字，
 * 相邻索引色相差异明显，浅色主题下都保证文字对比度。
 */
export const WS_PALETTE: readonly WsColor[] = [
  { bg: '#e4e8ff', fg: '#3b45b8', line: '#b9c1f4' },
  { bg: '#dcf4ef', fg: '#0f7565', line: '#a7ddd2' },
  { bg: '#fdeed6', fg: '#9a5d06', line: '#f0cd94' },
  { bg: '#fce1ea', fg: '#a82c59', line: '#f0b6c9' },
  { bg: '#efe4fd', fg: '#7136b8', line: '#d3bef1' },
  { bg: '#dcedfd', fg: '#146198', line: '#aed4f2' },
  { bg: '#e1f4dd', fg: '#2c7530', line: '#b8e0b1' },
  { bg: '#ffe6da', fg: '#b64a1b', line: '#f6c4ab' },
  { bg: '#d9f2f5', fg: '#0a6b7d', line: '#a5dbe2' },
  { bg: '#e7ebf1', fg: '#40506a', line: '#c3ccda' },
  { bg: '#fde8dc', fg: '#a34a12', line: '#f0c3a5' },
  { bg: '#e6f0e0', fg: '#4b6b1f', line: '#c6dbb2' }
]

export function workspaceColorCount(): number {
  return WS_PALETTE.length
}

/** FNV-1a 字符串散列：同一 id 永远得到同一索引。 */
function hashId(id: string): number {
  let h = 2166136261
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 取工作区的配色索引：
 * 优先使用已持久化的 color，缺失时按 id 稳定散列兜底。
 */
export function workspaceColorIndex(input: WsColorInput | string): number {
  const id = typeof input === 'string' ? input : input.id
  const raw = typeof input === 'string' ? undefined : input.color
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.trunc(raw) % WS_PALETTE.length
    return n < 0 ? n + WS_PALETTE.length : n
  }
  return hashId(id) % WS_PALETTE.length
}

/** 取工作区配色。 */
export function workspaceColor(input: WsColorInput | string): WsColor {
  return WS_PALETTE[workspaceColorIndex(input)]
}

/** 过滤工作区：按名称或类型短标签匹配，大小写不敏感。 */
export function filterWorkspaces<T extends Workspace>(list: readonly T[], query: string): T[] {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return list.slice()
  return list.filter((w) => {
    const name = String(w.name || '').toLowerCase()
    const type = w.type as WsType
    return name.includes(q) || WS_TYPE_SHORT[type].includes(q) || WS_TYPE_LABEL[type].toLowerCase().includes(q)
  })
}

function circularDistance(a: number, b: number, n: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, n - d)
}

/**
 * 为工作区补齐缺失的配色：
 * 在「当前使用次数最少」的颜色里，优先选色相离已有颜色最远的一个，
 * 保证工作区一多时，相邻工作区的颜色也尽量拉开、便于分辨。
 */
export function assignWorkspaceColors(list: Workspace[]): void {
  const n = WS_PALETTE.length
  const counts = new Array<number>(n).fill(0)
  const assigned: number[] = []
  for (const w of list) {
    const c = (w as WsColorInput).color
    if (typeof c === 'number' && Number.isFinite(c)) {
      const i = workspaceColorIndex(w)
      counts[i]++
      assigned.push(i)
    }
  }
  for (const w of list) {
    const c = (w as WsColorInput).color
    if (typeof c === 'number' && Number.isFinite(c)) continue
    const start = hashId(w.id) % n
    const minCount = Math.min(...counts)
    let pick = start
    let bestSeparation = -1
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n
      if (counts[i] !== minCount) continue
      const separation = assigned.length
        ? Math.min(...assigned.map((u) => circularDistance(i, u, n)))
        : n
      if (separation > bestSeparation) {
        bestSeparation = separation
        pick = i
      }
    }
    w.color = pick
    counts[pick]++
    assigned.push(pick)
  }
}
