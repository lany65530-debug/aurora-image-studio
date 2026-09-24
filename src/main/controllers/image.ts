import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/ipc'
import { loadSettings } from '../services/settings'
import { resolveProvider } from '../services/provider'
import { isTransparentPng, persistImages } from '../services/download'
import { renderTemplate, getPath, parseJsonTemplate, isImageModel, joinUrl } from '../common/utils'
import {
  runChatImages,
  runImageCall,
  runImagesByCount
} from '../services/image-service'
import { PROVIDER_PRESETS, resolvePixelSize, type ProviderGenerate } from '../config'
import { downloadBuffer, requestJson, throwIfAborted, uploadToHost } from '../common/http'
import { notify } from '../window-store'

// jobId -> AbortController，支持取消进行中的生图任务
const imageJobControllers = new Map<string, AbortController>()

type Emit = (phase: string, data?: Record<string, unknown>) => void

function makeEmit(jobId: string): Emit {
  return (phase, data) => {
    notify(IPC.Events.imageProgress, Object.assign({ jobId, phase }, data || {}))
  }
}

function requireApiKey(provider: { apiKey: string }): { ok: false; error: string } | null {
  if (!provider.apiKey) return { ok: false, error: '未配置 API Key，请先在设置中填写。' }
  return null
}

function transparentSize(model: string, size: string, resolution: string): string {
  if (!/^gpt-image-1(?:\.5)?$/.test(model)) return resolvePixelSize(size, resolution)
  const dimensions = /^\d+x\d+$/.test(size) ? size.split('x') : size.split(':')
  const ratio = Number(dimensions[0]) / Number(dimensions[1])
  return ratio > 1 ? '1536x1024' : ratio < 1 ? '1024x1536' : '1024x1024'
}

async function prepareImages(images: Array<{ type: 'url' | 'b64'; value: string }>, baseUrl: string, signal: AbortSignal, emit: Emit, transparentBackground = false) {
  const prepared: Array<{ type: 'b64'; value: string }> = []
  for (const image of images) {
    throwIfAborted(signal)
    if (image.type === 'b64' || /^data:/i.test(image.value)) {
      if (transparentBackground) {
        const data = image.value.replace(/^data:[^,]*,/, '')
        if (!isTransparentPng(Buffer.from(data, 'base64'))) throw new Error('接口返回的图片不是含透明像素的 PNG，未保存该批结果。')
      }
      prepared.push({ type: 'b64', value: image.value })
      continue
    }
    const url = new URL(image.value, baseUrl).href
    const onProgress = (data: { received: number; total: number }) => emit('downloading', data)
    let buffer: Buffer
    try {
      buffer = await downloadBuffer(url, onProgress, { signal })
    } catch (err) {
      throwIfAborted(signal)
      if (!baseUrl) throw err
      buffer = await downloadBuffer(url, onProgress, { signal, headers: { Referer: baseUrl } })
    }
    if (!buffer.length) throw new Error('图片下载为空')
    if (transparentBackground && !isTransparentPng(buffer)) throw new Error('接口返回的图片不是含透明像素的 PNG，未保存该批结果。')
    prepared.push({ type: 'b64', value: buffer.toString('base64') })
  }
  throwIfAborted(signal)
  return prepared
}

export function registerImageIpc(): void {
  ipcMain.on(IPC.Image.stop, (_e, jobId: string) => {
    const c = imageJobControllers.get(jobId)
    if (c) c.abort()
  })

  ipcMain.handle(IPC.Image.generate, async (_e, params) => {
    params = params || {}
    const jobId = params.jobId || randomUUID()
    if (imageJobControllers.has(jobId)) return { ok: false, error: '任务 ID 已在使用中' }
    const aborter = new AbortController()
    imageJobControllers.set(jobId, aborter)
    const emit = makeEmit(jobId)

    try {
      const settings = loadSettings()
      const provider = resolveProvider(settings, params)
      const noKey = requireApiKey(provider)
      if (noKey) return noKey

      const cfg = provider.generate as ProviderGenerate
      if (!cfg) return { ok: false, error: '当前接口未配置"文生图"请求。' }

      const vars: Record<string, any> = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: params.model || settings.model || (params.engine === 'banana' ? 'nano-banana' : 'gpt-image-2'),
        prompt: params.prompt || '',
        n: params.n || 1,
        size: params.size || '1:1',
        resolution: params.resolution || '2k',
        group: params.group || '',
        images: [],
        imagesFirst: '',
        sizePx: resolvePixelSize(params.size || '1:1', params.resolution || '2k')
      }

      const bananaStyle = params.engine === 'banana' || /banana|gemini/i.test(String(vars.model))
      if (params.transparentBackground) {
        vars.transparentBackground = true
        vars.sizePx = transparentSize(vars.model, vars.size, vars.resolution)
      }
      const images = bananaStyle
        ? await runChatImages(provider, vars.model, params.prompt, [], emit, aborter.signal, { size: vars.size, resolution: params.resolution || '2k', transparentBackground: vars.transparentBackground }, vars.n)
        : vars.n > 1
          ? await runImagesByCount(provider, cfg, vars, emit, aborter.signal, vars.n)
          : (await runImageCall(provider, cfg, vars, emit, aborter.signal)).images

      if (images.length === 0) {
        emit('error', { error: '接口未返回图片数据。' })
        return { ok: false, error: '接口未返回图片数据。' }
      }

      emit('saving')
      const prepared = await prepareImages(images, provider.baseUrl, aborter.signal, emit, vars.transparentBackground)
      const savedImages = await persistImages(prepared, {
        saveDir: params.saveDir || settings.saveDir || '',
        baseUrl: provider.baseUrl,
        prompt: params.prompt,
        model: vars.model,
        size: vars.size,
        resolution: params.resolution || '2k',
        mode: params.mode || 'generate',
        wsId: params.wsId || '',
        transparentBackground: vars.transparentBackground
      }, emit)
      throwIfAborted(aborter.signal)
      savedImages.forEach((image, index) => {
        if (images[index].type === 'url' && !/^data:/i.test(images[index].value)) image.remoteUrl = images[index].value
      })
      emit('done', { count: savedImages.length })
      return { ok: true, images: savedImages }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      emit('error', { error: msg })
      return { ok: false, error: msg }
    } finally {
      if (imageJobControllers.get(jobId) === aborter) imageJobControllers.delete(jobId)
    }
  })

  ipcMain.handle(IPC.Image.edit, async (_e, params) => {
    params = params || {}
    const jobId = params.jobId || randomUUID()
    if (imageJobControllers.has(jobId)) return { ok: false, error: '任务 ID 已在使用中' }
    const aborter = new AbortController()
    imageJobControllers.set(jobId, aborter)
    const emit = makeEmit(jobId)

    try {
      const settings = loadSettings()
      const provider = resolveProvider(settings, params)
      const noKey = requireApiKey(provider)
      if (noKey) return noKey
      if (!Array.isArray(params.images) || !params.images.length) {
        return { ok: false, error: '请先上传至少一张参考图。' }
      }

      let cfg = (provider.edit as ProviderGenerate) || null
      if (!cfg) {
        // fall back to generate config, inject images into body via template
        cfg = Object.assign({}, provider.generate, { images: 'url' }) as ProviderGenerate
      }

      const model = params.model || settings.model || 'gpt-image-2'
      const size = params.size || '1:1'

      // nano-banana / gemini 系模型的 /v1/images/edits 仅支持 multipart 文件上传格式
      if (/banana|gemini/i.test(String(model))) {
        cfg = {
          method: 'POST',
          path: (provider.edit && provider.edit.path) || '/v1/images/edits',
          images: 'file',
          form: { model: '{{model}}', prompt: '{{prompt}}', n: '{{n}}', size: '{{sizePx}}' },
          imagesPath: (provider.edit && provider.edit.imagesPath) || 'data',
          urlField: (provider.edit && provider.edit.urlField) || 'url',
          b64Field: (provider.edit && provider.edit.b64Field) || 'b64_json',
          binary: false,
          async: { enabled: false }
        }
      }

      // 兜底回退到 generate 配置时，需确认该配置能否真正把参考图送进请求
      const canInjectRefs = (c: ProviderGenerate) => {
        const IMG = /\{\{images(?=[:_}])/
        const body = String(c.body || '')
        if (IMG.test(body)) return true
        const form = c.form
        const formImg = (form && Object.keys(form).some((k) => IMG.test(String(form[k])))) || false
        if (formImg) return true
        if (c.images === 'file') return true
        return false
      }
      if (params.engine !== 'banana' && !canInjectRefs(cfg)) {
        const pname = (provider as any).preset || provider.name || '当前接口'
        const err = `当前接口（${pname}）未配置图生图（edit）能力，参考图会被忽略。请在该接口配置中新增 edit 请求，或改用支持图生图的接口后再编辑图片。`
        emit('error', { error: err })
        return { ok: false, error: err }
      }

      // normalize reference images into the mode the API wants
      const refMode = params.engine === 'banana' || cfg.images === 'b64' || cfg.images === 'dataurl' || cfg.images === 'file' ? 'b64' : 'url'
      const refImages: string[] = []
      for (let i = 0; i < params.images.length && refImages.length < 15; i++) {
        throwIfAborted(aborter.signal)
        const im = params.images[i]
        if (!im || typeof im !== 'object') throw new Error('参考图格式无效')
        const remote = im.url && /^https?:\/\//i.test(im.url) ? im.url : im.dataUrl && /^https?:\/\//i.test(im.dataUrl) ? im.dataUrl : ''
        if (refMode === 'b64') {
          if (im.dataUrl && /^data:/.test(im.dataUrl)) refImages.push(im.dataUrl)
          else if (remote) refImages.push(remote)
        } else {
          if (remote) refImages.push(remote)
          else if (im.dataUrl) {
            emit('uploading', { index: i + 1, count: params.images.length })
            const url = await uploadToHost(im.dataUrl, im.name, provider.refHosts, { allowPublicUpload: provider.allowPublicUpload, signal: aborter.signal })
            refImages.push(url)
          }
        }
      }

      if (!refImages.length) {
        emit('error', { error: '没有可用的参考图（请确保图床可用，或改用图片链接）。' })
        return { ok: false, error: '没有可用的参考图（请确保图床可用，或改用图片链接）。' }
      }

      const vars = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
        prompt: params.prompt || '',
        n: params.n || 1,
        size,
        sizePx: params.transparentBackground ? transparentSize(model, size, params.resolution || '2k') : resolvePixelSize(size, params.resolution || '2k'),
        resolution: params.resolution || '2k',
        group: params.group || '',
        images: refImages,
        imagesFirst: refImages[0] || '',
        transparentBackground: params.transparentBackground === true
      }

      const images = params.engine === 'banana'
        ? await runChatImages(provider, model, params.prompt, refImages, emit, aborter.signal, { size, resolution: params.resolution || '2k', transparentBackground: params.transparentBackground === true }, params.n || 1)
        : (params.n || 1) > 1
          ? await runImagesByCount(provider, cfg, vars, emit, aborter.signal, params.n || 1)
          : (await runImageCall(provider, cfg, vars, emit, aborter.signal)).images

      if (images.length === 0) {
        emit('error', { error: '接口未返回图片数据。' })
        return { ok: false, error: '接口未返回图片数据。' }
      }

      emit('saving')
      const prepared = await prepareImages(images, provider.baseUrl, aborter.signal, emit, vars.transparentBackground)
      const savedImages = await persistImages(prepared, {
        saveDir: params.saveDir || settings.saveDir || '',
        baseUrl: provider.baseUrl,
        prompt: params.prompt,
        model,
        size,
        resolution: params.resolution || '2k',
        mode: params.mode || 'edit',
        wsId: params.wsId || '',
        transparentBackground: vars.transparentBackground
      }, emit)
      throwIfAborted(aborter.signal)
      savedImages.forEach((image, index) => {
        if (images[index].type === 'url' && !/^data:/i.test(images[index].value)) image.remoteUrl = images[index].value
      })
      emit('done', { count: savedImages.length })
      return { ok: true, images: savedImages }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      emit('error', { error: msg })
      return { ok: false, error: msg }
    } finally {
      if (imageJobControllers.get(jobId) === aborter) imageJobControllers.delete(jobId)
    }
  })

  // ---- List available channels / models (fully provider-driven) ----
  ipcMain.handle(IPC.Image.modelsList, async (_e, params) => {
    const settings = loadSettings()
    const provider = resolveProvider(settings, params)
    const apiKey = provider.apiKey

    if (!apiKey) return { ok: false, error: '未配置 API Key，请先填写。' }

    const cfg = provider.models
    if (!cfg) return { ok: false, error: '当前接口未启用"渠道列表"功能，请手动填写模型名。' }

    const endpoint = joinUrl(provider.baseUrl, renderTemplate(cfg.path || '/v1/models', { baseUrl: provider.baseUrl, apiKey: provider.apiKey }))
    try {
      const resp = await requestJson(
        endpoint,
        {
          method: cfg.method || 'GET',
          headers: Object.assign(
            { Authorization: `Bearer ${apiKey}` },
            (typeof cfg.headers === 'string' ? parseJsonTemplate(cfg.headers, { baseUrl: provider.baseUrl, apiKey: provider.apiKey }) : {}) || {}
          )
        },
        null
      )
      if (!resp.ok) {
        const msg =
          (resp.data && (resp.data.error?.message || resp.data.message)) ||
          `获取渠道失败 (HTTP ${resp.status})`
        return { ok: false, error: msg, status: resp.status, raw: resp.raw }
      }
      const listPath = cfg.listPath || 'data'
      const rawList = resp.data ? getPath(resp.data, listPath) : null
      const list = rawList || (Array.isArray(resp.data) ? resp.data : [])
      const idField = cfg.idField || 'id'
      const ownerField = cfg.ownerField || 'owned_by'
      const models = (Array.isArray(list) ? list : [])
        .map((m: any) => {
          if (typeof m === 'string') return { id: m, owned_by: '' }
          if (m && typeof m === 'object') {
            const id = getPath(m, idField) || m.id
            if (!id) return null
            return { id: String(id), owned_by: getPath(m, ownerField) || m.owned_by || m.owner || '' }
          }
          return null
        })
        .filter(Boolean)
        .map((m: any) => Object.assign(m, { image: isImageModel(m.id) }))

      models.sort((a: any, b: any) => a.id.localeCompare(b.id))
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })

  // ---- List usable groups / channels (fully provider-driven, e.g. new-api /api/pricing) ----
  ipcMain.handle(IPC.Image.groupsList, async (_e, params) => {
    const settings = loadSettings()
    const provider = resolveProvider(settings, params)
    const apiKey = provider.apiKey

    if (!apiKey) return { ok: false, error: '未配置 API Key，请先填写。' }

    const cfg = provider.groups as any
    if (!cfg) return { ok: false, error: '当前接口未启用"分组查询"，该中转站可能不支持分组。' }

    const vars = { baseUrl: provider.baseUrl, apiKey: provider.apiKey }
    const candidates = Array.isArray(cfg.paths) && cfg.paths.length ? cfg.paths : [cfg.path || '/api/pricing']
    let data: any = null
    let lastErr = ''

    for (const p of candidates) {
      try {
        const resp = await requestJson(
          joinUrl(provider.baseUrl, renderTemplate(p, vars)),
          {
            method: cfg.method || 'GET',
            headers: Object.assign(
              {
                Authorization: `Bearer ${apiKey}`,
                'New-Api-User': '1',
                'User-Agent': 'Mozilla/5.0 AuroraImageStudio',
                Accept: 'application/json'
              },
              (typeof cfg.headers === 'string' ? parseJsonTemplate(cfg.headers, vars) : {}) || {}
            )
          },
          null
        )
        if (resp.ok && resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
          data = resp.data
          break
        }
        lastErr = `HTTP ${resp.status}`
      } catch (e) {
        lastErr = (e as Error).message || String(e)
      }
    }

    if (!data) {
      return { ok: false, error: '无法获取分组信息（' + (lastErr || '接口不可用') + '）。该中转站可能不支持分组查询。' }
    }

    const groupSet = new Map<string, { id: string; name: string; ratio: any }>()
    const addGroup = (id: any, name: any, ratio: any) => {
      if (id === undefined || id === null || id === '') return
      const key = String(id)
      if (!groupSet.has(key)) {
        groupSet.set(key, { id: key, name: name ? String(name) : key, ratio: ratio != null ? ratio : null })
      }
    }

    const groupRatio: any = getPath(data, cfg.groupsPath || 'group_ratio') || {}
    const usable: any = getPath(data, cfg.groupNamePath || 'usable_group') || {}
    const modelListPath = cfg.modelGroupsPath || 'data.data'
    const modelList = getPath(data, modelListPath) || (Array.isArray(data.data) ? data.data : [])
    const listField = cfg.modelGroupListField || 'enable_groups'

    if (usable && typeof usable === 'object' && !Array.isArray(usable)) {
      Object.keys(usable).forEach((k) => addGroup(k, usable[k], groupRatio[k]))
    } else if (groupRatio && typeof groupRatio === 'object' && !Array.isArray(groupRatio)) {
      Object.keys(groupRatio).forEach((k) => addGroup(k, k, groupRatio[k]))
    }

    const modelGroups: Record<string, string[]> = Object.create(null)
    if (Array.isArray(modelList)) {
      modelList.forEach((m: any) => {
        const mid = m && (m.model_name || m.model || m.id)
        if (!mid) return
        const eg = m[listField] || m.enable_groups || m.groups || m.enable_group || []
        if (Array.isArray(eg)) {
          eg.forEach((g: any) => addGroup(g, usable[g] || g, groupRatio[g]))
          modelGroups[String(mid)] = eg.map(String)
        }
      })
    }

    const groups = Array.from(groupSet.values())
    return { ok: true, groups, modelGroups, raw: { hasUsable: !!Object.keys(usable || {}).length } }
  })
}

// ---- Provider presets & test ----
export function registerProviderIpc(): void {
  ipcMain.handle(IPC.Provider.presets, () => {
    const out: Record<string, any> = {}
    Object.keys(PROVIDER_PRESETS).forEach((key) => {
      out[key] = Object.assign({ id: key }, PROVIDER_PRESETS[key])
    })
    return { ok: true, presets: out }
  })

  ipcMain.handle(IPC.Provider.test, async (_e, params) => {
    const settings = loadSettings()
    const provider = resolveProvider(settings, params)
    if (!provider.apiKey) return { ok: false, error: '未配置 API Key。' }

    const modelsCfg = provider.models || { path: '/v1/models' }
    const endpoint = joinUrl(
      provider.baseUrl,
      renderTemplate((modelsCfg as any).path || '/v1/models', { baseUrl: provider.baseUrl, apiKey: provider.apiKey })
    )
    try {
      const resp = await requestJson(
        endpoint,
        { method: 'GET', headers: { Authorization: `Bearer ${provider.apiKey}` } },
        null
      )
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          return { ok: false, error: `密钥无效或无权限 (HTTP ${resp.status})` }
        }
        const msg =
          (resp.data && (resp.data.error?.message || resp.data.message)) ||
          (resp.raw && resp.raw.trim().slice(0, 200)) ||
          `HTTP ${resp.status}`
        return { ok: false, error: `HTTP ${resp.status}：${msg}` }
      }
      const d = resp.data || {}
      const list = Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : []
      return { ok: true, count: list.length }
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) }
    }
  })
}
