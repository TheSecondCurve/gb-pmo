import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, type MyTaskRow, type MyTasksBoard } from '../types'
import { PageMasthead, SectionHeading } from '../components/editorial'
import { Badge, Card, Empty, Spinner } from '../components/ui'
import { dateRangeForm, fmtDateRange } from '../fmt'
import { barLayout, computeAxis, dayNum, monthTicks } from '../gantt'

// S66（v0.73，K52）我的任务工作台：跨在跑项目聚合本人未完任务（/my 斜杠同口径），
// 按项目分组 + 任务级甘特——复用 S30 gantt.ts 纯函数与四形态、S41 状态色、S30-4 文案四式；
// 逾期红优先于状态色；今日线；无日期任务沉底「未排期」不虚构（K52：每项目独立轴）。

const LABEL_W = 236
const STATUS_BAR_COLOR: Record<string, string> = {
  todo: 'var(--color-ink-soft)',
  doing: 'var(--color-brand)',
}

export default function MyTasks() {
  const [board, setBoard] = useState<MyTasksBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try { setBoard(await api.myTasks()) } catch (e) { setError(String((e as Error)?.message || e)) }
    })()
  }, [])
  if (error) return <Card><Empty hint={`加载失败：${error}`} /></Card>
  if (!board) return <Spinner />

  const { stats } = board
  const statBlocks = [
    { key: 'total', label: '未完任务', value: stats.total, tone: 'ink' as const },
    { key: 'overdue', label: '逾期', value: stats.overdue, tone: stats.overdue > 0 ? ('bad' as const) : ('ink' as const) },
    { key: 'week', label: '本周到期', value: stats.dueThisWeek, tone: stats.dueThisWeek > 0 ? ('warn' as const) : ('ink' as const) },
    { key: 'pending', label: '待确认建议', value: stats.pending, tone: stats.pending > 0 ? ('info' as const) : ('ink' as const) },
  ]

  return (
    <div className="space-y-7 md:space-y-8">
      <PageMasthead
        testId="myt-masthead"
        kicker="Workspace / 03"
        title="我的任务"
        description="跨项目聚合你名下的全部未完任务——按项目分组、按计划起止排上时间线。逾期标红、本周到期标黄，纯提醒任务带 ⏰。"
        aside={<div className="num text-[11px] tracking-[0.12em] text-[var(--color-ink-soft)]">今日 {board.today} · 北京时间</div>}
      />

      {/* 统计带：编辑化数据条，与页首同宽 */}
      <div data-testid="myt-stats" className="grid grid-cols-2 border-y border-[var(--color-ink)] md:grid-cols-4">
        {statBlocks.map((s, i) => (
          <div key={s.key} data-testid={`myt-stat-${s.key}`} className={`px-4 py-4 md:px-6 md:py-5 ${i > 0 ? 'border-l border-[var(--color-line)]' : ''}`}>
            <div className="editorial-kicker">{s.label}</div>
            <div className={`display-type mt-2 text-[34px] leading-none md:text-[40px] ${s.tone === 'bad' ? 'text-[var(--color-bad)]' : s.tone === 'warn' ? 'text-[var(--color-warn)]' : s.tone === 'info' ? 'text-[var(--color-brand)]' : 'text-[var(--color-ink)]'}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {board.projects.length === 0 ? (
        <Card><Empty hint="暂无未完任务——名下任务全部完成，或去项目列表认领（项目详情页任务行可就地改责任人）" /></Card>
      ) : (
        <div className="space-y-8">
          {board.projects.map((g, i) => (
            <ProjectBlock key={g.projectId} group={g} today={board.today} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 单项目分组：SectionHeading + 任务甘特卡（未排期任务沉底收组） */
function ProjectBlock({ group, today, index }: { group: MyTasksBoard['projects'][number]; today: string; index: number }) {
  const dated = useMemo(() => group.tasks.filter((t) => dateRangeForm(t.planStartDate, t.planEndDate) !== 'none'), [group.tasks])
  const unscheduled = useMemo(() => group.tasks.filter((t) => dateRangeForm(t.planStartDate, t.planEndDate) === 'none'), [group.tasks])
  const axis = useMemo(() => computeAxis(dated, today, 3), [dated, today])
  const dayPx = axis ? Math.max(3, Math.min(14, 1100 / axis.totalDays)) : 0
  const trackW = axis ? Math.ceil(axis.totalDays * dayPx) : 0
  const todayLeftPx = axis ? LABEL_W + (trackW * ((dayNum(today) - axis.start) / axis.totalDays)) : 0
  const ticks = axis ? monthTicks(axis) : []
  const sorted = useMemo(() => [...dated].sort((a, b) =>
    dayNum(a.planStartDate || a.planEndDate!) - dayNum(b.planStartDate || b.planEndDate!)
    || a.planEndDate!.localeCompare(b.planEndDate!)), [dated])

  return (
    <section data-testid="myt-project" aria-label={group.projectName}>
      <SectionHeading
        index={`0${index + 1}`}
        title={<a className="display-type editorial-link text-[20px] font-semibold" href={`#/projects/${group.projectId}`}>{group.projectName}</a>}
        aside={<span className="num text-[11px] tracking-[0.1em] text-[var(--color-ink-soft)]">{group.tasks.length} 项未完 · 前往项目 →</span>}
      />
      <Card>
        {axis ? (
          <div className="overflow-x-auto">
            <div style={{ width: LABEL_W + trackW }}>
              <div className="flex border-b border-[var(--color-line)]">
                <div className="sticky left-0 z-20 shrink-0 border-r border-[var(--color-line)] bg-[var(--color-card)] px-3 py-1.5 text-[12px] text-[var(--color-ink-soft)]" style={{ width: LABEL_W }}>任务（#{group.tasks.length}）</div>
                <div className="relative h-7 shrink-0" style={{ width: trackW }}>
                  {ticks.map((t) => (
                    <span key={t.label} data-testid="gantt-tick" className="absolute top-0 h-full border-l border-[var(--color-line)] pl-1 text-[11px] text-[var(--color-ink-soft)]" style={{ left: `${t.leftPct}%` }}>{t.label}</span>
                  ))}
                </div>
              </div>
              <div className="relative">
                {sorted.map((t) => {
                  const b = barLayout(t, axis)!
                  const overdue = t.overdueDays > 0
                  return (
                    <div key={t.id} className="flex border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
                      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 overflow-hidden border-r border-[var(--color-line)] bg-[var(--color-card)] px-3 py-1.5" style={{ width: LABEL_W }}>
                        <span className="num shrink-0 text-[10px] text-[var(--color-ink-faint)]">#{t.id}</span>
                        <a className="truncate text-[12px] text-[var(--color-ink)] hover:text-[var(--color-brand)]" href={`#/projects/${t.projectId}`} title={t.title}>{t.title}</a>
                        {t.isReminder && <span data-testid="myt-reminder" className="shrink-0" title="纯提醒任务（S57：到期推送后自动完成，不进追踪口径）">⏰</span>}
                        <Badge tone={TASK_STATUS_TONE[t.status] || 'muted'}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge>
                        {overdue && <Badge tone="bad" >逾期 {t.overdueDays} 天</Badge>}
                      </div>
                      <div className="relative shrink-0" style={{ width: trackW, height: 34 }}>
                        <TaskBar t={t} b={b} />
                      </div>
                    </div>
                  )
                })}
                <div data-testid="gantt-today" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[var(--color-brand)]" style={{ left: todayLeftPx }} />
              </div>
            </div>
          </div>
        ) : (
          <Empty hint="该项目名下任务均未排期（见下方未排期组）" />
        )}
        {unscheduled.length > 0 && (
          <div data-testid="unscheduled-group" className={axis ? 'mt-3 border-t border-[var(--color-line)] pt-3' : ''}>
            <div className="editorial-kicker mb-2">未排期（{unscheduled.length}）——补齐计划日期后进入时间线</div>
            <ul className="flex flex-wrap gap-2">
              {unscheduled.map((t) => (
                <li key={t.id} className="flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-panel)]/50 px-2.5 py-1.5 text-[12px]">
                  <span className="num text-[10px] text-[var(--color-ink-faint)]">#{t.id}</span>
                  <a className="text-[var(--color-ink)] hover:text-[var(--color-brand)]" href={`#/projects/${t.projectId}`}>{t.title}</a>
                  {t.isReminder && <span data-testid="myt-reminder" title="纯提醒任务">⏰</span>}
                  <Badge tone={TASK_STATUS_TONE[t.status] || 'muted'}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  )
}

/** 任务条：S30 四形态 + S41 状态色；逾期红优先于状态色（title 原生 tooltip，零依赖） */
function TaskBar({ t, b }: {
  t: MyTaskRow
  b: { form: 'range' | 'deadline' | 'open'; leftPct: number; widthPct: number }
}) {
  const overdue = t.overdueDays > 0
  const color = overdue ? 'var(--color-bad)' : STATUS_BAR_COLOR[t.status] || 'var(--color-ink-soft)'
  const tip = `${t.title} · ${fmtDateRange(t.planStartDate, t.planEndDate)} · ${TASK_STATUS_LABEL[t.status] || t.status}${overdue ? ` · 逾期 ${t.overdueDays} 天` : ''}`
  if (b.form === 'deadline') {
    return (
      <>
        <div className="absolute top-1/2 border-t border-dashed border-[var(--color-line)]" style={{ left: 0, width: `${b.widthPct}%` }} title={tip} />
        <div data-testid="gantt-bar" className="absolute top-1 h-4 w-[2px]" style={{ left: `${b.widthPct}%`, backgroundColor: overdue ? 'var(--color-bad)' : 'var(--color-warn)' }} title={tip} />
      </>
    )
  }
  if (b.form === 'open') {
    const style: CSSProperties = {
      left: `${b.leftPct}%`, width: `${b.widthPct}%`, height: 10,
      backgroundImage: `linear-gradient(to right, ${color}, transparent)`, // 渐隐=无期限，右端不封口
    }
    return <div data-testid="gantt-bar" className="absolute top-1/2 -translate-y-1/2 rounded-l-full" style={style} title={tip} />
  }
  return <div data-testid="gantt-bar" className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full" style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, backgroundColor: color }} title={tip} />
}
