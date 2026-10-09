import { describe, it, expect } from 'vitest'
import { progressStats } from './progress'

// PRD S42-1（v0.44）— 进度统计纯函数：按状态计数 + 完成百分比 + 逾期计数。
// 逾期口径取后端 isOverdue（BJ_TODAY），前端不另算（S19/K23）。

describe('S42 progressStats 进度统计纯函数', () => {
  it('S42-1: 按状态计数 + 完成百分比（完成/总数，四舍五入整数）+ 逾期计数', () => {
    const s = progressStats([
      { status: 'done', isOverdue: false },
      { status: 'done', isOverdue: false },
      { status: 'doing', isOverdue: true }, // 逾期与状态并存，双口径各计
      { status: 'doing', isOverdue: false },
      { status: 'todo', isOverdue: false },
    ])
    expect(s.total).toBe(5)
    expect(s.done).toBe(2)
    expect(s.doing).toBe(2)
    expect(s.todo).toBe(1)
    expect(s.overdue).toBe(1)
    expect(s.donePct).toBe(40)
  })

  it('S42-1: 完成百分比四舍五入为整数（1/3 → 33）', () => {
    const s = progressStats([
      { status: 'done', isOverdue: false },
      { status: 'doing', isOverdue: false },
      { status: 'todo', isOverdue: false },
    ])
    expect(s.donePct).toBe(33)
  })

  it('S42-1: 空任务清单返回零值（页面不 crash）', () => {
    expect(progressStats([])).toEqual({ total: 0, done: 0, doing: 0, todo: 0, overdue: 0, donePct: 0 })
  })

  it('S42-1: 未知状态值不计入任何分桶但计入总数（枚举漂移防御）', () => {
    const s = progressStats([{ status: 'blocked', isOverdue: false }, { status: 'done', isOverdue: false }])
    expect(s.total).toBe(2)
    expect(s.done).toBe(1)
    expect(s.donePct).toBe(50)
  })
})
