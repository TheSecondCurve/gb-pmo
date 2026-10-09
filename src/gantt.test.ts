import { describe, it, expect } from 'vitest'
import { dayNum, computeAxis, barLayout, monthTicks, pointPct } from './gantt'

// PRD S30-3/S30-4（v0.29）— 甘特布局纯函数：日历日差运算（无时区语义）、
// 轴窗口自适应、条形四形态（区间/截止旗/开放条/未排期=null）、月刻度。

describe('S30 甘特布局纯函数', () => {
  it('S30-4: dayNum 为纯日历日差（手动拆分 + UTC 毫秒差，无时区语义）', () => {
    expect(dayNum('2026-10-02') - dayNum('2026-09-30')).toBe(2)
    expect(dayNum('2026-01-01') - dayNum('2025-12-31')).toBe(1) // 跨年
    expect(dayNum('2026-03-01') - dayNum('2026-02-28')).toBe(1) // 平年二月
  })

  it('S30-3: computeAxis 以可见日期与今日为锚、两侧 pad；全部无日期返回 null（空态）', () => {
    const rows = [
      { planStartDate: '2026-08-01', planEndDate: '2026-10-15' },
      { planStartDate: null, planEndDate: '2026-09-10' },
    ]
    const axis = computeAxis(rows, '2026-09-01', 7)!
    expect(axis).toBeTruthy()
    expect(axis.start).toBe(dayNum('2026-08-01') - 7)
    expect(axis.end).toBe(dayNum('2026-10-15') + 7)
    expect(axis.totalDays).toBe(axis.end - axis.start + 1)
    expect(computeAxis([{ planStartDate: null, planEndDate: null }], '2026-09-01')).toBeNull()
  })

  it('S30-3: barLayout 四形态——区间条/截止旗/开放条/未排期(null)', () => {
    const axis = computeAxis([{ planStartDate: '2026-01-01', planEndDate: '2026-12-31' }], '2026-07-01', 0)!
    const total = axis.totalDays
    const pct = (days: number) => (days / total) * 100

    const range = barLayout({ planStartDate: '2026-02-01', planEndDate: '2026-03-01' }, axis)!
    expect(range.form).toBe('range')
    expect(range.leftPct).toBeCloseTo(pct(dayNum('2026-02-01') - axis.start), 5)
    expect(range.widthPct).toBeCloseTo(pct(dayNum('2026-03-01') - dayNum('2026-02-01') + 1), 5) // 含首尾日

    const deadline = barLayout({ planStartDate: null, planEndDate: '2026-03-01' }, axis)!
    expect(deadline.form).toBe('deadline')
    expect(deadline.leftPct).toBe(0) // 虚线引导从行首开始
    expect(deadline.widthPct).toBeCloseTo(pct(dayNum('2026-03-01') - axis.start), 5) // 止于旗位

    const open = barLayout({ planStartDate: '2026-02-01', planEndDate: null }, axis)!
    expect(open.form).toBe('open')
    expect(open.leftPct).toBeCloseTo(pct(dayNum('2026-02-01') - axis.start), 5)
    expect(open.widthPct).toBeCloseTo(100 - open.leftPct, 5) // 延伸到时间轴右端

    expect(barLayout({ planStartDate: null, planEndDate: null }, axis)).toBeNull()
  })

  it('S30-3: monthTicks 月刻度在轴内且升序（含右端月份）', () => {
    const axis = computeAxis([{ planStartDate: '2026-08-01', planEndDate: '2026-10-15' }], '2026-09-01', 7)!
    const ticks = monthTicks(axis)
    expect(ticks.map((t) => t.label)).toEqual(['2026-08', '2026-09', '2026-10'])
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].leftPct).toBeGreaterThan(ticks[i - 1].leftPct)
    expect(ticks.at(-1)!.leftPct).toBeLessThanOrEqual(100)
  })

  it('S42-4: pointPct 单日期定位（里程碑刻度），轴外日期钳制到端点', () => {
    const axis = computeAxis([{ planStartDate: '2026-09-01', planEndDate: '2026-10-15' }], '2026-09-20', 0)!
    const pct = (d: string) => ((dayNum(d) - axis.start) / axis.totalDays) * 100
    expect(pointPct('2026-09-01', axis)).toBeCloseTo(0, 5) // 轴起点
    expect(pointPct('2026-10-15', axis)).toBeCloseTo(pct('2026-10-15'), 5)
    expect(pointPct('2026-09-20', axis)).toBeCloseTo(pct('2026-09-20'), 5)
    // 轴外钳制：早于起点→0，晚于终点→100（里程碑超出任务日期范围时不飞出轨道）
    expect(pointPct('2020-01-01', axis)).toBe(0)
    expect(pointPct('2099-01-01', axis)).toBe(100)
  })
})
