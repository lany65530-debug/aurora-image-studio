/**
 * 渲染层 · 图片 Lightbox 大图预览
 * 模块加载时完成 DOM 事件绑定，导出开启 / 关闭供业务调用。
 */
import { $ } from '../state/store'

export function openLightbox(src: string): void {
  ($('#lightboxImg') as HTMLImageElement).src = src
  $('#lightbox').classList.add('open')
}

export function closeLightbox(): void {
  $('#lightbox').classList.remove('open')
}

// 事件绑定（单例，模块加载时执行一次）
$('#lightboxClose').addEventListener('click', closeLightbox)
$('#lightbox').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'lightbox') closeLightbox()
})