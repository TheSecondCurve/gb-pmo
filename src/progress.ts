// S42（v0.44）进度统计纯函数：由任务清单纯前端派生；逾期口径取后端 isOverdue（BJ_TODAY），
// 前端不另算（S19/K23）。渲染层（ProjectDetail 进度与排期卡）只消费结果。

export interface ProgressStats {
  total: number
  done: number
  doing: number
  todo: number
  overdue: number // 与状态并存的双口径：逾期任务同时属于 todo/doing 之一
  donePct: number // 完成/总数，四舍五入整数；空清单=0
}

export function progressStats(tasks: Array<{ status: string; isOverdue?: boolean }>): ProgressStats {
  const s: ProgressStats = { total: tasks.length, done: 0, doing: 0, todo: 0, overdue: 0, donePct: 0 }
  for (const t of tasks) {
    if (t.status === 'done') s.done++
    else if (t.status === 'doing') s.doing++
    else if (t.status === 'todo') s.todo++
    // 未知状态值计入总数但不进分桶（枚举漂移防御，进度条分段允许不足 100%）
    if (t.isOverdue) s.overdue++
  }
  s.donePct = s.total === 0 ? 0 : Math.round((s.done / s.total) * 100)
  return s
}

// S41（v0.44，K23）：任务行/甘特条的视觉桶——逾期红优先于状态色；未知状态归 todo 桶（muted 呈现）。
export type TaskVisual = 'overdue' | 'doing' | 'done' | 'todo'

export function taskVisual(t: { status: string; isOverdue?: boolean }): TaskVisual {
  if (t.isOverdue) return 'overdue'
  return t.status === 'doing' || t.status === 'done' ? t.status : 'todo'
}

/** 任务行整行浅底色（ProjectDetail 任务面）：todo 无底色保留 hover 反馈，其余状态各自浅底 */
export const TASK_ROW_CLS: Record<TaskVisual, string> = {
  todo: 'hover:bg-[var(--color-bg)]',
  doing: 'bg-[var(--color-brand-soft)]',
  done: 'bg-green-50',
  overdue: 'bg-red-50',
}
