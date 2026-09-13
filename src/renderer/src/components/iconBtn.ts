/**
 * 渲染层 · 通用图标按钮（悬停操作条按钮）
 */
export function iconBtn(svg: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'icon-btn'
  b.innerHTML = svg
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}