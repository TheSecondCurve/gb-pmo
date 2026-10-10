import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { fmtDateTime } from '../fmt'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, InlineSelect, InlineText, Modal, Spinner, inputCls } from '../components/ui'
import ProgressSchedule from '../components/ProgressSchedule'
import { TASK_ROW_CLS, taskVisual } from '../progress'
import {
  EVENT_PINNED_COLS, EVENT_STATUS_LABEL, EVENT_TYPE_LABEL, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE,
  PRIORITY_LABEL, PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, TASK_STATUS_TONE,
  type ChannelRow, type EventRow, type InitAssignmentRow, type Member, type ProjectDetail, type TaskRecordRow, type TaskRefRow,
} from '../types'

export default function ProjectDetail({ id }: { id: number }) {
  const { toast, member } = useStore()
  const [p, setP] = useState<ProjectDetail | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [closing, setClosing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [binding, setBinding] = useState(false)
  const [digesting, setDigesting] = useState(false)
  const [recordsTaskId, setRecordsTaskId] = useState<number | null>(null)
  const [refsTask, setRefsTask] = useState<{ id: number; title: string } | null>(null)
  const [initAssigning, setInitAssigning] = useState(false)
  const [hiddenEventTypes, setHiddenEventTypes] = useState<string[]>([]) // S4-8 其他栏筛选：被隐藏的类型（默认空=全显）

  const refresh = useCallback(async () => {
    const [d, e, m, c] = await Promise.all([
      api.project(id), api.projectEvents(id), api.members(), api.channels(),
    ])
    setP(d); setEvents(e.events); setMembers(m.members); setChannels(c.channels.filter((ch) => ch.projectId === id))
  }, [id])
  useEffect(() => { void refresh() }, [refresh])

  if (!p) return <Spinner />
  const readonly = p.status === 'closed' || p.status === 'cancelled'
  // S17-12：渠道写权限与后端同构——管理员或该项目牵头人（通用群在配置台维护）
  const canManageChannels = !readonly && (member?.role === 'admin' || member?.id === p.leadMemberId)
  const activeMembers = members.filter((m) => m.status === 'active')
  const nameOf = (mid: number | null | undefined) => activeMembers.find((m) => m.id === mid)?.name || '（未指派）'

  // S4-7（v0.46/K25）：待确认建议一键批量处理——走 confirmEvent/rejectEvent 同口子，聚合回执
  const pendingSuggestions = events.filter((e) => e.status === 'pending')
  const batchDecide = async (action: 'confirm' | 'reject') => {
    const ids = pendingSuggestions.map((e) => e.id)
    if (!ids.length) return
    const r = action === 'confirm' ? await api.confirmEventsBatch(ids) : await api.rejectEventsBatch(ids)
    const done = ('confirmed' in r ? r.confirmed : r.rejected).length
    const failText = r.failed.length ? `，${r.failed.length} 条失败：${r.failed.map((f) => `#${f.id} ${f.message}`).join('；')}` : ''
    toast(`${action === 'confirm' ? '已生效' : '已驳回'} ${done} 条${failText}`)
    await refresh()
  }

  // S4-8（v0.47）：讨论面分栏——固定三栏（进展/风险·阻塞/财务记录）+「其他」栏（类型筛选，默认全显；
  // 未识别类型自动落其他栏不丢失）；各栏保持业务时间倒序（listEvents 返回序）
  const pinnedTypes = new Set(EVENT_PINNED_COLS.flatMap((c) => c.types))
  const otherEvents = events.filter((e) => !pinnedTypes.has(e.eventType))
  const otherTypes = [
    ...Object.keys(EVENT_TYPE_LABEL).filter((t) => !pinnedTypes.has(t)),
    ...[...new Set(otherEvents.map((e) => e.eventType))].filter((t) => !(t in EVENT_TYPE_LABEL) && !pinnedTypes.has(t)),
  ]
  const shownOther = otherEvents.filter((e) => !hiddenEventTypes.includes(e.eventType))
  const renderEvent = (e: EventRow) => (
    <li key={e.id} className="rounded-md border border-[var(--color-line)] bg-[var(--color-card)] p-2.5 text-[13px]">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
        <Badge tone={e.status === 'pending' ? 'warn' : e.status === 'effective' ? 'ok' : 'muted'}>{EVENT_STATUS_LABEL[e.status]}</Badge>
        <Badge tone="muted">{EVENT_TYPE_LABEL[e.eventType] || e.eventType}</Badge>
        <Badge tone={e.nature === 'suggestion' ? 'info' : 'muted'}>{e.nature === 'suggestion' ? '建议型' : '记录型'}</Badge>
        {e.generatedBy === 'extraction' && <Badge tone="muted">IM 抽取</Badge>}
        <span className="num">{fmtDateTime(e.businessTime)}</span>
        {e.speakerLabel && <span>{e.speakerLabel}</span>}
      </div>
      <div>{e.summary}</div>
      {e.status === 'pending' && (
        <div className="mt-2 flex gap-2">
          <Btn small kind="primary" onClick={async () => { await api.confirmEvent(e.id); toast('建议已确认生效'); await refresh() }}>确认生效</Btn>
          <Btn small onClick={async () => { await api.rejectEvent(e.id); toast('已驳回'); await refresh() }}>驳回</Btn>
        </div>
      )}
    </li>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a className="text-[13px] text-[var(--color-brand)] hover:underline" href="#/projects">← 项目列表</a>
        <h1 className="text-lg font-bold">{p.name}</h1>
        <InlineSelect value={p.priority} options={PRIORITY_LABEL} onSubmit={async (v) => { await api.patchProject(id, { priority: v }); toast('优先级已调整并留痕'); await refresh() }} />
        <Badge tone={p.status === 'active' ? 'ok' : 'muted'}>{PROJECT_STATUS_LABEL[p.status] || p.status}</Badge>
        <span className="text-[12px] text-[var(--color-ink-soft)]">牵头人 {p.leadName}{p.clientName ? ` · 客户 ${p.clientName}` : ''}{readonly ? ' · 已归档只读' : ''}</span>
        <span className="num flex items-center gap-1.5 text-[12px] text-[var(--color-ink-soft)]">
          交付日期
          {readonly ? (p.planEndDate || '—') : (
            <InlineText type="date" value={p.planEndDate} onSubmit={async (v) => {
              try { await api.patchProject(id, { planEndDate: v }); toast('交付日期已更新'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
            }} />
          )}
          {p.daysToDelivery != null && (p.daysToDelivery >= 0
            ? <Badge tone={p.daysToDelivery <= 3 ? 'warn' : 'muted'}>{p.daysToDelivery === 0 ? '今日交付' : `剩 ${p.daysToDelivery} 天`}</Badge>
            : <Badge tone="bad">超期 {-p.daysToDelivery} 天</Badge>)}
        </span>
        <div className="ml-auto flex gap-2">
          <Btn onClick={async () => setDigesting(true)} disabled={digesting}>🧠 生成梳理（S15）</Btn>
          {!readonly && <Btn kind="danger" onClick={() => setClosing(true)}>结项（S8）</Btn>}
          {!readonly && <Btn kind="ghost" onClick={() => setCancelling(true)}>取消项目</Btn>}
          {/* S37 硬删除：物理抹除全部数据（与「取消」的留痕语义互补），仅管理员，双重确认 */}
          {member?.role === 'admin' && (
            <Btn kind="ghost" onClick={async () => {
              if (!confirm(`彻底删除项目「${p.name}」？物理删除不可恢复：任务/里程碑/事件/渠道绑定等全部数据将从库中抹除（与「取消」的留痕语义不同）。`)) return
              if (!confirm(`再次确认：删除后仅存一条审计快照，数据不可恢复。确定删除「${p.name}」？`)) return
              try {
                await api.deleteProject(p.id)
                toast('项目已彻底删除')
                location.hash = '#/projects'
              } catch (e) { toast((e as Error).message, 'bad') }
            }}>彻底删除</Btn>
          )}
        </div>
      </div>

      {readonly && p.closeoutSummary && (
        <Card title={`结束原因 / 复盘记录（${p.status === 'closed' ? '已结项' : '已取消'} · 只读）`}><div className="whitespace-pre-wrap text-[13px]">{p.closeoutSummary}</div></Card>
      )}

      {/* S42（v0.44）：进度（堆叠条/完成率）与排期（任务级甘特+里程碑刻度）一屏总览；v0.49 起交付日期入轴（S42-5）。
          S57（v0.62）：进度与甘特只认工作类——纯提醒送达不算工作完成度（与 brief/metrics 口径一致，K40）。 */}
      <ProgressSchedule tasks={p.tasks.filter((t) => t.kind !== 'reminder')} milestones={p.milestones} projectEndDate={p.planEndDate} />

      <Card title={`任务面（${p.tasks.length}）${readonly ? ' · 只读' : ''}`} actions={!readonly ? (
        <div className="flex gap-2">
          {/* S39：AI 初始分配——按类型初始化提示词批量产「责任人+排期」草案，人审后一键应用 */}
          {p.tasks.some((t) => t.status !== 'done') && (
            <Btn small onClick={() => setInitAssigning(true)} title="按类型初始化提示词批量分配责任人与计划起止（草案可改，应用后生效）">✨ AI 初始分配</Btn>
          )}
          <Btn small onClick={() => void 0} title="底部添加行">在下方添加</Btn>
        </div>
      ) : undefined}>
        {p.tasks.length === 0 ? <Empty hint="暂无任务（自由创建项目可手工添加）" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-[13px]">
              <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)] [&>th]:whitespace-nowrap">
                  <th className="py-1.5">任务</th><th>责任人（唯一）</th><th>状态</th><th>计划开始</th><th>计划结束</th><th>标记</th><th></th>
                </tr>
              </thead>
              <tbody>
                {p.tasks.map((t) => {
                  // S41/K23：整行浅底色按视觉桶区分（逾期红优先于状态色），data-visual 为冒烟锚点
                  const visual = taskVisual(t)
                  const statusTone = TASK_STATUS_TONE[t.status] || 'muted'
                  return (
                  <tr key={t.id} data-testid="task-row" data-visual={visual} className={`border-b border-[var(--color-line)] last:border-0 ${TASK_ROW_CLS[visual]}`}>
                    <td className={`py-1 ${t.status === 'done' ? 'text-[var(--color-ink-soft)]' : ''}`}>
                      {/* S2-4（v0.48）：标题旁展示稳定编号 #id——群内/任意渠道按编号锁定唯一任务（与机器人盘点/事件留痕同口径）；编号只读，不进标题编辑态 */}
                      <span className="num mr-1.5 text-[12px] text-[var(--color-ink-soft)]">#{t.id}</span>
                      {readonly ? t.title : (
                        <InlineText value={t.title} className={t.status === 'done' ? 'text-[var(--color-ink-soft)]' : undefined} onSubmit={async (v) => { await api.patchTask(t.id, { title: v }); await refresh() }} />
                      )}
                    </td>
                    <td>
                      {readonly ? nameOf(t.responsibleMemberId) : (
                        <select className="cursor-pointer rounded bg-transparent px-1 py-0.5 hover:bg-[var(--color-brand-soft)]"
                          value={t.responsibleMemberId ?? ''} onChange={async (e) => { await api.patchTask(t.id, { responsibleMemberId: e.target.value === '' ? '' : Number(e.target.value) }); toast('责任人变更已留痕'); await refresh() }}>
                          <option value="">（未指派）</option>
                          {activeMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      {readonly ? (
                        <Badge tone={statusTone} data-testid="task-status-badge" data-tone={statusTone}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge>
                      ) : (
                        <InlineSelect value={t.status} options={TASK_STATUS_LABEL} tones={TASK_STATUS_TONE} onSubmit={async (v) => { await api.patchTask(t.id, { status: v }); await refresh() }} />
                      )}
                    </td>
                    <td className="num">{readonly ? (t.planStartDate || '—') : <InlineText type="date" value={t.planStartDate} onSubmit={async (v) => { await api.patchTask(t.id, { planStartDate: v }); await refresh() }} />}</td>
                    <td className={`num ${t.isOverdue ? 'text-[var(--color-bad)]' : ''}`}>{readonly ? (t.planEndDate || '—') : <InlineText type="date" value={t.planEndDate} onSubmit={async (v) => { await api.patchTask(t.id, { planEndDate: v }); await refresh() }} />}</td>
                    <td>
                      {t.isOverdue && <Badge tone="bad">逾期</Badge>}
                      {t.kind === 'reminder' && <Badge tone="info" data-testid="reminder-badge">⏰ 提醒</Badge>}
                      {t.kind === 'reminder' && t.remindedAt && <Badge tone="ok">已送达</Badge>}
                      {!!t.refCount && <Badge tone="info">参考 {t.refCount}</Badge>}
                    </td>
                    <td className="whitespace-nowrap">
                      <Btn small kind="ghost" onClick={() => setRefsTask({ id: t.id, title: t.title })}>参考</Btn>
                      <Btn small kind="ghost" onClick={() => setRecordsTaskId(t.id)}>记录</Btn>
                      {!readonly && (
                        <Btn small kind="ghost" onClick={async () => {
                          if (!confirm(`删除任务「${t.title}」？软删留痕：任务从列表与指标中移除，参考链接一并移除；更新记录与历史事件保留。`)) return
                          try {
                            await api.deleteTask(t.id)
                            toast('任务已删除（软删留痕）'); await refresh()
                          } catch (e) { toast((e as Error).message, 'bad') }
                        }}>删除</Btn>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!readonly && <AddTask projectId={id} members={activeMembers} onDone={refresh} />}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`里程碑（${p.milestones.length}）`}>
          {p.milestones.length === 0 ? <Empty hint="暂无里程碑" /> : (
            <ul className="space-y-1 text-[13px]">
              {p.milestones.map((m) => (
                <li key={m.id} className="flex items-center justify-between border-b border-[var(--color-line)] py-1 last:border-0">
                  <span>{m.name}</span>
                  <span className="num flex items-center gap-2">
                    {readonly ? (m.planDate || '—') : <InlineText type="date" value={m.planDate} onSubmit={async (v) => { await api.patchMilestone(m.id, { planDate: v }); await refresh() }} />}
                    <Badge tone={MILESTONE_STATUS_TONE[m.status] || 'muted'}>{MILESTONE_STATUS_LABEL[m.status] || m.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!readonly && <AddMilestone projectId={id} onDone={refresh} />}
        </Card>

        <Card title={`核心渠道（${channels.length}）`} actions={canManageChannels ? <Btn small onClick={() => setBinding(true)}>绑定渠道</Btn> : undefined}>
          {channels.length === 0 ? <Empty hint="未绑定专题渠道（计入管理员待办）" /> : (
            <ul className="space-y-1 text-[13px]">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center justify-between border-b border-[var(--color-line)] py-1 last:border-0">
                  <span><Badge tone="info">{c.platform === 'feishu' ? '飞书' : '企微'}</Badge> <span className="num">{c.groupKey}</span> {c.name}</span>
                  {canManageChannels && <Btn small kind="ghost" onClick={async () => { await api.deleteChannel(c.id); toast('已解绑'); await refresh() }}>解绑</Btn>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`讨论面 · 事件流（${events.length}，append-only）`}>
        {/* S4-7（v0.46/K25）：多条待确认建议时提供一键批量处理——同口子逐条应用，聚合回执 */}
        {pendingSuggestions.length >= 2 && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] p-2 text-[12px]">
            <span className="text-[var(--color-ink-soft)]">待确认建议 {pendingSuggestions.length} 条</span>
            <Btn small kind="primary" onClick={() => void batchDecide('confirm')}>全部生效</Btn>
            <Btn small onClick={() => void batchDecide('reject')}>全部驳回</Btn>
          </div>
        )}
        {events.length === 0 ? <Empty hint="暂无事件：绑定渠道后由大脑自动抽取，或手动添加" /> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {EVENT_PINNED_COLS.map((col) => (
              <EventColumn
                key={col.key} title={col.title} testid={`event-col-${col.key}`}
                events={events.filter((e) => col.types.includes(e.eventType))}
                emptyHint={{ progress: '暂无进展', risk: '暂无风险/阻塞', finance: '暂无财务记录' }[col.key] ?? '暂无事件'}
                renderItem={renderEvent} />
            ))}
            <EventColumn
              title="其他" testid="event-col-other" events={shownOther}
              emptyHint={otherEvents.length ? '筛选已隐藏全部其他事件' : '暂无其他事件'}
              toolbar={(
                <div className="flex flex-wrap gap-1 border-b border-[var(--color-line)] px-2 py-1.5" aria-label="其他栏类型筛选器">
                  {otherTypes.map((t) => {
                    const shown = !hiddenEventTypes.includes(t)
                    return (
                      <button
                        key={t} type="button" aria-pressed={shown}
                        onClick={() => setHiddenEventTypes((cur) => (shown ? [...cur, t] : cur.filter((x) => x !== t)))}
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${
                          shown
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                            : 'border-[var(--color-line)] text-[var(--color-ink-soft)] opacity-60'
                        }`}>
                        {EVENT_TYPE_LABEL[t] || t}
                      </button>
                    )
                  })}
                </div>
              )}
              renderItem={renderEvent} />
          </div>
        )}
        {!readonly && <AddEvent projectId={id} onDone={refresh} />}
      </Card>

      {recordsTaskId !== null && (
        <TaskRecordsModal taskId={recordsTaskId} readonly={readonly} onClose={() => setRecordsTaskId(null)} />
      )}
      {refsTask !== null && (
        <TaskRefsModal taskId={refsTask.id} taskTitle={refsTask.title} readonly={readonly} onClose={() => setRefsTask(null)} />
      )}
      {closing && <CloseModal p={p} onClose={() => setClosing(false)} onDone={async () => { setClosing(false); toast('项目已结项归档'); await refresh() }} />}
      {cancelling && <CancelModal p={p} onClose={() => setCancelling(false)} onDone={async () => { setCancelling(false); toast('项目已取消归档'); await refresh() }} />}
      {binding && <BindChannelModal projectId={id} onClose={() => setBinding(false)} onDone={async () => { setBinding(false); toast('渠道已绑定'); await refresh() }} />}
      {initAssigning && (
        <InitAssignModal projectId={id} members={activeMembers} onClose={() => setInitAssigning(false)} onDone={async () => { setInitAssigning(false); await refresh() }} />
      )}
      {digesting && (
        <Modal title="🧠 项目梳理（S15）" onClose={() => setDigesting(false)} wide>
          <DigestBody fn={() => api.projectDigest(id)} />
        </Modal>
      )}
    </div>
  )
}

/** S4-8（v0.47）：讨论面分栏栏位——栏头（名称+计数）+ 可滚动时序列表；toolbar 槽给其他栏放类型筛选器。 */
function EventColumn({ title, testid, events, emptyHint, toolbar, renderItem }: {
  title: string; testid: string; events: EventRow[]; emptyHint: string
  toolbar?: ReactNode; renderItem: (e: EventRow) => ReactNode
}) {
  return (
    <section data-testid={testid} className="flex flex-col rounded-md border border-[var(--color-line)]">
      <header className="flex items-center gap-2 border-b border-[var(--color-line)] px-2.5 py-1.5 text-[12px] font-semibold">
        {title}
        <Badge tone="muted">{events.length}</Badge>
      </header>
      {toolbar}
      {events.length === 0 ? <div className="p-2"><Empty hint={emptyHint} /></div> : (
        <ul className="max-h-[28rem] space-y-2 overflow-y-auto p-2">{events.map(renderItem)}</ul>
      )}
    </section>
  )
}

function DigestBody({ fn }: { fn: () => Promise<Record<string, unknown>> }) {  const [out, setOut] = useState<Record<string, unknown> | null>(null)
  const [err, setErr] = useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意仅挂载时执行一次：fn 由父组件内联新建，加入依赖会在每次父渲染时重跑梳理（多烧 LLM 调用）
  useEffect(() => { fn().then(setOut).catch((e) => setErr((e as Error).message)) }, [])
  if (err) return <div className="rounded bg-red-50 px-2 py-1.5 text-[13px] text-[var(--color-bad)]">{err}</div>
  if (!out) return <div className="py-6 text-center text-[var(--color-ink-soft)]">大脑梳理中…</div>
  return (
    <div className="space-y-2 text-[13px]">
      <div className="whitespace-pre-wrap">{String(out.narrative || out.title || JSON.stringify(out, null, 2))}</div>
      <div className="text-[12px] text-[var(--color-ink-soft)]">
        任务 {String(out.taskCount)} 项 · 逾期 {String(out.overdueCount)} · 未指派 {String(out.unassignedCount)} · 近期事件 {String(out.eventCount)} 条 · 建议 {Array.isArray(out.suggestions) ? out.suggestions.length : 0} 条（待确认）
      </div>
    </div>
  )
}

function TaskRecordsModal({ taskId, readonly, onClose }: { taskId: number; readonly: boolean; onClose: () => void }) {
  const { toast } = useStore()
  const [records, setRecords] = useState<TaskRecordRow[] | null>(null)
  const [draft, setDraft] = useState('')
  const refresh = useCallback(async () => { const r = await api.taskRecords(taskId); setRecords(r.records) }, [taskId])
  useEffect(() => { void refresh() }, [refresh])
  return (
    <Modal title={`任务更新记录（S2-3，追加式 · ${records?.length ?? 0} 条）`} onClose={onClose}>
      {!records ? <Spinner /> : records.length === 0 ? <Empty hint="暂无记录，追加第一条更新" /> : (
        <ul className="mb-3 max-h-72 space-y-2 overflow-auto">
          {records.map((r) => (
            <li key={r.id} className="rounded-md border border-[var(--color-line)] p-2 text-[13px]">
              <div className="mb-0.5 text-[11px] text-[var(--color-ink-soft)]">
                <span className="num">{fmtDateTime(r.createdAt)}</span> · {r.memberName || '系统'}
              </div>
              <div className="whitespace-pre-wrap">{r.content}</div>
            </li>
          ))}
        </ul>
      )}
      {!readonly && (
        <div className="flex gap-2">
          <input
            className={inputCls} placeholder="追加一条更新记录（Enter 保存，只增不改）" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && draft.trim()) {
                try { await api.addTaskRecord(taskId, draft); setDraft(''); toast('记录已追加'); await refresh() } catch (e2) { toast((e2 as Error).message, 'bad') }
              }
            }} />
        </div>
      )}
      {readonly && <div className="text-[11px] text-[var(--color-ink-soft)]">项目已归档，记录只读。</div>}
    </Modal>
  )
}

/** S23 任务参考资料：SOP/知识库链接的查看与手工维护（软删；结项只读）；推送会附带给执行人。 */
function TaskRefsModal({ taskId, taskTitle, readonly, onClose }: { taskId: number; taskTitle: string; readonly: boolean; onClose: () => void }) {
  const { toast } = useStore()
  const [refs, setRefs] = useState<TaskRefRow[] | null>(null)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState<TaskRefRow | null>(null)
  const refresh = useCallback(async () => { const r = await api.taskRefs(taskId); setRefs(r.refs) }, [taskId])
  useEffect(() => { void refresh() }, [refresh])
  const add = async () => {
    try {
      await api.addTaskRef(taskId, { title: title.trim(), url: url.trim(), note: note.trim() || undefined })
      setTitle(''); setUrl(''); setNote(''); toast('参考资料已添加'); await refresh()
    } catch (e) { toast((e as Error).message, 'bad') }
  }
  const saveEdit = async () => {
    if (!editing) return
    try {
      await api.patchTaskRef(taskId, editing.id, { title: editing.title, url: editing.url, note: editing.note || '' })
      setEditing(null); toast('参考资料已更新'); await refresh()
    } catch (e) { toast((e as Error).message, 'bad') }
  }
  return (
    <Modal title={`任务参考资料（S23）· ${taskTitle}`} onClose={onClose}>
      {!refs ? <Spinner /> : refs.length === 0 ? <Empty hint="暂无参考资料（可挂 SOP / 知识库链接，推送时会附带给责任人）" /> : (
        <ul className="mb-3 max-h-72 space-y-2 overflow-auto">
          {refs.map((r) => (
            <li key={r.id} className="rounded-md border border-[var(--color-line)] p-2 text-[13px]">
              {editing?.id === r.id ? (
                <div className="space-y-1.5">
                  <input className={inputCls} placeholder="标题（如：部署 SOP）" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                  <input className={inputCls} placeholder="链接（https://…）" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
                  <input className={inputCls} placeholder="备注（可选）" value={editing.note || ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                  <div className="flex gap-2">
                    <Btn small kind="primary" disabled={!editing.title.trim() || !editing.url.trim()} onClick={() => void saveEdit()}>保存</Btn>
                    <Btn small onClick={() => setEditing(null)}>取消</Btn>
                  </div>
                </div>
              ) : (
                <>
                  <a className="font-medium text-[var(--color-brand)] hover:underline" href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                  <span className="num ml-2 break-all text-[11px] text-[var(--color-ink-soft)]">{r.url}</span>
                  {r.note && <div className="mt-0.5 text-[12px] text-[var(--color-ink-soft)]">{r.note}</div>}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
                    <span className="num">{fmtDateTime(r.createdAt)}</span>
                    {r.createdByName && <span>· {r.createdByName}</span>}
                    {!readonly && (
                      <span className="ml-auto flex gap-1">
                        <Btn small kind="ghost" onClick={() => setEditing({ ...r })}>编辑</Btn>
                        <Btn small kind="ghost" onClick={async () => {
                          try { await api.deleteTaskRef(taskId, r.id); toast('已移除（软删留痕）'); await refresh() } catch (e) { toast((e as Error).message, 'bad') }
                        }}>移除</Btn>
                      </span>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readonly && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input className={inputCls} placeholder="标题（如：部署 SOP）" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input className={inputCls} placeholder="链接（https://…）" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <input className={inputCls} placeholder="备注（可选：适用时机/范围）" value={note} onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && url.trim()) void add() }} />
            <Btn small kind="primary" disabled={!title.trim() || !url.trim()} onClick={() => void add()}>添加</Btn>
          </div>
        </div>
      )}
      {readonly && <div className="text-[11px] text-[var(--color-ink-soft)]">项目已归档，参考资料只读。</div>}
    </Modal>
  )
}

function AddTask({ projectId, members, onDone }: { projectId: number; members: Member[]; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('') // S38：新建默认未指派（责任人与项目牵头人解耦，K20）
  const [kind, setKind] = useState('work') // S57：work=工作 / reminder=纯提醒（到期推送后自动完成）
  const [date, setDate] = useState('') // S57：纯提醒的提醒日（=planEndDate，必填）
  const submit = async () => {
    if (!title.trim()) return
    if (kind === 'reminder' && !date) return
    await api.createTask({
      projectId, title, kind,
      ...(kind === 'reminder' ? { planEndDate: date } : {}),
      ...(owner ? { responsibleMemberId: Number(owner) } : {}),
    })
    setTitle(''); setOwner(''); setDate(''); await onDone()
  }
  const reminder = kind === 'reminder'
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <select className="cell-input w-full sm:w-28" aria-label="新任务分类" value={kind}
        onChange={(e) => setKind(e.target.value)}>
        <option value="work">工作</option>
        <option value="reminder">⏰ 纯提醒</option>
      </select>
      <input className="cell-input min-w-[12rem] flex-1"
        placeholder={reminder ? '新增提醒标题（提醒日推责任人+项目群后自动完成）' : '新增任务标题（默认未指派，Enter 保存）'}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
      {reminder && (
        <input type="date" className="cell-input w-full sm:w-40" aria-label="提醒日（必填）" value={date}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
      )}
      <select className="cell-input w-full sm:w-32" aria-label="新任务责任人（默认未指派）" value={owner} onChange={(e) => setOwner(e.target.value)}>
        <option value="">（未指派）</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </div>
  )
}

/** S39（v0.42）+ S44（v0.45 异步化）：AI 初始分配弹窗——启动后 2s 轮询作业（GLM 可能要 1~2 分钟），
 * 草案（不落库）逐行可编辑，「应用」单事务批量生效并留痕。 */
function InitAssignModal({ projectId, members, onClose, onDone }: { projectId: number; members: Member[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useStore()
  const [rows, setRows] = useState<InitAssignmentRow[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [waitSec, setWaitSec] = useState(0)
  const [applying, setApplying] = useState(false)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const t0 = Date.now()
    void (async () => {
      try {
        const start = await api.draftInitAssignments(projectId) // 202 {draftId, status:'running'}
        const poll = async () => {
          if (stopped) return
          try {
            const out = await api.getDraftInitAssignment(projectId, start.draftId)
            if (stopped) return
            if (out.status === 'running') {
              setWaitSec(Math.round((Date.now() - t0) / 1000))
              timer = setTimeout(() => void poll(), 2000)
              return
            }
            if (out.status === 'error') { setErr(out.message || '草案生成失败'); return }
            setRows(out.assignments ?? []); setWarnings(out.warnings ?? [])
          } catch (e) { if (!stopped) setErr((e as Error).message) }
        }
        await poll()
      } catch (e) { if (!stopped) setErr((e as Error).message) }
    })()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [projectId])
  const patchRow = (taskId: number, p: Partial<InitAssignmentRow>) =>
    setRows((rs) => (rs ?? []).map((r) => (r.taskId === taskId ? { ...r, ...p } : r)))
  const apply = async () => {
    if (!rows?.length) return
    setApplying(true); setErr('')
    try {
      const out = await api.applyInitAssignments(projectId, rows.map((r) => ({
        taskId: r.taskId, responsibleMemberId: r.responsibleMemberId, planStartDate: r.planStartDate, planEndDate: r.planEndDate,
      })))
      toast(`初始分配已应用：${out.updated} 项任务（已留痕）`)
      await onDone()
    } catch (e) { setErr((e as Error).message); setApplying(false) }
  }
  return (
    <Modal title="✨ AI 初始分配（S39）" onClose={onClose} wide>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      {!rows && !err && (
        <div className="py-6 text-center text-[var(--color-ink-soft)]" data-testid="init-assign-waiting">
          大脑分配中（已等待 {waitSec}s；GLM 大输出可能要 1~2 分钟）…
        </div>
      )}
      {rows && (
        <>
          {warnings.length > 0 && (
            <div className="mb-2 rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[12px] text-[var(--color-ink-soft)]">
              {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-[13px]">
              <thead className="text-left text-[12px] text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)]"><th className="py-1.5">任务</th><th>责任人</th><th>计划开始</th><th>计划结束</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.taskId} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="py-1 pr-2">{r.title}</td>
                    <td>
                      <select className="cursor-pointer rounded bg-transparent px-1 py-0.5 hover:bg-[var(--color-brand-soft)]"
                        aria-label={`任务 ${r.title} 责任人`}
                        value={r.responsibleMemberId ?? ''}
                        onChange={(e) => patchRow(r.taskId, { responsibleMemberId: e.target.value === '' ? null : Number(e.target.value) })}>
                        <option value="">（未指派）</option>
                        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td><input type="date" className="cell-input !w-36" value={r.planStartDate ?? ''} onChange={(e) => patchRow(r.taskId, { planStartDate: e.target.value || null })} /></td>
                    <td><input type="date" className="cell-input !w-36" value={r.planEndDate ?? ''} onChange={(e) => patchRow(r.taskId, { planEndDate: e.target.value || null })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-[var(--color-ink-soft)]">草案由 AI 按类型初始化提示词生成（未落库）；应用后单事务生效，讨论面与审计留痕。</span>
            <Btn onClick={onClose}>取消</Btn>
            <Btn kind="primary" disabled={applying || rows.length === 0} onClick={() => void apply()}>{applying ? '应用中…' : `应用 ${rows.length} 项`}</Btn>
          </div>
        </>
      )}
    </Modal>
  )
}

function AddMilestone({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <input className="cell-input" placeholder="里程碑名" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="date" className="cell-input w-full sm:w-40" value={date} onChange={(e) => setDate(e.target.value)} />
      <Btn small disabled={!name} onClick={async () => { await api.createMilestone({ projectId, name, planDate: date }); setName(''); setDate(''); await onDone() }}>添加</Btn>
    </div>
  )
}

function AddEvent({ projectId, onDone }: { projectId: number; onDone: () => Promise<void> }) {
  const [summary, setSummary] = useState('')
  const [type, setType] = useState('progress')
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <select className="cell-input w-full sm:w-28" value={type} onChange={(e) => setType(e.target.value)}>
        {Object.entries(EVENT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <input className="cell-input" placeholder="手动补充讨论面记录（记录型，Enter 保存）" value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === 'Enter' && summary.trim()) { await api.addProjectEvent(projectId, { eventType: type, summary, nature: 'record' }); setSummary(''); await onDone() }
        }} />
    </div>
  )
}

function CloseModal({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [unfinished, setUnfinished] = useState(() => p.tasks.filter((t) => t.status !== 'done'))
  const [summary, setSummary] = useState('')
  const [err, setErr] = useState('')
  const [drafting, setDrafting] = useState(false)
  const markDone = async (taskId: number) => {
    await api.patchTask(taskId, { status: 'done' })
    setUnfinished((list) => list.filter((t) => t.id !== taskId))
  }
  const markAll = async () => {
    for (const t of unfinished) await api.patchTask(t.id, { status: 'done' })
    setUnfinished([])
  }
  const aiDraft = async () => {
    setDrafting(true); setErr('')
    try {
      const out = await api.closeoutDraft(p.id)
      setSummary(out.summary) // AI 草稿仅预填，人工改后提交（S8-2/S29：最终文本人拍板）
    } catch (e) { setErr((e as Error).message) } finally { setDrafting(false) }
  }
  const submit = async () => {
    try {
      await api.closeProject(p.id, { summary: summary.trim() })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title="结项（S8）：所有任务标记完成后方可结项；结项总结必填（S29）" onClose={onClose} wide>
      {unfinished.length === 0 ? <div className="mb-3 text-[13px] text-[var(--color-ink-soft)]">无未完任务，可直接结项。</div> : (
        <div className="mb-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px]">未完任务 {unfinished.length} 项（v0.6：唯一终态=完成，无「取消」处置）</span>
            <Btn small kind="primary" onClick={() => void markAll()}>全部标记完成</Btn>
          </div>
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-[var(--color-ink-soft)]"><tr className="border-b border-[var(--color-line)]"><th className="py-1">任务</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {unfinished.map((t) => {
                const tone = TASK_STATUS_TONE[t.status] || 'muted'
                return (
                <tr key={t.id} data-testid="task-row" data-visual={taskVisual(t)} className={`border-b border-[var(--color-line)] last:border-0 ${TASK_ROW_CLS[taskVisual(t)]}`}>
                  <td className="py-1">{t.title}</td>
                  <td><Badge tone={tone} data-testid="task-status-badge" data-tone={tone}>{TASK_STATUS_LABEL[t.status] || t.status}</Badge></td>
                  <td><Btn small onClick={() => void markDone(t.id)}>标记完成</Btn></td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Field label="结项总结 *（必填：结束项目必须留原因文本，S29）">
        <textarea className={inputCls} rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="可点下方「AI 复盘草稿」基于事件流生成草稿，再人工修订" />
      </Field>
      <div className="mb-3">
        <Btn small disabled={drafting} onClick={() => void aiDraft()}>{drafting ? '生成中…' : '✨ AI 复盘草稿（预填可改）'}</Btn>
      </div>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>返回</Btn>
        <Btn kind="danger" disabled={!summary.trim()} onClick={submit}>确认结项</Btn>
      </div>
      {err === '' && <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">结项后项目与任务面转只读、终态不可逆，事件流保留。</div>}
    </Modal>
  )
}

/** S8-3/S29 取消项目：原因必填；未完任务原样冻结（无需处置）；终态不可逆。 */
function CancelModal({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const open = p.tasks.filter((t) => t.status !== 'done').length
  const submit = async () => {
    try {
      await api.cancelProject(p.id, { reason: reason.trim() })
      await onDone()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <Modal title="取消项目（S8-3）：原因必填，取消后终态不可逆" onClose={onClose}>
      {open > 0 && (
        <div className="mb-3 rounded-md border border-[var(--color-line)] px-2.5 py-2 text-[12px] text-[var(--color-ink-soft)]">
          还有 {open} 项未完任务——取消不做处置、原样冻结（退出预警/日报/梳理口径），项目转只读归档。
        </div>
      )}
      <Field label="取消原因 *（必填：结束项目必须留原因文本，S29）">
        <textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：客户战略调整，项目终止" />
      </Field>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>返回</Btn>
        <Btn kind="danger" disabled={!reason.trim()} onClick={submit}>确认取消项目</Btn>
      </div>
    </Modal>
  )
}

function BindChannelModal({ projectId, onClose, onDone }: { projectId: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [platform, setPlatform] = useState('feishu')
  const [groupKey, setGroupKey] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  return (
    <Modal title="绑定核心渠道（S1-3）" onClose={onClose}>
      <Field label="平台">
        <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="feishu">飞书</option><option value="wecom">企业微信</option>
        </select>
      </Field>
      <Field label="群标识（飞书 chat_id / 企微群 id）"><input className={inputCls} value={groupKey} onChange={(e) => setGroupKey(e.target.value)} /></Field>
      <Field label="群名称（可选）"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {err && <div className="mb-3 rounded bg-red-50 px-2 py-1.5 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>取消</Btn>
        <Btn kind="primary" disabled={!groupKey} onClick={async () => {
          try { await api.upsertChannel({ platform, groupKey, name, channelType: 'dedicated', projectId }); await onDone() } catch (e) { setErr((e as Error).message) }
        }}>绑定</Btn>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-soft)]">专题渠道 1 群:1 项目；跨项目混聊的通用群请在配置台维护。</div>
    </Modal>
  )
}
