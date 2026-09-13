/**
 * 阅读辅助（移植自 ai-novel-app/src/services/readerService.ts）
 * --------------------------------------------------------------
 * 段落解析：将章节正文按行解析为带「段落缩进 / 空行」标记的结构，供阅读器排版。
 */
export interface ParsedParagraph {
  text: string
  indent: boolean
  blank: boolean
}

export function parseParagraphs(text: string): ParsedParagraph[] {
  const lines = (text || '').split('\n')
  const res: ParsedParagraph[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      res.push({ text: '', indent: false, blank: true })
      continue
    }
    const indent = !(
      line.startsWith('\u3000') ||
      line.startsWith(' ') ||
      line.startsWith('\t')
    )
    res.push({ text: line, indent, blank: false })
  }
  while (res.length && res[0].blank) res.shift()
  while (res.length && res[res.length - 1].blank) res.pop()
  return res
}