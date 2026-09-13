/**
 * 渲染层 · 生成进度卡片（skel/加载中骨架）
 * 由 doGenerate 创建，切换工作区再切回时经瞬态重新附着。
 */

export interface ProgressCardHandle {
  el: HTMLDivElement
  done: boolean
  setPhase: (t: string) => void
  setTime: (t: string) => void
  setPercent: (p: number) => void
  setIndeterminate: () => void
}

export function buildProgressCard(shapeClass: string, index: number): ProgressCardHandle {
  const el = document.createElement('div')
  el.className = 'progress-card ' + shapeClass
  el.style.animationDelay = `${index * 0.08}s`
  el.innerHTML = `
    <div class="pc-shimmer"></div>
    <div class="pc-body">
      <div class="pc-spinner"><span></span><span></span><span></span></div>
      <div class="pc-phase">准备中</div>
      <div class="pc-time">0.0s</div>
      <div class="pc-bar"><i class="pc-bar-fill indeterminate"></i></div>
    </div>`
  const phaseEl = el.querySelector('.pc-phase') as HTMLElement
  const timeEl = el.querySelector('.pc-time') as HTMLElement
  const fill = el.querySelector('.pc-bar-fill') as HTMLElement
  return {
    el,
    done: false,
    setPhase: (t) => {
      phaseEl.textContent = t
    },
    setTime: (t) => {
      timeEl.textContent = t
    },
    setPercent: (p) => {
      fill.classList.remove('indeterminate')
      fill.style.width = p + '%'
    },
    setIndeterminate: () => {
      fill.classList.add('indeterminate')
      fill.style.width = ''
    }
  }
}