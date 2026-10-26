import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, type MyTaskRow, type MyTasksBoard } from '../types'
import { PageMasthead, SectionHeading } from '../components/editorial'
import { Badge, Card, Empty, Spinner } from '../components/ui'
import { dateRangeForm, fmtDateRange } from '../fmt'

// S66（v0.73 K52 建 / v0.75 K55 展示改版）我的任务工作台：跨在跑项目聚合本人未完任务（/my 斜杠同口径），
// 按项目分组的 todolist 待办清单——项目内按计划时间升序（有截止日按截止日、仅有开工日按开工日），
// 逾期整行红提示（行底红晕 + 红日期 + 红徽章）；无日期任务沉底「未排期」不虚构；不画甘特（K55）。

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
        description="跨项目聚合你名下的全部未完任务——按项目分组的待办清单，按时间排序。逾期标红、本周到期标黄，纯提醒任务带 ⏰。"
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
            <ProjectBlock key={g.projectId} group={g} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 单项目分组：todolist 清单按计划时间升序（逾期日期在过去自然排前），未排期沉底收组 */
function ProjectBlock({ group, index }: { group: MyTasksBoard['projects'][number]; index: number }) {
  const dated = useMemo(() => group.tasks.filter((t) => dateRangeForm(t.planStartDate, t.planEndDate) !== 'none'), [group.tasks])
  const unscheduled = useMemo(() => group.tasks.filter((t) => dateRangeForm(t.planStartDate, t.planEndDate) === 'none'), [group.tasks])
  const sorted = useMemo(() => [...dated].sort((a, b) =>
    (a.planEndDate || a.planStartDate)!.localeCompare((b.planEndDate || b.planStartDate)!)), [dated])

  return (
    <section data-testid="myt-project" aria-label={group.projectName}>
      <SectionHeading
        index={`0${index + 1}`}
        title={<a className="display-type editorial-link text-[20px] font-semibold" href={`#/projects/${group.projectId}`}>{group.projectName}</a>}
        aside={<span className="num text-[11px] tracking-[0.1em] text-[var(--color-ink-soft)]">{group.tasks.length} 项未完 · 前往项目 →</span>}
      />
      <Card>
        {sorted.length > 0 ? (
          <ul data-testid="myt-task-list">
            {sorted.map((t) => <TaskRow key={t.id} t={t} />)}
          </ul>
        ) : (
          <Empty hint="该项目名下任务均未排期（见下方未排期组）" />
        )}
        {unscheduled.length > 0 && (
          <div data-testid="unscheduled-group" className={sorted.length > 0 ? 'mt-3 border-t border-[var(--color-line)] pt-3' : ''}>
            <div className="editorial-kicker mb-2">未排期（{unscheduled.length}）——补齐计划日期后进入清单排序</div>
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

/** 清单行：标题链接 + 状态徽章 + S30-4 日期文案；逾期整行红提示（行底红晕 + 红日期 + 红徽章） */
function TaskRow({ t }: { t: MyTaskRow }) {
  const overdue = t.overdueDays > 0
  return (
    <li data-testid="myt-task-row" className={`flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2.5 last:border-0 hover:bg-[var(--color-bg)] ${overdue ? 'bg-[var(--color-bad-soft)]' : ''}`}>
      <span className="num w-11 shrink-0 text-right text-[10px] text-[var(--color-ink-faint)]">#{t.id}</span>
      <a className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink)] hover:text-[var(--color-brand)]" href={`#/projects/${t.projectId}`} title={t.title}>{t.title}</a>
      {t.isReminder && <span data-testid="myt-reminder" className="shrink-0" title="纯提醒任务（S57：到期推送后自动完成，不进追踪口径）">⏰</span>}
      <Badge tone={TASK_STATUS_TONE[t.status] || 'muted'}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge>
      <span data-testid="myt-task-date" className={`num shrink-0 text-[12px] ${overdue ? 'font-semibold text-[var(--color-bad)]' : 'text-[var(--color-ink-soft)]'}`}>{fmtDateRange(t.planStartDate, t.planEndDate)}</span>
      {overdue && <Badge tone="bad">逾期 {t.overdueDays} 天</Badge>}
    </li>
  )
}
