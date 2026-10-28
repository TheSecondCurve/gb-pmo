// @vitest-environment jsdom
// S69（v0.80，K64）前端冒烟：常态项目周视图 DailyWeekGrid——周格子矩阵渲染、不适用格置灰、
// 就地打卡调用与周切换；WeekdayPicker 星期勾选。api 层 mock（组件冒烟不设标准层）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import DailyWeekGrid, { WeekdayPicker } from './components/DailyWeekGrid'
import { StoreProvider } from './store'
import { api } from './api'
import type { DailyBoardData } from './types'

vi.mock('./api', () => ({
  api: {
    me: vi.fn(async () => ({ member: { id: 1, name: '甲', role: 'admin' } })),
    dailyBoard: vi.fn(),
    setDayStatus: vi.fn(async () => ({ day: '2026-10-26', status: 'done', eventId: 1 })),
  },
}))

const MONDAY = '2026-10-26' // 周一
const board = (over: Partial<DailyBoardData> = {}): DailyBoardData => ({
  projectId: 1,
  weekStart: MONDAY,
  weekEnd: '2026-11-01',
  days: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
  tasks: [
    {
      taskId: 11, title: '看资讯', note: null, weekdays: [1, 2, 3, 4, 5, 6, 7], weekdaysLabel: '每天',
      responsibleMemberId: 2, responsibleName: '李四',
      cells: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].map((day) => ({
        day, applicable: true, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null,
      })),
      weekApplicable: 7, weekDone: 0,
    },
    {
      taskId: 12, title: '周报整理', note: null, weekdays: [1, 3, 5], weekdaysLabel: '每周一、三、五',
      responsibleMemberId: null, responsibleName: null,
      cells: [
        { day: '2026-10-26', applicable: true, status: 'done', note: '初稿', operatorMemberId: 1, operatorName: '甲', source: 'web', updatedAt: 1 },
        { day: '2026-10-27', applicable: false, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null },
        { day: '2026-10-28', applicable: true, status: 'skip', note: null, operatorMemberId: 1, operatorName: '甲', source: 'bot', updatedAt: 1 },
        { day: '2026-10-29', applicable: false, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null },
        { day: '2026-10-30', applicable: true, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null },
        { day: '2026-10-31', applicable: false, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null },
        { day: '2026-11-01', applicable: false, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null },
      ],
      weekApplicable: 3, weekDone: 1,
    },
  ],
  summary: { tasks: 2, applicableCells: 10, done: 1, skip: 1, pending: 8, perDay: [] },
  ...over,
})

beforeEach(() => {
  cleanup()
  // mock 跟随 week 参数返回该周（周一锚点），使周切换断言可预期
  const mondayOf = (d: string) => {
    const n = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay()
    const back = n === 0 ? 7 : n - 1
    return new Date(Date.parse(`${d}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10)
  }
  vi.mocked(api.dailyBoard).mockReset().mockImplementation(async (_id?: number, week?: string) => {
    const start = week ? mondayOf(week) : MONDAY
    return board({ weekStart: start, weekEnd: new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10) })
  })
  vi.mocked(api.setDayStatus).mockClear()
})

describe('S69 DailyWeekGrid 周视图冒烟', () => {
  it('渲染行=任务、列=周一~周日：每天任务 7 格可打，周一三五任务不适用格显示 —；已完成/跳过带标签', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} readonly={false} /></StoreProvider>)
    expect(await screen.findByTestId('daily-week-grid')).toBeTruthy()
    // 两行任务 + 7 天列
    expect(screen.getAllByTestId('daily-task-row').length).toBe(2)
    expect(screen.getAllByTestId('day-col').length).toBe(7)
    // 不适用格（周二/四/六/日 × 周报整理行）显示 —
    const row = screen.getAllByTestId('daily-task-row')[1]
    expect(row.textContent).toContain('—')
    // 完成态备注与机器人打卡标记可见
    expect(row.textContent).toContain('初稿')
    expect(row.textContent).toContain('🤖')
    // 周一三五标签 + 本周统计
    expect(row.textContent).toContain('每周一、三、五')
    expect(row.textContent).toContain('1/3')
  })

  it('格子就地打卡：切换状态即调 setDayStatus 并刷新周板', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} readonly={false} /></StoreProvider>)
    await screen.findByTestId('daily-week-grid')
    const selects = screen.getAllByDisplayValue('未做')
    fireEvent.change(selects[0], { target: { value: 'done' } })
    await waitFor(() => expect(api.setDayStatus).toHaveBeenCalledWith(1, { taskId: 11, day: MONDAY, status: 'done' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenCalledTimes(2)) // 初始 + 打卡后刷新
  })

  it('周切换：上周/下周按钮带 week 参数重新取数', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} readonly={false} /></StoreProvider>)
    await screen.findByTestId('daily-week-nav')
    fireEvent.click(screen.getByRole('button', { name: '下周 →' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenLastCalledWith(1, '2026-11-02'))
    fireEvent.click(await screen.findByRole('button', { name: '← 上周' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenLastCalledWith(1, '2026-10-26'))
  })

  it('WeekdayPicker：勾选星期与「每天」快捷，确定提交（空选禁用）', async () => {
    const onChange = vi.fn()
    render(<WeekdayPicker value={[1, 3, 5]} onChange={onChange} />)
    expect(screen.getByTestId('weekday-picker').textContent).toContain('每周一、三、五')
    fireEvent.click(screen.getByRole('button', { name: '每周一、三、五' }))
    fireEvent.click(screen.getByRole('button', { name: '二' })) // 勾周二
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenCalledWith([1, 2, 3, 5])
    // 每天快捷
    fireEvent.click(screen.getByRole('button', { name: '每周一、三、五' }))
    fireEvent.click(screen.getByRole('button', { name: '每天' }))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenLastCalledWith([1, 2, 3, 4, 5, 6, 7])
  })
})
