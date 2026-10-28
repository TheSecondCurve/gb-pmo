// @vitest-environment jsdom
// S69（v0.80，K64）前端冒烟：常态项目执行视图 DailyWeekGrid——窗口格子矩阵渲染、不适用格置灰、
// 就地打卡调用与期切换；WeekdayPicker 星期勾选。api 层 mock（组件冒烟不设标准层）。
// v0.81（K65）：窗口三档 span（周/双周/月）+ 导航锚点服务端下发（前端零日期推算）+ Tabs 切换即持久化项目默认。
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
    patchProject: vi.fn(async () => ({})),
  },
}))

const MONDAY = '2026-10-26' // 周一
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const rangeOf = (start: string, n: number) => Array.from({ length: n }, (_, i) => addDays(start, i))

const board = (over: Partial<DailyBoardData> = {}): DailyBoardData => {
  const start = over.start ?? MONDAY
  const days = over.days ?? rangeOf(start, 7)
  return {
    projectId: 1,
    span: 'week',
    start,
    end: days[days.length - 1],
    days,
    prevAnchor: addDays(start, -7),
    nextAnchor: addDays(start, 7),
    tasks: [
      {
        taskId: 11, title: '看资讯', note: null, weekdays: [1, 2, 3, 4, 5, 6, 7], weekdaysLabel: '每天',
        responsibleMemberId: 2, responsibleName: '李四',
        cells: days.map((day) => ({
          day, applicable: true, status: 'pending', note: null, operatorMemberId: null, operatorName: null, source: null, updatedAt: null,
        })),
        periodApplicable: days.length, periodDone: 0,
        ...over.tasks?.[0],
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
        periodApplicable: 3, periodDone: 1,
        ...over.tasks?.[1],
      },
    ],
    summary: { tasks: 2, applicableCells: 10, done: 1, skip: 1, pending: 8, perDay: [] },
    ...over,
    // days/start 等键以显式覆盖优先（tasks 的 spread 在上面已处理，此处抹掉再回填避免顺序问题）
    ...(over.tasks ? { tasks: over.tasks } : {}),
  }
}

beforeEach(() => {
  cleanup()
  vi.mocked(api.dailyBoard).mockReset().mockImplementation(async (_id?: number, opts?: { anchor?: string; span?: string }) => {
    const span = opts?.span ?? 'week'
    const n = span === 'month' ? 31 : span === 'biweek' ? 14 : 7
    const anchorDay = opts?.anchor ?? MONDAY
    // 简化桩：以 anchor 当窗口起点（导航断言用得到期长即可，不模拟真实窗口对齐）
    return board({ span: span as DailyBoardData['span'], start: anchorDay, days: rangeOf(anchorDay, n) })
  })
  vi.mocked(api.setDayStatus).mockClear()
  vi.mocked(api.patchProject).mockClear()
})

describe('S69 DailyWeekGrid 执行视图冒烟', () => {
  it('渲染行=任务、列=逐日：每天任务全格可打，周一三五任务不适用格显示 —；完成/跳过/机器人标记可见', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} readonly={false} /></StoreProvider>)
    expect(await screen.findByTestId('daily-week-grid')).toBeTruthy()
    expect(screen.getAllByTestId('daily-task-row').length).toBe(2)
    expect(screen.getAllByTestId('day-col').length).toBe(7)
    const row = screen.getAllByTestId('daily-task-row')[1]
    expect(row.textContent).toContain('—')
    expect(row.textContent).toContain('初稿')
    expect(row.textContent).toContain('🤖')
    expect(row.textContent).toContain('每周一、三、五')
    expect(row.textContent).toContain('1/3')
  })

  it('格子就地打卡：切换状态即调 setDayStatus 并刷新视图', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} readonly={false} /></StoreProvider>)
    await screen.findByTestId('daily-week-grid')
    const selects = screen.getAllByDisplayValue('未做')
    fireEvent.change(selects[0], { target: { value: 'done' } })
    await waitFor(() => expect(api.setDayStatus).toHaveBeenCalledWith(1, { taskId: 11, day: MONDAY, status: 'done' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenCalledTimes(2)) // 初始 + 打卡后刷新
  })

  it('期导航：上/下一期按钮用引擎下发的锚点取数（前端零日期推算）', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} readonly={false} /></StoreProvider>)
    await screen.findByTestId('daily-week-nav')
    fireEvent.click(screen.getByRole('button', { name: '下一期 →' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenLastCalledWith(1, { anchor: '2026-11-02', span: 'week' }))
    // 桩以 anchor 为起点 → 窗口前进后 prevAnchor 随之回拨，再点上一期回到更早窗口
    fireEvent.click(await screen.findByRole('button', { name: '← 上一期' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenLastCalledWith(1, { anchor: '2026-10-26', span: 'week' }))
  })

  it('窗口 Tabs：切双周/月即按新 span 取数并持久化为项目默认（WYSIWYG）；月视图列数如实', async () => {
    render(<StoreProvider><DailyWeekGrid projectId={1} defaultSpan="week" readonly={false} /></StoreProvider>)
    await screen.findByTestId('daily-week-grid')
    expect(screen.getAllByTestId('day-col').length).toBe(7)
    fireEvent.click(screen.getByRole('tab', { name: '月' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenLastCalledWith(1, { anchor: undefined, span: 'month' }))
    await waitFor(() => expect(screen.getAllByTestId('day-col').length).toBe(31))
    expect(api.patchProject).toHaveBeenCalledWith(1, { boardSpan: 'month' })
    fireEvent.click(screen.getByRole('tab', { name: '双周' }))
    await waitFor(() => expect(api.dailyBoard).toHaveBeenLastCalledWith(1, { anchor: undefined, span: 'biweek' }))
    await waitFor(() => expect(screen.getAllByTestId('day-col').length).toBe(14))
    expect(api.patchProject).toHaveBeenLastCalledWith(1, { boardSpan: 'biweek' })
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
