import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Card, Empty, Spinner } from '../components/ui'
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

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">全局看板 <span className="text-[12px] font-normal text-[var(--color-ink-soft)]">{member?.name} · 按优先级档位排序 · 健康度口径与 Agent metrics 端点同源</span></h1>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><div className="text-[12px] text-[var(--color-ink-soft)]">在跑项目</div><div className="num text-2xl font-bold">{totalRunning}</div></Card>
        <Card><div className="text-[12px] text-[var(--color-ink-soft)]">逾期任务</div><div className={`num text-2xl font-bold ${totalOverdue ? 'text-[var(--color-bad)]' : ''}`}>{totalOverdue}</div></Card>
        <Card><div className="text-[12px] text-[var(--color-ink-soft)]">沉默项目（≥7 天无事件）</div><div className={`num text-2xl font-bold ${silentCount ? 'text-[var(--color-warn)]' : ''}`}>{silentCount}</div></Card>
        <Card>
          <div className="text-[12px] text-[var(--color-ink-soft)]">关键人负载（并行/上限）</div>
          <div className="mt-1 space-y-0.5">
            {(load?.rows || []).filter((r) => Number(r.parallelProjects) > 0).slice(0, 3).map((r) => (
              <div key={String(r.member)} className="flex items-center justify-between text-[12px]">
                <span>{String(r.member)}{r.isKeyPerson ? ' ★' : ''}</span>
                <span className={`num ${r.overloaded ? 'font-bold text-[var(--color-bad)]' : ''}`}>{String(r.parallelProjects)}/{String(r.maxParallelProjects)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="在跑项目（高 → 中 → 低）">
        {projects.length === 0 ? <Empty hint="暂无在跑项目，去项目列表立项" /> : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
              <tr className="border-b border-[var(--color-line)]">
                <th className="py-1.5">优先级</th><th>项目</th><th>牵头人</th><th>状态</th>
                <th className="num">逾期</th><th className="num">沉默天数</th><th>健康度</th><th>计划截止</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
                  <td className="py-1.5"><Badge tone={p.priority === 'high' ? 'bad' : p.priority === 'medium' ? 'warn' : 'muted'}>{PRIORITY_LABEL[p.priority]}</Badge></td>
                  <td><a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a></td>
                  <td>{p.leadName}</td>
                  <td>{PROJECT_STATUS_LABEL[p.status] || p.status}</td>
                  <td className={`num ${p.overdueTasks ? 'text-[var(--color-bad)]' : ''}`}>{p.overdueTasks}</td>
                  <td className="num">{p.silentDays ?? '—'}</td>
                  <td><Badge tone={healthOf(p)}>{HEALTH_LABEL[healthOf(p)]}</Badge></td>
                  <td className="num">{p.planEndDate || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
