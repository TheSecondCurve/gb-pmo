// S30（v0.29）项目级甘特布局纯函数：坐标映射与形态判定全部在此，渲染层（Projects.tsx）只消费百分比。
// 日期差用手动拆分 + UTC 毫秒差（纯日历运算，无时区语义，S19 禁止字符串反解）；
// 「今天」由 fmt.bjToday() 提供（Asia/Shanghai，与后端 BJ_TODAY 同口径）。

/** 'YYYY-MM-DD' → 距 1970-01-01 的天数（纯日历日差） */
export function dayNum(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86400000)
}

export interface AxisWindow {
  start: number // 起始日（含）
  end: number // 结束日（含）
  totalDays: number
}

/**
 * 时间轴自适应：可见日期 min/max 与今日合并为锚，两侧 pad 天。
 * 全部行均无任何日期时返回 null（调用方渲染空态引导，不虚构轴）。
 */
export function computeAxis(
  rows: Array<{ planStartDate?: string | null; planEndDate?: string | null }>,
  today: string,
  padDays = 7,
): AxisWindow | null {
  const anchors: number[] = [dayNum(today)]
  for (const r of rows) {
    if (r.planStartDate) anchors.push(dayNum(r.planStartDate))
    if (r.planEndDate) anchors.push(dayNum(r.planEndDate))
  }
  const dated = rows.some((r) => r.planStartDate || r.planEndDate)
  if (!dated) return null
  const start = Math.min(...anchors) - padDays
  const end = Math.max(...anchors) + padDays
  return { start, end, totalDays: end - start + 1 }
}

export type BarForm = 'range' | 'deadline' | 'open'

/**
 * 条形布局（相对时间轴的百分比）：
 * - range：leftPct=起点，widthPct=含首尾日的区间宽；
 * - deadline：leftPct=0（虚线引导从行首开始），widthPct=止于旗位——虚线语义是「尚未排期」而非区间；
 * - open：leftPct=起点，widthPct=延伸到时间轴右端（右端不封口，渲染层渐隐）；
 * - 全空返回 null（不入时间轴，收进未排期分组）。
 */
export function barLayout(
  row: { planStartDate?: string | null; planEndDate?: string | null },
  axis: AxisWindow,
): { form: BarForm; leftPct: number; widthPct: number } | null {
  const pct = (days: number) => (days / axis.totalDays) * 100
  const start = row.planStartDate ? dayNum(row.planStartDate) : null
  const end = row.planEndDate ? dayNum(row.planEndDate) : null
  if (start !== null && end !== null) {
    const left = pct(start - axis.start)
    return { form: 'range', leftPct: left, widthPct: pct(end - start + 1) }
  }
  if (end !== null) {
    return { form: 'deadline', leftPct: 0, widthPct: pct(end - axis.start) }
  }
  if (start !== null) {
    const left = pct(start - axis.start)
    return { form: 'open', leftPct: left, widthPct: 100 - left }
  }
  return null
}

export interface Tick {
  label: string // YYYY-MM
  leftPct: number
}

/** S42-4 单日期定位（里程碑刻度）：轴外日期钳制到端点（不飞出轨道）。 */
export function pointPct(date: string, axis: AxisWindow): number {
  const pct = ((dayNum(date) - axis.start) / axis.totalDays) * 100
  return Math.max(0, Math.min(100, pct))
}

/** 月刻度：轴内每个月边界一格；跨度超 540 天降为季度刻度（防密集）。 */
export function monthTicks(axis: AxisWindow): Tick[] {
  const quarterly = axis.totalDays > 540
  const d = new Date(axis.start * 86400000) // UTC 构造仅用于逐月推进日历
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const ticks: Tick[] = []
  for (let i = 0; ; i++) {
    const monthStart = Date.UTC(y, m + i, 1) / 86400000
    if (monthStart > axis.end) break
    if (monthStart >= axis.start && (!quarterly || (m + i) % 3 === 0)) {
      const label = `${y + Math.floor((m + i) / 12)}-${String(((m + i) % 12) + 1).padStart(2, '0')}`
      ticks.push({ label, leftPct: ((monthStart - axis.start) / axis.totalDays) * 100 })
    }
  }
  return ticks
}
