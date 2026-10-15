import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Spinner } from '../components/ui'
import { PageMasthead, SectionHeading } from '../components/editorial'
import { PRIORITY_LABEL, PROJECT_STATUS_LABEL, type MetricQuery, type ProjectRow } from '../types'

function healthOf(p: ProjectRow): 'ok' | 'warn' | 'bad' | 'muted' {
  if (p.overdueTasks >= 3 || (p.silentDays ?? 0) >= 7) return 'bad'
  if (p.overdueTasks >= 1 || (p.silentDays ?? 0) >= 3) return 'warn'
  return 'ok'
}
const HEALTH_LABEL = { ok: '绿', warn: '黄', bad: '红', muted: '—' } as const

export default function Dashboard() {
  const { member } = useStore()
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [running, setRunning] = useState<MetricQuery | null>(null)
  const [overdue, setOverdue] = useState<MetricQuery | null>(null)
  const [load, setLoad] = useState<MetricQuery | null>(null)
  const [silent, setSilent] = useState<MetricQuery | null>(null)

  useEffect(() => {
    void (async () => {
      const [p, r, o, l, s] = await Promise.all([
        api.projects(), api.metric('running_projects'), api.metric('overdue_tasks'),
        api.metric('keyperson_load'), api.metric('silent_projects'),
      ])
      setProjects(p.projects); setRunning(r); setOverdue(o); setLoad(l); setSilent(s)
    })()
  }, [])

  if (!projects) return <Spinner />

  const totalRunning = running?.rows.reduce((s, r) => s + Number(r.count), 0) ?? 0
  const totalOverdue = overdue?.rows.reduce((s, r) => s + Number(r.overdue || 0), 0) ?? 0
  const silentCount = silent?.rows.reduce((s, r) => s + Number(r.count), 0) ?? 0
  const loadRows = (load?.rows || []).filter((r) => Number(r.parallelProjects) > 0).slice(0, 3)

  return (
    <div className="space-y-10 md:space-y-12">
      <PageMasthead
        testId="dashboard-masthead"
        kicker="Overview / 01"
        title="全局看板"
        description={<>{member?.name}，这里是此刻的项目组合。先看整体节奏，再把目光放到需要风险干预的地方。</>}
        aside={(
          <div className="max-w-[240px] md:border-l md:border-[var(--color-line-strong)] md:pl-5">
            <div className="text-[10px] font-semibold tracking-[0.16em] text-[var(--color-ink-faint)]">PORTFOLIO NOTES</div>
            <div className="mt-2 text-[12px] leading-5 text-[var(--color-ink-soft)]">按优先级档位排序<br />健康度与 Agent metrics 同源</div>
          </div>
        )}
      />

      <section data-testid="dashboard-metrics" className="editorial-enter-late grid overflow-hidden rounded-[5px] border border-[var(--color-line)] bg-[var(--color-card)] xl:grid-cols-12">
        <div className="flex min-h-[270px] flex-col justify-between border-b border-[var(--color-line)] p-6 md:p-8 xl:col-span-5 xl:border-b-0 xl:border-r">
          <div className="flex items-start justify-between gap-4">
            <div className="editorial-kicker">Active projects / 在跑项目</div>
            <span className="num text-[10px] text-[var(--color-ink-faint)]">01</span>
          </div>
          <div className="my-8 flex items-end gap-4">
            <div className="num text-[92px] font-light leading-[0.82] tracking-[-0.075em] text-[var(--color-ink)] md:text-[112px]">{totalRunning}</div>
            <div className="pb-1 text-[12px] leading-5 text-[var(--color-ink-soft)]">个项目<br />正在推进</div>
          </div>
          <p className="max-w-[320px] border-t border-[var(--color-line)] pt-4 text-[12px] leading-5 text-[var(--color-ink-soft)]">
            每一个数字背后，都是正在发生的工作。保持节奏，也给风险留出被看见的位置。
          </p>
        </div>

        <div className="grid sm:grid-cols-2 xl:col-span-7">
          <div className="border-b border-[var(--color-line)] p-6 sm:border-r md:p-7">
            <div className="text-[11px] text-[var(--color-ink-soft)]">逾期任务</div>
            <div className={`num mt-5 text-[48px] font-light leading-none tracking-[-0.055em] ${totalOverdue ? 'text-[var(--color-bad)]' : 'text-[var(--color-ink)]'}`}>{totalOverdue}</div>
            <div className="mt-4 text-[10px] tracking-[0.12em] text-[var(--color-ink-faint)]">OVERDUE TASKS</div>
          </div>
          <div className="border-b border-[var(--color-line)] p-6 md:p-7">
            <div className="text-[11px] text-[var(--color-ink-soft)]">沉默项目（≥7 天无事件）</div>
            <div className={`num mt-5 text-[48px] font-light leading-none tracking-[-0.055em] ${silentCount ? 'text-[var(--color-warn)]' : 'text-[var(--color-ink)]'}`}>{silentCount}</div>
            <div className="mt-4 text-[10px] tracking-[0.12em] text-[var(--color-ink-faint)]">SILENT PROJECTS</div>
          </div>
          <div className="p-6 sm:col-span-2 md:p-7">
            <div className="flex items-center justify-between gap-4">
              <div className="text-[11px] text-[var(--color-ink-soft)]">关键人负载</div>
              <div className="text-[9px] tracking-[0.14em] text-[var(--color-ink-faint)]">并行 / 上限</div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {loadRows.length === 0 && <div className="py-2 text-[12px] text-[var(--color-ink-faint)]">当前没有并行项目负载</div>}
              {loadRows.map((r) => (
                <div key={String(r.member)} className="border-l border-[var(--color-line-strong)] pl-3">
                  <div className="truncate text-[12px]">{String(r.member)}{r.isKeyPerson ? ' ★' : ''}</div>
                  <div className={`num mt-1 text-[20px] font-light ${r.overloaded ? 'font-medium text-[var(--color-bad)]' : ''}`}>{String(r.parallelProjects)}<span className="text-[13px] text-[var(--color-ink-faint)]"> / {String(r.maxParallelProjects)}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section data-testid="project-index" className="editorial-enter-late">
        <SectionHeading index="02" title="在跑项目" aside={<span className="num">{projects.length} 个项目 · 高 → 中 → 低</span>} />
        {projects.length === 0 ? (
          <div className="border-b border-[var(--color-line)] py-14 text-center">
            <div className="display-type text-[28px]">版面已备好。</div>
            <p className="mt-3 text-[13px] text-[var(--color-ink-soft)]">暂无在跑项目，去项目列表立项</p>
            <a href="#/projects" className="editorial-link mt-5 inline-block text-[12px] font-medium text-[var(--color-brand)]">前往项目组合 →</a>
          </div>
        ) : (
          <div className="overflow-x-auto border-b border-[var(--color-line)]">
            <table className="w-full min-w-[48rem] text-[13px]">
              <thead className="text-left text-[10px] font-medium tracking-[0.08em] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap [&>th]:px-4 [&>th]:py-3">
                  <th>优先级</th><th>项目</th><th>牵头人</th><th>状态</th>
                  <th className="num">逾期</th><th className="num">沉默天数</th><th>健康度</th><th>计划截止</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="border-b border-[var(--color-line)] transition-colors last:border-0 hover:bg-[var(--color-panel)]/60 [&>td]:px-4 [&>td]:py-4">
                    <td><Badge tone={p.priority === 'high' ? 'bad' : p.priority === 'medium' ? 'warn' : 'muted'}>{PRIORITY_LABEL[p.priority]}</Badge></td>
                    <td><a className="display-type editorial-link whitespace-nowrap text-[16px] font-semibold text-[var(--color-ink)]" href={`#/projects/${p.id}`}>{p.name}</a></td>
                    <td className="whitespace-nowrap">{p.leadName}</td>
                    <td className="text-[var(--color-ink-soft)]">{PROJECT_STATUS_LABEL[p.status] || p.status}</td>
                    <td className={`num ${p.overdueTasks ? 'font-semibold text-[var(--color-bad)]' : ''}`}>{p.overdueTasks}</td>
                    <td className="num">{p.silentDays ?? '—'}</td>
                    <td><Badge tone={healthOf(p)}>{HEALTH_LABEL[healthOf(p)]}</Badge></td>
                    <td className="num whitespace-nowrap">{p.planEndDate || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
