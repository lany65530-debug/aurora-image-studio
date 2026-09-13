/**
 * 渲染层 · 自绘确认弹窗（替代原生 confirm）
 */
import { $ } from '../state/store'

let _confirmResolve: ((v: boolean) => void) | null = null

export function confirmDialog(title: string, message: string, okText = '确认'): Promise<boolean> {
  return new Promise((resolve) => {
    _confirmResolve = resolve
    $('#confirmTitle').textContent = title || '确认操作'
    $('#confirmMsg').textContent = message || ''
    $('#confirmOkBtn').textContent = okText || '确认'
    openConfirm()
    ;($('#confirmOkBtn') as HTMLButtonElement).focus()
  })
}

function openConfirm(): void {
  $('#confirmModal').classList.add('open')
}

function closeConfirm(result: boolean): void {
  const overlay = $('#confirmModal')
  if (overlay.classList.contains('open')) overlay.classList.remove('open')
  if (_confirmResolve) {
    _confirmResolve(result)
    _confirmResolve = null
  }
}

// 事件绑定（单例，模块加载时执行一次）
$('#confirmOkBtn').addEventListener('click', () => closeConfirm(true))
$('#confirmCancelBtn').addEventListener('click', () => closeConfirm(false))
$('#confirmModal').addEventListener('mousedown', (e) => {
  if (e.target === $('#confirmModal')) closeConfirm(false)
})

/** Escape 关闭确认弹窗（由全局键盘处理调用）。 */
export function closeConfirmEsc(): void {
  const overlay = $('#confirmModal')
  if (overlay.classList.contains('open')) closeConfirm(false)
}