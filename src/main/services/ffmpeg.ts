import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { loadSettings, mergeAndSaveSettings } from './settings'
import {
  TRANSITIONS,
  clipEnd,
  projectContentEnd,
  type EditClip,
  type EditKeyframe,
  type EditTransition,
  type EditorProbeResult,
  type EditorProgressEvent,
  type ExportQuality,
  type ExportTimelineArgs,
  type ExportTimelineResult,
  type FfmpegStatus
} from '../../shared/editor'

/**
 * 主进程 · FFmpeg 服务
 * ------------------------------------------------------------
 * - 自动查找 ffmpeg/ffprobe（环境变量 / 内置 resources / 设置 / PATH / 常见安装位置）
 * - ffprobe 探测媒体（时长 / 分辨率 / 编码 / 是否 Chromium 可直接播放）
 * - 非 Web 友好格式自动转码为 MP4 代理
 * - 抽帧缩略图
 * - 用 filter_complex 直接把时间线渲染成 MP4（非实时，速度快，支持 H.264/AAC）
 */

const WIN = process.platform === 'win32'
const exe = (n: string): string => (WIN ? `${n}.exe` : n)

let cached: FfmpegStatus | null = null
let currentProc: ChildProcess | null = null
const probeCache = new Map<string, EditorProbeResult>()

/* ===== 路径查找 ===== */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function whichSync(cmd: string): string {
  try {
    const out = execFileSync(WIN ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || ''
  } catch {
    return ''
  }
}

interface Candidate {
  path: string
  source: string
}

function candidates(): Candidate[] {
  const list: Candidate[] = []
  const envPath = process.env.AURORA_FFMPEG_PATH
  if (envPath) list.push({ path: envPath, source: 'AURORA_FFMPEG_PATH' })

  const res = process.resourcesPath || ''
  if (res) {
    list.push({ path: path.join(res, 'ffmpeg', exe('ffmpeg')), source: 'bundled' })
    list.push({ path: path.join(res, exe('ffmpeg')), source: 'bundled' })
  }
  try {
    const s = loadSettings() as { ffmpegPath?: string }
    if (s.ffmpegPath) list.push({ path: s.ffmpegPath, source: 'settings' })
  } catch {
    /* 忽略设置读取失败 */
  }
  const pathHit = whichSync('ffmpeg')
  if (pathHit) list.push({ path: pathHit, source: 'PATH' })

  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  list.push(
    { path: path.join(pf, 'ffmpeg', 'bin', exe('ffmpeg')), source: 'system' },
    { path: path.join(pf86, 'ffmpeg', 'bin', exe('ffmpeg')), source: 'system' },
    { path: path.join(pf, 'File Converter', exe('ffmpeg')), source: 'system' },
    { path: path.join('C:\\ffmpeg', 'bin', exe('ffmpeg')), source: 'system' },
    { path: path.join(local, 'Microsoft', 'WinGet', 'Links', exe('ffmpeg')), source: 'system' }
  )
  // 剪映 / CapCut 等自带 ffmpeg（无 libx264，但支持硬件编码）
  if (WIN) {
    for (const root of ['C:\\', 'D:\\', 'E:\\', 'F:\\']) {
      for (const appName of ['JianyingPro', 'CapCut']) {
        const base = path.join(root, appName)
        if (!fs.existsSync(base)) continue
        try {
          const versions = fs.readdirSync(base).filter((v) => /^\d/.test(v))
          versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          for (const v of versions.slice(0, 3)) list.push({ path: path.join(base, v, exe('ffmpeg')), source: 'system' })
        } catch {
          /* 忽略无权限目录 */
        }
      }
    }
  }
  return list
}

function readEncoders(bin: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-encoders'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`
      const names = new Set<string>()
      text.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*[A-Z.]{6,}\s+(\S+)/)
        if (m) names.add(m[1])
      })
      resolve([...names])
    })
  })
}

function version(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-version'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(!err && /ffmpeg version/i.test(String(stdout)))
    })
  })
}

/** 查找可用 ffmpeg（带缓存）。 */
export async function getFfmpegStatus(force = false): Promise<FfmpegStatus> {
  if (cached && !force) return cached
  for (const c of candidates()) {
    if (!c.path || !isFile(c.path)) continue
    if (!(await version(c.path))) continue
    const dir = path.dirname(c.path)
    let ffprobe = path.join(dir, exe('ffprobe'))
    if (!isFile(ffprobe)) ffprobe = whichSync('ffprobe')
    const encoders = await readEncoders(c.path)
    cached = {
      available: true,
      ffmpeg: c.path,
      ffprobe: isFile(ffprobe) ? ffprobe : '',
      source: c.source,
      encoders
    }
    return cached
  }
  cached = { available: false, ffmpeg: '', ffprobe: '', source: '', encoders: [], error: '未检测到 FFmpeg' }
  return cached
}

/** 保存用户手动选择的 ffmpeg 路径并重新探测。 */
export async function setFfmpegPath(p: string): Promise<FfmpegStatus> {
  mergeAndSaveSettings({ ffmpegPath: p })
  cached = null
  probeCache.clear()
  return getFfmpegStatus(true)
}

export function cancelCurrent(): void {
  if (currentProc) {
    try {
      currentProc.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
    currentProc = null
  }
}

/* ===== 探测 ===== */
const OK_CONTAINERS = ['mp4', 'mov', 'm4v', 'webm', 'ogg', 'oga', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'opus']
const OK_VIDEO = ['h264', 'vp8', 'vp9', 'av1']
const OK_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_u8', 'pcm_f32le', 'alac']

function isPlayable(container: string, vcodec: string, acodec: string, hasVideo: boolean, hasAudio: boolean): boolean {
  const conts = container.split(',').map((s) => s.trim())
  if (!conts.some((c) => OK_CONTAINERS.includes(c))) return false
  if (hasVideo && !OK_VIDEO.includes(vcodec)) return false
  if (hasAudio && acodec && !OK_AUDIO.includes(acodec)) return false
  return true
}

interface ProbeRaw {
  duration: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  container: string
  videoCodec?: string
  audioCodec?: string
}

function probeWithFfprobe(bin: string, input: string): Promise<ProbeRaw> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          const data = JSON.parse(String(stdout))
          const streams: Array<Record<string, unknown>> = Array.isArray(data.streams) ? data.streams : []
          const v = streams.find((s) => s.codec_type === 'video')
          const a = streams.find((s) => s.codec_type === 'audio')
          const fmt = (data.format || {}) as Record<string, unknown>
          const dur = Number(fmt.duration) || Number(v?.duration) || Number(a?.duration) || 0
          resolve({
            duration: Number.isFinite(dur) ? dur : 0,
            width: v ? Number(v.width) || undefined : undefined,
            height: v ? Number(v.height) || undefined : undefined,
            hasVideo: !!v,
            hasAudio: !!a,
            container: String(fmt.format_name || ''),
            videoCodec: v ? String(v.codec_name || '') : undefined,
            audioCodec: a ? String(a.codec_name || '') : undefined
          })
        } catch (e) {
          reject(e as Error)
        }
      }
    )
  })
}

function probeWithFfmpegInfo(bin: string, input: string): Promise<ProbeRaw> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-hide_banner', '-i', input], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (_err, _stdout, stderr) => {
      const text = String(stderr || '')
      const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      const duration = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 0
      const vMatch = text.match(/Stream #\d+:\d+(?:\([^)]*\))?: Video:\s*([a-zA-Z0-9_]+).*?(\d{2,5})x(\d{2,5})/)
      const aMatch = text.match(/Stream #\d+:\d+(?:\([^)]*\))?: Audio:\s*([a-zA-Z0-9_]+)/)
      const contMatch = text.match(/Input #0,\s*([^,]+),/)
      if (!vMatch && !aMatch) return reject(new Error('无法识别媒体流'))
      resolve({
        duration,
        width: vMatch ? Number(vMatch[2]) : undefined,
        height: vMatch ? Number(vMatch[3]) : undefined,
        hasVideo: !!vMatch,
        hasAudio: !!aMatch,
        container: contMatch ? contMatch[1].trim().toLowerCase() : '',
        videoCodec: vMatch ? vMatch[1] : undefined,
        audioCodec: aMatch ? aMatch[1] : undefined
      })
    })
  })
}

export async function probeMedia(input: string): Promise<EditorProbeResult> {
  const cachedProbe = probeCache.get(input)
  if (cachedProbe) return cachedProbe
  const status = await getFfmpegStatus()
  if (!status.available) {
    return { ok: false, path: input, duration: 0, hasVideo: false, hasAudio: false, container: '', playable: false, error: '未检测到 FFmpeg' }
  }
  if (!fs.existsSync(input)) {
    return { ok: false, path: input, duration: 0, hasVideo: false, hasAudio: false, container: '', playable: false, error: '文件不存在' }
  }
  try {
    const raw = status.ffprobe ? await probeWithFfprobe(status.ffprobe, input) : await probeWithFfmpegInfo(status.ffmpeg, input)
    const result: EditorProbeResult = {
      ok: true,
      path: input,
      duration: raw.duration,
      width: raw.width,
      height: raw.height,
      hasVideo: raw.hasVideo,
      hasAudio: raw.hasAudio,
      container: raw.container,
      videoCodec: raw.videoCodec,
      audioCodec: raw.audioCodec,
      playable: isPlayable(raw.container, raw.videoCodec || '', raw.audioCodec || '', raw.hasVideo, raw.hasAudio)
    }
    probeCache.set(input, result)
    return result
  } catch (e) {
    return { ok: false, path: input, duration: 0, hasVideo: false, hasAudio: false, container: '', playable: false, error: (e as Error).message }
  }
}

/* ===== 进程执行 ===== */
function runFfmpeg(
  bin: string,
  args: string[],
  onProgress?: (percent: number) => void,
  total = 0
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { windowsHide: true })
    currentProc = proc
    let stderr = ''
    let buf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        const m = line.match(/^out_time_(?:ms|us)=(\d+)/)
        if (m && total > 0 && onProgress) {
          onProgress(Math.min(99, (Number(m[1]) / 1e6 / total) * 100))
        }
        idx = buf.indexOf('\n')
      }
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 200000) stderr = stderr.slice(-100000)
    })
    proc.on('error', (e) => {
      currentProc = null
      resolve({ code: -1, stderr: String(e) })
    })
    proc.on('close', (code) => {
      currentProc = null
      resolve({ code: code ?? -1, stderr })
    })
  })
}

/* ===== 编码器选择 ===== */
interface EncoderOption {
  name: string
  args: string[]
}

function encoderChain(encoders: string[], quality: ExportQuality = 'medium'): EncoderOption[] {
  const settings =
    quality === 'high' ? { crf: 18, preset: 'medium' } : quality === 'fast' ? { crf: 24, preset: 'ultrafast' } : { crf: 21, preset: 'veryfast' }
  const chain: EncoderOption[] = []
  if (encoders.includes('libx264')) {
    chain.push({ name: 'libx264', args: ['-c:v', 'libx264', '-preset', settings.preset, '-crf', String(settings.crf), '-pix_fmt', 'yuv420p'] })
  }
  if (encoders.includes('h264_nvenc')) {
    chain.push({ name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(settings.crf + 2), '-b:v', '0', '-pix_fmt', 'yuv420p'] })
  }
  if (encoders.includes('h264_qsv')) {
    chain.push({ name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-global_quality', String(settings.crf + 2), '-pix_fmt', 'yuv420p'] })
  }
  if (encoders.includes('h264_amf')) {
    chain.push({ name: 'h264_amf', args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(settings.crf), '-qp_p', String(settings.crf + 2), '-pix_fmt', 'yuv420p'] })
  }
  if (encoders.includes('mpeg4')) chain.push({ name: 'mpeg4', args: ['-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p'] })
  if (!chain.length) chain.push({ name: 'h264', args: ['-c:v', 'h264', '-pix_fmt', 'yuv420p'] })
  return chain
}

/* ===== 转码代理 ===== */
export async function transcodeToProxy(
  input: string,
  mediaId: string,
  maxSize: number,
  onProgress: (e: EditorProgressEvent) => void
): Promise<{ proxyPath: string; proxyUrl: string; duration: number }> {
  const status = await getFfmpegStatus()
  if (!status.available) throw new Error('未检测到 FFmpeg')
  const probe = await probeMedia(input)
  const dir = path.join(app.getPath('userData'), 'edits', 'proxy')
  fs.mkdirSync(dir, { recursive: true })
  const safe = mediaId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const out = path.join(dir, `${safe}.mp4`)
  const cap = Math.max(480, Math.min(3840, Number(maxSize) || 1920))
  const base = [
    '-y',
    '-hide_banner',
    '-i',
    input,
    '-vf',
    `scale=${cap}:${cap}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-map',
    '0:v:0'
  ]
  if (probe.hasAudio) base.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k')
  else base.push('-an')
  base.push('-movflags', '+faststart')

  let lastErr = ''
  for (const enc of encoderChain(status.encoders, 'fast')) {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true })
    onProgress({ stage: 'transcode', percent: 0, message: `转码中（${enc.name}）` })
    const res = await runFfmpeg(status.ffmpeg, [...base, ...enc.args, out], (p) => onProgress({ stage: 'transcode', percent: p, message: `转码中（${enc.name}）` }), probe.duration)
    if (res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
      probeCache.delete(out)
      onProgress({ stage: 'transcode', percent: 100, message: '转码完成' })
      return { proxyPath: out, proxyUrl: pathToFileURL(out).href, duration: probe.duration }
    }
    lastErr = res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
  }
  throw new Error(`转码失败：${lastErr || '未知错误'}`)
}

/* ===== 缩略图 ===== */
export async function makeThumbnail(input: string, at = 0): Promise<string | null> {
  const status = await getFfmpegStatus()
  if (!status.available) return null
  const probe = await probeMedia(input)
  if (!probe.hasVideo) return null
  const dir = path.join(app.getPath('userData'), 'edits', 'thumbs')
  fs.mkdirSync(dir, { recursive: true })
  const key = `${input}::${Math.round(at * 10)}`
  const file = path.join(dir, `${Buffer.from(key).toString('hex').slice(0, 40)}.jpg`)
  if (!fs.existsSync(file)) {
    const res = await runFfmpeg(
      status.ffmpeg,
      ['-y', '-hide_banner', '-ss', String(Math.max(0, at)), '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', file],
      undefined,
      0
    )
    if (res.code !== 0 || !fs.existsSync(file)) return null
  }
  try {
    return 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64')
  } catch {
    return null
  }
}

/* ===== 时间线导出（filter_complex） ===== */
function atempoChain(speed: number): string {
  const parts: string[] = []
  let r = speed
  while (r > 2.0001) {
    parts.push('atempo=2')
    r /= 2
  }
  while (r < 0.4999) {
    parts.push('atempo=0.5')
    r /= 0.5
  }
  if (Math.abs(r - 1) > 0.001) parts.push(`atempo=${r.toFixed(4)}`)
  return parts.join(',')
}

/**
 * 把关键帧列表编译成 ffmpeg 表达式（变量名由调用方指定，如 t / T）。
 * 返回 null 表示没有关键帧。
 */
function kfExpr(kfs: EditKeyframe[] | undefined, varName = 't'): string | null {
  if (!kfs || !kfs.length) return null
  const list = [...kfs].sort((a, b) => a.t - b.t)
  const f = (n: number): string => n.toFixed(4)
  if (list.length === 1) return f(list[0].v)
  let expr = f(list[list.length - 1].v)
  for (let i = list.length - 2; i >= 0; i--) {
    const a = list[i]
    const b = list[i + 1]
    const span = Math.max(0.0001, b.t - a.t)
    const u = `min(1,max(0,(${varName}-${f(a.t)})/${f(span)}))`
    let eased = u
    if (a.e === 'easeIn') eased = `(${u})*(${u})`
    else if (a.e === 'easeOut') eased = `(1-(1-(${u}))*(1-(${u})))`
    else if (a.e === 'easeInOut') eased = `(${u})*(${u})*(3-2*(${u}))`
    const seg = `(${f(a.v)}+(${f(b.v)}-${f(a.v)})*(${eased}))`
    expr = `if(lt(${varName},${f(b.t)}),${seg},${expr})`
  }
  return `if(lt(${varName},${f(list[0].t)}),${f(list[0].v)},${expr})`
}

/** 单片段核心滤镜链（从 0 开始，未做时间线偏移与淡入淡出）。 */
function videoCoreChain(clip: EditClip, W: number, H: number): string {
  const parts: string[] = []
  const kfs = clip.keyframes
  const start = clip.inPoint
  const end = clip.inPoint + clip.duration * clip.speed
  parts.push(`trim=start=${start.toFixed(3)}:end=${end.toFixed(3)}`, `setpts=(PTS-STARTPTS)/${clip.speed}`)
  const rotExpr = kfExpr(kfs?.rotation)
  if (rotExpr) {
    parts.push(`rotate=angle='(${rotExpr})*PI/180':c=black@0`)
  } else if (clip.rotation === 90) parts.push('transpose=1')
  else if (clip.rotation === 270) parts.push('transpose=2')
  else if (clip.rotation === 180) parts.push('hflip', 'vflip')
  else if (Math.abs(clip.rotation) > 0.01) parts.push(`rotate=angle=${((clip.rotation * Math.PI) / 180).toFixed(4)}:c=black@0`)
  parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`, 'setsar=1')
  const f = clip.filter
  const bExpr = kfExpr(kfs?.brightness)
  const cExpr = kfExpr(kfs?.contrast)
  const sExpr = kfExpr(kfs?.saturate)
  const gExpr = kfExpr(kfs?.grayscale)
  if (bExpr || cExpr || sExpr || gExpr) {
    const brightness = bExpr ? `((${bExpr})-100)/100` : ((f.brightness - 100) / 100).toFixed(3)
    const contrast = cExpr ? `(${cExpr})/100` : (f.contrast / 100).toFixed(3)
    const saturate = `(${sExpr ? `(${sExpr})/100` : (f.saturate / 100).toFixed(3)})*(1-(${gExpr ? `(${gExpr})/100` : (f.grayscale / 100).toFixed(3)}))`
    parts.push(`eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturate}':eval=frame`)
  }
  if (f.blur > 0) parts.push(`gblur=sigma=${(f.blur / 2).toFixed(2)}`)
  const oExpr = kfExpr(kfs?.opacity, 'T')
  if (oExpr) {
    parts.push(
      'format=rgba',
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${oExpr})'`
    )
  } else if (clip.opacity < 0.999) {
    parts.push('format=rgba', `colorchannelmixer=aa=${clip.opacity.toFixed(3)}`)
  }
  return parts.join(',')
}

/** 在核心链后追加「时间线偏移 + 淡入淡出」，使其 PTS 落在片段实际时间线上。 */
function videoShiftAndFades(clip: EditClip, chain: string): string {
  const parts = [chain, `setpts=PTS+${clip.start.toFixed(3)}/TB`]
  if (clip.fadeIn > 0) parts.push(`fade=t=in:st=${clip.start.toFixed(3)}:d=${Math.min(clip.fadeIn, clip.duration).toFixed(3)}`)
  if (clip.fadeOut > 0) {
    parts.push(
      `fade=t=out:st=${(clip.start + Math.max(0, clip.duration - clip.fadeOut)).toFixed(3)}:d=${Math.min(clip.fadeOut, clip.duration).toFixed(3)}`
    )
  }
  return parts.join(',')
}

function audioFilterChain(clip: EditClip, hasDelay: boolean): string {
  const start = clip.inPoint
  const end = clip.inPoint + clip.duration * clip.speed
  const parts = [`atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)}`, 'asetpts=PTS-STARTPTS']
  const tempo = atempoChain(clip.speed)
  if (tempo) parts.push(tempo)
  const volExpr = kfExpr(clip.keyframes?.volume)
  if (clip.muted) parts.push('volume=0')
  else if (volExpr) parts.push(`volume=volume='(${volExpr})':eval=frame`)
  else parts.push(`volume=${Math.max(0, clip.volume).toFixed(3)}`)
  if (clip.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${Math.min(clip.fadeIn, clip.duration).toFixed(3)}`)
  if (clip.fadeOut > 0) parts.push(`afade=t=out:st=${Math.max(0, clip.duration - clip.fadeOut).toFixed(3)}:d=${Math.min(clip.fadeOut, clip.duration).toFixed(3)}`)
  if (hasDelay && clip.start > 0.001) parts.push(`adelay=${Math.round(clip.start * 1000)}:all=1`)
  return parts.join(',')
}

export async function exportTimeline(
  args: ExportTimelineArgs,
  outputPath: string,
  onProgress: (e: EditorProgressEvent) => void
): Promise<ExportTimelineResult> {
  const status = await getFfmpegStatus()
  if (!status.available) return { ok: false, error: '未检测到 FFmpeg' }
  const project = args.project
  const duration = Math.max(0.1, projectContentEnd(project))
  const W = Math.max(2, Math.round(args.width) & ~1)
  const H = Math.max(2, Math.round(args.height) & ~1)
  const fps = Math.max(1, Math.round(args.fps) || 30)

  const mediaById = new Map(project.media.map((m) => [m.id, m]))
  const trackById = new Map(project.tracks.map((t) => [t.id, t]))
  interface Resolved {
    clip: EditClip
    mediaPath: string
    probe: EditorProbeResult
    trackIndex: number
    videoVisible: boolean
    audioAudible: boolean
  }
  /** A/V 链接的视频片段：声音由链接的音频轨片段负责，避免导出时声音重复。 */
  const hasLinkedAudioClip = (clip: EditClip): boolean =>
    !!clip.linkId &&
    project.clips.some((c) => c.linkId === clip.linkId && c.id !== clip.id && trackById.get(c.trackId)?.kind === 'audio')
  const resolved: Resolved[] = []
  const probeByPath = new Map<string, EditorProbeResult>()
  for (const clip of project.clips) {
    const media = mediaById.get(clip.mediaId)
    const track = trackById.get(clip.trackId)
    if (!media || !track) continue
    let probe = probeByPath.get(media.path)
    if (!probe) {
      probe = await probeMedia(media.path)
      probeByPath.set(media.path, probe)
    }
    if (!probe.ok) continue
    resolved.push({
      clip,
      mediaPath: media.path,
      probe,
      trackIndex: project.tracks.findIndex((t) => t.id === track.id),
      videoVisible: track.kind === 'video' && !track.hidden && media.kind === 'video' && probe.hasVideo,
      audioAudible:
        !track.muted &&
        (track.kind !== 'video' || !track.hidden) &&
        probe.hasAudio &&
        (track.kind === 'audio' || !hasLinkedAudioClip(clip))
    })
  }
  const hasTextOverlay = project.clips.some((c) => !!c.text && !!args.textImages?.[c.id])
  if (!resolved.length && !hasTextOverlay) return { ok: false, error: '时间线没有可用片段' }

  // 统计每个素材需要 split 的份数（同一素材多片段时必须拆流）
  const vCount = new Map<string, number>()
  const aCount = new Map<string, number>()
  resolved.forEach((r) => {
    if (r.videoVisible) vCount.set(r.mediaPath, (vCount.get(r.mediaPath) || 0) + 1)
    if (r.audioAudible) aCount.set(r.mediaPath, (aCount.get(r.mediaPath) || 0) + 1)
  })

  const inputs: string[] = []
  const inputIndex = new Map<string, number>()
  let inputCount = 0
  const ensureInput = (p: string): number => {
    const found = inputIndex.get(p)
    if (found !== undefined) return found
    const idx = inputCount++
    inputIndex.set(p, idx)
    inputs.push('-i', p)
    return idx
  }
  /** 追加自定义输入（文字 PNG 用 -loop 1），返回输入序号。 */
  const pushCustomInput = (inputArgs: string[]): number => {
    const idx = inputCount++
    inputs.push(...inputArgs)
    return idx
  }

  const parts: string[] = []
  parts.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${duration.toFixed(3)}[base]`)

  const vLabels = new Map<string, string[]>()
  const aLabels = new Map<string, string[]>()
  for (const [p, count] of vCount) {
    const idx = ensureInput(p)
    if (count > 1) {
      const labels = Array.from({ length: count }, (_, i) => `vs${idx}_${i}`)
      parts.push(`[${idx}:v]split=${count}${labels.map((l) => `[${l}]`).join('')}`)
      vLabels.set(p, labels)
    } else {
      vLabels.set(p, [`${idx}:v`])
    }
  }
  for (const [p, count] of aCount) {
    const idx = ensureInput(p)
    if (count > 1) {
      const labels = Array.from({ length: count }, (_, i) => `as${idx}_${i}`)
      parts.push(`[${idx}:a]asplit=${count}${labels.map((l) => `[${l}]`).join('')}`)
      aLabels.set(p, labels)
    } else {
      aLabels.set(p, [`${idx}:a`])
    }
  }

  // ---- 视频：按轨道分段；带转场的相邻片段用 xfade 融合成一段再叠加 ----
  interface SegItem {
    clip: EditClip
    trackIndex: number
    mediaPath: string
  }
  const videoSegments: Array<{ label: string; start: number; end: number; trackIndex: number }> = []
  let segSeq = 0
  const trackIds = [...new Set(resolved.filter((r) => r.videoVisible).map((r) => r.clip.trackId))]
  for (const trackId of trackIds) {
    const items: SegItem[] = resolved
      .filter((r) => r.videoVisible && r.clip.trackId === trackId)
      .map((r) => ({ clip: r.clip, trackIndex: r.trackIndex, mediaPath: r.mediaPath }))
      .sort((a, b) => a.clip.start - b.clip.start)
    const segments: Array<{ items: SegItem[]; transitions: Array<EditTransition | undefined> }> = []
    for (const item of items) {
      const cur = segments[segments.length - 1]
      const prev = cur?.items[cur.items.length - 1]
      const tr = item.clip.transition
      const overlap = prev ? clipEnd(prev.clip) - item.clip.start : 0
      const usable = !!tr && !!prev && Math.abs(overlap - tr.duration) <= 0.08
      if (cur && prev && usable) {
        cur.items.push(item)
        cur.transitions.push(tr)
      } else {
        segments.push({ items: [item], transitions: [] })
      }
    }
    for (const seg of segments) {
      const srcs: string[] = []
      for (const it of seg.items) {
        const src = vLabels.get(it.mediaPath)?.shift()
        if (!src) break
        srcs.push(src)
      }
      if (srcs.length !== seg.items.length) continue
      if (seg.items.length === 1) {
        const label = `vseg${segSeq++}`
        parts.push(`[${srcs[0]}]${videoShiftAndFades(seg.items[0].clip, videoCoreChain(seg.items[0].clip, W, H))}[${label}]`)
        videoSegments.push({
          label,
          start: seg.items[0].clip.start,
          end: clipEnd(seg.items[0].clip),
          trackIndex: seg.items[0].trackIndex
        })
        continue
      }
      const labels: string[] = []
      seg.items.forEach((it, i) => {
        const label = `s${segSeq}_${i}`
        parts.push(`[${srcs[i]}]${videoCoreChain(it.clip, W, H)}[${label}]`)
        labels.push(label)
      })
      let acc = labels[0]
      let accDur = seg.items[0].clip.duration
      for (let i = 1; i < labels.length; i++) {
        const tr = seg.transitions[i - 1]
        const clip = seg.items[i].clip
        const d = Math.max(0.05, Math.min(Number(tr?.duration) || 0.5, accDur - 0.02, clip.duration - 0.02))
        const offset = Math.max(0.01, accDur - d)
        const xf = TRANSITIONS.find((x) => x.id === (tr?.type || 'dissolve'))?.xfade || 'dissolve'
        const out = `sx${segSeq}_${i}`
        parts.push(`[${acc}][${labels[i]}]xfade=transition=${xf}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`)
        acc = out
        accDur = offset + clip.duration
      }
      const label = `vseg${segSeq++}`
      const segStart = seg.items[0].clip.start
      parts.push(`[${acc}]setpts=PTS+${segStart.toFixed(3)}/TB[${label}]`)
      videoSegments.push({ label, start: segStart, end: segStart + accDur, trackIndex: seg.items[0].trackIndex })
    }
  }
  // 底层先叠，索引小的轨道最后叠（显示在最上层）
  videoSegments.sort((a, b) => b.trackIndex - a.trackIndex)
  let baseLabel = 'base'
  videoSegments.forEach((v, i) => {
    const out = `ov${i}`
    const s = v.start.toFixed(3)
    const e = v.end.toFixed(3)
    parts.push(`[${baseLabel}][${v.label}]overlay=x=0:y=0:enable='between(t,${s},${e})'[${out}]`)
    baseLabel = out
  })

  // 文字 / 字幕：透明 PNG 叠在最上层，按时间窗显示
  const textClips = project.clips
    .filter((c) => !!c.text && !!args.textImages?.[c.id] && fs.existsSync(args.textImages[c.id]))
    .sort((a, b) => a.start - b.start)
  textClips.forEach((clip, i) => {
    const png = args.textImages?.[clip.id] as string
    const idx = pushCustomInput(['-loop', '1', '-framerate', String(fps), '-i', png])
    const s = clip.start.toFixed(3)
    const e = clipEnd(clip).toFixed(3)
    const chain: string[] = ['format=rgba', `scale=${W}:${H}`, `setpts=PTS-STARTPTS+${s}/TB`]
    if (clip.fadeIn > 0) chain.push(`fade=t=in:st=${s}:d=${Math.min(clip.fadeIn, clip.duration).toFixed(3)}`)
    if (clip.fadeOut > 0) {
      chain.push(`fade=t=out:st=${Math.max(clip.start, clipEnd(clip) - clip.fadeOut).toFixed(3)}:d=${Math.min(clip.fadeOut, clip.duration).toFixed(3)}`)
    }
    if (clip.opacity < 0.999) chain.push(`colorchannelmixer=aa=${clip.opacity.toFixed(3)}`)
    const label = `tx${i}`
    parts.push(`[${idx}:v]${chain.join(',')}[${label}]`)
    const out = `tt${i}`
    parts.push(`[${baseLabel}][${label}]overlay=x=0:y=0:enable='between(t,${s},${e})'[${out}]`)
    baseLabel = out
  })

  parts.push(`[${baseLabel}]format=yuv420p[vout]`)

  const audioUse: string[] = []
  let aSeq = 0
  for (const r of resolved) {
    if (!r.audioAudible) continue
    const src = aLabels.get(r.mediaPath)?.shift()
    if (!src) continue
    const label = `a${aSeq++}`
    parts.push(`[${src}]${audioFilterChain(r.clip, true)}[${label}]`)
    audioUse.push(label)
  }
  if (audioUse.length === 1) parts.push(`[${audioUse[0]}]anull[aout]`)
  else if (audioUse.length > 1) parts.push(`${audioUse.map((l) => `[${l}]`).join('')}amix=inputs=${audioUse.length}:normalize=0:duration=longest[aout]`)

  const graph = parts.join(';')
  const tmpOut = outputPath + '.part.mp4'
  if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut, { force: true })

  let lastErr = ''
  for (const enc of encoderChain(status.encoders, args.quality || 'medium')) {
    const cmd = ['-y', '-hide_banner', '-progress', 'pipe:1', '-nostats', ...inputs, '-filter_complex', graph, '-map', '[vout]']
    if (audioUse.length) cmd.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
    else cmd.push('-an')
    cmd.push(...enc.args)
    if (args.videoBitrate && args.videoBitrate > 0) cmd.push('-b:v', `${Math.round(args.videoBitrate)}k`, '-maxrate', `${Math.round(args.videoBitrate * 1.5)}k`, '-bufsize', `${Math.round(args.videoBitrate * 2)}k`)
    cmd.push('-movflags', '+faststart', '-t', duration.toFixed(3), tmpOut)
    onProgress({ stage: 'export', percent: 0, message: `导出中（${enc.name}）` })
    const res = await runFfmpeg(status.ffmpeg, cmd, (p) => onProgress({ stage: 'export', percent: p, message: `导出中（${enc.name}）` }), duration)
    if (res.code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0) {
      try {
        if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true })
        fs.renameSync(tmpOut, outputPath)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      onProgress({ stage: 'done', percent: 100, message: '导出完成' })
      return { ok: true, path: outputPath }
    }
    lastErr = res.stderr.split(/\r?\n/).filter((l) => /error|invalid|failed|no such|not found/i.test(l)).slice(-3).join(' | ') || res.stderr.slice(-400)
  }
  if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut, { force: true })
  return { ok: false, error: `导出失败：${lastErr || '未知错误'}` }
}
