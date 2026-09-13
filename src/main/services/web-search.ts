/** 联网搜索服务：DuckDuckGo 优先，Bing 兜底（国内网络可达时）。返回格式化文本结果。 */

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&ensp;|&emsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&bull;/g, '•')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export async function duckduckgoSearch(query: string): Promise<string> {
  const q = String(query || '').trim().slice(0, 200)
  if (!q) return '搜索关键词为空。'

  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      body: new URLSearchParams({ q }).toString(),
      signal: AbortSignal.timeout(20000)
    })
    if (!resp.ok) return `搜索失败（HTTP ${resp.status}）。`

    const html = await resp.text()
    const results: string[] = []
    const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const links: Array<{ url: string; title: string }> = []
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html)) && links.length < 8) {
      let url = m[1]
      // DuckDuckGo 跳转链接解包 uddg 参数
      const uddg = /[?&]uddg=([^&]+)/.exec(url)
      if (uddg) {
        try {
          url = decodeURIComponent(uddg[1])
        } catch (e) {
          /* 保留原链接 */
        }
      }
      links.push({ url, title: stripTags(m[2]) })
    }
    const snippets: string[] = []
    while ((m = snipRe.exec(html)) && snippets.length < 8) {
      snippets.push(stripTags(m[1]))
    }
    for (let i = 0; i < links.length && results.length < 6; i++) {
      const s = snippets[i] || ''
      if (links[i].title || s) results.push(`【${links[i].title || '(无标题)'}】\n${links[i].url}\n${s}`)
    }

    if (!results.length) return '未找到相关搜索结果，建议换个关键词。'
    return `以下是「${q}」的搜索结果（第 ${1} 页，共 ${results.length} 条）：\n\n` + results.join('\n\n')
  } catch (err) {
    const reason = err && (err as any).name === 'TimeoutError' ? '搜索超时' : ((err as Error).message || String(err))
    return `搜索失败：${reason}。请基于已有知识回答，或提示用户稍后重试。`
  }
}

// ---- Bing 搜索兜底（cn.bing.com，国内网络可达） ----
async function bingSearch(query: string): Promise<string> {
  const q = String(query || '').trim().slice(0, 200)
  if (!q) return '搜索关键词为空。'

  try {
    const resp = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q), {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(20000)
    })
    if (!resp.ok) return ''

    const html = await resp.text()
    const results: string[] = []
    const algoRe = /<li class="b_algo"[\s\S]*?<\/li>/g
    let block: RegExpExecArray | null
    while ((block = algoRe.exec(html)) && results.length < 6) {
      const b = block[0]
      const titleRe = /<h2[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b)
      const url = titleRe ? titleRe[1] : ''
      const title = titleRe ? stripTags(titleRe[2]) : ''
      const snipRe = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b)
      const snippet = snipRe ? stripTags(snipRe[1]) : ''
      if (title || snippet) results.push(`【${title || '(无标题)'}】\n${url}\n${snippet}`)
    }

    if (!results.length) return ''
    return `以下是「${q}」的搜索结果（Bing）：\n\n` + results.join('\n\n')
  } catch (err) {
    const reason = err && (err as any).name === 'TimeoutError' ? '搜索超时' : ((err as Error).message || String(err))
    return `搜索失败：${reason}。请基于已有知识回答，或提示用户稍后重试。`
  }
}

/** 多源并行搜索，取第一个成功的非空结果；全部失败时返回兜底提示。 */
export async function searchWeb(query: string): Promise<string> {
  const q = String(query || '').trim().slice(0, 200)
  if (!q) return '搜索关键词为空。'

  const isSuccess = (v: string) => !!v && !/^(搜索失败|未找到)/.test(v)
  const attempts = [duckduckgoSearch(q), bingSearch(q)]

  return new Promise((resolve) => {
    let done = false
    const pick = (v: string) => {
      if (done) return
      if (isSuccess(v)) {
        done = true
        resolve(v)
      }
    }
    attempts.forEach((p) => p.then(pick, () => {}))
    // 全部无成功结果时兜底：取第一个非空返回（通常是 DDG 的错误提示）
    Promise.allSettled(attempts).then((rs) => {
      if (done) return
      done = true
      const vals = rs.map((r) => (r.status === 'fulfilled' ? r.value : ''))
      resolve(vals.find((v) => v) || '搜索失败：多个搜索源均不可用，请稍后重试。')
    })
  })
}