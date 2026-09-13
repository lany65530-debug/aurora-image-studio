/**
 * 渲染层 · 轻量 Markdown 渲染（无第三方依赖）
 */
import { escapeHtml } from '../state/store'

export function renderMarkdown(md: string): string {
  const src = String(md || '')
  if (!src.trim()) return ''

  // 1. 先抽出代码块
  const codeBlocks: { lang: string; code: string }[] = []
  let text = src.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    codeBlocks.push({ lang: lang || '', code })
    return `\u0000CB${codeBlocks.length - 1}\u0000`
  })

  // 2. 转义 HTML
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  // 3. 行内元素
  text = text
    .replace(/`([^`\n]+)`/g, '<code class="md-code-inline">$1</code>')
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  // 4. 行级解析（标题 / 列表 / 引用 / 分割线 / 表格 / 段落）
  const lines = text.split('\n')
  const out: string[] = []
  let para: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listItems: string[] = []
  let quote: string[] = []
  let tableRows: string[] = []

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p class="md-p">${para.join('<br>')}</p>`)
      para = []
    }
  }
  const flushList = (): void => {
    if (listType) {
      out.push(`<${listType} class="md-list">${listItems.map((i) => `<li>${i}</li>`).join('')}</${listType}>`)
      listType = null
      listItems = []
    }
  }
  const flushQuote = (): void => {
    if (quote.length) {
      out.push(`<blockquote class="md-quote">${quote.join('<br>')}</blockquote>`)
      quote = []
    }
  }
  const flushTable = (): void => {
    if (tableRows.length >= 2) {
      const rows = tableRows.map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
      const isSep = (r: string[]): boolean => r.every((c) => /^:?-{2,}:?$/.test(c))
      if (isSep(rows[1])) {
        const head = rows[0]
        const body = rows.slice(2)
        out.push(
          '<div class="md-table-wrap"><table class="md-table"><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>'
        )
        tableRows = []
        return
      }
    }
    if (tableRows.length) {
      out.push(...tableRows.map((r) => `<p class="md-p">${r}</p>`))
      tableRows = []
    }
  }
  const flushAll = (): void => {
    flushPara()
    flushList()
    flushQuote()
    flushTable()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()

    // 表格行
    if (t.startsWith('|') && t.endsWith('|') && t.length > 2) {
      flushPara()
      flushList()
      flushQuote()
      tableRows.push(t)
      continue
    }
    flushTable()

    if (!t) {
      flushAll()
      continue
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(t)
    if (h) {
      flushAll()
      const level = Math.min(h[1].length + 2, 5)
      out.push(`<h${level} class="md-h">${h[2]}</h${level}>`)
      continue
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushAll()
      out.push('<hr class="md-hr">')
      continue
    }

    // 引用
    if (t.startsWith('&gt; ')) {
      flushPara()
      flushList()
      quote.push(t.slice(5))
      continue
    }

    // 无序列表
    const ul = /^[-*+]\s+(.*)$/.exec(t)
    if (ul) {
      flushPara()
      flushQuote()
      if (listType !== 'ul') {
        flushList()
        listType = 'ul'
      }
      listItems.push(ul[1])
      continue
    }

    // 有序列表
    const ol = /^\d+[.)]\s+(.*)$/.exec(t)
    if (ol) {
      flushPara()
      flushQuote()
      if (listType !== 'ol') {
        flushList()
        listType = 'ol'
      }
      listItems.push(ol[1])
      continue
    }

    // 普通段落
    flushList()
    flushQuote()
    para.push(t)
  }
  flushAll()

  let html = out.join('\n')

  // 5. 还原代码块
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => {
    const b = codeBlocks[+i]
    if (!b) return ''
    const lang = b.lang ? `<span class="md-code-lang">${escapeHtml(b.lang)}</span>` : ''
    return `<div class="md-code-block">${lang}<button class="md-code-copy" type="button">复制</button><pre><code>${escapeHtml(b.code.replace(/\n$/, ''))}</code></pre></div>`
  })

  return html
}