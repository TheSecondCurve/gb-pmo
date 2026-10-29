// @vitest-environment jsdom
// S69（v0.80，K64）前端冒烟：常态项目执行视图 DailyWeekGrid——窗口格子矩阵渲染、不适用格置灰、
// 就地打卡调用与期切换；WeekdayPicker 星期勾选。api 层 mock（组件冒烟不设标准层）。
// v0.81（K65）：窗口三档 span（周/双周/月）+ 导航锚点服务端下发（前端零日期推算）+ Tabs 切换即持久化项目默认。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import DailyWeekGrid, { CadencePicker } from './components/DailyWeekGrid'
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

  it('CadencePicker（S75）：四档切换与提交——每周勾星期组合；每月勾几号；每两周选序列；空选禁用', () => {
    const onChange = vi.fn()
    render(<CadencePicker value={{ type: 'weekly', weekdays: [1, 3, 5] }} onChange={onChange} />)
    expect(screen.getByTestId('cadence-picker').textContent).toContain('每周一、三、五')
    fireEvent.click(screen.getByRole('button', { name: '每周一、三、五' }))
    // 每周：勾周二 → 确定
    fireEvent.click(screen.getByRole('button', { name: '二' }))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenCalledWith({ type: 'weekly', weekdays: [1, 2, 3, 5] })
    // 每月：勾 1、15 号 → 确定（value prop 未变，触发器标签仍是「每周一、三、五」）
    fireEvent.click(screen.getByRole('button', { name: '每周一、三、五' }))
    fireEvent.click(screen.getByRole('tab', { name: '每月' }))
    fireEvent.click(screen.getByRole('button', { name: '1', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '15', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'monthly', monthDays: [1, 15] })
    // 每两周：切档保留已选星期——先清空再勾周一 + 序列 B → 确定
    fireEvent.click(screen.getByRole('button', { name: '每周一、三、五' }))
    fireEvent.click(screen.getByRole('tab', { name: '每两周' }))
    for (const w of ['一', '三', '五']) fireEvent.click(screen.getByRole('button', { name: w, exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '一', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: /序列 B/ }))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'biweekly', weekdays: [1], parity: 1 })
    // 空选禁用（每周：取消全部已选星期）
    fireEvent.click(screen.getByRole('button', { name: '每周一、三、五' }))
    fireEvent.click(screen.getByRole('tab', { name: '每周' }))
    for (const w of ['一', '三', '五']) fireEvent.click(screen.getByRole('button', { name: w, exact: true }))
    expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true)
  })

  // v0.86.1（S69-2 修订）：弹层原先 absolute 定位在原地展开，被任务表格 overflow-x-auto 与页面滚动容器
  // （app-canvas）两层裁切——新建行滚到屏底时弹层完全不可见。现 portal 到 body + fixed 定位 + 近屏底上翻。
  it('S69-2 弹层不被滚动容器裁切：portal 到 document.body 且 fixed 定位（脱离 overflow 裁切祖先）', () => {
    const onChange = vi.fn()
    // 模拟任务表格包裹层：overflow-x-auto（overflow-y 随之计算为 auto → 裁切 absolute 后代）
    const { container } = render(
      <div style={{ overflowX: 'auto', maxHeight: 100 }}>
        <CadencePicker value={{ type: 'daily' }} onChange={onChange} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: '每天' }))
    const pop = document.querySelector('[data-testid="cadence-picker-pop"]')
    expect(pop).toBeTruthy()
    expect(container.contains(pop)).toBe(false) // 不在渲染容器（= 不在任何 overflow 裁切祖先）内
    expect(document.body.contains(pop)).toBe(true) // portal 到 body
    expect(pop.className).toContain('fixed') // fixed 定位：裁切祖先不再生效
    expect(pop.className).toContain('z-30') // 层叠：弹层高于遮罩，低于 Modal z-40 / toast z-50
    const backdrop = document.querySelector('[data-testid="cadence-picker-backdrop"]')
    expect(backdrop?.className).toContain('z-20')
    // 遮罩点击关闭（既有行为保留）
    fireEvent.click(backdrop!)
    expect(document.querySelector('[data-testid="cadence-picker-pop"]')).toBeNull()
  })

  it('S69-2 近屏底自动向上翻转 + Esc 关闭：触发器在视口底部时弹层改在上方展开', () => {
    const onChange = vi.fn()
    // jsdom 无布局：mock 触发器矩形为近屏底（top 800 / bottom 830，视口高 860）
    const vh = window.innerHeight
    window.innerHeight = 860
    const orig = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 100, y: 800, top: 800, bottom: 830, left: 100, right: 144, width: 44, height: 30, toJSON: () => ({}) } as DOMRect
    }
    try {
      render(<CadencePicker value={{ type: 'daily' }} onChange={onChange} />)
      fireEvent.click(screen.getByRole('button', { name: '每天' }))
      const pop = document.querySelector('[data-testid="cadence-picker-pop"]') as HTMLElement
      expect(pop).toBeTruthy()
      expect(parseInt(pop.style.top, 10)).toBeLessThan(800) // 上翻：弹层顶高于触发器顶
      expect(parseInt(pop.style.top, 10)).toBeGreaterThanOrEqual(0)
      // Esc 关闭
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(document.querySelector('[data-testid="cadence-picker-pop"]')).toBeNull()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig
      window.innerHeight = vh
    }
  })

  it('S69-2 滚动跟随：触发器矩形变化后弹层贴住重算（事件 + 轮询兜底，不依赖单一机制）', async () => {
    const onChange = vi.fn()
    let rect = { x: 100, y: 300, top: 300, bottom: 330, left: 100, right: 144, width: 44, height: 30, toJSON: () => ({}) }
    const orig = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () { return rect as DOMRect }
    try {
      render(<CadencePicker value={{ type: 'daily' }} onChange={onChange} />)
      fireEvent.click(screen.getByRole('button', { name: '每天' }))
      const pop = document.querySelector('[data-testid="cadence-picker-pop"]') as HTMLElement
      expect(parseInt(pop.style.top, 10)).toBe(334) // 下方展开：bottom 330 + GAP 4
      rect = { ...rect, y: 100, top: 100, bottom: 130 } // 触发器随页面上移（等价容器滚动）
      await new Promise((r) => setTimeout(r, 220)) // 轮询周期 100ms，留两拍
      expect(parseInt(pop.style.top, 10)).toBe(134) // 弹层贴住新位置
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig
    }
  })
})
