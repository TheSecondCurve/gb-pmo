import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { bjToday, dateRangeForm, fmtDateRange } from '../fmt'
import { barLayout, computeAxis, dayNum, monthTicks } from '../gantt'
import { Badge, Btn, Card, Empty, Field, InlineSelect, Modal, Spinner, inputCls } from '../components/ui'
import { PRIORITY_LABEL, PROJECT_STATUS_LABEL, type Member, type ProjectRow, type ProjectType } from '../types'

// S30（v0.29）项目组合页：一次取回三态项目，四视图纯前端切换。
// 松散排期语言贯穿全页：日期全可空合法——文案四式（fmtDateRange）、排序 null 沉底成组不穿插、
// 甘特四形态（gantt.ts 纯函数），不虚构日期、单层甘特（条色=状态）、无拖拽（编辑走表单/就地编辑）。

export type PortfolioView = 'board' | 'table' | 'people' | 'timeline'
const VIEWS: { key: PortfolioView; label: string }[] = [
  { key: 'board', label: '看板' }, { key: 'table', label: '表格' }, { key: 'people', label: '人员' }, { key: 'timeline', label: '时间线' },
]
const STATUS_KEYS = ['active', 'closed', 'cancelled'] as const
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
const PRIORITY_BAR: Record<string, string> = {
  high: 'border-l-[var(--color-bad)]', medium: 'border-l-[var(--color-warn)]', low: 'border-l-[var(--color-line)]',
}
type SortKey = 'priority' | 'delivery' | 'activity' | 'updated'
const SORT_LABEL: Record<SortKey, string> = { priority: '优先级', delivery: '交付临近', activity: '最近活跃', updated: '最近更新' }

export default function Projects({ view }: { view: PortfolioView }) {
  const { toast } = useStore()
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [creating, setCreating] = useState(false)
  const [unassigned, setUnassigned] = useState<number>(0)
  const [statuses, setStatuses] = useState<Set<string>>(new Set(STATUS_KEYS))
  const [priority, setPriority] = useState('all')
  const [q, setQ] = useState('')
  const [onlyUnscheduled, setOnlyUnscheduled] = useState(false)
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const [sort, setSort] = useState<SortKey>(() => {
    const saved = localStorage.getItem('pmo.projects.sort') as SortKey | null
    return saved && saved in SORT_LABEL ? saved : 'priority'
  })

  const refresh = async () => {
    const [p, m, u] = await Promise.all([api.projects([...STATUS_KEYS]), api.members(), api.unassigned()])
    setProjects(p.projects); setMembers(m.members); setUnassigned(u.tasks.length)
  }
  useEffect(() => { void refresh() }, [])

  const filtered = useMemo(() => (projects || []).filter((p) =>
    statuses.has(p.status)
    && (priority === 'all' || p.priority === priority)
    && (!onlyUnscheduled || dateRangeForm(p.planStartDate, p.planEndDate) === 'none')
    && (!onlyOverdue || p.overdueTasks > 0)
    && (!q.trim() || p.name.includes(q.trim()) || (p.clientName || '').includes(q.trim())),
  ), [projects, statuses, priority, q, onlyUnscheduled, onlyOverdue])

  const stats = useMemo(() => ({
    byStatus: Object.fromEntries(STATUS_KEYS.map((s) => [s, (projects || []).filter((p) => p.status === s).length])),
    unscheduled: (projects || []).filter((p) => dateRangeForm(p.planStartDate, p.planEndDate) === 'none').length,
    overdueTasks: (projects || []).reduce((s, p) => s + p.overdueTasks, 0),
  }), [projects])

  const scheduled = useMemo(() => filtered.filter((p) => dateRangeForm(p.planStartDate, p.planEndDate) !== 'none'), [filtered])
  const unscheduled = useMemo(() => filtered.filter((p) => dateRangeForm(p.planStartDate, p.planEndDate) === 'none'), [filtered])
  const sortedScheduled = useMemo(() => [...scheduled].sort((a, b) => {
    if (sort === 'delivery') {
      const av = a.daysToDelivery ?? Infinity, bv = b.daysToDelivery ?? Infinity // null 沉底（S30-2 不穿插）
      if (av !== bv) return av - bv
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    }
    if (sort === 'activity') return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0)
    if (sort === 'updated') return b.updatedAt - a.updatedAt
    const pr = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    return pr !== 0 ? pr : b.updatedAt - a.updatedAt
  }), [scheduled, sort])

  if (!projects) return <Spinner />

  const toggleStatus = (s: string) => setStatuses((prev) => {
    const next = new Set(prev)
    if (next.has(s)) { if (next.size > 1) next.delete(s) } else next.add(s) // 至少保留一个状态
    return next
  })
  const onPriority = async (p: ProjectRow, v: string) => {
    await api.patchProject(p.id, { priority: v }); toast('优先级已调整并留痕'); await refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">项目组合 {unassigned > 0 && <Badge tone="bad">未指派任务 {unassigned}</Badge>}</h1>
        <Btn kind="primary" onClick={() => setCreating(true)}>+ 立项</Btn>
      </div>

      {/* 摘要条：三态/未排期/逾期任务计数，点击即过滤（S30） */}
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {STATUS_KEYS.map((s) => (
          <FilterChip key={s} active={statuses.has(s)} onClick={() => toggleStatus(s)}>
            {PROJECT_STATUS_LABEL[s]} {stats.byStatus[s]}
          </FilterChip>
        ))}
        <FilterChip active={onlyUnscheduled} onClick={() => setOnlyUnscheduled(!onlyUnscheduled)}>未排期 {stats.unscheduled}</FilterChip>
        <FilterChip active={onlyOverdue} onClick={() => setOnlyOverdue(!onlyOverdue)}>逾期任务 {stats.overdueTasks}</FilterChip>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="搜索" className={`${inputCls} max-w-56`} placeholder="搜索项目 / 客户" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="优先级" className={`${inputCls} w-28`} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="all">全部优先级</option>
          {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {view === 'table' && (
          <select aria-label="排序维度" className={`${inputCls} w-28`} value={sort}
            onChange={(e) => { const v = e.target.value as SortKey; setSort(v); localStorage.setItem('pmo.projects.sort', v) }}>
            {Object.entries(SORT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
      </div>

      {/* 视图 Tabs：hash 深链可分享（S30-2） */}
      <div data-nav="portfolio-views" className="flex flex-wrap gap-1 border-b border-[var(--color-line)]">
        {VIEWS.map((v) => (
          <a key={v.key} href={`#/projects/${v.key}`}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
              view === v.key
                ? 'border-[var(--color-brand)] font-medium text-[var(--color-brand)]'
                : 'border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]'
            }`}>{v.label}</a>
        ))}
      </div>

      {filtered.length === 0 ? <Card><Empty hint="无符合条件的项目" /></Card> : (
        view === 'board' ? <BoardView rows={filtered} />
          : view === 'people' ? <PeopleView rows={filtered} />
            : view === 'timeline' ? <TimelineView rows={filtered} />
              : <TableView rows={sortedScheduled} unscheduled={unscheduled} onPriority={onPriority} />
      )}

      {creating && <CreateModal members={members} onClose={() => setCreating(false)} onDone={async () => { setCreating(false); toast('立项成功'); await refresh() }} />}
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border px-2.5 py-1 transition-colors ${
        active
          ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]'
          : 'border-[var(--color-line)] bg-[var(--color-card)] text-[var(--color-ink-soft)] hover:border-[var(--color-brand)]'
      }`}>{children}</button>
  )
}

function StatusBadge({ p }: { p: ProjectRow }) {
  return <Badge tone={p.status === 'active' ? 'ok' : 'muted'}>{PROJECT_STATUS_LABEL[p.status] || p.status}</Badge>
}

/** 交付倒计时徽章（S21 口径：填了交付日期才派生；终态/未填为 null 不展示） */
function DeliveryBadge({ p }: { p: ProjectRow }) {
  if (!p.planEndDate || p.daysToDelivery == null) return null
  return p.daysToDelivery >= 0
    ? <Badge tone={p.daysToDelivery <= 3 ? 'warn' : 'muted'}>{p.daysToDelivery === 0 ? '今日交付' : `剩 ${p.daysToDelivery} 天`}</Badge>
    : <Badge tone="bad">超期 {-p.daysToDelivery} 天</Badge>
}

function TableView({ rows, unscheduled, onPriority }: {
  rows: ProjectRow[]; unscheduled: ProjectRow[]; onPriority: (p: ProjectRow, v: string) => Promise<void>
}) {
  const row = (p: ProjectRow) => (
    <tr key={p.id} className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
      <td className="py-1">
        <InlineSelect value={p.priority} options={PRIORITY_LABEL} onSubmit={(v) => onPriority(p, v)} />
      </td>
      <td><a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>{p.clientName ? <span className="text-[var(--color-ink-soft)]">（{p.clientName}）</span> : null}</td>
      <td>{p.leadName}</td>
      <td><StatusBadge p={p} /></td>
      <td className={`num ${p.overdueTasks ? 'text-[var(--color-bad)]' : ''}`}>{p.overdueTasks}</td>
      <td className="num whitespace-nowrap">
        {fmtDateRange(p.planStartDate, p.planEndDate)} <DeliveryBadge p={p} />
      </td>
      <td className="text-[var(--color-ink-soft)]">{p.typeName || p.templateCode}</td>
    </tr>
  )
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-[13px]">
          <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
            <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap">
              <th className="py-1.5">优先级</th><th>项目</th><th>牵头人</th><th>状态</th>
              <th className="num">逾期</th><th>交付周期（S21）</th><th>类型</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row)}
            {unscheduled.length > 0 && (
              <>
                <tr data-testid="unscheduled-group" className="border-b border-[var(--color-line)] bg-[var(--color-bg)]">
                  <td colSpan={7} className="px-2 py-1.5 text-[12px] font-medium text-[var(--color-ink-soft)]">
                    未排期（{unscheduled.length}）— 松散管理合法态，填计划日期后参与排序与时间线
                  </td>
                </tr>
                {unscheduled.map(row)}
              </>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ProjectCard({ p }: { p: ProjectRow }) {
  return (
    <div className={`rounded-md border border-[var(--color-line)] border-l-4 ${PRIORITY_BAR[p.priority]} bg-[var(--color-card)] p-2.5 text-[13px] ${p.status === 'cancelled' ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <a className="font-medium text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>
        <StatusBadge p={p} />
      </div>
      <div className="mt-1 truncate text-[12px] text-[var(--color-ink-soft)]">
        {p.clientName ? `${p.clientName} · ` : ''}{p.typeName || p.templateCode} · {p.leadName}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="num text-[var(--color-ink-soft)]">{fmtDateRange(p.planStartDate, p.planEndDate)}</span>
        <DeliveryBadge p={p} />
        {p.overdueTasks > 0 && <Badge tone="bad">逾期 {p.overdueTasks}</Badge>}
        {p.status === 'active' && p.silentDays != null && p.silentDays >= 3 && <Badge tone="warn">静默 {p.silentDays} 天</Badge>}
      </div>
    </div>
  )
}

function BoardView({ rows }: { rows: ProjectRow[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {STATUS_KEYS.map((s) => {
        const col = rows.filter((p) => p.status === s)
        return (
          <section key={s} data-testid={`board-col-${s}`} className="rounded-lg border border-[var(--color-line)] bg-[var(--color-card)]">
            <header className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-2 text-[13px] font-semibold">
              <span>{PROJECT_STATUS_LABEL[s]} <span className="num font-normal text-[var(--color-ink-soft)]">{col.length}</span></span>
              {s !== 'active' && col.length > 0 && (
                <Btn small kind="ghost" onClick={() => setCollapsed((c) => ({ ...c, [s]: !c[s] }))}>{collapsed[s] ? '展开' : '折叠'}</Btn>
              )}
            </header>
            <div className="space-y-2 p-2">
              {col.length === 0 ? <Empty hint="无" /> : collapsed[s] ? (
                <button type="button" className="w-full rounded-md border border-dashed border-[var(--color-line)] px-2 py-2 text-[12px] text-[var(--color-ink-soft)] hover:border-[var(--color-brand)]"
                  onClick={() => setCollapsed((c) => ({ ...c, [s]: false }))}>已折叠 {col.length} 项，点击展开</button>
              ) : col.map((p) => <ProjectCard key={p.id} p={p} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function PeopleView({ rows }: { rows: ProjectRow[] }) {
  const groups = useMemo(() => {
    const map = new Map<number, { leadName: string; projects: ProjectRow[] }>()
    for (const p of rows) {
      const g = map.get(p.leadMemberId) || { leadName: p.leadName, projects: [] }
      g.projects.push(p)
      map.set(p.leadMemberId, g)
    }
    return [...map.values()]
      .map((g) => ({
        ...g,
        activeCount: g.projects.filter((p) => p.status === 'active').length,
        overdue: g.projects.reduce((s, p) => s + p.overdueTasks, 0),
      }))
      .sort((a, b) => b.activeCount - a.activeCount || b.projects.length - a.projects.length || a.leadName.localeCompare(b.leadName))
  }, [rows])
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={`${g.leadName}-${g.projects[0]?.leadMemberId}`} data-testid="people-group" className="rounded-lg border border-[var(--color-line)] bg-[var(--color-card)]">
          <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2 text-[13px]">
            <span className="font-semibold">{g.leadName}</span>
            <span className="text-[12px] text-[var(--color-ink-soft)]">
              在跑 {g.activeCount} · 共 {g.projects.length}{g.overdue > 0 ? ` · 逾期任务 ${g.overdue}` : ''}
            </span>
          </header>
          <ul className="divide-y divide-[var(--color-line)]">
            {[...g.projects].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.updatedAt - a.updatedAt).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-1.5 text-[13px]">
                <a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>
                <StatusBadge p={p} />
                <Badge tone={p.priority === 'high' ? 'bad' : p.priority === 'medium' ? 'warn' : 'muted'}>{PRIORITY_LABEL[p.priority]}</Badge>
                <span className="num ml-auto text-[12px] text-[var(--color-ink-soft)]">{fmtDateRange(p.planStartDate, p.planEndDate)}</span>
                {p.overdueTasks > 0 && <Badge tone="bad">逾期 {p.overdueTasks}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const GANTT_LABEL_W = 224

/** 甘特单元格：单层条形，形态与颜色语义见 gantt.ts / S30-3（title 原生 tooltip，零依赖） */
function GanttBarCell({ p, b }: {
  p: ProjectRow; b: { form: 'range' | 'deadline' | 'open'; leftPct: number; widthPct: number }
}) {
  const tip = `${p.name} · ${fmtDateRange(p.planStartDate, p.planEndDate)} · ${PROJECT_STATUS_LABEL[p.status] || p.status} · ${p.leadName}`
  const color = p.status === 'active' ? 'var(--color-brand)' : 'var(--color-ink-soft)'
  if (b.form === 'deadline') {
    return (
      <>
        {/* 虚线引导=尚未排期（不是区间），止于旗标 */}
        <div className="absolute top-1/2 border-t border-dashed border-[var(--color-line)]" style={{ left: 0, width: `${b.widthPct}%` }} title={tip} />
        <div data-testid="gantt-bar" className="absolute top-1 h-4 w-[2px] bg-[var(--color-warn)]" style={{ left: `${b.widthPct}%` }} title={tip} />
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
  const style: CSSProperties = { left: `${b.leftPct}%`, width: `${b.widthPct}%`, backgroundColor: color }
  if (p.status === 'cancelled') {
    return (
      <div data-testid="gantt-bar" className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full opacity-50"
        style={{ ...style, backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(0,0,0,.3) 3px, rgba(0,0,0,.3) 6px)' }} title={tip} />
    )
  }
  return <div data-testid="gantt-bar" className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full" style={style} title={tip} />
}

function UnscheduledCard({ rows }: { rows: ProjectRow[] }) {
  if (rows.length === 0) return null
  return (
    <div data-testid="unscheduled-group">
      <Card title={`未排期（${rows.length}）— 松散管理合法态，补齐计划日期后进入时间线`}>
        <ul className="divide-y divide-[var(--color-line)]">
          {rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[13px]">
              <a className="text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`}>{p.name}</a>
              <StatusBadge p={p} />
              <Badge tone={p.priority === 'high' ? 'bad' : p.priority === 'medium' ? 'warn' : 'muted'}>{PRIORITY_LABEL[p.priority]}</Badge>
              <span className="ml-auto text-[12px] text-[var(--color-ink-soft)]">{p.leadName}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function TimelineView({ rows }: { rows: ProjectRow[] }) {
  const today = bjToday()
  const dated = useMemo(() => rows.filter((p) => dateRangeForm(p.planStartDate, p.planEndDate) !== 'none'), [rows])
  const unscheduled = useMemo(() => rows.filter((p) => dateRangeForm(p.planStartDate, p.planEndDate) === 'none'), [rows])
  const axis = useMemo(() => computeAxis(rows, today), [rows, today])

  if (!axis) {
    return (
      <div className="space-y-4">
        <Card><Empty hint="暂无可排期项目（所有项目均未填计划日期，补齐后在此呈现时间线）" /></Card>
        <UnscheduledCard rows={unscheduled} />
      </div>
    )
  }

  const dayPx = Math.max(2, Math.min(12, 1400 / axis.totalDays)) // 跨度越长日宽越窄，总宽约 1400px 封顶
  const trackW = Math.ceil(axis.totalDays * dayPx)
  const todayLeftPx = GANTT_LABEL_W + (trackW * ((dayNum(today) - axis.start) / axis.totalDays))
  const ticks = monthTicks(axis)
  const sorted = [...dated].sort((a, b) =>
    dayNum(a.planStartDate || a.planEndDate!) - dayNum(b.planStartDate || b.planEndDate!)
    || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])

  return (
    <div className="space-y-4">
      <Card title={`时间线（${dated.length} 有排期 · 今日 ${today}）`}>
        <div className="overflow-x-auto">
          <div style={{ width: GANTT_LABEL_W + trackW }}>
            <div className="flex border-b border-[var(--color-line)]">
              <div className="sticky left-0 z-20 shrink-0 border-r border-[var(--color-line)] bg-[var(--color-card)] px-3 py-1.5 text-[12px] text-[var(--color-ink-soft)]" style={{ width: GANTT_LABEL_W }}>项目</div>
              <div className="relative h-7 shrink-0" style={{ width: trackW }}>
                {ticks.map((t) => (
                  <span key={t.label} data-testid="gantt-tick" className="absolute top-0 h-full border-l border-[var(--color-line)] pl-1 text-[11px] text-[var(--color-ink-soft)]" style={{ left: `${t.leftPct}%` }}>{t.label}</span>
                ))}
              </div>
            </div>
            <div className="relative">
              {sorted.map((p) => {
                const b = barLayout(p, axis)!
                return (
                  <div key={p.id} className="flex border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-bg)]">
                    <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 overflow-hidden border-r border-[var(--color-line)] bg-[var(--color-card)] px-3 text-[12px]" style={{ width: GANTT_LABEL_W }}>
                      <a className="truncate text-[var(--color-brand)] hover:underline" href={`#/projects/${p.id}`} title={p.name}>{p.name}</a>
                      {p.status !== 'active' && <span className="shrink-0 text-[10px] text-[var(--color-ink-soft)]">{PROJECT_STATUS_LABEL[p.status]}</span>}
                    </div>
                    <div className="relative shrink-0" style={{ width: trackW, height: 32 }}>
                      <GanttBarCell p={p} b={b} />
                    </div>
                  </div>
                )
              })}
              <div data-testid="gantt-today" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[var(--color-brand)]" style={{ left: todayLeftPx }} />
            </div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">
          形态：实心条=有起止 · 旗标=只有交付日（虚线=尚未排期） · 渐隐条=只有开始日 · 条色=状态（灰=已结项，斜纹=已取消）
        </div>
      </Card>
      <UnscheduledCard rows={unscheduled} />
    </div>
  )
}

function CreateModal({ members, onClose, onDone }: { members: Member[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [types, setTypes] = useState<ProjectType[]>([])
  const [form, setForm] = useState({ name: '', typeCode: '', leadMemberId: '', priority: 'medium', clientName: '', planStartDate: '', planEndDate: '' })
  const [tasksText, setTasksText] = useState('')
  const [tasksDirty, setTasksDirty] = useState(false) // 未改动=按类型清单实例化（source=template）；改动过=自定义（source=manual）
  const [backfill, setBackfill] = useState(false) // S1-7：按交付日期倒排任务计划起止
  const [schedule, setSchedule] = useState<{ planStartDate: string; planEndDate: string }[] | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    void (async () => {
      const t = await api.projectTypes()
      const active = t.types.filter((x) => x.status === 'active')
      setTypes(active)
      if (active.length) {
        setForm((f) => ({ ...f, typeCode: f.typeCode || active[0].code }))
        setTasksText(active[0].tasks.map((x) => x.title).join('\n'))
      }
    })()
  }, [])

  const chosen = types.find((t) => t.code === form.typeCode)
  // 切类型：未手改过清单则跟随预填；改过则保留（用户已表达自定义意图）
  const switchType = (code: string) => {
    set('typeCode', code)
    if (!tasksDirty) setTasksText((types.find((t) => t.code === code)?.tasks ?? []).map((x) => x.title).join('\n'))
  }
  const titles = tasksText.split('\n').map((l) => l.trim()).filter(Boolean)

  // 倒排预览：engine 同一公式（POST preview-schedule，不落库）
  useEffect(() => {
    if (!backfill || !form.planEndDate || titles.length === 0) { setSchedule(null); return }
    let alive = true
    void (async () => {
      try {
        const out = await api.previewSchedule({ planStartDate: form.planStartDate || undefined, planEndDate: form.planEndDate, count: titles.length })
        if (alive) setSchedule(out.schedule)
      } catch { if (alive) setSchedule(null) }
    })()
    return () => { alive = false }
  }, [backfill, form.planStartDate, form.planEndDate, titles.length])

  const submit = async () => {
    try {
      await api.createProject({
        ...form, leadMemberId: Number(form.leadMemberId),
        ...(tasksDirty ? { tasks: titles } : {}), // 未改动→缺省按类型清单（S1-2）；改动过→显式覆盖（S1-6，空清单=空项目）
        ...(backfill && form.planEndDate ? { autoSchedule: true } : {}),
      })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <Modal title="立项（S1）" onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="项目名 *"><input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="项目类型（预填任务清单，可在下方自由增删改；类型在配置台维护）">
          <select className={inputCls} value={form.typeCode} onChange={(e) => switchType(e.target.value)}>
            {types.map((t) => (
              <option key={t.code} value={t.code}>{t.name}（{t.tasks.length} 项任务）</option>
            ))}
          </select>
        </Field>
      </div>
      {chosen?.description && <div className="-mt-2 mb-3 text-[11px] text-[var(--color-ink-soft)]">{chosen.description}</div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="牵头人 *（必填，任务默认责任人）">
          <select className={inputCls} value={form.leadMemberId} onChange={(e) => set('leadMemberId', e.target.value)}>
            <option value="">选择成员…</option>
            {members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="优先级">
          <select className={inputCls} value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="客户（可选）"><input className={inputCls} value={form.clientName} onChange={(e) => set('clientName', e.target.value)} /></Field>
        <Field label="计划开始"><input type="date" className={inputCls} value={form.planStartDate} onChange={(e) => set('planStartDate', e.target.value)} /></Field>
        <Field label="交付日期（选填：填了派生剩余/超期天数并进项目日历）"><input type="date" className={inputCls} value={form.planEndDate} onChange={(e) => set('planEndDate', e.target.value)} /></Field>
      </div>
      <Field label={`任务清单（每行一条；选类型自动预填${tasksDirty ? '，已自定义——不携带类型预设的参考资料' : '，含类型逐步骤参考资料（立项后任务行可见「参考 N」）'}；留空=空项目）`}>
        <textarea className={inputCls} rows={8} value={tasksText} onChange={(e) => { setTasksText(e.target.value); setTasksDirty(true) }} placeholder={'需求确认与范围冻结\n技术方案与排期\n开发联调\n结项复盘'} />
      </Field>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Btn small disabled={!form.name.trim() || drafting} onClick={async () => {
          setDrafting(true); setErr('')
          try {
            const out = await api.draftProjectTasks({ name: form.name, description: chosen?.description || form.clientName })
            setTasksText(out.tasks.join('\n')); setTasksDirty(true)
            toast(`AI 起草 ${out.tasks.length} 条任务，可继续编辑（草稿未落库）`)
          } catch (e) { setErr((e as Error).message) } finally { setDrafting(false) }
        }}>{drafting ? 'AI 起草中…' : '✨ AI 起草任务清单'}</Btn>
        <label className="flex items-center gap-1 text-[12px]">
          <input type="checkbox" checked={backfill} disabled={!form.planEndDate} onChange={(e) => setBackfill(e.target.checked)} />
          按交付日期倒排任务计划起止（均分，S1-7）
        </label>
        {!form.planEndDate && <span className="text-[11px] text-[var(--color-ink-soft)]">填交付日期后可倒排</span>}
      </div>
      {backfill && schedule && schedule.length === titles.length && titles.length > 0 && (
        <div className="mb-3 rounded-md border border-[var(--color-line)] p-2 text-[12px] leading-5">
          <div className="mb-1 text-[var(--color-ink-soft)]">倒排预览（末条截止 = 交付日期 {form.planEndDate}；立项后可再调整）：</div>
          {titles.map((t, i) => (
            <div key={i} className="flex gap-2"><span className="num text-[var(--color-ink-soft)]">{schedule[i].planStartDate} ~ {schedule[i].planEndDate}</span><span className="truncate">{t}</span></div>
          ))}
        </div>
      )}
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!form.name || !form.leadMemberId || !form.typeCode} onClick={submit}>立项</Btn>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">立项后请在详情页绑定核心渠道（飞书/企微专题群），未绑定会计入管理员待办。</div>
    </Modal>
  )
}
