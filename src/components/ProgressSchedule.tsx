// S42（v0.44）项目详情「进度与排期」卡：堆叠进度条（progressStats 纯前端派生）+ 任务级甘特。
// 甘特复用 S30 gantt.ts 纯函数与条形形态语义（区间条/截止旗/开放条/未排期组），
// 条色=状态、逾期红优先（K23），今日锚点走 bjToday()（S19）；不虚构日期、单层条形、无拖拽。
// v0.49（K27，S42-5/S42-6）：轴右端以项目交付日期/任务计划结束日期的最大值（不早于今天）为锚、
// 右端 1 天呼吸边；轨道弹性撑满卡片宽度（跨度长横向滚动，最小日宽 2px）；只有开始日的开放任务
// 按同项目任务中位时长估算名义结束日（无样本 14 天），开放条按估算时长渐隐收尾，估算不落数据。
import { useMemo, type CSSProperties } from 'react'
import { bjToday, dateRangeForm, fmtDateRange } from '../fmt'
import { barLayout, computeAxis, dayNum, medianDurationDays, monthTicks, pointPct } from '../gantt'
import { progressStats, taskVisual, type TaskVisual } from '../progress'
import { Badge, Card, Empty } from './ui'
import {
  MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, TASK_STATUS_LABEL,
  type MilestoneRow, type TaskRow, type Tone,
} from '../types'

const LABEL_W = 176
const MIN_DAY_PX = 2 // 轨道最小日宽：跨度长时撑出 min-width 触发横向滚动，跨度短由 flex-1 拉满卡片

const SEGS: { key: 'done' | 'doing' | 'todo'; label: string; cls: string }[] = [
  { key: 'done', label: '完成', cls: 'bg-[var(--color-ok)]' },
  { key: 'doing', label: '进行中', cls: 'bg-[var(--color-brand)]' },
  { key: 'todo', label: '未开始', cls: 'bg-gray-300' },
]

const BAR_COLOR: Record<TaskVisual, string> = {
  todo: 'var(--color-ink-soft)', doing: 'var(--color-brand)', done: 'var(--color-ok)', overdue: 'var(--color-bad)',
}
const MILESTONE_TEXT: Record<Tone, string> = {
  ok: 'text-[var(--color-ok)]', warn: 'text-[var(--color-warn)]', bad: 'text-[var(--color-bad)]',
  info: 'text-[var(--color-brand)]', muted: 'text-[var(--color-ink-soft)]',
}

export default function ProgressSchedule({ tasks, milestones, projectEndDate }: {
  tasks: TaskRow[]; milestones: MilestoneRow[]; projectEndDate?: string | null
}) {
  const s = progressStats(tasks)
  const today = bjToday()
  const undated = useMemo(() => tasks.filter((t) => dateRangeForm(t.planStartDate, t.planEndDate) === 'none'), [tasks])
  // S42-6：开放任务名义时长 = 同项目起止齐全任务的中位时长（无样本回退 14 天）
  const est = useMemo(() => medianDurationDays(tasks), [tasks])
  // S42-5：轴右端锚 = max(项目交付日期, 任务计划结束日期, 今天) + 1 天呼吸边
  const axis = useMemo(
    () => computeAxis(tasks, today, { endAnchor: projectEndDate ?? null, padEnd: 1, estimateDuration: est }),
    [tasks, today, projectEndDate, est],
  )

  return (
    <Card title={`进度与排期${s.total > 0 ? `（完成 ${s.done}/${s.total}）` : ''}`}>
      {s.total === 0 ? <Empty hint="暂无任务，进度与排期在创建任务后呈现" /> : (
        <>
          {/* 堆叠进度条：分段=状态，逾期计数独立徽章（双口径，逾期任务仍属 todo/doing 之一） */}
          <div data-testid="progress-strip">
            <div className="flex items-center gap-3">
              <div className="flex h-2.5 min-w-24 flex-1 overflow-hidden rounded-full bg-gray-100">
                {SEGS.map((seg) => s[seg.key] > 0 && (
                  <div key={seg.key} data-seg={seg.key} className={seg.cls} style={{ width: `${(s[seg.key] / s.total) * 100}%` }} />
                ))}
              </div>
              <span className="num shrink-0 text-[13px] font-medium">完成 {s.done}/{s.total}（{s.donePct}%）</span>
              {s.overdue > 0 && <Badge tone="bad">逾期 {s.overdue}</Badge>}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-[var(--color-ink-soft)]">
              {SEGS.map((seg) => (
                <span key={seg.key} className="flex items-center gap-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${seg.cls}`} />{seg.label} {s[seg.key]}
                </span>
              ))}
            </div>
          </div>
          <TaskGantt tasks={tasks} milestones={milestones} axis={axis} today={today} undated={undated} est={est} />
        </>
      )}
    </Card>
  )
}

function TaskGantt({ tasks, milestones, axis, today, undated, est }: {
  tasks: TaskRow[]; milestones: MilestoneRow[]
  axis: ReturnType<typeof computeAxis>; today: string; undated: TaskRow[]; est: number
}) {
  const datedMilestones = milestones.filter((m) => m.planDate)
  if (!axis) {
    return (
      <div className="mt-3 border-t border-[var(--color-line)] pt-3">
        <div className="rounded-md border border-dashed border-[var(--color-line)] px-3 py-4 text-center text-[12px] text-[var(--color-ink-soft)]">
          暂无可排期任务（所有任务均未填计划日期，补齐后在此呈现时间线）
        </div>
        {undated.length > 0 && <UndatedGroup undated={undated} />}
      </div>
    )
  }

  const minW = LABEL_W + axis.totalDays * MIN_DAY_PX // 兜底横向滚动；容器更宽时由 width:100% + flex-1 拉满
  const todayFrac = (dayNum(today) - axis.start) / axis.totalDays
  const ticks = monthTicks(axis)
  const dated = tasks.filter((t) => dateRangeForm(t.planStartDate, t.planEndDate) !== 'none')
  const sorted = [...dated].sort((a, b) => dayNum(a.planStartDate || a.planEndDate!) - dayNum(b.planStartDate || b.planEndDate!))

  return (
    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
      <div className="overflow-x-auto">
        <div data-testid="task-gantt-canvas" style={{ width: '100%', minWidth: minW }}>
          {/* 月刻度行 */}
          <div className="flex border-b border-[var(--color-line)]">
            <div className="shrink-0 px-2 py-1 text-[11px] text-[var(--color-ink-soft)]" style={{ width: LABEL_W }}>任务（{dated.length}）</div>
            <div className="relative h-6 flex-1">
              {ticks.map((t) => (
                <span key={t.label} data-testid="task-gantt-tick" className="absolute top-0 h-full border-l border-[var(--color-line)] pl-1 text-[10px] text-[var(--color-ink-soft)]" style={{ left: `${t.leftPct}%` }}>{t.label}</span>
              ))}
            </div>
          </div>
          {/* 里程碑菱形刻度行（计划日期定位，轴外钳制到端点，S42-4） */}
          {datedMilestones.length > 0 && (
            <div className="flex border-b border-[var(--color-line)]">
              <div className="shrink-0 px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]" style={{ width: LABEL_W }}>里程碑</div>
              <div className="relative h-5 flex-1">
                {datedMilestones.map((m) => {
                  const tone = MILESTONE_STATUS_TONE[m.status] || 'muted'
                  return (
                    <span
                      key={m.id} data-testid="milestone-marker" data-tone={tone}
                      className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] leading-none ${MILESTONE_TEXT[tone]}`}
                      style={{ left: `${pointPct(m.planDate!, axis)}%` }}
                      title={`${m.name} · ${m.planDate} · ${MILESTONE_STATUS_LABEL[m.status] || m.status}`}
                    >◆</span>
                  )
                })}
              </div>
            </div>
          )}
          {/* 任务条（今日线贯穿） */}
          <div className="relative">
            {sorted.map((t) => {
              const b = barLayout(t, axis, est)!
              return (
                <div key={t.id} className="flex border-b border-[var(--color-line)] last:border-0">
                  <div className="flex shrink-0 items-center overflow-hidden px-2 text-[12px]" style={{ width: LABEL_W }}>
                    <span className="truncate" title={t.title}>{t.title}</span>
                  </div>
                  <div className="relative flex-1" style={{ height: 26 }}>
                    <TaskBarCell t={t} b={b} />
                  </div>
                </div>
              )
            })}
            {/* 今日线：calc 百分比定位（左=标签列宽 + 轨道弹性宽 × 今日进度），随轨道伸缩不变形 */}
            <div data-testid="task-gantt-today" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[var(--color-brand)]"
              style={{ left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${todayFrac})` }} />
          </div>
        </div>
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
        条色=状态（蓝=进行中 · 绿=完成 · 灰=未开始 · 红=逾期）；旗标=只有截止日；渐隐=只有开始日，长度按同项目任务中位时长估算（无样本 14 天）；轴右端=项目交付日期与任务结束日期的最大值；今日 {today}
      </div>
      {undated.length > 0 && <UndatedGroup undated={undated} />}
    </div>
  )
}

function UndatedGroup({ undated }: { undated: TaskRow[] }) {
  return (
    <div data-testid="task-gantt-unscheduled" className="mt-2 rounded-md bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-ink-soft)]">
      未排期（{undated.length}）：{undated.map((t) => t.title).join('、')}
    </div>
  )
}

/** 任务甘特条单元格：形态与颜色语义见 gantt.ts / S30-3、S42/K23（title 原生 tooltip，零依赖） */
function TaskBarCell({ t, b }: { t: TaskRow; b: { form: 'range' | 'deadline' | 'open'; leftPct: number; widthPct: number } }) {
  const visual = taskVisual(t)
  const tip = `${t.title} · ${fmtDateRange(t.planStartDate, t.planEndDate)} · ${TASK_STATUS_LABEL[t.status] || t.status}${t.isOverdue ? ' · 已逾期' : ''}`
  const color = BAR_COLOR[visual]
  if (b.form === 'deadline') {
    return (
      <>
        {/* 虚线引导=只有截止日（不是区间），止于旗位 */}
        <div className="absolute top-1/2 border-t border-dashed border-[var(--color-line)]" style={{ left: 0, width: `${b.widthPct}%` }} title={tip} />
        <div data-testid="task-gantt-bar" data-visual={visual} className="absolute top-0.5 h-3.5 w-[2px]" style={{ left: `${b.widthPct}%`, backgroundColor: color }} title={tip} />
      </>
    )
  }
  if (b.form === 'open') {
    const style: CSSProperties = {
      left: `${b.leftPct}%`, width: `${b.widthPct}%`, height: 9,
      backgroundImage: `linear-gradient(to right, ${color}, transparent)`, // 渐隐=无期限，右端不封口
    }
    return <div data-testid="task-gantt-bar" data-visual={visual} className="absolute top-1/2 -translate-y-1/2 rounded-l-full" style={style} title={tip} />
  }
  return (
    <div data-testid="task-gantt-bar" data-visual={visual} className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
      style={{ left: `${b.leftPct}%`, width: `${Math.max(b.widthPct, 0.8)}%`, backgroundColor: color }} title={tip} />
  )
}
