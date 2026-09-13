import http from 'http'
import https from 'https'
import { URL } from 'url'
import { setTimeout as delay } from 'node:timers/promises'

/** 统一 HTTP 请求/下载/上传超时（毫秒）。 */
export const HTTP_TIMEOUT = 120000

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消生成')
}

export async function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  try {
    await delay(ms, undefined, { signal })
  } catch (err) {
    throwIfAborted(signal)
    throw err
  }
}

function trackRequest(req: http.ClientRequest, signal: AbortSignal | undefined, timeout: number, reject: (err: Error) => void): () => void {
  const cleanup = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const fail = (err: Error) => {
    cleanup()
    req.destroy(err)
    reject(err)
  }
  const onAbort = () => fail(new Error('已取消生成'))
  const timer = setTimeout(() => fail(new Error('请求超时')), timeout)
  req.on('error', (err) => { cleanup(); reject(err) })
  req.on('response', (res) => {
    res.on('error', fail)
    res.on('aborted', () => fail(new Error('响应连接中断')))
    res.on('close', () => {
      if (!res.complete) fail(new Error('响应未完整接收'))
    })
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return cleanup
}

/** 标准化 HTTP 响应。 */
export interface ApiResponse {
  ok: boolean
  status?: number
  data: any
  raw?: string
  buf?: Buffer
  dataUrl?: string | null
  contentType?: string
}

export interface Progress {
  received: number
  total: number
}

/** 通用 HTTPS/HTTP JSON 请求（绕过浏览器 CORS）。 */
export function requestJson(
  urlStr: string,
  options: {
    method?: string
    headers?: Record<string, string>
    onProgress?: (p: Progress) => void
    signal?: AbortSignal
    timeout?: number
  } = {},
  bodyObj: unknown = null
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    throwIfAborted(options.signal)
    let urlObj: URL
    try {
      urlObj = new URL(urlStr)
    } catch (e) {
      return reject(new Error('无效的请求地址: ' + urlStr))
    }
    if (!['http:', 'https:'].includes(urlObj.protocol)) return reject(new Error('仅支持 HTTP/HTTPS 请求'))
    const lib = urlObj.protocol === 'http:' ? http : https
    const payload = bodyObj === null || bodyObj === undefined ? null : JSON.stringify(bodyObj)

    const headers: Record<string, string> = Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      options.headers || {}
    )
    if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload))

    const reqOptions: http.RequestOptions = {
      method: options.method || 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search,
      headers
    }

    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = []
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        received += c.length
        try {
          options.onProgress?.({ received, total })
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)))
        }
      })
      res.on('end', () => {
        cleanupAbort()
        const buf = Buffer.concat(chunks)
        const raw = buf.toString('utf-8')
        let json: any = null
        try {
          json = raw ? JSON.parse(raw) : null
        } catch (e) {
          json = null
        }
        const ctype = String(res.headers['content-type'] || '').toLowerCase()
        let dataUrl: string | null = null
        if (/image\//.test(ctype) && buf.length > 0) {
          dataUrl = 'data:' + ctype + ';base64,' + buf.toString('base64')
        }
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300,
          status: res.statusCode,
          data: json,
          raw,
          buf,
          dataUrl,
          contentType: ctype
        })
      })
    })
    const cleanupAbort = trackRequest(req, options.signal, options.timeout || HTTP_TIMEOUT, reject)
    try {
      if (payload) req.write(payload)
      req.end()
    } catch (err) {
      cleanupAbort()
      req.destroy()
      reject(err)
    }
  })
}

/** 下载远程资源为 Buffer，带字节进度，支持重定向。 */
export function downloadBuffer(
  urlStr: string,
  onProgress?: (p: Progress) => void,
  opts: { redirects?: number; headers?: Record<string, string>; timeout?: number; signal?: AbortSignal } = {}
): Promise<Buffer> {
  let redirects = opts.redirects || 0
  const timeoutMs = opts.timeout || HTTP_TIMEOUT

  return new Promise((resolve, reject) => {
    throwIfAborted(opts.signal)
    const isHttp = /^http:\/\//i.test(urlStr)
    const lib = isHttp ? http : https

    const req = lib.get(
      urlStr,
      {
        headers: Object.assign(
          {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8'
          },
          opts.headers || {}
        ),
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode! >= 300 && res.statusCode! < 400 && res.headers.location) {
          cleanup()
          res.resume()
          if (redirects >= 5) return reject(new Error('download redirect limit exceeded'))
          try {
            const next = new URL(res.headers.location, urlStr)
            if (!['http:', 'https:'].includes(next.protocol)) throw new Error('无效的重定向协议')
            const headers = { ...opts.headers }
            if (next.origin !== new URL(urlStr).origin) {
              Object.keys(headers).forEach((key) => {
                if (/^(authorization|cookie|proxy-authorization|host)$/i.test(key)) delete headers[key]
              })
            }
            return downloadBuffer(next.href, onProgress, { ...opts, headers, redirects: redirects + 1 }).then(resolve, reject)
          } catch (err) {
            reject(err)
            return
          }
        }

        if (res.statusCode! < 200 || res.statusCode! >= 300) {
          cleanup()
          res.resume()
          return reject(new Error(`download failed (HTTP ${res.statusCode})`))
        }

        const chunks: Buffer[] = []
        const total = Number(res.headers['content-length'] || 0)
        let received = 0
        res.on('data', (c: Buffer) => {
          chunks.push(c)
          received += c.length
          try {
            onProgress?.({ received, total })
          } catch (err) {
            req.destroy(err instanceof Error ? err : new Error(String(err)))
          }
        })
        res.on('end', () => { cleanup(); resolve(Buffer.concat(chunks)) })
        res.on('error', (err) => reject(err))
      }
    )
    const cleanup = trackRequest(req, opts.signal, timeoutMs, reject)
  })
}

/** multipart/form-data 请求（含可选文件，用于 edit 端点）。 */
export function requestMultipart(
  urlStr: string,
  headers: Record<string, string>,
  fields: Record<string, any>,
  files: Array<{ field: string; filename: string; contentType?: string; buffer: Buffer }>,
  onProgress?: (p: Progress) => void,
  signal?: AbortSignal
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    let urlObj: URL
    try {
      urlObj = new URL(urlStr)
    } catch (e) {
      return reject(new Error('无效的请求地址: ' + urlStr))
    }
    if (!['http:', 'https:'].includes(urlObj.protocol)) return reject(new Error('仅支持 HTTP/HTTPS 请求'))
    const lib = urlObj.protocol === 'http:' ? http : https
    const boundary = '----AuroraForm' + Date.now().toString(16) + Math.random().toString(16).slice(2)
    const parts: Buffer[] = []
    const quoted = (value: string) => String(value).replace(/[\r\n]/g, '').replace(/"/g, '%22')

    Object.keys(fields || {}).forEach((key) => {
      const val = fields[key]
      if (val === undefined || val === null || val === '') return
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(key)}"\r\n\r\n${val}\r\n`, 'utf-8'))
    })
    ;(files || []).forEach((f) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(f.field)}"; filename="${quoted(f.filename)}"\r\nContent-Type: ${String(f.contentType || 'application/octet-stream').replace(/[\r\n]/g, '')}\r\n\r\n`,
          'utf-8'
        )
      )
      parts.push(f.buffer)
      parts.push(Buffer.from('\r\n', 'utf-8'))
    })
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
    const bodyBuf = Buffer.concat(parts)

    const reqOptions: http.RequestOptions = {
      method: 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search,
      headers: Object.assign(
        { Accept: 'application/json' },
        Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !/^(content-type|content-length|transfer-encoding)$/i.test(key))),
        {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuf.length
        }
      )
    }

    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = []
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        received += c.length
        try {
          onProgress?.({ received, total })
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)))
        }
      })
      res.on('end', () => {
        cleanupAbort()
        const buf = Buffer.concat(chunks)
        const raw = buf.toString('utf-8')
        const contentType = String(res.headers['content-type'] || '').toLowerCase()
        let json: any = null
        try {
          json = raw ? JSON.parse(raw) : null
        } catch (e) {
          json = null
        }
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300, status: res.statusCode, data: json, raw, buf, contentType,
          dataUrl: /^image\//.test(contentType) && buf.length ? `data:${contentType};base64,${buf.toString('base64')}` : null
        })
      })
    })
    const cleanupAbort = trackRequest(req, signal, HTTP_TIMEOUT, reject)
    try {
      req.write(bodyBuf)
      req.end()
    } catch (err) {
      cleanupAbort()
      req.destroy()
      reject(err)
    }
  })
}

export function requestForm(
  urlStr: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType?: string; buffer: Buffer }>,
  onProgress?: (p: Progress) => void,
  signal?: AbortSignal
): Promise<ApiResponse> {
  return requestMultipart(urlStr, headers, fields, files, onProgress, signal)
}

type UploadHost = {
  name: string
  url: string
  headers: Record<string, string>
  fields: Record<string, string>
  fileField: string
  parse?: (resp: ApiResponse) => string | null
  urlPath?: string
}

/** 上传 base64 dataURL 到公开图床，返回公开 URL。 */
export async function uploadToHost(
  dataUrl: string,
  filename: string,
  customHosts?: UploadHost[],
  options: { allowPublicUpload?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
  throwIfAborted(options.signal)
  if (options.allowPublicUpload !== true) throw new Error('公共图床上传默认禁用，请显式启用 provider.allowPublicUpload 或使用图片链接。')
  const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl || '')
  if (!m) throw new Error('参考图格式无效。')
  const mime = m[1] || 'image/png'
  const buffer = Buffer.from(m[2], 'base64')
  const ext = (mime.split('/')[1] || 'png').split('+')[0]
  const name = filename || `ref.${ext}`
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

  const fallbackHosts: UploadHost[] = [
    {
      name: 'remit',
      url: 'https://img.remit.ee/api/upload',
      headers: { 'User-Agent': ua, Referer: 'https://img.remit.ee/', Origin: 'https://img.remit.ee' },
      fields: {},
      fileField: 'file',
      parse: (resp) => {
        const d = resp.data || {}
        const rel = d.directUrl || d.url
        if (!rel) return null
        return /^https?:\/\//i.test(rel) ? rel : 'https://img.remit.ee' + rel
      }
    },
    {
      name: 'tmpfiles',
      url: 'https://tmpfiles.org/api/v1/upload',
      headers: { 'User-Agent': ua },
      fields: {},
      fileField: 'file',
      parse: (resp) => {
        const u = resp.data && resp.data.data && resp.data.data.url
        if (!u) return null
        return String(u).replace('tmpfiles.org/', 'tmpfiles.org/dl/')
      }
    },
    {
      name: 'catbox',
      url: 'https://catbox.moe/user/api.php',
      headers: { 'User-Agent': ua },
      fields: { reqtype: 'fileupload' },
      fileField: 'fileToUpload',
      parse: (resp) => (resp.raw || '').trim()
    },
    {
      name: 'uguu',
      url: 'https://uguu.se/upload.php',
      headers: { 'User-Agent': ua },
      fields: {},
      fileField: 'files[]',
      parse: (resp) => {
        const f = resp.data && resp.data.files && resp.data.files[0]
        return f && f.url ? f.url : null
      }
    },
    {
      name: '0x0',
      url: 'https://0x0.st',
      headers: { 'User-Agent': ua },
      fields: {},
      fileField: 'file',
      parse: (resp) => {
        const t = (resp.raw || '').trim()
        return /^https?:\/\/\S+/i.test(t) ? t : null
      }
    }
  ]
  const custom = Array.isArray(customHosts) && customHosts.length > 0
  const hosts = custom ? customHosts : fallbackHosts

  const errors: string[] = []
  for (const host of hosts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        throwIfAborted(options.signal)
        const resp = await requestMultipart(
          host.url,
          host.headers,
          host.fields,
          [{ field: host.fileField, filename: name, contentType: mime, buffer }],
          undefined,
          options.signal
        )
        if (resp.ok) {
          let url: unknown
          if (custom) {
            url = host.urlPath ? resp.data : resp.raw?.trim()
            for (const key of host.urlPath?.split('.') || []) {
              if (['__proto__', 'constructor', 'prototype'].includes(key) || !url || typeof url !== 'object' || !Object.hasOwn(url, key)) {
                url = undefined
                break
              }
              url = (url as Record<string, unknown>)[key]
            }
          } else {
            url = host.parse?.(resp)
          }
          if (typeof url === 'string' && /^https?:\/\/\S+$/i.test(url)) return url
          errors.push(`${host.name}: 返回无有效地址`)
          break
        }
        errors.push(`${host.name}: HTTP ${resp.status}`)
      } catch (e: any) {
        throwIfAborted(options.signal)
        const msg = (e && e.message) || String(e)
        errors.push(`${host.name}: ${msg}`)
        if (!/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|超时/i.test(msg)) break
        await waitFor(600, options.signal)
      }
    }
  }

  throw new Error('参考图上传失败，已尝试多个图床均不可用（' + errors.slice(0, 4).join('；') + '）。可能是网络限制，建议稍后重试、改用图片链接或在接口配置中自定义图床。')
}
