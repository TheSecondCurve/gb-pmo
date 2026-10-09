import { describe, it, expect } from 'vitest'
import { dayNum, computeAxis, barLayout, monthTicks, pointPct, medianDurationDays } from './gantt'

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

// PRD S42-5/S42-6（v0.49，design.md K27）— 任务甘特轴右端锚定 + 开放任务中位时长估算：
// 轴右端 = max(项目交付日期, 任务计划结束日期, 今天) + 1 天呼吸边；只有开始日的开放任务
// 按同项目起止齐全任务的中位时长（无样本 14 天）估算名义结束日，开放条按估算时长渐隐收尾。
describe('S42-5/S42-6 轴右端锚定与开放任务估算（v0.49）', () => {
  it('S42-5: 轴右端 = max(endAnchor, 任务结束日期, 今天) + padEnd；左端 pad 不变', () => {
    const rows = [{ planStartDate: '2026-09-01', planEndDate: '2026-10-15' }]
    // 项目交付日期最晚 → 交付日期为右端，+1 天呼吸边
    const a1 = computeAxis(rows, '2026-09-20', { endAnchor: '2026-11-09', padStart: 7, padEnd: 1 })!
    expect(a1.end).toBe(dayNum('2026-11-09') + 1)
    expect(a1.start).toBe(dayNum('2026-09-01') - 7)
    expect(a1.totalDays).toBe(a1.end - a1.start + 1)
    // 任务结束日期晚于交付日期 → 任务结束为右端
    const a2 = computeAxis(rows, '2026-09-20', { endAnchor: '2026-10-01', padEnd: 1 })!
    expect(a2.end).toBe(dayNum('2026-10-15') + 1)
    // 今天最晚 → 今天入轴（今日线不飞出轨道）
    const a3 = computeAxis(rows, '2026-12-01', { endAnchor: '2026-11-09', padEnd: 1 })!
    expect(a3.end).toBe(dayNum('2026-12-01') + 1)
    // endAnchor 为空 → 退化为任务日期 + 今天
    const a4 = computeAxis(rows, '2026-09-20', { endAnchor: null, padEnd: 1 })!
    expect(a4.end).toBe(dayNum('2026-10-15') + 1)
    // 数字形参旧契约不变（S30 组合页）：两侧同 pad
    const a5 = computeAxis(rows, '2026-09-20', 7)!
    expect(a5.end).toBe(dayNum('2026-10-15') + 7)
    expect(a5.start).toBe(dayNum('2026-09-01') - 7)
  })

  it('S42-6: medianDurationDays 取起止齐全任务的中位时长（含首尾），无样本回退 14 天', () => {
    expect(medianDurationDays([
      { planStartDate: '2026-09-01', planEndDate: '2026-09-10' }, // 10 天
      { planStartDate: '2026-10-01', planEndDate: '2026-10-20' }, // 20 天
      { planStartDate: '2026-08-20', planEndDate: '2026-09-01' }, // 13 天
      { planStartDate: '2026-10-01', planEndDate: null }, // 开放任务不计入样本
      { planStartDate: null, planEndDate: '2026-12-01' }, // 只有截止日不计入样本
    ])).toBe(13) // [10,13,20] 中位
    // 偶数样本取下中位
    expect(medianDurationDays([
      { planStartDate: '2026-09-01', planEndDate: '2026-09-10' }, // 10
      { planStartDate: '2026-09-01', planEndDate: '2026-09-20' }, // 20
    ])).toBe(10)
    // 无样本 / 结束早于开始的脏数据不计入 → 回退 14
    expect(medianDurationDays([{ planStartDate: '2026-09-01', planEndDate: null }])).toBe(14)
    expect(medianDurationDays([{ planStartDate: '2026-09-10', planEndDate: '2026-09-01' }])).toBe(14)
    expect(medianDurationDays([], 21)).toBe(21) // 回退值可配
  })

  it('S42-6: 估算模式——开放条宽 = 估算时长且渐隐收尾；名义结束日参与轴右端取大', () => {
    const rows = [{ planStartDate: '2026-10-01', planEndDate: null }]
    const axis = computeAxis(rows, '2026-09-20', { padStart: 7, padEnd: 1, estimateDuration: 14 })!
    // 名义结束日 = 10-01 + 14 - 1 = 10-14，右端 = max(今天, 开始日, 名义结束) + 1
    expect(axis.end).toBe(dayNum('2026-10-14') + 1)
    expect(axis.start).toBe(dayNum('2026-09-20') - 7)
    const b = barLayout({ planStartDate: '2026-10-01', planEndDate: null }, axis, 14)!
    expect(b.form).toBe('open')
    expect(b.widthPct).toBeCloseTo((14 / axis.totalDays) * 100, 5) // 宽度=估算时长，不冲到轴右端
    // 今天晚于名义结束日 → 右端由今天锚定
    const axis2 = computeAxis(rows, '2026-11-01', { padEnd: 1, estimateDuration: 14 })!
    expect(axis2.end).toBe(dayNum('2026-11-01') + 1)
    // 不传估算参数 → 维持 S30 旧语义（延伸到轴右端，组合页行为不变）
    const legacy = barLayout({ planStartDate: '2026-10-01', planEndDate: null }, axis)!
    expect(legacy.form).toBe('open')
    expect(legacy.widthPct).toBeCloseTo(100 - legacy.leftPct, 5)
    // 有绝对结束日可锚时，估算的名义结束日不盖过绝对锚
    const anchored = computeAxis(
      [{ planStartDate: '2026-10-01', planEndDate: null }, { planStartDate: null, planEndDate: '2026-12-01' }],
      '2026-09-20', { endAnchor: '2026-11-09', padEnd: 1, estimateDuration: 14 },
    )!
    expect(anchored.end).toBe(dayNum('2026-12-01') + 1)
  })
})
